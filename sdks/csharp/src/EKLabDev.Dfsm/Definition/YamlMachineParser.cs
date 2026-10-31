using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using EKLabDev.Dfsm.Policy;
using Json.Schema;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace EKLabDev.Dfsm.Definition;

public static class YamlMachineParser
{
    private static readonly Lazy<JsonSchema> CachedSchema = new(() =>
    {
        var assembly = typeof(YamlMachineParser).Assembly;
        var resourceName = "EKLabDev.Dfsm.schemas.dfsm-v1.schema.json";
        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Embedded resource '{resourceName}' not found in {assembly.FullName}.");
        using var reader = new StreamReader(stream);
        var schemaJson = reader.ReadToEnd();
        return JsonSchema.FromText(schemaJson);
    });

    public static MachineDefinition Parse(string yamlContent)
    {
        if (string.IsNullOrWhiteSpace(yamlContent))
        {
            throw new ValidationException("DFSM YAML content cannot be empty.");
        }

        // Convert YAML to strongly-typed JsonNode
        var yamlStream = new YamlStream();
        using (var stringReader = new StringReader(yamlContent))
        {
            yamlStream.Load(stringReader);
        }

        if (yamlStream.Documents.Count == 0 || yamlStream.Documents[0].RootNode == null)
        {
            throw new ValidationException("DFSM YAML content has no root document.");
        }

        var jsonNode = ConvertYamlNodeToJsonNode(yamlStream.Documents[0].RootNode, null);
        if (jsonNode == null)
        {
            throw new ValidationException("Failed to convert DFSM YAML to JSON structure.");
        }

        // Validate against JSON Schema
        var schema = CachedSchema.Value;
        var evaluationResults = schema.Evaluate(jsonNode, new EvaluationOptions { OutputFormat = OutputFormat.List });
        if (!evaluationResults.IsValid)
        {
            var errors = new List<string>();
            foreach (var detail in evaluationResults.Details)
            {
                if (!detail.IsValid && !string.IsNullOrEmpty(detail.EvaluationPath?.ToString()))
                {
                    errors.Add($"{detail.InstanceLocation}: {detail.Errors?.Values.FirstOrDefault() ?? "Schema validation failed"}");
                }
            }
            throw new ValidationException(
                $"DFSM YAML failed JSON Schema validation: {string.Join("; ", errors)}",
                errors
            );
        }

        var jsonString = jsonNode.ToJsonString();
        using var jsonDoc = JsonDocument.Parse(jsonString);
        var root = jsonDoc.RootElement;

        string? ns = null;
        if (root.TryGetProperty("registry", out var regProp) && regProp.TryGetProperty("namespace", out var nsProp))
        {
            ns = nsProp.GetString();
        }

        var machine = new MachineDefinition
        {
            Id = root.GetProperty("id").GetString()!,
            Dfsm = root.TryGetProperty("dfsm", out var dfsmProp) ? dfsmProp.GetString()! : "1.0",
            Description = root.TryGetProperty("description", out var descProp) ? descProp.GetString() : null,
            Type = root.TryGetProperty("type", out var typeProp) ? typeProp.GetString() : null,
            Initial = root.TryGetProperty("initial", out var initProp) ? initProp.GetString()! : string.Empty,
            MaxEffectChainDepth = root.TryGetProperty("maxEffectChainDepth", out var maxDepthProp) ? maxDepthProp.GetInt32() : 25
        };

        if (root.TryGetProperty("defaults", out var defaultsProp))
        {
            machine.Defaults = ParsePartialPolicy(defaultsProp, ns);
        }

        if (root.TryGetProperty("hooks", out var hooksProp) && hooksProp.ValueKind == JsonValueKind.Array)
        {
            foreach (var h in hooksProp.EnumerateArray())
            {
                if (h.ValueKind == JsonValueKind.String)
                {
                    machine.Hooks.Add(Qualify(h.GetString()!, ns));
                }
            }
        }

        if (root.TryGetProperty("effects", out var effectsProp) && effectsProp.ValueKind == JsonValueKind.Array)
        {
            foreach (var e in effectsProp.EnumerateArray())
            {
                if (e.ValueKind == JsonValueKind.String)
                {
                    machine.Effects.Add(Qualify(e.GetString()!, ns));
                }
            }
        }

        if (root.TryGetProperty("states", out var statesProp) && statesProp.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in statesProp.EnumerateObject())
            {
                machine.States[prop.Name] = ParseStateDefinition(prop.Name, prop.Value, ns);
            }
        }

        // If root type is parallel, states are regions
        if (string.Equals(machine.Type, "parallel", StringComparison.OrdinalIgnoreCase))
        {
            // parallel root machine
        }
        else if (string.IsNullOrEmpty(machine.Initial) && machine.States.Count > 0)
        {
            machine.Initial = machine.States.Keys.First();
        }

        // Inject default implicit error state if not declared
        if (!machine.States.ContainsKey("error"))
        {
            machine.States["error"] = new StateDefinition
            {
                Id = "error",
                Type = "final"
            };
        }

        ValidateAst(machine);

        return machine;
    }

    private static string Qualify(string name, string? ns)
    {
        if (string.IsNullOrEmpty(ns) || string.IsNullOrEmpty(name)) return name;
        if (name.Contains('.')) return name;
        return $"{ns}.{name}";
    }

    private static JsonNode? ConvertYamlNodeToJsonNode(YamlNode yamlNode, string? propertyName)
    {
        if (yamlNode is YamlScalarNode scalar)
        {
            if (scalar.Style == ScalarStyle.Plain)
            {
                if (string.Equals(propertyName, "dfsm", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(propertyName, "version", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonValue.Create(scalar.Value);
                }

                if (string.Equals(scalar.Value, "true", StringComparison.OrdinalIgnoreCase)) return JsonValue.Create(true);
                if (string.Equals(scalar.Value, "false", StringComparison.OrdinalIgnoreCase)) return JsonValue.Create(false);
                if (string.Equals(scalar.Value, "null", StringComparison.OrdinalIgnoreCase)) return null;

                if (long.TryParse(scalar.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l))
                {
                    return JsonValue.Create(l);
                }
                if (double.TryParse(scalar.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
                {
                    return JsonValue.Create(d);
                }
            }
            return JsonValue.Create(scalar.Value);
        }

        if (yamlNode is YamlSequenceNode seq)
        {
            var arr = new JsonArray();
            foreach (var item in seq.Children)
            {
                arr.Add(ConvertYamlNodeToJsonNode(item, propertyName));
            }
            return arr;
        }

        if (yamlNode is YamlMappingNode map)
        {
            var obj = new JsonObject();
            foreach (var entry in map.Children)
            {
                var key = ((YamlScalarNode)entry.Key).Value!;
                obj[key] = ConvertYamlNodeToJsonNode(entry.Value, key);
            }
            return obj;
        }

        return null;
    }

    private static StateDefinition ParseStateDefinition(string id, JsonElement element, string? ns)
    {
        var state = new StateDefinition
        {
            Id = id,
            Type = element.TryGetProperty("type", out var typeProp) ? typeProp.GetString() : null,
            Initial = element.TryGetProperty("initial", out var initialProp) ? initialProp.GetString() : null
        };

        if (element.TryGetProperty("entry", out var entryProp))
        {
            if (entryProp.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in entryProp.EnumerateArray()) state.Entry.Add(Qualify(item.GetString()!, ns));
            }
            else if (entryProp.ValueKind == JsonValueKind.String)
            {
                state.Entry.Add(Qualify(entryProp.GetString()!, ns));
            }
        }

        if (element.TryGetProperty("exit", out var exitProp))
        {
            if (exitProp.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in exitProp.EnumerateArray()) state.Exit.Add(Qualify(item.GetString()!, ns));
            }
            else if (exitProp.ValueKind == JsonValueKind.String)
            {
                state.Exit.Add(Qualify(exitProp.GetString()!, ns));
            }
        }

        if (element.TryGetProperty("states", out var childStatesProp) && childStatesProp.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in childStatesProp.EnumerateObject())
            {
                state.States[prop.Name] = ParseStateDefinition(prop.Name, prop.Value, ns);
            }
        }

        if (element.TryGetProperty("on", out var onProp) && onProp.ValueKind == JsonValueKind.Object)
        {
            foreach (var evtProp in onProp.EnumerateObject())
            {
                var transitions = new List<TransitionDefinition>();
                if (evtProp.Value.ValueKind == JsonValueKind.String)
                {
                    // Shorthand string target! e.g. RETRY_LATER: ready
                    transitions.Add(new TransitionDefinition { Target = evtProp.Value.GetString()! });
                }
                else if (evtProp.Value.ValueKind == JsonValueKind.Object)
                {
                    transitions.Add(ParseTransitionDefinition(evtProp.Value, ns));
                }
                else if (evtProp.Value.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in evtProp.Value.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.String)
                        {
                            transitions.Add(new TransitionDefinition { Target = item.GetString()! });
                        }
                        else
                        {
                            transitions.Add(ParseTransitionDefinition(item, ns));
                        }
                    }
                }
                state.On[evtProp.Name] = transitions;
            }
        }

        if (element.TryGetProperty("onDone", out var onDoneProp))
        {
            var list = new List<TransitionDefinition>();
            if (onDoneProp.ValueKind == JsonValueKind.String)
            {
                list.Add(new TransitionDefinition { Target = onDoneProp.GetString()! });
            }
            else if (onDoneProp.ValueKind == JsonValueKind.Object)
            {
                list.Add(ParseTransitionDefinition(onDoneProp, ns));
            }
            else if (onDoneProp.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in onDoneProp.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.String)
                    {
                        list.Add(new TransitionDefinition { Target = item.GetString()! });
                    }
                    else
                    {
                        list.Add(ParseTransitionDefinition(item, ns));
                    }
                }
            }
            state.OnDone = list;
        }

        return state;
    }

    private static TransitionDefinition ParseTransitionDefinition(JsonElement element, string? ns)
    {
        var target = element.TryGetProperty("target", out var targetProp) ? targetProp.GetString()! : string.Empty;

        string? handler = null;
        if (element.TryGetProperty("transition", out var tProp))
        {
            handler = Qualify(tProp.GetString()!, ns);
        }
        else if (element.TryGetProperty("handler", out var hProp))
        {
            handler = Qualify(hProp.GetString()!, ns);
        }

        var policy = ParsePartialPolicy(element, ns);

        return new TransitionDefinition
        {
            Target = target,
            Handler = handler,
            Policy = policy
        };
    }

    private static PartialTransitionPolicy ParsePartialPolicy(JsonElement element, string? ns)
    {
        int? retryAttempts = null;
        int? retryBackoffMs = null;
        double? retryBackoffFactor = null;
        int? retryMaxBackoffMs = null;
        string? retryBackoff = null;
        bool? retryJitter = null;
        bool? retryDefined = null;

        if (element.TryGetProperty("retry", out var retryProp))
        {
            retryDefined = true;
            if (retryProp.ValueKind == JsonValueKind.Number)
            {
                retryAttempts = retryProp.GetInt32();
            }
            else if (retryProp.ValueKind == JsonValueKind.Object)
            {
                if (retryProp.TryGetProperty("maxAttempts", out var ma)) retryAttempts = ma.GetInt32();
                if (retryProp.TryGetProperty("backoffMs", out var bm)) retryBackoffMs = bm.GetInt32();
                if (retryProp.TryGetProperty("backoffFactor", out var bf)) retryBackoffFactor = bf.GetDouble();
                if (retryProp.TryGetProperty("maxBackoffMs", out var mm)) retryMaxBackoffMs = mm.GetInt32();
                if (retryProp.TryGetProperty("backoff", out var bo))
                {
                    if (bo.ValueKind == JsonValueKind.String)
                    {
                        retryBackoff = bo.GetString();
                    }
                    else if (bo.ValueKind == JsonValueKind.Object)
                    {
                        if (bo.TryGetProperty("strategy", out var st)) retryBackoff = st.GetString();
                        if (bo.TryGetProperty("initialDelayMs", out var idm)) retryBackoffMs = (int)idm.GetDouble();
                        if (bo.TryGetProperty("maxDelayMs", out var mdm)) retryMaxBackoffMs = (int)mdm.GetDouble();
                        if (bo.TryGetProperty("multiplier", out var mul)) retryBackoffFactor = mul.GetDouble();
                    }
                }
                if (retryProp.TryGetProperty("jitter", out var ji)) retryJitter = ji.GetBoolean();
            }
        }

        int? cbFailure = null;
        int? cbRecovery = null;
        int? cbSuccess = null;
        bool? cbDefined = null;

        if (element.TryGetProperty("circuitBreaker", out var cbProp))
        {
            cbDefined = true;
            if (cbProp.TryGetProperty("failureThreshold", out var ft)) cbFailure = ft.GetInt32();
            if (cbProp.TryGetProperty("recoveryTimeoutMs", out var rt)) cbRecovery = rt.GetInt32();
            if (cbProp.TryGetProperty("openDurationMs", out var od)) cbRecovery = od.GetInt32();
            if (cbProp.TryGetProperty("halfOpenSuccessThreshold", out var st)) cbSuccess = st.GetInt32();
            if (cbProp.TryGetProperty("halfOpenMaxCalls", out var mc)) cbSuccess = mc.GetInt32();
        }

        string? onFailTarget = null;
        bool? onFailComp = null;
        bool? onFailDefined = null;

        if (element.TryGetProperty("onFail", out var onFailProp))
        {
            onFailDefined = true;
            if (onFailProp.TryGetProperty("target", out var oft)) onFailTarget = oft.GetString();
            if (onFailProp.TryGetProperty("compensate", out var ofc)) onFailComp = ofc.GetBoolean();
        }

        string? compWith = null;
        if (element.TryGetProperty("compensateWith", out var cwProp))
        {
            compWith = Qualify(cwProp.GetString()!, ns);
        }
        else if (element.TryGetProperty("compensate", out var compProp))
        {
            compWith = Qualify(compProp.GetString()!, ns);
        }

        bool? benchEnabled = null;
        int? benchWarn = null;

        if (element.TryGetProperty("benchmark", out var benchProp))
        {
            if (benchProp.TryGetProperty("enabled", out var be)) benchEnabled = be.GetBoolean();
            if (benchProp.TryGetProperty("warnThresholdMs", out var bw)) benchWarn = bw.GetInt32();
        }

        return new PartialTransitionPolicy(
            RetryMaxAttempts: retryAttempts,
            RetryBackoffMs: retryBackoffMs,
            RetryBackoffFactor: retryBackoffFactor,
            RetryMaxBackoffMs: retryMaxBackoffMs,
            RetryBackoff: retryBackoff,
            RetryJitter: retryJitter,
            RetryExplicitlyDefined: retryDefined,

            CbFailureThreshold: cbFailure,
            CbRecoveryTimeoutMs: cbRecovery,
            CbHalfOpenSuccessThreshold: cbSuccess,
            CbExplicitlyDefined: cbDefined,

            OnFailTarget: onFailTarget,
            OnFailCompensate: onFailComp,
            OnFailExplicitlyDefined: onFailDefined,

            CompensateWith: compWith,

            BenchmarkEnabled: benchEnabled,
            BenchmarkWarnThresholdMs: benchWarn
        );
    }

    private static void ValidateAst(MachineDefinition machine)
    {
        if (string.Equals(machine.Type, "parallel", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (string.IsNullOrEmpty(machine.Initial))
        {
            throw new ValidationException($"Machine '{machine.Id}' missing required root initial state.");
        }

        if (!machine.States.ContainsKey(machine.Initial))
        {
            throw new ValidationException($"Machine '{machine.Id}' initial state '{machine.Initial}' does not exist in states.");
        }

        var allKnownStates = new HashSet<string>(StringComparer.Ordinal);
        CollectStateNames(machine.States, "", allKnownStates);

        ValidateStateHierarchy(machine.States, allKnownStates, machine.Id);
    }

    private static void CollectStateNames(Dictionary<string, StateDefinition> states, string prefix, HashSet<string> set)
    {
        foreach (var kvp in states)
        {
            var fullName = string.IsNullOrEmpty(prefix) ? kvp.Key : $"{prefix}.{kvp.Key}";
            set.Add(fullName);
            set.Add(kvp.Key);
            if (kvp.Value.States.Count > 0)
            {
                CollectStateNames(kvp.Value.States, fullName, set);
            }
        }
    }

    private static void ValidateStateHierarchy(Dictionary<string, StateDefinition> states, HashSet<string> allKnown, string machineId)
    {
        foreach (var kvp in states)
        {
            var s = kvp.Value;
            if (s.IsCompound && s.States.Count > 0)
            {
                if (string.IsNullOrEmpty(s.Initial))
                {
                    throw new ValidationException($"Compound state '{s.Id}' must define an initial child state.");
                }
                if (!s.States.ContainsKey(s.Initial))
                {
                    throw new ValidationException($"Compound state '{s.Id}' initial state '{s.Initial}' not found in child states.");
                }
            }

            foreach (var onTransitions in s.On.Values)
            {
                foreach (var t in onTransitions)
                {
                    if (!string.IsNullOrEmpty(t.Target) && !allKnown.Contains(t.Target))
                    {
                        throw new ValidationException($"Transition target '{t.Target}' from state '{s.Id}' does not exist in machine '{machineId}'.");
                    }
                }
            }

            if (s.OnDone != null)
            {
                foreach (var t in s.OnDone)
                {
                    if (!string.IsNullOrEmpty(t.Target) && !allKnown.Contains(t.Target))
                    {
                        throw new ValidationException($"onDone target '{t.Target}' from state '{s.Id}' does not exist in machine '{machineId}'.");
                    }
                }
            }

            if (s.States.Count > 0)
            {
                ValidateStateHierarchy(s.States, allKnown, machineId);
            }
        }
    }
}
