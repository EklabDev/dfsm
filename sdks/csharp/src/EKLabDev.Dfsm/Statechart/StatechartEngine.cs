using System;
using System.Collections.Generic;
using System.Linq;
using EKLabDev.Dfsm.Definition;

namespace EKLabDev.Dfsm.Statechart;

public sealed record MatchedTransition(StateDefinition SourceNode, TransitionDefinition Edge, string SourcePath);

public sealed record InitialResolution(StateValue StateValue, IReadOnlyList<string> EntryEffects);

public sealed record AppliedTransition(
    string TargetPath,
    StateValue NextStateValue,
    IReadOnlyList<string> ExitEffects,
    IReadOnlyList<string> EntryEffects
);

public static class StatechartEngine
{
    private sealed record SubtreeEntry(StateValue? SubValue, List<string> EntryEffects);

    public static StateDefinition? GetNodeByPath(MachineDefinition machine, string dotPath)
    {
        if (string.IsNullOrWhiteSpace(dotPath)) return null;
        var parts = dotPath.Split('.', StringSplitOptions.RemoveEmptyEntries);
        Dictionary<string, StateDefinition> map = machine.States;
        StateDefinition? current = null;
        foreach (var part in parts)
        {
            if (!map.TryGetValue(part, out current)) return null;
            map = current.States;
        }
        return current;
    }

    private static SubtreeEntry EnterSubtree(StateDefinition node)
    {
        var entryEffects = new List<string>(node.Entry);

        if (!node.IsCompound && !node.IsParallel)
        {
            return new SubtreeEntry(null, entryEffects);
        }

        if (node.IsCompound)
        {
            if (string.IsNullOrEmpty(node.Initial) || !node.States.TryGetValue(node.Initial, out var child))
            {
                return new SubtreeEntry(null, entryEffects);
            }
            var enteredChild = EnterSubtree(child);
            entryEffects.AddRange(enteredChild.EntryEffects);
            var val = enteredChild.SubValue == null
                ? StateValue.Of(child.Id)
                : StateValue.Of(new Dictionary<string, StateValue> { [child.Id] = enteredChild.SubValue });
            return new SubtreeEntry(val, entryEffects);
        }

        // PARALLEL
        var parallelMap = new Dictionary<string, StateValue>(StringComparer.Ordinal);
        foreach (var kvp in node.States)
        {
            var enteredRegion = EnterSubtree(kvp.Value);
            entryEffects.AddRange(enteredRegion.EntryEffects);
            parallelMap[kvp.Key] = enteredRegion.SubValue ?? StateValue.Of(kvp.Key);
        }
        return new SubtreeEntry(StateValue.Of(parallelMap), entryEffects);
    }

    public static InitialResolution ResolveInitialState(MachineDefinition machine)
    {
        if (string.Equals(machine.Type, "parallel", StringComparison.OrdinalIgnoreCase))
        {
            var rootMap = new Dictionary<string, StateValue>(StringComparer.Ordinal);
            var effects = new List<string>();
            foreach (var kvp in machine.States)
            {
                if (kvp.Key == "error") continue;
                var entered = EnterSubtree(kvp.Value);
                effects.AddRange(entered.EntryEffects);
                rootMap[kvp.Key] = entered.SubValue ?? StateValue.Of(kvp.Key);
            }
            return new InitialResolution(StateValue.Of(rootMap), effects);
        }

        var initialNode = machine.States[machine.Initial];
        var enteredRoot = EnterSubtree(initialNode);
        var stateValue = enteredRoot.SubValue == null
            ? StateValue.Of(initialNode.Id)
            : StateValue.Of(new Dictionary<string, StateValue> { [initialNode.Id] = enteredRoot.SubValue });

        return new InitialResolution(stateValue, enteredRoot.EntryEffects);
    }

    public static IReadOnlyList<string> GetActiveLeafPaths(MachineDefinition machine, StateValue stateValue)
    {
        return GetActiveLeafPathsInternal(machine, stateValue, string.Empty);
    }

    private static List<string> GetActiveLeafPathsInternal(MachineDefinition machine, StateValue stateValue, string parentPath)
    {
        if (!stateValue.IsCompound)
        {
            var leaf = stateValue.AtomicValue!;
            return new List<string> { string.IsNullOrEmpty(parentPath) ? leaf : $"{parentPath}.{leaf}" };
        }

        var leaves = new List<string>();
        foreach (var kvp in stateValue.CompoundValue!)
        {
            var key = kvp.Key;
            var childVal = kvp.Value;
            var currentPath = string.IsNullOrEmpty(parentPath) ? key : $"{parentPath}.{key}";
            var node = GetNodeByPath(machine, currentPath);

            if (node != null && node.IsParallel && childVal.IsCompound)
            {
                foreach (var reg in childVal.CompoundValue!)
                {
                    var regionPath = $"{currentPath}.{reg.Key}";
                    var regVal = reg.Value;
                    var regNode = GetNodeByPath(machine, regionPath);
                    if (regNode != null && !regNode.IsCompound && !regNode.IsParallel)
                    {
                        leaves.Add(regionPath);
                    }
                    else if (!regVal.IsCompound)
                    {
                        leaves.Add($"{regionPath}.{regVal.AtomicValue}");
                    }
                    else
                    {
                        leaves.AddRange(GetActiveLeafPathsInternal(machine, regVal, regionPath));
                    }
                }
            }
            else
            {
                leaves.AddRange(GetActiveLeafPathsInternal(machine, childVal, currentPath));
            }
        }
        return leaves;
    }

    public static IReadOnlyList<MatchedTransition> ResolveTransitionsForEvent(MachineDefinition machine, StateValue stateValue, string eventName)
    {
        if (!stateValue.IsCompound)
        {
            if (machine.States.TryGetValue(stateValue.AtomicValue!, out var rootChild))
            {
                return SearchInSubtree(machine, rootChild, null, eventName, rootChild.Id);
            }
            return Array.Empty<MatchedTransition>();
        }

        var results = new List<MatchedTransition>();
        foreach (var kvp in stateValue.CompoundValue!)
        {
            if (!machine.States.TryGetValue(kvp.Key, out var rootChild)) continue;
            var normalized = (!rootChild.IsCompound && !rootChild.IsParallel) ? null : kvp.Value;
            results.AddRange(SearchInSubtree(machine, rootChild, normalized, eventName, rootChild.Id));
        }
        return results;
    }

    private static List<MatchedTransition> SearchInSubtree(
        MachineDefinition machine,
        StateDefinition node,
        StateValue? subVal,
        string eventName,
        string currentPath)
    {
        if (!node.IsCompound && !node.IsParallel)
        {
            if (node.On.TryGetValue(eventName, out var list) && list.Count > 0)
            {
                return new List<MatchedTransition> { new(node, list[0], currentPath) };
            }
            return new List<MatchedTransition>();
        }

        if (node.IsCompound)
        {
            if (subVal != null && !subVal.IsCompound)
            {
                if (node.States.TryGetValue(subVal.AtomicValue!, out var child))
                {
                    var childMatches = SearchInSubtree(machine, child, null, eventName, $"{currentPath}.{child.Id}");
                    if (childMatches.Count > 0) return childMatches;
                }
            }
            else if (subVal != null && subVal.IsCompound)
            {
                foreach (var kvp in subVal.CompoundValue!)
                {
                    if (node.States.TryGetValue(kvp.Key, out var child))
                    {
                        var childMatches = SearchInSubtree(machine, child, kvp.Value, eventName, $"{currentPath}.{child.Id}");
                        if (childMatches.Count > 0) return childMatches;
                    }
                }
            }

            // Bubble up to this compound state!
            if (node.On.TryGetValue(eventName, out var selfList) && selfList.Count > 0)
            {
                return new List<MatchedTransition> { new(node, selfList[0], currentPath) };
            }
            return new List<MatchedTransition>();
        }

        // PARALLEL
        var regionMatches = new List<MatchedTransition>();
        var regionMap = (subVal != null && subVal.IsCompound) ? subVal.CompoundValue! : new Dictionary<string, StateValue>();

        foreach (var kvp in node.States)
        {
            var regionNode = kvp.Value;
            regionMap.TryGetValue(kvp.Key, out var rVal);
            var normalized = (!regionNode.IsCompound && !regionNode.IsParallel) ? null : rVal;
            regionMatches.AddRange(SearchInSubtree(machine, regionNode, normalized, eventName, $"{currentPath}.{regionNode.Id}"));
        }

        if (regionMatches.Count > 0) return regionMatches;

        // Bubble to parallel node
        if (node.On.TryGetValue(eventName, out var parList) && parList.Count > 0)
        {
            return new List<MatchedTransition> { new(node, parList[0], currentPath) };
        }
        return new List<MatchedTransition>();
    }

    public static string ResolveTargetStatePath(MachineDefinition machine, string sourcePath, string targetRef)
    {
        if (string.IsNullOrEmpty(targetRef)) return sourcePath;
        if (targetRef.StartsWith("#")) targetRef = targetRef.Substring(1);

        // Check if root contains it directly
        if (machine.States.ContainsKey(targetRef)) return targetRef;

        // Check relative from source parent
        var parts = sourcePath.Split('.');
        for (int i = parts.Length - 1; i >= 0; i--)
        {
            var prefix = string.Join(".", parts.Take(i));
            var candidate = string.IsNullOrEmpty(prefix) ? targetRef : $"{prefix}.{targetRef}";
            if (GetNodeByPath(machine, candidate) != null) return candidate;
        }

        // Search anywhere in machine
        var found = FindPathRecursive(machine.States, targetRef, "");
        if (found != null) return found;

        return targetRef;
    }

    private static string? FindPathRecursive(Dictionary<string, StateDefinition> states, string targetRef, string prefix)
    {
        foreach (var kvp in states)
        {
            var currentPath = string.IsNullOrEmpty(prefix) ? kvp.Key : $"{prefix}.{kvp.Key}";
            if (kvp.Key == targetRef || currentPath == targetRef) return currentPath;
            if (kvp.Value.States.Count > 0)
            {
                var childFound = FindPathRecursive(kvp.Value.States, targetRef, currentPath);
                if (childFound != null) return childFound;
            }
        }
        return null;
    }

    public static AppliedTransition ApplyTargetTransition(
        MachineDefinition machine,
        StateValue currentStateValue,
        string sourceStatePath,
        string targetRef)
    {
        var targetPath = ResolveTargetStatePath(machine, sourceStatePath, targetRef);
        var targetNode = GetNodeByPath(machine, targetPath);
        if (targetNode == null)
        {
            throw new InvalidOperationException($"Cannot resolve target state '{targetRef}' from '{sourceStatePath}' in machine '{machine.Id}'.");
        }

        var srcParts = sourceStatePath.Split('.');
        var tgtParts = targetPath.Split('.');

        int commonLen = 0;
        int maxCommon = Math.Min(srcParts.Length, tgtParts.Length) - 1;
        while (commonLen < maxCommon && srcParts[commonLen] == tgtParts[commonLen])
        {
            commonLen++;
        }

        var lcaParts = tgtParts.Take(commonLen).ToArray();
        var exitingRootPath = srcParts.Length > commonLen
            ? string.Join(".", srcParts.Take(commonLen + 1))
            : sourceStatePath;

        var exitEffects = CollectExitEffects(machine, currentStateValue, exitingRootPath);

        var entryEffects = new List<string>();
        for (int i = commonLen; i < tgtParts.Length - 1; i++)
        {
            var ancestorPath = string.Join(".", tgtParts.Take(i + 1));
            var ancestorNode = GetNodeByPath(machine, ancestorPath);
            if (ancestorNode != null) entryEffects.AddRange(ancestorNode.Entry);
        }

        var enteredTarget = EnterSubtree(targetNode);
        entryEffects.AddRange(enteredTarget.EntryEffects);

        var builtBranch = enteredTarget.SubValue == null
            ? StateValue.Of(targetNode.Id)
            : StateValue.Of(new Dictionary<string, StateValue> { [targetNode.Id] = enteredTarget.SubValue });

        for (int i = tgtParts.Length - 2; i >= commonLen; i--)
        {
            var ancestorKey = tgtParts[i];
            var ancestorPath = string.Join(".", tgtParts.Take(i + 1));
            var ancestorNode = GetNodeByPath(machine, ancestorPath);

            if (ancestorNode != null && ancestorNode.IsParallel)
            {
                var existingRegions = new Dictionary<string, StateValue>(
                    ExtractSubStateMap(currentStateValue, ancestorPath),
                    StringComparer.Ordinal
                );
                var regionKey = tgtParts[i + 1];
                var regionVal = (builtBranch.IsCompound && builtBranch.CompoundValue!.ContainsKey(regionKey))
                    ? builtBranch.CompoundValue[regionKey]
                    : builtBranch;
                existingRegions[regionKey] = regionVal;
                builtBranch = StateValue.Of(new Dictionary<string, StateValue> { [ancestorKey] = StateValue.Of(existingRegions) });
            }
            else
            {
                builtBranch = StateValue.Of(new Dictionary<string, StateValue> { [ancestorKey] = builtBranch });
            }
        }

        if (lcaParts.Length == 0)
        {
            if (string.Equals(machine.Type, "parallel", StringComparison.OrdinalIgnoreCase) && currentStateValue.IsCompound)
            {
                var topRegionKey = tgtParts[0];
                var regionVal = (builtBranch.IsCompound && builtBranch.CompoundValue!.ContainsKey(topRegionKey))
                    ? builtBranch.CompoundValue[topRegionKey]
                    : builtBranch;
                var nextRoot = new Dictionary<string, StateValue>(currentStateValue.CompoundValue!, StringComparer.Ordinal);
                nextRoot[topRegionKey] = regionVal;
                return new AppliedTransition(targetPath, StateValue.Of(nextRoot), exitEffects, entryEffects);
            }
            return new AppliedTransition(targetPath, builtBranch, exitEffects, entryEffects);
        }

        var nextStateValue = ReplaceAtLca(machine, currentStateValue, lcaParts, 0, builtBranch);
        return new AppliedTransition(targetPath, nextStateValue, exitEffects, entryEffects);
    }

    private static List<string> CollectExitEffects(MachineDefinition machine, StateValue stateValue, string subtreePrefix)
    {
        var leaves = GetActiveLeafPaths(machine, stateValue);
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var exitEffects = new List<string>();

        foreach (var leafPath in leaves)
        {
            if (!string.IsNullOrEmpty(subtreePrefix) && !leafPath.Equals(subtreePrefix) && !leafPath.StartsWith($"{subtreePrefix}."))
            {
                continue;
            }
            var segments = leafPath.Split('.');
            for (int len = segments.Length; len >= 1; len--)
            {
                var candidatePath = string.Join(".", segments.Take(len));
                if (!string.IsNullOrEmpty(subtreePrefix) && !candidatePath.Equals(subtreePrefix) && !candidatePath.StartsWith($"{subtreePrefix}."))
                {
                    break;
                }
                if (visited.Add(candidatePath))
                {
                    var node = GetNodeByPath(machine, candidatePath);
                    if (node != null) exitEffects.AddRange(node.Exit);
                }
            }
        }
        return exitEffects;
    }

    private static IReadOnlyDictionary<string, StateValue> ExtractSubStateMap(StateValue rootVal, string dotPath)
    {
        var parts = dotPath.Split('.');
        StateValue cursor = rootVal;
        foreach (var part in parts)
        {
            if (string.IsNullOrEmpty(part)) continue;
            if (!cursor.IsCompound || !cursor.CompoundValue!.TryGetValue(part, out var child))
            {
                return new Dictionary<string, StateValue>();
            }
            cursor = child;
        }
        return cursor.IsCompound ? cursor.CompoundValue! : new Dictionary<string, StateValue>();
    }

    private static StateValue ReplaceAtLca(
        MachineDefinition machine,
        StateValue current,
        string[] lcaParts,
        int depth,
        StateValue replacementBranch)
    {
        var key = lcaParts[depth];
        var currentPath = string.Join(".", lcaParts.Take(depth + 1));
        var node = GetNodeByPath(machine, currentPath);

        if (depth == lcaParts.Length - 1)
        {
            if (node != null && node.IsParallel && current.IsCompound)
            {
                current.CompoundValue!.TryGetValue(key, out var existingParallel);
                var regions = new Dictionary<string, StateValue>(
                    (existingParallel != null && existingParallel.IsCompound) ? existingParallel.CompoundValue! : new Dictionary<string, StateValue>(),
                    StringComparer.Ordinal
                );
                if (replacementBranch.IsCompound && replacementBranch.CompoundValue!.Count > 0)
                {
                    var repEntry = replacementBranch.CompoundValue.First();
                    regions[repEntry.Key] = repEntry.Value;
                    var updatedOuter = new Dictionary<string, StateValue>(current.CompoundValue, StringComparer.Ordinal);
                    updatedOuter[key] = StateValue.Of(regions);
                    return StateValue.Of(updatedOuter);
                }
            }

            if (current.IsCompound)
            {
                var updated = new Dictionary<string, StateValue>(current.CompoundValue!, StringComparer.Ordinal);
                updated[key] = replacementBranch;
                return StateValue.Of(updated);
            }
            return StateValue.Of(new Dictionary<string, StateValue> { [key] = replacementBranch });
        }

        var childCurrent = (current.IsCompound && current.CompoundValue!.TryGetValue(key, out var cVal))
            ? cVal
            : StateValue.Of("");
        var updatedChild = ReplaceAtLca(machine, childCurrent, lcaParts, depth + 1, replacementBranch);

        if (current.IsCompound)
        {
            var updated = new Dictionary<string, StateValue>(current.CompoundValue!, StringComparer.Ordinal);
            updated[key] = updatedChild;
            return StateValue.Of(updated);
        }
        return StateValue.Of(new Dictionary<string, StateValue> { [key] = updatedChild });
    }

    public static MatchedTransition? FindPendingOnDone(MachineDefinition machine, StateValue stateValue)
    {
        var leaves = GetActiveLeafPaths(machine, stateValue);
        var candidateContainers = new HashSet<string>(StringComparer.Ordinal);

        foreach (var leaf in leaves)
        {
            var parts = leaf.Split('.');
            for (int i = parts.Length - 1; i >= 1; i--)
            {
                candidateContainers.Add(string.Join(".", parts.Take(i)));
            }
        }

        var sortedContainers = candidateContainers.OrderByDescending(c => c.Split('.').Length).ToList();

        foreach (var containerPath in sortedContainers)
        {
            var containerNode = GetNodeByPath(machine, containerPath);
            if (containerNode == null || containerNode.OnDone == null || containerNode.OnDone.Count == 0) continue;

            if (containerNode.IsCompound)
            {
                var childLeaves = leaves.Where(l => l.StartsWith($"{containerPath}.")).ToList();
                if (childLeaves.Count == 1)
                {
                    var leafNode = GetNodeByPath(machine, childLeaves[0]);
                    if (leafNode != null && leafNode.IsFinal)
                    {
                        return new MatchedTransition(containerNode, containerNode.OnDone[0], containerPath);
                    }
                }
            }
            else if (containerNode.IsParallel)
            {
                bool allRegionsDone = containerNode.States.Values.All(region =>
                {
                    var regionPath = $"{containerPath}.{region.Id}";
                    var regionLeaves = leaves.Where(l => l.Equals(regionPath) || l.StartsWith($"{regionPath}.")).ToList();
                    return regionLeaves.Count > 0 && regionLeaves.All(leafPath => IsBranchFinalAt(machine, regionPath, leafPath));
                });

                if (allRegionsDone)
                {
                    return new MatchedTransition(containerNode, containerNode.OnDone[0], containerPath);
                }
            }
        }

        return null;
    }

    private static bool IsBranchFinalAt(MachineDefinition machine, string regionPath, string leafPath)
    {
        var leafNode = GetNodeByPath(machine, leafPath);
        if (leafNode == null || !leafNode.IsFinal) return false;
        var regionNode = GetNodeByPath(machine, regionPath);
        if (regionNode == null) return false;
        if (regionNode.IsFinal) return true;
        if (regionNode.IsCompound)
        {
            return leafPath.Equals($"{regionPath}.{leafNode.Id}");
        }
        return false;
    }

    public static TransactionStatus ResolveSettledTransactionStatus(MachineDefinition machine, StateValue stateValue, bool wasCompensated)
    {
        if (wasCompensated) return TransactionStatus.COMPENSATED;
        if (!stateValue.IsCompound && stateValue.AtomicValue == "error" && machine.States.ContainsKey("error"))
        {
            return TransactionStatus.FAILED;
        }

        var leaves = GetActiveLeafPaths(machine, stateValue);
        if (leaves.Count > 0 && leaves.All(l =>
        {
            var n = GetNodeByPath(machine, l);
            return n != null && n.IsFinal;
        }))
        {
            return TransactionStatus.COMPLETED;
        }

        return TransactionStatus.IDLE;
    }

    public static IReadOnlyList<string> GetAvailableEvents(MachineDefinition machine, StateValue stateValue)
    {
        var leaves = GetActiveLeafPaths(machine, stateValue);
        var events = new HashSet<string>(StringComparer.Ordinal);

        foreach (var leafPath in leaves)
        {
            var parts = leafPath.Split('.');
            for (int len = parts.Length; len >= 1; len--)
            {
                var candidatePath = string.Join(".", parts.Take(len));
                var node = GetNodeByPath(machine, candidatePath);
                if (node == null || node.IsFinal) continue;
                foreach (var evt in node.On.Keys)
                {
                    events.Add(evt);
                }
            }
        }

        return events.ToList();
    }

    public static IReadOnlyList<string> GetTerminalStates(MachineDefinition machine)
    {
        var terminals = new List<string>();
        WalkTerminals(machine.States, "", terminals);
        return terminals;
    }

    private static void WalkTerminals(Dictionary<string, StateDefinition> states, string prefix, List<string> list)
    {
        foreach (var kvp in states)
        {
            var currentPath = string.IsNullOrEmpty(prefix) ? kvp.Key : $"{prefix}.{kvp.Key}";
            if (kvp.Value.IsFinal || kvp.Key == "error")
            {
                list.Add(currentPath);
            }
            if (kvp.Value.States.Count > 0)
            {
                WalkTerminals(kvp.Value.States, currentPath, list);
            }
        }
    }
}
