using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Policy;
using EKLabDev.Dfsm.Runtime;
using EKLabDev.Dfsm.Store;
using EKLabDev.Dfsm.Telemetry;
using FluentAssertions;
using Xunit;

namespace EKLabDev.Dfsm.ConformanceTests;

public class ConformanceTests
{
    private static readonly string ConformanceDir = FindConformanceDir();

    private static string FindConformanceDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "spec", "conformance")))
        {
            dir = dir.Parent;
        }
        if (dir == null)
        {
            throw new DirectoryNotFoundException("Could not find repository root containing 'spec/conformance'.");
        }
        return Path.Combine(dir.FullName, "spec", "conformance");
    }

    public static IEnumerable<object[]> GetScenarios()
    {
        var suitePath = Path.Combine(ConformanceDir, "conformance-suite.json");
        var json = File.ReadAllText(suitePath);
        using var doc = JsonDocument.Parse(json);
        var scenarios = doc.RootElement.GetProperty("scenarios");

        var list = new List<object[]>();
        foreach (var sc in scenarios.EnumerateArray())
        {
            list.Add(new object[] { sc.GetProperty("id").GetString()!, sc.Clone() });
        }
        return list;
    }

    [Theory]
    [MemberData(nameof(GetScenarios))]
    public async Task RunCanonicalScenario(string scenarioId, JsonElement scenario)
    {
        var compensationLog = new List<string>();
        var clock = new VirtualClock(1000);
        var registry = new FSMRegistry(
            store: new SqliteStateStore($"Data Source=dfsm_conformance_{scenarioId}_{Guid.NewGuid():N};Mode=Memory;Cache=Shared"),
            benchmarkEngine: NoOpBenchmarkLogEngine.Instance,
            clock: clock
        );

        // Standard transitions
        foreach (var txName in new[]
        {
            "conformance.traffic.recordStep",
            "conformance.hierarchy.beginAuth",
            "conformance.hierarchy.captureFunds",
            "conformance.hierarchy.markCancelled",
            "conformance.parallel.initFulfillment",
            "conformance.parallel.recordPaid",
            "conformance.parallel.recordPacked",
            "conformance.saga.bookFlight",
            "conformance.saga.bookHotel"
        })
        {
            registry.RegisterTransition(txName, (TransitionRequest<Dictionary<string, object>, Dictionary<string, object>> req) =>
            {
                var merged = new Dictionary<string, object>(StringComparer.Ordinal);
                if (req.Data != null)
                {
                    foreach (var kvp in req.Data) merged[kvp.Key] = kvp.Value;
                }
                if (req.Input != null)
                {
                    foreach (var kvp in req.Input) merged[kvp.Key] = kvp.Value;
                }
                return TransitionOutput<Dictionary<string, object>, object>.OfContext(merged);
            });
        }

        // Failure transitions
        scenario.TryGetProperty("decoratorOverrides", out var decoratorOverrides);
        foreach (var failTxName in new[]
        {
            "conformance.traffic.brokenBulb",
            "conformance.resilience.callPrimary",
            "conformance.resilience.alwaysFail",
            "conformance.saga.bookCar"
        })
        {
            Func<TransitionRequest<Dictionary<string, object>, Dictionary<string, object>>, TransitionOutput<Dictionary<string, object>, object>> fn = req =>
            {
                bool shouldFail = true;
                if (req.Input != null && req.Input.TryGetValue("fail", out var fVal))
                {
                    if (fVal is bool b && !b) shouldFail = false;
                    else if (fVal is JsonElement je && je.ValueKind == JsonValueKind.False) shouldFail = false;
                }
                if (shouldFail)
                {
                    throw new Exception($"Simulated failure in {failTxName}");
                }
                return TransitionOutput<Dictionary<string, object>, object>.Empty();
            };

            PartialTransitionPolicy? p = null;
            if (decoratorOverrides.ValueKind == JsonValueKind.Object && decoratorOverrides.TryGetProperty(failTxName, out var ovNode))
            {
                int? retryMax = null;
                if (ovNode.TryGetProperty("retry", out var rNode) && rNode.TryGetProperty("maxAttempts", out var ma))
                {
                    retryMax = ma.GetInt32();
                }
                p = new PartialTransitionPolicy(RetryMaxAttempts: retryMax, RetryExplicitlyDefined: retryMax.HasValue);
            }

            registry.RegisterTransition(failTxName, fn, p);
        }

        // Compensations
        foreach (var compName in new[]
        {
            "conformance.saga.cancelFlight",
            "conformance.saga.cancelHotel",
            "conformance.saga.cancelCar"
        })
        {
            registry.RegisterCompensate(compName, (CompensationRequest<Dictionary<string, object>> req) =>
            {
                compensationLog.Add(compName);
            });
        }

        // Effects
        foreach (var effName in new[]
        {
            "conformance.traffic.onEnterRed",
            "conformance.traffic.onExitRed",
            "conformance.hierarchy.enterActive",
            "conformance.hierarchy.exitActive",
            "conformance.hierarchy.enterIdle",
            "conformance.hierarchy.exitIdle",
            "conformance.hierarchy.enterAuthorizing",
            "conformance.hierarchy.exitAuthorizing",
            "conformance.parallel.notifyShipped",
            "conformance.resilience.alertError"
        })
        {
            registry.RegisterEffect(effName, (EffectRequest<Dictionary<string, object>> req) => { });
        }

        var fileName = scenario.GetProperty("file").GetString()!;
        var machineId = scenario.GetProperty("machineId").GetString()!;
        var yamlPath = Path.Combine(ConformanceDir, fileName);
        var yaml = await File.ReadAllTextAsync(yamlPath);
        var machine = YamlMachineParser.Parse(yaml);
        registry.RegisterMachine(machine);

        var actor = registry.CreateActor<Dictionary<string, object>>(machineId);

        var expectedInit = StateValue.FromJsonElement(scenario.GetProperty("expectedInitialState"));
        string txId = $"conformance-{scenarioId}-{Guid.NewGuid():N}";

        if (scenario.TryGetProperty("steps", out var stepsProp))
        {
            bool firstStep = true;
            foreach (var step in stepsProp.EnumerateArray())
            {
                var evt = step.GetProperty("event").GetString()!;
                var expectedState = StateValue.FromJsonElement(step.GetProperty("expectedState"));
                var expectedStatus = Enum.Parse<TransactionStatus>(step.GetProperty("expectedStatus").GetString()!);

                Dictionary<string, object>? inputDict = null;
                if (step.TryGetProperty("input", out var inputEl))
                {
                    inputDict = JsonSerializer.Deserialize<Dictionary<string, object>>(inputEl.GetRawText());
                }

                var res = await actor.TransitionAsync(txId, evt, inputDict);

                if (firstStep)
                {
                    firstStep = false;
                }

                res.CurrentState.Should().Be(expectedState, $"Scenario {scenarioId} step {evt} state");
                res.Status.Should().Be(expectedStatus, $"Scenario {scenarioId} step {evt} status");
            }
        }

        if (scenario.TryGetProperty("expectedCompensationOrder", out var compProp))
        {
            var expectedOrder = new List<string>();
            foreach (var item in compProp.EnumerateArray())
            {
                expectedOrder.Add(item.GetString()!);
            }
            compensationLog.Should().Equal(expectedOrder, $"Scenario {scenarioId} compensation order");
        }
    }
}
