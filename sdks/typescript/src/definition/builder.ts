import type { LifecycleHookName, PartialTransitionPolicy } from "../types.js";
import {
  createEmptyMachineHooksIR,
  finalizeAndValidateMachineIR,
  type MachineDefinition,
  type MachineHooksIR,
  type RegistryBindingIR,
  type StateNodeIR,
  type StateNodeType,
  type TransitionEdgeIR,
} from "./ir.js";

export interface TransitionBuilderInput extends PartialTransitionPolicy {
  target?: string;
  transition?: string;
  compensate?: string;
  effects?: string[];
  description?: string;
}

export class StateNodeBuilder<TContext = unknown> {
  private readonly key: string;
  private readonly path: string;
  private nodeType: StateNodeType;
  private initialChild?: string;
  private desc?: string;
  private readonly entryEffects: string[] = [];
  private readonly exitEffects: string[] = [];
  private readonly transitions: Record<string, TransitionEdgeIR> = {};
  private onDoneEdge?: TransitionEdgeIR;
  private readonly children: Record<string, StateNodeIR> = {};

  constructor(key: string, parentPath: string, type: StateNodeType = "atomic", initial?: string) {
    this.key = key;
    this.path = parentPath ? `${parentPath}.${key}` : key;
    this.nodeType = type;
    this.initialChild = initial;
  }

  description(text: string): this {
    this.desc = text;
    return this;
  }

  entry(...handlers: string[]): this {
    this.entryEffects.push(...handlers);
    return this;
  }

  exit(...handlers: string[]): this {
    this.exitEffects.push(...handlers);
    return this;
  }

  on(event: string, targetOrConfig: string | TransitionBuilderInput): this {
    this.transitions[event] = this.toEdge(event, targetOrConfig);
    return this;
  }

  onDone(targetOrConfig: string | TransitionBuilderInput): this {
    this.onDoneEdge = this.toEdge("$onDone", targetOrConfig);
    return this;
  }

  state(
    childKey: string,
    configure?: (sub: StateNodeBuilder<TContext>) => void
  ): this {
    const child = new StateNodeBuilder<TContext>(childKey, this.path, "atomic");
    configure?.(child);
    this.children[childKey] = child.buildNode();
    if (this.nodeType === "atomic") {
      this.nodeType = "compound";
    }
    return this;
  }

  compoundState(
    childKey: string,
    initial: string,
    configure: (sub: StateNodeBuilder<TContext>) => void
  ): this {
    const child = new StateNodeBuilder<TContext>(childKey, this.path, "compound", initial);
    configure(child);
    this.children[childKey] = child.buildNode();
    if (this.nodeType === "atomic") {
      this.nodeType = "compound";
    }
    return this;
  }

  parallelState(
    childKey: string,
    configure: (sub: StateNodeBuilder<TContext>) => void
  ): this {
    const child = new StateNodeBuilder<TContext>(childKey, this.path, "parallel");
    configure(child);
    this.children[childKey] = child.buildNode();
    if (this.nodeType === "atomic") {
      this.nodeType = "compound";
    }
    return this;
  }

  finalState(childKey: string, configure?: (sub: StateNodeBuilder<TContext>) => void): this {
    const child = new StateNodeBuilder<TContext>(childKey, this.path, "final");
    configure?.(child);
    this.children[childKey] = child.buildNode();
    if (this.nodeType === "atomic") {
      this.nodeType = "compound";
    }
    return this;
  }

  private toEdge(event: string, targetOrConfig: string | TransitionBuilderInput): TransitionEdgeIR {
    if (typeof targetOrConfig === "string") {
      return { event, target: targetOrConfig, effects: [], policy: {} };
    }
    const policy: PartialTransitionPolicy = {
      ...(targetOrConfig.retry ? { retry: targetOrConfig.retry } : {}),
      ...(targetOrConfig.circuitBreaker ? { circuitBreaker: targetOrConfig.circuitBreaker } : {}),
      ...(targetOrConfig.onFail ? { onFail: targetOrConfig.onFail } : {}),
      ...(targetOrConfig.benchmark ? { benchmark: targetOrConfig.benchmark } : {}),
      ...(targetOrConfig.compensate ?? targetOrConfig.compensateHandler
        ? { compensateHandler: targetOrConfig.compensate ?? targetOrConfig.compensateHandler }
        : {}),
    };
    return {
      event,
      target: targetOrConfig.target,
      transition: targetOrConfig.transition,
      compensate: targetOrConfig.compensate ?? targetOrConfig.compensateHandler,
      effects: targetOrConfig.effects ? [...targetOrConfig.effects] : [],
      description: targetOrConfig.description,
      policy,
    };
  }

  /** @internal */
  buildNode(): StateNodeIR {
    return {
      key: this.key,
      path: this.path,
      type: this.nodeType,
      description: this.desc,
      initial: this.initialChild,
      entry: [...this.entryEffects],
      exit: [...this.exitEffects],
      on: { ...this.transitions },
      onDone: this.onDoneEdge,
      states: { ...this.children },
    };
  }
}

export class MachineBuilder<TContext = unknown> {
  private readonly machineId: string;
  private machineVersion = "1.0.0";
  private machineDescription?: string;
  private rootType: "compound" | "parallel" = "compound";
  private initialKey?: string;
  private registryConfig: RegistryBindingIR = { strict: true };
  private defaultPolicy: PartialTransitionPolicy = {};
  private readonly machineHooks: MachineHooksIR = createEmptyMachineHooksIR();
  private readonly machineEffects: string[] = [];
  private effectChainLimit?: number;
  private readonly rootStates: Record<string, StateNodeIR> = {};

  constructor(machineId: string) {
    this.machineId = machineId;
  }

  version(v: string): this {
    this.machineVersion = v;
    return this;
  }

  description(text: string): this {
    this.machineDescription = text;
    return this;
  }

  initial(stateKey: string): this {
    this.initialKey = stateKey;
    this.rootType = "compound";
    return this;
  }

  parallelRoot(): this {
    this.rootType = "parallel";
    this.initialKey = undefined;
    return this;
  }

  registry(config: { namespace?: string; strict?: boolean }): this {
    this.registryConfig = {
      namespace: config.namespace,
      strict: config.strict ?? true,
    };
    return this;
  }

  defaults(policy: PartialTransitionPolicy): this {
    this.defaultPolicy = { ...this.defaultPolicy, ...policy };
    return this;
  }

  /**
   * Binds lifecycle hook handler names (resolved from `FSMRegistry` on machine creation)
   * to `onStart`, `beforeTransition`, `afterTransition`, `onCompensate`, `onComplete`, or `onTerminal`.
   */
  hooks(config: Partial<Record<LifecycleHookName, string | string[]>>): this {
    for (const [slot, val] of Object.entries(config) as Array<
      [LifecycleHookName, string | string[] | undefined]
    >) {
      if (!val) continue;
      const list = Array.isArray(val) ? val : [val];
      this.machineHooks[slot].push(...list);
    }
    return this;
  }

  hook(slot: LifecycleHookName, ...handlerNames: string[]): this {
    this.machineHooks[slot].push(...handlerNames);
    return this;
  }

  /**
   * Declares machine-level effect handler names (e.g. conditional sub-effects invoked via `req.runEffect`)
   * so they are verified against `FSMRegistry` on machine creation when `strict: true`.
   */
  effects(...handlerNames: string[]): this {
    this.machineEffects.push(...handlerNames);
    return this;
  }

  maxEffectChainDepth(depth: number): this {
    this.effectChainLimit = depth;
    return this;
  }

  state(
    stateKey: string,
    configure?: (sub: StateNodeBuilder<TContext>) => void
  ): this {
    const b = new StateNodeBuilder<TContext>(stateKey, "", "atomic");
    configure?.(b);
    this.rootStates[stateKey] = b.buildNode();
    return this;
  }

  compoundState(
    stateKey: string,
    initialChild: string,
    configure: (sub: StateNodeBuilder<TContext>) => void
  ): this {
    const b = new StateNodeBuilder<TContext>(stateKey, "", "compound", initialChild);
    configure(b);
    this.rootStates[stateKey] = b.buildNode();
    return this;
  }

  parallelState(
    stateKey: string,
    configure: (sub: StateNodeBuilder<TContext>) => void
  ): this {
    const b = new StateNodeBuilder<TContext>(stateKey, "", "parallel");
    configure(b);
    this.rootStates[stateKey] = b.buildNode();
    return this;
  }

  finalState(
    stateKey: string,
    configure?: (sub: StateNodeBuilder<TContext>) => void
  ): this {
    const b = new StateNodeBuilder<TContext>(stateKey, "", "final");
    configure?.(b);
    this.rootStates[stateKey] = b.buildNode();
    return this;
  }

  /**
   * Explicitly overrides the built-in default `error` state.
   */
  errorState(
    configure: (sub: StateNodeBuilder<TContext>) => void,
    type: StateNodeType = "atomic"
  ): this {
    const b = new StateNodeBuilder<TContext>("error", "", type);
    configure(b);
    this.rootStates.error = b.buildNode();
    return this;
  }

  build(): MachineDefinition {
    return finalizeAndValidateMachineIR({
      dfsm: "1.0",
      id: this.machineId,
      version: this.machineVersion,
      description: this.machineDescription,
      source: "builder",
      type: this.rootType,
      initial: this.initialKey,
      registry: { ...this.registryConfig },
      defaults: { ...this.defaultPolicy },
      hooks: {
        onStart: [...this.machineHooks.onStart],
        beforeTransition: [...this.machineHooks.beforeTransition],
        afterTransition: [...this.machineHooks.afterTransition],
        onCompensate: [...this.machineHooks.onCompensate],
        onComplete: [...this.machineHooks.onComplete],
        onTerminal: [...this.machineHooks.onTerminal],
      },
      effects: [...this.machineEffects],
      ...(this.effectChainLimit !== undefined
        ? { maxEffectChainDepth: this.effectChainLimit }
        : {}),
      states: { ...this.rootStates },
    });
  }
}

export function createMachine<TContext = unknown>(machineId: string): MachineBuilder<TContext> {
  return new MachineBuilder<TContext>(machineId);
}

