package io.github.eklabdev.dfsm.engine;

import io.github.eklabdev.dfsm.DfsmModels.TerminalStateDescriptor;
import io.github.eklabdev.dfsm.DfsmModels.TerminalStatesInfo;
import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.definition.MachineDefinition;
import io.github.eklabdev.dfsm.definition.MachineDefinition.StateNodeIR;
import io.github.eklabdev.dfsm.definition.MachineDefinition.TransitionEdgeIR;
import io.github.eklabdev.dfsm.definition.StateNodeType;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pure XState-aligned hierarchical, parallel, LCA exit/entry, and {@code onDone} statechart engine.
 */
public final class StatechartEngine {
    private StatechartEngine() {}

    public record MatchedTransition(StateNodeIR sourceNode, TransitionEdgeIR edge) {}

    public record InitialResolution(StateValue stateValue, List<String> entryEffects) {}

    public record AppliedTransition(
            String targetPath,
            StateValue nextStateValue,
            List<String> exitEffects,
            List<String> entryEffects
    ) {}

    private record SubtreeEntry(StateValue subValue, List<String> entryEffects) {}

    public static StateNodeIR getNodeByPath(MachineDefinition machine, String dotPath) {
        if (dotPath == null || dotPath.isBlank()) {
            return null;
        }
        String[] parts = dotPath.split("\\.");
        Map<String, StateNodeIR> map = machine.states();
        StateNodeIR current = null;
        for (String part : parts) {
            if (part.isEmpty()) continue;
            current = map.get(part);
            if (current == null) return null;
            map = current.states();
        }
        return current;
    }

    private static SubtreeEntry enterSubtree(StateNodeIR node) {
        List<String> entryEffects = new ArrayList<>(node.entry());

        if (node.type() == StateNodeType.ATOMIC || node.type() == StateNodeType.FINAL) {
            return new SubtreeEntry(null, entryEffects);
        }

        if (node.type() == StateNodeType.COMPOUND) {
            StateNodeIR child = node.states().get(node.initial());
            if (child == null) {
                return new SubtreeEntry(null, entryEffects);
            }
            SubtreeEntry enteredChild = enterSubtree(child);
            entryEffects.addAll(enteredChild.entryEffects());
            StateValue val = enteredChild.subValue() == null
                    ? StateValue.of(child.key())
                    : StateValue.ofSingleNested(child.key(), enteredChild.subValue());
            return new SubtreeEntry(val, entryEffects);
        }

        // PARALLEL: enter all child regions in declaration order
        Map<String, StateValue> parallelMap = new LinkedHashMap<>();
        for (Map.Entry<String, StateNodeIR> e : node.states().entrySet()) {
            SubtreeEntry enteredRegion = enterSubtree(e.getValue());
            entryEffects.addAll(enteredRegion.entryEffects());
            parallelMap.put(
                    e.getKey(),
                    enteredRegion.subValue() == null ? StateValue.of(e.getKey()) : enteredRegion.subValue()
            );
        }
        return new SubtreeEntry(StateValue.ofMap(parallelMap), entryEffects);
    }

    public static InitialResolution resolveInitialState(MachineDefinition machine) {
        if (machine.rootType() == StateNodeType.PARALLEL) {
            Map<String, StateValue> rootMap = new LinkedHashMap<>();
            List<String> effects = new ArrayList<>();
            for (Map.Entry<String, StateNodeIR> e : machine.states().entrySet()) {
                if (e.getValue().isImplicitError()) continue;
                SubtreeEntry entered = enterSubtree(e.getValue());
                effects.addAll(entered.entryEffects());
                rootMap.put(
                        e.getKey(),
                        entered.subValue() == null ? StateValue.of(e.getKey()) : entered.subValue()
                );
            }
            return new InitialResolution(StateValue.ofMap(rootMap), List.copyOf(effects));
        }

        StateNodeIR initialNode = machine.states().get(machine.initial());
        SubtreeEntry entered = enterSubtree(initialNode);
        StateValue stateValue = entered.subValue() == null
                ? StateValue.of(initialNode.key())
                : StateValue.ofSingleNested(initialNode.key(), entered.subValue());
        return new InitialResolution(stateValue, List.copyOf(entered.entryEffects()));
    }

    public static List<String> getActiveLeafPaths(MachineDefinition machine, StateValue stateValue) {
        return getActiveLeafPaths(machine, stateValue, "");
    }

    private static List<String> getActiveLeafPaths(
            MachineDefinition machine,
            StateValue stateValue,
            String parentPath
    ) {
        if (stateValue.isLeaf()) {
            String leaf = stateValue.asLeaf();
            return List.of(parentPath.isEmpty() ? leaf : parentPath + "." + leaf);
        }

        List<String> leaves = new ArrayList<>();
        for (Map.Entry<String, StateValue> e : stateValue.asMap().entrySet()) {
            String key = e.getKey();
            StateValue childVal = e.getValue();
            String currentPath = parentPath.isEmpty() ? key : parentPath + "." + key;
            StateNodeIR node = getNodeByPath(machine, currentPath);

            if (node != null && node.type() == StateNodeType.PARALLEL && childVal.isCompoundOrParallel()) {
                for (Map.Entry<String, StateValue> reg : childVal.asMap().entrySet()) {
                    String regionPath = currentPath + "." + reg.getKey();
                    StateValue regionVal = reg.getValue();
                    StateNodeIR regionNode = getNodeByPath(machine, regionPath);
                    if (regionNode != null
                            && (regionNode.type() == StateNodeType.ATOMIC || regionNode.type() == StateNodeType.FINAL)) {
                        leaves.add(regionPath);
                    } else if (regionVal.isLeaf()) {
                        leaves.add(regionPath + "." + regionVal.asLeaf());
                    } else {
                        leaves.addAll(getActiveLeafPaths(machine, regionVal, regionPath));
                    }
                }
            } else {
                leaves.addAll(getActiveLeafPaths(machine, childVal, currentPath));
            }
        }
        return leaves;
    }

    private static List<String> collectBottomUpExitEffects(
            MachineDefinition machine,
            StateValue stateValue,
            String subtreePrefix
    ) {
        List<String> leaves = getActiveLeafPaths(machine, stateValue);
        Set<String> visited = new LinkedHashSet<>();
        List<String> exitEffects = new ArrayList<>();

        for (String leafPath : leaves) {
            if (!subtreePrefix.isEmpty()
                    && !leafPath.equals(subtreePrefix)
                    && !leafPath.startsWith(subtreePrefix + ".")) {
                continue;
            }
            String[] segments = leafPath.split("\\.");
            for (int len = segments.length; len >= 1; len--) {
                String candidatePath = String.join(".", Arrays.copyOfRange(segments, 0, len));
                if (!subtreePrefix.isEmpty()
                        && !candidatePath.equals(subtreePrefix)
                        && !candidatePath.startsWith(subtreePrefix + ".")) {
                    break;
                }
                if (visited.add(candidatePath)) {
                    StateNodeIR node = getNodeByPath(machine, candidatePath);
                    if (node != null) {
                        exitEffects.addAll(node.exit());
                    }
                }
            }
        }
        return exitEffects;
    }

    public static List<MatchedTransition> resolveTransitionsForEvent(
            MachineDefinition machine,
            StateValue stateValue,
            String event
    ) {
        if (stateValue.isLeaf()) {
            StateNodeIR rootChild = machine.states().get(stateValue.asLeaf());
            return rootChild != null ? searchInSubtree(rootChild, null, event) : List.of();
        }

        List<MatchedTransition> results = new ArrayList<>();
        for (Map.Entry<String, StateValue> e : stateValue.asMap().entrySet()) {
            StateNodeIR rootChild = machine.states().get(e.getKey());
            if (rootChild == null) continue;
            StateValue normalized = (rootChild.type() == StateNodeType.ATOMIC || rootChild.type() == StateNodeType.FINAL)
                    ? null
                    : e.getValue();
            results.addAll(searchInSubtree(rootChild, normalized, event));
        }
        return results;
    }

    private static List<MatchedTransition> searchInSubtree(
            StateNodeIR node,
            StateValue subVal,
            String event
    ) {
        if (node.type() == StateNodeType.ATOMIC || node.type() == StateNodeType.FINAL) {
            TransitionEdgeIR direct = node.on().get(event);
            return direct != null ? List.of(new MatchedTransition(node, direct)) : List.of();
        }

        if (node.type() == StateNodeType.COMPOUND) {
            if (subVal != null && subVal.isLeaf()) {
                StateNodeIR child = node.states().get(subVal.asLeaf());
                if (child != null) {
                    List<MatchedTransition> childMatches = searchInSubtree(child, null, event);
                    if (!childMatches.isEmpty()) return childMatches;
                }
            } else if (subVal != null && subVal.isCompoundOrParallel()) {
                for (Map.Entry<String, StateValue> e : subVal.asMap().entrySet()) {
                    StateNodeIR child = node.states().get(e.getKey());
                    if (child != null) {
                        List<MatchedTransition> childMatches = searchInSubtree(child, e.getValue(), event);
                        if (!childMatches.isEmpty()) return childMatches;
                    }
                }
            }
            TransitionEdgeIR selfMatch = node.on().get(event);
            return selfMatch != null ? List.of(new MatchedTransition(node, selfMatch)) : List.of();
        }

        // PARALLEL
        List<MatchedTransition> regionMatches = new ArrayList<>();
        Map<String, StateValue> regionMap = (subVal != null && subVal.isCompoundOrParallel())
                ? subVal.asMap()
                : Map.of();

        for (Map.Entry<String, StateNodeIR> e : node.states().entrySet()) {
            StateNodeIR regionNode = e.getValue();
            StateValue rVal = regionMap.get(e.getKey());
            StateValue normalized = (regionNode.type() == StateNodeType.ATOMIC || regionNode.type() == StateNodeType.FINAL)
                    ? null
                    : rVal;
            regionMatches.addAll(searchInSubtree(regionNode, normalized, event));
        }
        if (!regionMatches.isEmpty()) {
            return regionMatches;
        }

        TransitionEdgeIR parallelBubble = node.on().get(event);
        return parallelBubble != null ? List.of(new MatchedTransition(node, parallelBubble)) : List.of();
    }

    public static AppliedTransition applyTargetTransition(
            MachineDefinition machine,
            StateValue currentStateValue,
            String sourceStatePath,
            String targetRef
    ) {
        String targetPath = machine.resolveTargetStatePath(sourceStatePath, targetRef);
        if (targetPath == null) {
            throw new IllegalArgumentException(
                    "Cannot resolve target '" + targetRef + "' from '" + sourceStatePath + "' in machine '" + machine.id() + "'"
            );
        }

        String[] srcParts = sourceStatePath.split("\\.");
        String[] tgtParts = targetPath.split("\\.");

        int commonLen = 0;
        int maxCommon = Math.min(srcParts.length, tgtParts.length) - 1;
        while (commonLen < maxCommon && srcParts[commonLen].equals(tgtParts[commonLen])) {
            commonLen++;
        }

        String[] lcaParts = Arrays.copyOfRange(tgtParts, 0, commonLen);
        String exitingRootPath = srcParts.length > commonLen
                ? String.join(".", Arrays.copyOfRange(srcParts, 0, commonLen + 1))
                : sourceStatePath;

        List<String> exitEffects = collectBottomUpExitEffects(machine, currentStateValue, exitingRootPath);

        List<String> entryEffects = new ArrayList<>();
        for (int i = commonLen; i < tgtParts.length - 1; i++) {
            String ancestorPath = String.join(".", Arrays.copyOfRange(tgtParts, 0, i + 1));
            StateNodeIR ancestorNode = getNodeByPath(machine, ancestorPath);
            if (ancestorNode != null) {
                entryEffects.addAll(ancestorNode.entry());
            }
        }

        StateNodeIR targetNode = getNodeByPath(machine, targetPath);
        SubtreeEntry enteredTarget = enterSubtree(targetNode);
        entryEffects.addAll(enteredTarget.entryEffects());

        StateValue builtBranch = enteredTarget.subValue() == null
                ? StateValue.of(targetNode.key())
                : StateValue.ofSingleNested(targetNode.key(), enteredTarget.subValue());

        for (int i = tgtParts.length - 2; i >= commonLen; i--) {
            String ancestorKey = tgtParts[i];
            String ancestorPath = String.join(".", Arrays.copyOfRange(tgtParts, 0, i + 1));
            StateNodeIR ancestorNode = getNodeByPath(machine, ancestorPath);

            if (ancestorNode.type() == StateNodeType.PARALLEL) {
                Map<String, StateValue> existingRegions = new LinkedHashMap<>(
                        extractSubStateMap(currentStateValue, ancestorPath)
                );
                String regionKey = tgtParts[i + 1];
                StateValue regionVal = (builtBranch.isCompoundOrParallel() && builtBranch.asMap().containsKey(regionKey))
                        ? builtBranch.asMap().get(regionKey)
                        : builtBranch;
                existingRegions.put(regionKey, regionVal);
                builtBranch = StateValue.ofSingleNested(ancestorKey, StateValue.ofMap(existingRegions));
            } else {
                builtBranch = StateValue.ofSingleNested(ancestorKey, builtBranch);
            }
        }

        if (lcaParts.length == 0) {
            if (machine.rootType() == StateNodeType.PARALLEL && currentStateValue.isCompoundOrParallel()) {
                String topRegionKey = tgtParts[0];
                StateValue regionVal = (builtBranch.isCompoundOrParallel() && builtBranch.asMap().containsKey(topRegionKey))
                        ? builtBranch.asMap().get(topRegionKey)
                        : builtBranch;
                Map<String, StateValue> nextRoot = new LinkedHashMap<>(currentStateValue.asMap());
                nextRoot.put(topRegionKey, regionVal);
                return new AppliedTransition(targetPath, StateValue.ofMap(nextRoot), exitEffects, entryEffects);
            }
            return new AppliedTransition(targetPath, builtBranch, exitEffects, entryEffects);
        }

        StateValue nextStateValue = replaceAtLca(machine, currentStateValue, lcaParts, 0, builtBranch);
        return new AppliedTransition(targetPath, nextStateValue, exitEffects, entryEffects);
    }

    private static Map<String, StateValue> extractSubStateMap(StateValue rootVal, String dotPath) {
        String[] parts = dotPath.split("\\.");
        StateValue cursor = rootVal;
        for (String part : parts) {
            if (part.isEmpty()) continue;
            if (cursor == null || !cursor.isCompoundOrParallel() || !cursor.asMap().containsKey(part)) {
                return Map.of();
            }
            cursor = cursor.asMap().get(part);
        }
        return (cursor != null && cursor.isCompoundOrParallel()) ? cursor.asMap() : Map.of();
    }

    private static StateValue replaceAtLca(
            MachineDefinition machine,
            StateValue current,
            String[] lcaParts,
            int depth,
            StateValue replacementBranch
    ) {
        String key = lcaParts[depth];
        String currentPath = String.join(".", Arrays.copyOfRange(lcaParts, 0, depth + 1));
        StateNodeIR node = getNodeByPath(machine, currentPath);

        if (depth == lcaParts.length - 1) {
            if (node != null && node.type() == StateNodeType.PARALLEL && current.isCompoundOrParallel()) {
                StateValue existingParallel = current.asMap().get(key);
                Map<String, StateValue> regions = new LinkedHashMap<>(
                        existingParallel != null && existingParallel.isCompoundOrParallel()
                                ? existingParallel.asMap()
                                : Map.of()
                );
                if (replacementBranch.isCompoundOrParallel() && !replacementBranch.asMap().isEmpty()) {
                    Map.Entry<String, StateValue> repEntry = replacementBranch.asMap().entrySet().iterator().next();
                    regions.put(repEntry.getKey(), repEntry.getValue());
                    Map<String, StateValue> updatedOuter = new LinkedHashMap<>(current.asMap());
                    updatedOuter.put(key, StateValue.ofMap(regions));
                    return StateValue.ofMap(updatedOuter);
                }
            }

            if (current.isCompoundOrParallel()) {
                Map<String, StateValue> updated = new LinkedHashMap<>(current.asMap());
                updated.put(key, replacementBranch);
                return StateValue.ofMap(updated);
            }
            return StateValue.ofSingleNested(key, replacementBranch);
        }

        StateValue childCurrent = (current.isCompoundOrParallel() && current.asMap().containsKey(key))
                ? current.asMap().get(key)
                : StateValue.of("");
        StateValue updatedChild = replaceAtLca(machine, childCurrent, lcaParts, depth + 1, replacementBranch);

        if (current.isCompoundOrParallel()) {
            Map<String, StateValue> updated = new LinkedHashMap<>(current.asMap());
            updated.put(key, updatedChild);
            return StateValue.ofMap(updated);
        }
        return StateValue.ofSingleNested(key, updatedChild);
    }

    public static MatchedTransition findPendingOnDone(MachineDefinition machine, StateValue stateValue) {
        List<String> leaves = getActiveLeafPaths(machine, stateValue);
        Set<String> candidateContainers = new LinkedHashSet<>();

        for (String leaf : leaves) {
            String[] parts = leaf.split("\\.");
            for (int i = parts.length - 1; i >= 1; i--) {
                candidateContainers.add(String.join(".", Arrays.copyOfRange(parts, 0, i)));
            }
        }

        List<String> sortedContainers = new ArrayList<>(candidateContainers);
        sortedContainers.sort((a, b) -> Integer.compare(b.split("\\.").length, a.split("\\.").length));

        for (String containerPath : sortedContainers) {
            StateNodeIR containerNode = getNodeByPath(machine, containerPath);
            if (containerNode == null || containerNode.onDone() == null) continue;

            if (containerNode.type() == StateNodeType.COMPOUND) {
                List<String> childLeaves = leaves.stream()
                        .filter(l -> l.startsWith(containerPath + "."))
                        .toList();
                if (childLeaves.size() == 1) {
                    StateNodeIR leafNode = getNodeByPath(machine, childLeaves.get(0));
                    if (leafNode != null && leafNode.type() == StateNodeType.FINAL) {
                        return new MatchedTransition(containerNode, containerNode.onDone());
                    }
                }
            } else if (containerNode.type() == StateNodeType.PARALLEL) {
                boolean allRegionsDone = containerNode.states().values().stream().allMatch(region -> {
                    List<String> regionLeaves = leaves.stream()
                            .filter(l -> l.equals(region.path()) || l.startsWith(region.path() + "."))
                            .toList();
                    return !regionLeaves.isEmpty() && regionLeaves.stream()
                            .allMatch(leafPath -> isBranchFinalAt(machine, region.path(), leafPath));
                });
                if (allRegionsDone) {
                    return new MatchedTransition(containerNode, containerNode.onDone());
                }
            }
        }

        return null;
    }

    private static boolean isBranchFinalAt(MachineDefinition machine, String regionPath, String leafPath) {
        StateNodeIR leafNode = getNodeByPath(machine, leafPath);
        if (leafNode == null || leafNode.type() != StateNodeType.FINAL) return false;
        StateNodeIR regionNode = getNodeByPath(machine, regionPath);
        if (regionNode == null) return false;
        if (regionNode.type() == StateNodeType.FINAL) return true;
        if (regionNode.type() == StateNodeType.COMPOUND) {
            return leafPath.equals(regionPath + "." + leafNode.key());
        }
        return false;
    }

    public static TransactionStatus resolveSettledTransactionStatus(
            MachineDefinition machine,
            StateValue stateValue,
            boolean wasCompensated
    ) {
        if (wasCompensated) {
            return TransactionStatus.COMPENSATED;
        }
        if (stateValue.matchesLeaf("error") && machine.states().containsKey("error")) {
            return TransactionStatus.FAILED;
        }
        List<String> leaves = getActiveLeafPaths(machine, stateValue);
        if (!leaves.isEmpty() && leaves.stream().allMatch(l -> {
            StateNodeIR n = getNodeByPath(machine, l);
            return n != null && n.type() == StateNodeType.FINAL;
        })) {
            return TransactionStatus.COMPLETED;
        }
        return TransactionStatus.IDLE;
    }

    public static List<String> getAvailableEvents(MachineDefinition machine, StateValue stateValue) {
        List<String> leaves = getActiveLeafPaths(machine, stateValue);
        Set<String> events = new LinkedHashSet<>();

        for (String leafPath : leaves) {
            String[] parts = leafPath.split("\\.");
            for (int len = parts.length; len >= 1; len--) {
                String candidatePath = String.join(".", Arrays.copyOfRange(parts, 0, len));
                StateNodeIR node = getNodeByPath(machine, candidatePath);
                if (node == null || node.type() == StateNodeType.FINAL) continue;
                events.addAll(node.on().keySet());
            }
        }
        return List.copyOf(events);
    }

    public static TerminalStatesInfo getTerminalStatesInfo(MachineDefinition machine) {
        List<TerminalStateDescriptor> descriptors = new ArrayList<>();
        List<String> topLevel = new ArrayList<>();
        List<String> allFinals = new ArrayList<>();

        for (StateNodeIR root : machine.states().values()) {
            walkTerminals(root, 0, descriptors, topLevel, allFinals);
        }

        StateNodeIR errNode = machine.states().get("error");
        boolean errIsFinal = errNode != null && errNode.type() == StateNodeType.FINAL;

        return new TerminalStatesInfo(
                machine.id(),
                List.copyOf(topLevel),
                List.copyOf(allFinals),
                machine.hasCustomErrorState() ? "custom" : "implicit_default",
                errIsFinal,
                List.copyOf(descriptors),
                TransactionStatus.TERMINAL_STATUSES,
                TransactionStatus.NON_TERMINAL_STATUSES
        );
    }

    private static void walkTerminals(
            StateNodeIR node,
            int depth,
            List<TerminalStateDescriptor> descriptors,
            List<String> topLevel,
            List<String> allFinals
    ) {
        boolean isError = depth == 0 && "error".equals(node.key());
        if (node.type() == StateNodeType.FINAL) {
            allFinals.add(node.path());
        }
        if (node.type() == StateNodeType.FINAL || isError) {
            List<String> outgoing = List.copyOf(node.on().keySet());
            String kind = isError
                    ? (node.isImplicitError() ? "implicit_error" : "custom_error")
                    : "final";
            if (depth == 0) {
                topLevel.add(node.key());
            }
            descriptors.add(new TerminalStateDescriptor(
                    node.path(),
                    kind,
                    depth == 0,
                    !outgoing.isEmpty(),
                    outgoing
            ));
        }
        for (StateNodeIR child : node.states().values()) {
            walkTerminals(child, depth + 1, descriptors, topLevel, allFinals);
        }
    }
}

