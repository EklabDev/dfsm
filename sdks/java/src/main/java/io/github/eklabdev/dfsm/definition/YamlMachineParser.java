package io.github.eklabdev.dfsm.definition;

import com.fasterxml.jackson.databind.JsonNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import io.github.eklabdev.dfsm.JsonCodec;
import io.github.eklabdev.dfsm.definition.MachineDefinition.MachineHooksIR;
import io.github.eklabdev.dfsm.definition.MachineDefinition.RegistryBindingIR;
import io.github.eklabdev.dfsm.definition.MachineDefinition.StateNodeIR;
import io.github.eklabdev.dfsm.definition.MachineDefinition.TransitionEdgeIR;
import io.github.eklabdev.dfsm.error.SchemaValidationException;
import io.github.eklabdev.dfsm.policy.BackoffStrategy;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Parses and validates canonical DFSM v1.0 YAML definitions against {@code dfsm-v1.schema.json}
 * (JSON Schema Draft 2020-12) and compiles them into immutable {@link MachineDefinition} IR.
 */
public final class YamlMachineParser {
    private static final JsonSchema SCHEMA = loadSchema();

    private YamlMachineParser() {}

    private static JsonSchema loadSchema() {
        try (InputStream in = YamlMachineParser.class.getClassLoader()
                .getResourceAsStream("schemas/dfsm-v1.schema.json")) {
            if (in == null) {
                throw new IllegalStateException("Bundled schemas/dfsm-v1.schema.json not found on classpath");
            }
            JsonNode schemaNode = JsonCodec.jsonMapper().readTree(in);
            JsonSchemaFactory factory = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
            return factory.getSchema(schemaNode);
        } catch (IOException e) {
            throw new IllegalStateException("Failed to load dfsm-v1.schema.json", e);
        }
    }

    public static MachineDefinition parseYamlFile(Path path) {
        try {
            return parseYaml(Files.readString(path));
        } catch (IOException e) {
            throw new SchemaValidationException("Failed to read YAML file " + path, List.of(e.getMessage()));
        }
    }

    public static MachineDefinition parseYaml(String yamlContent) {
        if (yamlContent == null || yamlContent.isBlank()) {
            throw new SchemaValidationException("DFSM YAML definition is empty", List.of("empty document"));
        }

        JsonNode root;
        try {
            root = JsonCodec.parseYamlToTree(yamlContent);
        } catch (Exception e) {
            throw new SchemaValidationException("Malformed YAML syntax", List.of(e.getMessage()));
        }

        if (root == null || !root.isObject()) {
            throw new SchemaValidationException("DFSM YAML root must be an object", List.of("root is not an object"));
        }

        Set<ValidationMessage> schemaErrors = SCHEMA.validate(root);
        if (!schemaErrors.isEmpty()) {
            List<String> msgs = schemaErrors.stream()
                    .map(ValidationMessage::getMessage)
                    .toList();
            throw new SchemaValidationException("YAML failed DFSM v1.0 JSON Schema validation", msgs);
        }

        String id = textOrNull(root, "id");
        String version = textOrDefault(root, "version", "1.0.0");
        String description = textOrNull(root, "description");
        String rawType = textOrNull(root, "type");
        StateNodeType rootType = "parallel".equalsIgnoreCase(rawType)
                ? StateNodeType.PARALLEL
                : StateNodeType.COMPOUND;
        String initial = textOrNull(root, "initial");

        RegistryBindingIR registry = parseRegistry(root.get("registry"));
        PartialTransitionPolicy defaults = parsePolicy(root.get("defaults"), null);
        MachineHooksIR hooks = parseHooks(root.get("hooks"));
        List<String> effects = parseStringList(root.get("effects"));
        Integer maxEffectChainDepth = root.hasNonNull("maxEffectChainDepth")
                ? root.get("maxEffectChainDepth").asInt()
                : null;

        Map<String, StateNodeIR> states = new LinkedHashMap<>();
        JsonNode statesNode = root.get("states");
        if (statesNode != null && statesNode.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = statesNode.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> entry = fields.next();
                String stateKey = entry.getKey();
                states.put(stateKey, parseStateNode(stateKey, stateKey, entry.getValue()));
            }
        }

        return MachineDefinition.finalizeAndValidate(
                id,
                version,
                description,
                "yaml",
                rootType,
                initial,
                registry,
                defaults,
                hooks,
                effects,
                maxEffectChainDepth,
                states
        );
    }

    private static RegistryBindingIR parseRegistry(JsonNode node) {
        if (node == null || !node.isObject()) {
            return new RegistryBindingIR(null, true);
        }
        String ns = textOrNull(node, "namespace");
        boolean strict = !node.hasNonNull("strict") || node.get("strict").asBoolean(true);
        return new RegistryBindingIR(ns, strict);
    }

    private static MachineHooksIR parseHooks(JsonNode node) {
        if (node == null || !node.isObject()) {
            return MachineHooksIR.empty();
        }
        return new MachineHooksIR(
                parseStringList(node.get("onStart")),
                parseStringList(node.get("beforeTransition")),
                parseStringList(node.get("afterTransition")),
                parseStringList(node.get("onCompensate")),
                parseStringList(node.get("onComplete")),
                parseStringList(node.get("onTerminal"))
        );
    }

    private static StateNodeIR parseStateNode(String key, String path, JsonNode node) {
        if (node == null || node.isNull() || (node.isObject() && node.isEmpty())) {
            return new StateNodeIR(
                    key, path, StateNodeType.ATOMIC, null, null,
                    List.of(), List.of(), Map.of(), null, Map.of(), false
            );
        }

        JsonNode childStatesNode = node.get("states");
        Map<String, StateNodeIR> children = new LinkedHashMap<>();
        if (childStatesNode != null && childStatesNode.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = childStatesNode.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> ch = it.next();
                String childKey = ch.getKey();
                children.put(childKey, parseStateNode(childKey, path + "." + childKey, ch.getValue()));
            }
        }

        StateNodeType type = StateNodeType.fromString(textOrNull(node, "type"), !children.isEmpty());
        String description = textOrNull(node, "description");
        String initial = textOrNull(node, "initial");
        List<String> entry = parseStringList(node.get("entry"));
        List<String> exit = parseStringList(node.get("exit"));

        Map<String, TransitionEdgeIR> on = new LinkedHashMap<>();
        JsonNode onNode = node.get("on");
        if (onNode != null && onNode.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = onNode.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                on.put(e.getKey(), parseTransitionEdge(e.getKey(), e.getValue()));
            }
        }

        TransitionEdgeIR onDone = node.hasNonNull("onDone")
                ? parseTransitionEdge("$onDone", node.get("onDone"))
                : null;

        return new StateNodeIR(
                key,
                path,
                type,
                description,
                initial,
                entry,
                exit,
                Collections.unmodifiableMap(on),
                onDone,
                Collections.unmodifiableMap(children),
                false
        );
    }

    private static TransitionEdgeIR parseTransitionEdge(String event, JsonNode node) {
        if (node.isTextual()) {
            return new TransitionEdgeIR(
                    event, node.asText(), null, null, List.of(), null, PartialTransitionPolicy.EMPTY
            );
        }
        String target = textOrNull(node, "target");
        String transition = textOrNull(node, "transition");
        String compensate = textOrNull(node, "compensate");
        List<String> effects = parseStringList(node.get("effects"));
        String description = textOrNull(node, "description");
        PartialTransitionPolicy policy = parsePolicy(node, compensate);

        return new TransitionEdgeIR(event, target, transition, compensate, effects, description, policy);
    }

    private static PartialTransitionPolicy parsePolicy(JsonNode node, String compensateHandler) {
        if (node == null || !node.isObject()) {
            return compensateHandler != null
                    ? PartialTransitionPolicy.EMPTY.withCompensateHandler(compensateHandler)
                    : PartialTransitionPolicy.EMPTY;
        }

        PartialTransitionPolicy.PartialRetry retry = null;
        JsonNode retryNode = node.get("retry");
        if (retryNode != null) {
            if (retryNode.isInt() || retryNode.isNumber()) {
                retry = new PartialTransitionPolicy.PartialRetry(retryNode.asInt(), null);
            } else if (retryNode.isObject()) {
                Integer maxAttempts = retryNode.hasNonNull("maxAttempts")
                        ? retryNode.get("maxAttempts").asInt()
                        : null;
                PartialTransitionPolicy.PartialBackoff backoff = null;
                JsonNode boNode = retryNode.get("backoff");
                if (boNode != null && boNode.isObject()) {
                    backoff = new PartialTransitionPolicy.PartialBackoff(
                            boNode.hasNonNull("strategy")
                                    ? BackoffStrategy.fromString(boNode.get("strategy").asText())
                                    : null,
                            boNode.hasNonNull("initialDelayMs") ? boNode.get("initialDelayMs").asLong() : null,
                            boNode.hasNonNull("maxDelayMs") ? boNode.get("maxDelayMs").asLong() : null,
                            boNode.hasNonNull("multiplier") ? boNode.get("multiplier").asDouble() : null
                    );
                }
                retry = new PartialTransitionPolicy.PartialRetry(maxAttempts, backoff);
            }
        }

        PartialTransitionPolicy.PartialCircuitBreaker cb = null;
        JsonNode cbNode = node.get("circuitBreaker");
        if (cbNode != null && cbNode.isObject()) {
            cb = new PartialTransitionPolicy.PartialCircuitBreaker(
                    cbNode.hasNonNull("enabled") ? cbNode.get("enabled").asBoolean() : null,
                    cbNode.hasNonNull("failureThreshold") ? cbNode.get("failureThreshold").asInt() : null,
                    cbNode.hasNonNull("slidingWindowSize") ? cbNode.get("slidingWindowSize").asInt() : null,
                    cbNode.hasNonNull("openDurationMs") ? cbNode.get("openDurationMs").asLong() : null,
                    cbNode.hasNonNull("halfOpenMaxCalls") ? cbNode.get("halfOpenMaxCalls").asInt() : null
            );
        }

        PartialTransitionPolicy.PartialOnFail onFail = null;
        JsonNode ofNode = node.get("onFail");
        if (ofNode != null && ofNode.isObject()) {
            onFail = new PartialTransitionPolicy.PartialOnFail(
                    ofNode.hasNonNull("compensate") ? ofNode.get("compensate").asBoolean() : null,
                    textOrNull(ofNode, "target")
            );
        }

        PartialTransitionPolicy.PartialBenchmark bm = null;
        JsonNode bmNode = node.get("benchmark");
        if (bmNode != null) {
            if (bmNode.isBoolean()) {
                bm = new PartialTransitionPolicy.PartialBenchmark(bmNode.asBoolean());
            } else if (bmNode.isObject() && bmNode.hasNonNull("enabled")) {
                bm = new PartialTransitionPolicy.PartialBenchmark(bmNode.get("enabled").asBoolean());
            }
        }

        return new PartialTransitionPolicy(retry, cb, onFail, bm, compensateHandler);
    }

    private static List<String> parseStringList(JsonNode node) {
        if (node == null || node.isNull()) {
            return List.of();
        }
        if (node.isTextual()) {
            String s = node.asText();
            return s.isBlank() ? List.of() : List.of(s);
        }
        if (node.isArray()) {
            List<String> out = new ArrayList<>();
            for (JsonNode elem : node) {
                if (elem.isTextual() && !elem.asText().isBlank()) {
                    out.add(elem.asText());
                }
            }
            return List.copyOf(out);
        }
        return List.of();
    }

    private static String textOrNull(JsonNode obj, String field) {
        if (obj == null || !obj.hasNonNull(field)) {
            return null;
        }
        String val = obj.get(field).asText();
        return val != null && !val.isBlank() ? val : null;
    }

    private static String textOrDefault(JsonNode obj, String field, String fallback) {
        String v = textOrNull(obj, field);
        return v != null ? v : fallback;
    }
}

