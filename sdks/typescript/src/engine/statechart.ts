import {
  resolveTargetStatePath,
  type MachineDefinition,
  type StateNodeIR,
  type TransitionEdgeIR,
} from "../definition/ir.js";
import type { StateValue, TerminalStateDescriptor, TransactionStatus } from "../types.js";

export interface MatchedTransition {
  sourceNode: StateNodeIR;
  edge: TransitionEdgeIR;
}

export function getNodeByPath(
  machine: MachineDefinition,
  dotPath: string
): StateNodeIR | undefined {
  const parts = dotPath.split(".").filter(Boolean);
  let map: Record<string, StateNodeIR> = machine.states;
  let current: StateNodeIR | undefined;
  for (const part of parts) {
    current = map[part];
    if (!current) return undefined;
    map = current.states;
  }
  return current;
}

/**
 * Enters a `StateNodeIR` top-down, resolving nested `compound` initial states and
 * `parallel` regions, returning its `StateValue` contribution and ordered `entry` effects.
 */
function enterSubtree(node: StateNodeIR): {
  subValue: StateValue | null; // null when node is a leaf whose parent holds its key
  entryEffects: string[];
} {
  const entryEffects = [...node.entry];

  if (node.type === "atomic" || node.type === "final") {
    return { subValue: null, entryEffects };
  }

  if (node.type === "compound") {
    const child = node.states[node.initial!];
    if (!child) {
      return { subValue: null, entryEffects };
    }
    const enteredChild = enterSubtree(child);
    entryEffects.push(...enteredChild.entryEffects);
    const val: StateValue =
      enteredChild.subValue === null ? child.key : { [child.key]: enteredChild.subValue };
    return { subValue: val, entryEffects };
  }

  // Parallel state: enter all child regions in declaration order
  const parallelMap: Record<string, StateValue> = {};
  for (const [regionKey, regionNode] of Object.entries(node.states)) {
    const enteredRegion = enterSubtree(regionNode);
    entryEffects.push(...enteredRegion.entryEffects);
    parallelMap[regionKey] =
      enteredRegion.subValue === null ? regionKey : enteredRegion.subValue;
  }
  return { subValue: parallelMap, entryEffects };
}

export function resolveInitialState(machine: MachineDefinition): {
  stateValue: StateValue;
  entryEffects: string[];
} {
  if (machine.type === "parallel") {
    const rootMap: Record<string, StateValue> = {};
    const effects: string[] = [];
    for (const [regionKey, regionNode] of Object.entries(machine.states)) {
      if (regionNode.isImplicitError) continue;
      const entered = enterSubtree(regionNode);
      effects.push(...entered.entryEffects);
      rootMap[regionKey] = entered.subValue === null ? regionKey : entered.subValue;
    }
    return { stateValue: rootMap, entryEffects: effects };
  }

  const initialNode = machine.states[machine.initial!]!;
  const entered = enterSubtree(initialNode);
  const stateValue: StateValue =
    entered.subValue === null ? initialNode.key : { [initialNode.key]: entered.subValue };
  return { stateValue, entryEffects: entered.entryEffects };
}

/**
 * Collects all currently active state paths (from shallowest to deepest per branch)
 * represented by `stateValue`.
 */
export function getActiveLeafPaths(
  machine: MachineDefinition,
  stateValue: StateValue,
  parentPath = ""
): string[] {
  if (typeof stateValue === "string") {
    const full = parentPath ? `${parentPath}.${stateValue}` : stateValue;
    return [full];
  }

  const leaves: string[] = [];
  for (const [key, childVal] of Object.entries(stateValue)) {
    const currentPath = parentPath ? `${parentPath}.${key}` : key;
    const node = getNodeByPath(machine, currentPath);
    if (
      node &&
      node.type === "parallel" &&
      typeof childVal === "object" &&
      childVal !== null
    ) {
      for (const [regionKey, regionVal] of Object.entries(childVal)) {
        const regionPath = `${currentPath}.${regionKey}`;
        const regionNode = getNodeByPath(machine, regionPath);
        if (regionNode && (regionNode.type === "atomic" || regionNode.type === "final")) {
          leaves.push(regionPath);
        } else if (typeof regionVal === "string") {
          leaves.push(`${regionPath}.${regionVal}`);
        } else {
          leaves.push(...getActiveLeafPaths(machine, regionVal, regionPath));
        }
      }
    } else {
      leaves.push(...getActiveLeafPaths(machine, childVal, currentPath));
    }
  }
  return leaves;
}

/**
 * Collects `exit` effects in strict bottom-up order for all active states inside `subtreePrefix`.
 */
function collectBottomUpExitEffects(
  machine: MachineDefinition,
  stateValue: StateValue,
  subtreePrefix: string // "" means exit entire root active tree
): string[] {
  const leaves = getActiveLeafPaths(machine, stateValue);
  const visited = new Set<string>();
  const exitEffects: string[] = [];

  for (const leafPath of leaves) {
    if (
      subtreePrefix &&
      leafPath !== subtreePrefix &&
      !leafPath.startsWith(`${subtreePrefix}.`)
    ) {
      continue;
    }

    const segments = leafPath.split(".");
    for (let len = segments.length; len >= 1; len--) {
      const candidatePath = segments.slice(0, len).join(".");
      if (
        subtreePrefix &&
        candidatePath !== subtreePrefix &&
        !candidatePath.startsWith(`${subtreePrefix}.`)
      ) {
        break;
      }
      if (!visited.has(candidatePath)) {
        visited.add(candidatePath);
        const node = getNodeByPath(machine, candidatePath);
        if (node) {
          exitEffects.push(...node.exit);
        }
      }
    }
  }

  return exitEffects;
}

/**
 * Resolves matching transitions for `event` using XState deepest-first bubbling
 * and orthogonal `parallel` region dispatch.
 */
export function resolveTransitionsForEvent(
  machine: MachineDefinition,
  stateValue: StateValue,
  event: string
): MatchedTransition[] {
  const searchInSubtree = (node: StateNodeIR, subVal: StateValue | null): MatchedTransition[] => {
    if (node.type === "atomic" || node.type === "final") {
      const direct = node.on[event];
      return direct ? [{ sourceNode: node, edge: direct }] : [];
    }

    if (node.type === "compound") {
      if (typeof subVal === "string") {
        const child = node.states[subVal];
        if (child) {
          const childMatches = searchInSubtree(child, null);
          if (childMatches.length > 0) return childMatches;
        }
      } else if (subVal && typeof subVal === "object") {
        for (const [childKey, grandVal] of Object.entries(subVal)) {
          const child = node.states[childKey];
          if (child) {
            const childMatches = searchInSubtree(child, grandVal);
            if (childMatches.length > 0) return childMatches;
          }
        }
      }
      const selfMatch = node.on[event];
      return selfMatch ? [{ sourceNode: node, edge: selfMatch }] : [];
    }

    // Parallel state: evaluate all regions in declaration order
    const regionMatches: MatchedTransition[] = [];
    const regionMap = (subVal && typeof subVal === "object" ? subVal : {}) as Record<
      string,
      StateValue
    >;
    for (const [regionKey, regionNode] of Object.entries(node.states)) {
      const rVal = regionMap[regionKey];
      const normalizedChildVal =
        regionNode.type === "atomic" || regionNode.type === "final" ? null : (rVal ?? null);
      const matches = searchInSubtree(regionNode, normalizedChildVal);
      regionMatches.push(...matches);
    }
    if (regionMatches.length > 0) {
      return regionMatches;
    }

    const parallelBubble = node.on[event];
    return parallelBubble ? [{ sourceNode: node, edge: parallelBubble }] : [];
  };

  if (typeof stateValue === "string") {
    const rootChild = machine.states[stateValue];
    return rootChild ? searchInSubtree(rootChild, null) : [];
  }

  const results: MatchedTransition[] = [];
  for (const [topKey, topSubVal] of Object.entries(stateValue)) {
    const rootChild = machine.states[topKey];
    if (!rootChild) continue;
    const normalized =
      rootChild.type === "atomic" || rootChild.type === "final" ? null : topSubVal;
    results.push(...searchInSubtree(rootChild, normalized));
  }
  return results;
}

/**
 * Replaces the active state within `lcaPath` so the machine transitions cleanly
 * to `targetStatePath`, returning `{ nextStateValue, exitEffects, entryEffects }`.
 */
export function applyTargetTransition(
  machine: MachineDefinition,
  currentStateValue: StateValue,
  sourceStatePath: string,
  targetRef: string
): {
  targetPath: string;
  nextStateValue: StateValue;
  exitEffects: string[];
  entryEffects: string[];
} {
  const targetPath = resolveTargetStatePath(machine, sourceStatePath, targetRef);
  if (!targetPath) {
    throw new Error(
      `Cannot resolve target '${targetRef}' from state '${sourceStatePath}' in machine '${machine.id}'`
    );
  }

  const srcParts = sourceStatePath.split(".").filter(Boolean);
  const tgtParts = targetPath.split(".").filter(Boolean);

  // Compute Lowest Common Ancestor path segments (strict ancestor of both source & target,
  // so self-transitions exit and re-enter the target node itself per XState external transition rules)
  let commonLen = 0;
  const maxCommon = Math.min(srcParts.length, tgtParts.length) - 1;
  while (commonLen < maxCommon && srcParts[commonLen] === tgtParts[commonLen]) {
    commonLen++;
  }

  const lcaParts = tgtParts.slice(0, commonLen);
  const exitingRootPath =
    srcParts.length > commonLen ? srcParts.slice(0, commonLen + 1).join(".") : sourceStatePath;

  const exitEffects = collectBottomUpExitEffects(machine, currentStateValue, exitingRootPath);

  // Build entry effects from commonLen down to targetPath + target's initial descendants
  const entryEffects: string[] = [];
  for (let i = commonLen; i < tgtParts.length - 1; i++) {
    const ancestorPath = tgtParts.slice(0, i + 1).join(".");
    const ancestorNode = getNodeByPath(machine, ancestorPath);
    if (ancestorNode) {
      entryEffects.push(...ancestorNode.entry);
    }
  }

  const targetNode = getNodeByPath(machine, targetPath)!;
  const enteredTarget = enterSubtree(targetNode);
  entryEffects.push(...enteredTarget.entryEffects);

  // Build nested StateValue for tgtParts[commonLen..]
  let builtBranch: StateValue =
    enteredTarget.subValue === null
      ? targetNode.key
      : { [targetNode.key]: enteredTarget.subValue };

  for (let i = tgtParts.length - 2; i >= commonLen; i--) {
    const ancestorKey = tgtParts[i]!;
    const ancestorPath = tgtParts.slice(0, i + 1).join(".");
    const ancestorNode = getNodeByPath(machine, ancestorPath)!;

    if (ancestorNode.type === "parallel") {
      // Preserve sibling orthogonal regions inside this parallel node!
      const existingParallelObj = extractSubStateObject(currentStateValue, ancestorPath);
      const regionKey = tgtParts[i + 1]!;
      const regionVal =
        typeof builtBranch === "object" && regionKey in builtBranch
          ? builtBranch[regionKey]!
          : builtBranch;
      builtBranch = {
        [ancestorKey]: {
          ...existingParallelObj,
          [regionKey]: regionVal,
        },
      };
    } else {
      builtBranch = { [ancestorKey]: builtBranch };
    }
  }

  if (lcaParts.length === 0) {
    if (machine.type === "parallel" && typeof currentStateValue === "object") {
      const topRegionKey = tgtParts[0]!;
      const regionVal =
        typeof builtBranch === "object" && topRegionKey in builtBranch
          ? builtBranch[topRegionKey]!
          : builtBranch;
      return {
        targetPath,
        nextStateValue: { ...currentStateValue, [topRegionKey]: regionVal },
        exitEffects,
        entryEffects,
      };
    }
    return {
      targetPath,
      nextStateValue: builtBranch,
      exitEffects,
      entryEffects,
    };
  }

  const nextStateValue = replaceAtLca(
    machine,
    currentStateValue,
    lcaParts,
    0,
    builtBranch
  );

  return {
    targetPath,
    nextStateValue,
    exitEffects,
    entryEffects,
  };
}

function extractSubStateObject(
  rootVal: StateValue,
  dotPath: string
): Record<string, StateValue> {
  const parts = dotPath.split(".").filter(Boolean);
  let cursor: unknown = rootVal;
  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || !(part in cursor)) {
      return {};
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "object" && cursor !== null
    ? ({ ...(cursor as Record<string, StateValue>) } as Record<string, StateValue>)
    : {};
}

function replaceAtLca(
  machine: MachineDefinition,
  current: StateValue,
  lcaParts: string[],
  depth: number,
  replacementBranch: StateValue
): StateValue {
  const key = lcaParts[depth]!;
  const currentPath = lcaParts.slice(0, depth + 1).join(".");
  const node = getNodeByPath(machine, currentPath);

  if (depth === lcaParts.length - 1) {
    if (node?.type === "parallel" && typeof current === "object" && current !== null) {
      const parallelRegions =
        typeof current[key] === "object" && current[key] !== null
          ? (current[key] as Record<string, StateValue>)
          : {};
      if (typeof replacementBranch === "object" && replacementBranch !== null) {
        const [repRegionKey, repRegionVal] = Object.entries(replacementBranch)[0]!;
        return {
          ...current,
          [key]: {
            ...parallelRegions,
            [repRegionKey]: repRegionVal,
          },
        };
      }
    }

    if (typeof current === "object" && current !== null) {
      return {
        ...current,
        [key]: replacementBranch,
      };
    }
    return { [key]: replacementBranch };
  }

  const childCurrent =
    typeof current === "object" && current !== null && key in current ? current[key]! : "";
  const updatedChild = replaceAtLca(
    machine,
    childCurrent,
    lcaParts,
    depth + 1,
    replacementBranch
  );

  if (typeof current === "object" && current !== null) {
    return {
      ...current,
      [key]: updatedChild,
    };
  }
  return { [key]: updatedChild };
}

/**
 * Checks if any active `compound` or `parallel` state has completed (`type: final` in active child
 * or ALL orthogonal regions) and possesses an `onDone` transition ready to fire.
 * Evaluates deepest completed containers first.
 */
export function findPendingOnDone(
  machine: MachineDefinition,
  stateValue: StateValue
): MatchedTransition | null {
  const leaves = getActiveLeafPaths(machine, stateValue);

  // Collect all active container ancestors sorted deepest-first
  const candidateContainers = new Set<string>();
  for (const leaf of leaves) {
    const parts = leaf.split(".");
    for (let i = parts.length - 1; i >= 1; i--) {
      candidateContainers.add(parts.slice(0, i).join("."));
    }
  }

  const sortedContainers = [...candidateContainers].sort(
    (a, b) => b.split(".").length - a.split(".").length
  );

  for (const containerPath of sortedContainers) {
    const containerNode = getNodeByPath(machine, containerPath);
    if (!containerNode || !containerNode.onDone) continue;

    if (containerNode.type === "compound") {
      const childLeaves = leaves.filter((l) => l.startsWith(`${containerPath}.`));
      if (
        childLeaves.length === 1 &&
        getNodeByPath(machine, childLeaves[0]!)?.type === "final"
      ) {
        return { sourceNode: containerNode, edge: containerNode.onDone };
      }
    } else if (containerNode.type === "parallel") {
      const regionNodes = Object.values(containerNode.states);
      const allRegionsDone = regionNodes.every((region) => {
        const regionLeaves = leaves.filter(
          (l) => l === region.path || l.startsWith(`${region.path}.`)
        );
        return (
          regionLeaves.length > 0 &&
          regionLeaves.every((leafPath) => isBranchFinalAt(machine, region.path, leafPath))
        );
      });
      if (allRegionsDone) {
        return { sourceNode: containerNode, edge: containerNode.onDone };
      }
    }
  }

  return null;
}

function isBranchFinalAt(
  machine: MachineDefinition,
  regionPath: string,
  leafPath: string
): boolean {
  const leafNode = getNodeByPath(machine, leafPath);
  if (!leafNode || leafNode.type !== "final") return false;
  // Ensure leaf is the direct child of region (or region itself is final)
  const regionNode = getNodeByPath(machine, regionPath);
  if (!regionNode) return false;
  if (regionNode.type === "final") return true;
  if (regionNode.type === "compound") {
    return leafPath === `${regionPath}.${leafNode.key}`;
  }
  return false;
}

/**
 * Computes transaction lifecycle status (`IDLE`, `COMPLETED`, or `FAILED`) for a settled `StateValue`.
 */
export function resolveSettledTransactionStatus(
  machine: MachineDefinition,
  stateValue: StateValue,
  wasCompensated = false
): TransactionStatus {
  if (wasCompensated) {
    return "COMPENSATED";
  }

  if (stateValue === "error") {
    const errNode = machine.states.error;
    // If error state is final, mark FAILED; even if overridden with recovery transitions,
    // landing in 'error' without compensation marks FAILED unless user transitions out of it!
    if (errNode) {
      return "FAILED";
    }
  }

  const leaves = getActiveLeafPaths(machine, stateValue);
  if (leaves.length > 0 && leaves.every((l) => getNodeByPath(machine, l)?.type === "final")) {
    return "COMPLETED";
  }

  return "IDLE";
}

/**
 * Returns the ordered list of valid event names accepted from `stateValue`
 * (including active leaf transitions, parallel region transitions, and bubbled ancestor transitions).
 */
export function getAvailableEvents(
  machine: MachineDefinition,
  stateValue: StateValue
): string[] {
  const leaves = getActiveLeafPaths(machine, stateValue);
  const events = new Set<string>();

  for (const leafPath of leaves) {
    const parts = leafPath.split(".").filter(Boolean);
    // Walk deepest-first up to root ancestor so leaf events appear before bubbled parent events
    for (let len = parts.length; len >= 1; len--) {
      const candidatePath = parts.slice(0, len).join(".");
      const node = getNodeByPath(machine, candidatePath);
      if (!node || node.type === "final") continue;
      for (const evt of Object.keys(node.on)) {
        events.add(evt);
      }
    }
  }

  return [...events];
}

/**
 * Inspects a `MachineDefinition` and returns all terminal (`type: "final"`) and `error`
 * state descriptors, distinguishing top-level machine terminal states from region-local
 * `final` sub-states and flagging whether `error` is recoverable.
 */
export function getTerminalStates(machine: MachineDefinition): TerminalStateDescriptor[] {
  const descriptors: TerminalStateDescriptor[] = [];

  const walk = (node: StateNodeIR, depth: number) => {
    const isErrorNode = depth === 0 && node.key === "error";
    if (node.type === "final" || isErrorNode) {
      const recoveryEvents = Object.keys(node.on);
      descriptors.push({
        path: node.path,
        key: node.key,
        kind: isErrorNode ? "error" : "final",
        isTopLevel: depth === 0,
        isImplicitDefaultError: Boolean(node.isImplicitError),
        isRecoverableError: isErrorNode && node.type !== "final" && recoveryEvents.length > 0,
        recoveryEvents,
      });
    }
    for (const child of Object.values(node.states)) {
      walk(child, depth + 1);
    }
  };

  for (const root of Object.values(machine.states)) {
    walk(root, 0);
  }

  return descriptors;
}



