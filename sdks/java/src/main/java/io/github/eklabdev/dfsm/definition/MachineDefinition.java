package io.github.eklabdev.dfsm.definition;

import io.github.eklabdev.dfsm.LifecycleHookName;
import io.github.eklabdev.dfsm.error.SchemaValidationException;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Immutable compiled DFSM v1.0 Machine Definition IR shared by both {@link YamlMachineParser}
 * and {@link MachineBuilder}.
 */
public record MachineDefinition(
        String dfsm,
        String id,
        String version,
        String description,
        String source,
        StateNodeType rootType,
        String initial,
        RegistryBindingIR registry,
        PartialTransitionPolicy defaults,
        MachineHooksIR hooks,
        List<String> effects,
        Integer maxEffectChainDepth,
        Map<String, StateNodeIR> states,
        boolean hasCustomErrorState
) {
    private static final Pattern VALID_ID = Pattern.compile("^[a-zA-Z0-9_-]+$");

    public record TransitionEdgeIR(
            String event,
            String target,
            String transition,
            String compensate,
            List<String> effects,
            String description,
            PartialTransitionPolicy policy
    ) {}

    public record StateNodeIR(
            String key,
            String path,
            StateNodeType type,
            String description,
            String initial,
            List<String> entry,
            List<String> exit,
            Map<String, TransitionEdgeIR> on,
            TransitionEdgeIR onDone,
            Map<String, StateNodeIR> states,
            boolean isImplicitError
    ) {}

    public record RegistryBindingIR(
            String namespace,
            boolean strict
    ) {}

    public record MachineHooksIR(
            List<String> onStart,
            List<String> beforeTransition,
            List<String> afterTransition,
            List<String> onCompensate,
            List<String> onComplete,
            List<String> onTerminal
    ) {
        public static MachineHooksIR empty() {
            return new MachineHooksIR(List.of(), List.of(), List.of(), List.of(), List.of(), List.of());
        }

        public List<String> get(LifecycleHookName slot) {
            return switch (slot) {
                case ON_START -> onStart;
                case BEFORE_TRANSITION -> beforeTransition;
                case AFTER_TRANSITION -> afterTransition;
                case ON_COMPENSATE -> onCompensate;
                case ON_COMPLETE -> onComplete;
                case ON_TERMINAL -> onTerminal;
            };
        }

        public Map<LifecycleHookName, List<String>> toNonEmptyMap() {
            Map<LifecycleHookName, List<String>> out = new EnumMap<>(LifecycleHookName.class);
            for (LifecycleHookName slot : LifecycleHookName.values()) {
                List<String> list = get(slot);
                if (list != null && !list.isEmpty()) {
                    out.put(slot, list);
                }
            }
            return out;
        }
    }

    public static String qualifyHandlerName(String handlerName, String namespace) {
        if (handlerName == null || handlerName.isBlank()) {
            return handlerName;
        }
        if (namespace == null || namespace.isBlank()) {
            return handlerName;
        }
        if (handlerName.startsWith(namespace + ".")) {
            return handlerName;
        }
        return namespace + "." + handlerName;
    }

    public static String resolveTargetStatePath(
            String machineId,
            Map<String, StateNodeIR> rootStates,
            String sourceStatePath,
            String targetRef
    ) {
        if (targetRef == null || targetRef.isBlank()) {
            return null;
        }

        if (targetRef.startsWith("#")) {
            String stripped = targetRef.substring(1);
            if (stripped.startsWith(machineId + ".")) {
                String rel = stripped.substring(machineId.length() + 1);
                StateNodeIR n = lookupByDotPath(rootStates, rel);
                return n != null ? n.path() : null;
            }
            StateNodeIR n = lookupByDotPath(rootStates, stripped);
            return n != null ? n.path() : null;
        }

        String[] sourceSegments = (sourceStatePath != null && !sourceStatePath.isBlank())
                ? sourceStatePath.split("\\.")
                : new String[0];
        if (sourceSegments.length > 1) {
            StringBuilder parentPrefix = new StringBuilder();
            for (int i = 0; i < sourceSegments.length - 1; i++) {
                if (i > 0) parentPrefix.append('.');
                parentPrefix.append(sourceSegments[i]);
            }
            String siblingCandidate = parentPrefix + "." + targetRef;
            StateNodeIR foundSibling = lookupByDotPath(rootStates, siblingCandidate);
            if (foundSibling != null) {
                return foundSibling.path();
            }
        }

        StateNodeIR foundRoot = lookupByDotPath(rootStates, targetRef);
        return foundRoot != null ? foundRoot.path() : null;
    }

    public String resolveTargetStatePath(String sourceStatePath, String targetRef) {
        return resolveTargetStatePath(this.id, this.states, sourceStatePath, targetRef);
    }

    private static StateNodeIR lookupByDotPath(Map<String, StateNodeIR> rootStates, String dotPath) {
        if (dotPath == null || dotPath.isBlank()) {
            return null;
        }
        String[] parts = dotPath.split("\\.");
        Map<String, StateNodeIR> curMap = rootStates;
        StateNodeIR found = null;
        for (String seg : parts) {
            if (seg.isEmpty() || curMap == null) {
                return null;
            }
            StateNodeIR node = curMap.get(seg);
            if (node == null) {
                return null;
            }
            found = node;
            curMap = node.states();
        }
        return found;
    }

    public static MachineDefinition finalizeAndValidate(
            String id,
            String version,
            String description,
            String source,
            StateNodeType rootType,
            String initial,
            RegistryBindingIR registry,
            PartialTransitionPolicy defaults,
            MachineHooksIR hooks,
            List<String> effects,
            Integer maxEffectChainDepth,
            Map<String, StateNodeIR> rawStates
    ) {
        List<String> issues = new ArrayList<>();

        if (id == null || !VALID_ID.matcher(id).matches()) {
            issues.add("Invalid machine id '" + id + "'. Must match /^[a-zA-Z0-9_-]+$/.");
        }
        if (maxEffectChainDepth != null && maxEffectChainDepth < 1) {
            issues.add("Invalid maxEffectChainDepth '" + maxEffectChainDepth + "'. Must be >= 1.");
        }
        if (rawStates == null || rawStates.isEmpty()) {
            issues.add("Machine '" + id + "' must define at least one state.");
        }

        Map<String, StateNodeIR> statesCopy = new LinkedHashMap<>();
        if (rawStates != null) {
            statesCopy.putAll(rawStates);
        }

        boolean hasCustomErrorState = statesCopy.containsKey("error");
        if (!hasCustomErrorState) {
            statesCopy.put("error", new StateNodeIR(
                    "error",
                    "error",
                    StateNodeType.FINAL,
                    null,
                    null,
                    List.of(),
                    List.of(),
                    Map.of(),
                    null,
                    Map.of(),
                    true
            ));
        }

        StateNodeType effectiveRootType = rootType != null ? rootType : StateNodeType.COMPOUND;
        if (effectiveRootType == StateNodeType.COMPOUND) {
            if (initial == null || initial.isBlank()) {
                issues.add("Root compound machine '" + id + "' requires an 'initial' state.");
            } else if (!statesCopy.containsKey(initial)) {
                issues.add("Root 'initial' state '" + initial + "' does not exist in machine '" + id + "'.");
            }
        } else if (effectiveRootType == StateNodeType.PARALLEL && initial != null && !initial.isBlank()) {
            issues.add("Root parallel machine '" + id + "' must not specify 'initial'.");
        }

        PartialTransitionPolicy effectiveDefaults = defaults != null ? defaults : PartialTransitionPolicy.EMPTY;
        if (effectiveDefaults.onFail() != null && effectiveDefaults.onFail().target() != null) {
            String resolved = resolveTargetStatePath(id, statesCopy, "", effectiveDefaults.onFail().target());
            if (resolved == null) {
                issues.add("Unresolvable defaults.onFail.target '" + effectiveDefaults.onFail().target() + "'.");
            }
        }

        for (StateNodeIR state : statesCopy.values()) {
            validateNodeRecursive(id, statesCopy, state, issues);
        }

        if (!issues.isEmpty()) {
            throw new SchemaValidationException("Invalid DFSM definition for '" + id + "'", issues);
        }

        return new MachineDefinition(
                "1.0",
                id,
                version != null && !version.isBlank() ? version : "1.0.0",
                description,
                source,
                effectiveRootType,
                initial,
                registry != null ? registry : new RegistryBindingIR(null, true),
                effectiveDefaults,
                hooks != null ? hooks : MachineHooksIR.empty(),
                effects != null ? List.copyOf(effects) : List.of(),
                maxEffectChainDepth,
                Collections.unmodifiableMap(statesCopy),
                hasCustomErrorState
        );
    }

    private static void validateNodeRecursive(
            String machineId,
            Map<String, StateNodeIR> rootStates,
            StateNodeIR node,
            List<String> issues
    ) {
        Map<String, StateNodeIR> children = node.states() != null ? node.states() : Map.of();
        switch (node.type()) {
            case COMPOUND -> {
                if (children.isEmpty()) {
                    issues.add("Compound state '" + node.path() + "' must define child 'states'.");
                }
                if (node.initial() == null || node.initial().isBlank()) {
                    issues.add("Compound state '" + node.path() + "' requires an 'initial' child state.");
                } else if (!children.containsKey(node.initial())) {
                    issues.add("Compound state '" + node.path() + "' initial '" + node.initial() + "' does not exist.");
                }
            }
            case PARALLEL -> {
                if (children.isEmpty()) {
                    issues.add("Parallel state '" + node.path() + "' must define child region 'states'.");
                }
                if (node.initial() != null && !node.initial().isBlank()) {
                    issues.add("Parallel state '" + node.path() + "' must not define 'initial'.");
                }
            }
            case ATOMIC -> {
                if (!children.isEmpty()) {
                    issues.add("Atomic state '" + node.path() + "' cannot contain child 'states'.");
                }
                if (node.initial() != null && !node.initial().isBlank()) {
                    issues.add("Atomic state '" + node.path() + "' cannot define 'initial'.");
                }
            }
            case FINAL -> {
                if (!children.isEmpty()) {
                    issues.add("Final state '" + node.path() + "' cannot contain child 'states'.");
                }
                if (node.initial() != null && !node.initial().isBlank()) {
                    issues.add("Final state '" + node.path() + "' cannot define 'initial'.");
                }
                if (node.on() != null && !node.on().isEmpty()) {
                    issues.add("Final state '" + node.path() + "' cannot define outgoing 'on' transitions.");
                }
            }
        }

        if (node.on() != null) {
            for (Map.Entry<String, TransitionEdgeIR> e : node.on().entrySet()) {
                validateEdge(machineId, rootStates, node.path(), "event '" + e.getKey() + "'", e.getValue(), issues);
            }
        }
        if (node.onDone() != null) {
            validateEdge(machineId, rootStates, node.path(), "'onDone'", node.onDone(), issues);
        }

        for (StateNodeIR child : children.values()) {
            validateNodeRecursive(machineId, rootStates, child, issues);
        }
    }

    private static void validateEdge(
            String machineId,
            Map<String, StateNodeIR> rootStates,
            String sourcePath,
            String label,
            TransitionEdgeIR edge,
            List<String> issues
    ) {
        if (edge.target() != null && !edge.target().isBlank()) {
            if (resolveTargetStatePath(machineId, rootStates, sourcePath, edge.target()) == null) {
                issues.add("Unresolvable target '" + edge.target() + "' on " + label + " in state '" + sourcePath + "'.");
            }
        }
        if (edge.policy() != null && edge.policy().onFail() != null && edge.policy().onFail().target() != null) {
            String fb = edge.policy().onFail().target();
            if (resolveTargetStatePath(machineId, rootStates, sourcePath, fb) == null) {
                issues.add("Unresolvable onFail.target '" + fb + "' on " + label + " in state '" + sourcePath + "'.");
            }
        }
    }
}

