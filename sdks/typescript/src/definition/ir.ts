import { MachineValidationError } from "../errors.js";
import type { PartialTransitionPolicy } from "../types.js";

export type StateNodeType = "atomic" | "compound" | "parallel" | "final";

export interface TransitionEdgeIR {
  event: string;
  target?: string;
  transition?: string;
  compensate?: string;
  effects: string[];
  description?: string;
  policy: PartialTransitionPolicy;
}

export interface StateNodeIR {
  key: string;
  path: string; // dot-separated path from root states, e.g. "processing.payment.charging"
  type: StateNodeType;
  description?: string;
  initial?: string;
  entry: string[];
  exit: string[];
  on: Record<string, TransitionEdgeIR>;
  onDone?: TransitionEdgeIR;
  states: Record<string, StateNodeIR>;
  isImplicitError?: boolean;
}

export interface RegistryBindingIR {
  namespace?: string;
  strict: boolean;
}

export interface MachineHooksIR {
  onStart: string[];
  beforeTransition: string[];
  afterTransition: string[];
  onCompensate: string[];
  onComplete: string[];
  onTerminal: string[];
}

export function createEmptyMachineHooksIR(): MachineHooksIR {
  return {
    onStart: [],
    beforeTransition: [],
    afterTransition: [],
    onCompensate: [],
    onComplete: [],
    onTerminal: [],
  };
}

export interface MachineDefinition {
  dfsm: "1.0";
  id: string;
  version: string;
  description?: string;
  source: "yaml" | "builder";
  type: "compound" | "parallel";
  initial?: string;
  registry: RegistryBindingIR;
  defaults: PartialTransitionPolicy;
  hooks: MachineHooksIR;
  effects: string[];
  maxEffectChainDepth?: number;
  states: Record<string, StateNodeIR>;
  hasCustomErrorState: boolean;
}

/**
 * Resolves a handler name with optional machine registry namespace.
 * If handler already contains '.' and starts with namespace, or if namespace is unset, returns as-is;
 * otherwise prefixes with `<namespace>.<handler>`.
 */
export function qualifyHandlerName(handlerName: string, namespace?: string): string {
  if (!namespace) return handlerName;
  if (handlerName.startsWith(`${namespace}.`)) return handlerName;
  return `${namespace}.${handlerName}`;
}

/**
 * Resolves a target reference from a source state path (dot-separated, or "" for root)
 * to a canonical dot-separated state path in `machine.states`, or returns `null` if unresolvable.
 */
export function resolveTargetStatePath(
  machine: Pick<MachineDefinition, "id" | "states">,
  sourceStatePath: string,
  targetRef: string
): string | null {
  const lookupByDotPath = (dotPath: string): StateNodeIR | null => {
    const parts = dotPath.split(".").filter(Boolean);
    if (parts.length === 0) return null;
    let currentMap: Record<string, StateNodeIR> = machine.states;
    let found: StateNodeIR | null = null;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      const node = currentMap[seg];
      if (!node) return null;
      found = node;
      currentMap = node.states;
    }
    return found;
  };

  if (targetRef.startsWith("#")) {
    const stripped = targetRef.slice(1);
    if (stripped.startsWith(`${machine.id}.`)) {
      const rel = stripped.slice(machine.id.length + 1);
      return lookupByDotPath(rel)?.path ?? null;
    }
    return lookupByDotPath(stripped)?.path ?? null;
  }

  // Relative to source state's parent container first
  const sourceSegments = sourceStatePath ? sourceStatePath.split(".") : [];
  const parentSegments = sourceSegments.slice(0, -1);

  if (parentSegments.length > 0) {
    const siblingCandidate = [...parentSegments, targetRef].join(".");
    const foundSibling = lookupByDotPath(siblingCandidate);
    if (foundSibling) {
      return foundSibling.path;
    }
  }

  // Fallback to root-relative lookup (supports e.g. `target: error` from nested states)
  const foundRoot = lookupByDotPath(targetRef);
  return foundRoot?.path ?? null;
}

/**
 * Injects the implicit top-level `error` final state if missing and validates
 * the entire `MachineDefinition` state hierarchy and target references.
 */
export function finalizeAndValidateMachineIR(
  raw: Omit<MachineDefinition, "hasCustomErrorState" | "hooks" | "effects"> & {
    hooks?: Partial<MachineHooksIR>;
    effects?: string[];
  }
): MachineDefinition {
  const issues: string[] = [];

  if (!raw.id || !/^[a-zA-Z0-9_-]+$/.test(raw.id)) {
    issues.push(`Invalid machine id '${raw.id}'. Must match /^[a-zA-Z0-9_-]+$/.`);
  }

  if (
    raw.maxEffectChainDepth !== undefined &&
    (!Number.isInteger(raw.maxEffectChainDepth) || raw.maxEffectChainDepth < 1)
  ) {
    issues.push(
      `Invalid maxEffectChainDepth '${raw.maxEffectChainDepth}' in machine '${raw.id}'. Must be an integer >= 1.`
    );
  }

  const statesCopy: Record<string, StateNodeIR> = { ...raw.states };
  const hasCustomErrorState = Object.prototype.hasOwnProperty.call(statesCopy, "error");

  if (!hasCustomErrorState) {
    statesCopy.error = {
      key: "error",
      path: "error",
      type: "final",
      entry: [],
      exit: [],
      on: {},
      states: {},
      isImplicitError: true,
    };
  }

  const normalizedHooks: MachineHooksIR = {
    onStart: [...(raw.hooks?.onStart ?? [])],
    beforeTransition: [...(raw.hooks?.beforeTransition ?? [])],
    afterTransition: [...(raw.hooks?.afterTransition ?? [])],
    onCompensate: [...(raw.hooks?.onCompensate ?? [])],
    onComplete: [...(raw.hooks?.onComplete ?? [])],
    onTerminal: [...(raw.hooks?.onTerminal ?? [])],
  };

  const machine: MachineDefinition = {
    ...raw,
    hooks: normalizedHooks,
    effects: [...(raw.effects ?? [])],
    states: statesCopy,
    hasCustomErrorState,
  };

  const userDefinedStateKeys = Object.keys(raw.states);
  if (userDefinedStateKeys.length === 0) {
    issues.push(`Machine '${machine.id}' must define at least one state.`);
  }

  if (machine.type === "compound") {
    if (!machine.initial) {
      issues.push(`Root compound machine '${machine.id}' requires an 'initial' state.`);
    } else if (!machine.states[machine.initial]) {
      issues.push(
        `Root 'initial' state '${machine.initial}' does not exist in machine '${machine.id}' states.`
      );
    }
  } else if (machine.type === "parallel" && machine.initial) {
    issues.push(`Root parallel machine '${machine.id}' must not specify 'initial'.`);
  }

  const validateEdge = (sourcePath: string, label: string, edge: TransitionEdgeIR) => {
    if (edge.target) {
      const resolved = resolveTargetStatePath(machine, sourcePath, edge.target);
      if (!resolved) {
        issues.push(
          `Unresolvable target '${edge.target}' on ${label} in state '${sourcePath || "<root>"}'.`
        );
      }
    }
    if (edge.policy.onFail?.target) {
      const resolvedFallback = resolveTargetStatePath(
        machine,
        sourcePath,
        edge.policy.onFail.target
      );
      if (!resolvedFallback) {
        issues.push(
          `Unresolvable onFail.target '${edge.policy.onFail.target}' on ${label} in state '${sourcePath || "<root>"}'.`
        );
      }
    }
  };

  if (machine.defaults.onFail?.target) {
    const resolvedDefaultFallback = resolveTargetStatePath(
      machine,
      "",
      machine.defaults.onFail.target
    );
    if (!resolvedDefaultFallback) {
      issues.push(
        `Unresolvable defaults.onFail.target '${machine.defaults.onFail.target}' in machine '${machine.id}'.`
      );
    }
  }

  const validateNode = (node: StateNodeIR) => {
    const childKeys = Object.keys(node.states);

    if (node.type === "compound") {
      if (childKeys.length === 0) {
        issues.push(`Compound state '${node.path}' must define child 'states'.`);
      }
      if (!node.initial) {
        issues.push(`Compound state '${node.path}' requires an 'initial' child state.`);
      } else if (!node.states[node.initial]) {
        issues.push(
          `Compound state '${node.path}' initial '${node.initial}' does not exist among its child states (${childKeys.join(", ")}).`
        );
      }
    } else if (node.type === "parallel") {
      if (childKeys.length === 0) {
        issues.push(`Parallel state '${node.path}' must define child region 'states'.`);
      }
      if (node.initial) {
        issues.push(`Parallel state '${node.path}' must not define 'initial'.`);
      }
    } else if (node.type === "atomic") {
      if (childKeys.length > 0) {
        issues.push(`Atomic state '${node.path}' cannot contain child 'states'.`);
      }
      if (node.initial) {
        issues.push(`Atomic state '${node.path}' cannot define 'initial'.`);
      }
    } else if (node.type === "final") {
      if (childKeys.length > 0) {
        issues.push(`Final state '${node.path}' cannot contain child 'states'.`);
      }
      if (node.initial) {
        issues.push(`Final state '${node.path}' cannot define 'initial'.`);
      }
      if (Object.keys(node.on).length > 0) {
        issues.push(`Final state '${node.path}' cannot define outgoing 'on' transitions.`);
      }
    }

    for (const [event, edge] of Object.entries(node.on)) {
      validateEdge(node.path, `event '${event}'`, edge);
    }
    if (node.onDone) {
      validateEdge(node.path, "'onDone'", node.onDone);
    }

    for (const child of Object.values(node.states)) {
      validateNode(child);
    }
  };

  for (const state of Object.values(machine.states)) {
    validateNode(state);
  }

  if (issues.length > 0) {
    throw new MachineValidationError(
      `Invalid DFSM definition for '${raw.id || "<unknown>"}': ${issues.join(" | ")}`,
      issues
    );
  }

  return machine;
}

