import { MachineBuilder } from "../definition/builder.js";
import { qualifyHandlerName, type MachineDefinition } from "../definition/ir.js";
import { loadYamlMachineFromFile, parseYamlMachine } from "../definition/parser.js";
import { setDecoratorAutoRegisterHook } from "../decorators/decorators.js";
import {
  getDecoratedPrototypeMembers,
  getFunctionMetadata,
  upsertFunctionMetadata,
} from "../decorators/metadata.js";
import { DfsmError, UnregisteredHandlerError } from "../errors.js";
import { ConsoleBenchmarkLogger, type BenchmarkLogEngine } from "../logger.js";
import { getTerminalStates } from "../engine/statechart.js";
import { CircuitBreakerManager } from "../policy/circuit-breaker.js";
import { normalizeTransitionPolicy } from "../policy/merger.js";
import { SqliteStateStore } from "../store/sqlite-store.js";
import type { StateStore } from "../store/store.js";
import {
  NON_TERMINAL_STATUSES,
  systemClock,
  TERMINAL_STATUSES,
  type ActorLifecycleHooks,
  type ActorSummary,
  type CleanUpAction,
  type CleanUpReport,
  type Clock,
  type CompensateFunction,
  type EffectFunction,
  type EffectiveMachineConfig,
  type EffectiveTransitionConfig,
  type ForceCleanUpOptions,
  type HandlerDescriptor,
  type InFlightStats,
  type LifecycleHookFunction,
  type LifecycleHookName,
  type MachineSummary,
  type MachineTerminalStatesSummary,
  type PartialTransitionPolicy,
  type TransactionStatus,
  type TransitionFunction,
} from "../types.js";
import { toSchemaValidator, type ValidatorInput } from "../validation.js";
import {
  DfsmActor,
  type ActorConfig,
  type HandlerLookupProvider,
  type MachineHandlerBindings,
  type RegisteredTransitionEntry,
} from "./actor.js";

export interface RegistryOptions {
  store?: StateStore;
  logEngine?: BenchmarkLogEngine;
  globalDefaults?: PartialTransitionPolicy;
  clock?: Clock;
  /**
   * Optional global transaction lifecycle hooks inherited by all actors created by this registry.
   */
  hooks?: ActorLifecycleHooks<any>;
}

export interface RegisterTransitionOptions<TInput = any> extends PartialTransitionPolicy {
  inputValidator?: ValidatorInput<TInput>;
}

export class FSMRegistry implements HandlerLookupProvider {
  private static singleton: FSMRegistry | null = null;

  public static getInstance(): FSMRegistry {
    if (!FSMRegistry.singleton) {
      FSMRegistry.singleton = new FSMRegistry();
    }
    return FSMRegistry.singleton;
  }

  /**
   * Resets and closes the singleton registry (ideal for clean unit test isolation).
   */
  public static async resetInstance(): Promise<void> {
    if (FSMRegistry.singleton) {
      await FSMRegistry.singleton.shutdown();
      FSMRegistry.singleton = null;
    }
  }

  private defaultStore: StateStore;
  private logEngine: BenchmarkLogEngine;
  private globalDefaults: PartialTransitionPolicy;
  private clock: Clock;
  private globalHooks?: ActorLifecycleHooks<any>;

  private readonly machines = new Map<string, MachineDefinition>();
  private readonly transitions = new Map<string, RegisteredTransitionEntry>();
  private readonly compensations = new Map<string, CompensateFunction<any, any>>();
  private readonly effects = new Map<string, EffectFunction<any>>();
  private readonly hooks = new Map<string, LifecycleHookFunction<any>>();
  private readonly activeActors = new Map<string, DfsmActor<any>>();

  constructor(options?: RegistryOptions) {
    this.defaultStore = options?.store ?? new SqliteStateStore({ filename: ":memory:" });
    this.logEngine = options?.logEngine ?? new ConsoleBenchmarkLogger({ silent: true });
    this.globalDefaults = options?.globalDefaults ?? {};
    this.clock = options?.clock ?? systemClock;
    this.globalHooks = options?.hooks;
  }

  configure(options: RegistryOptions): this {
    if (options.store) this.defaultStore = options.store;
    if (options.logEngine) this.logEngine = options.logEngine;
    if (options.globalDefaults) {
      this.globalDefaults = { ...this.globalDefaults, ...options.globalDefaults };
    }
    if (options.clock) this.clock = options.clock;
    if (options.hooks) this.globalHooks = options.hooks;
    return this;
  }

  // ==========================================================================
  // Handler Registration (Decorated Functions, Plain Functions & Service Classes)
  // ==========================================================================

  registerTransition<TContext = any, TInput = any, TOutput = any>(
    name: string,
    fn: TransitionFunction<TContext, TInput, TOutput>,
    options?: RegisterTransitionOptions<TInput>
  ): this {
    const attached = getFunctionMetadata(fn);
    let mergedFn = fn;

    if (options) {
      const explicitPolicy: PartialTransitionPolicy = {
        ...(options.retry ? { retry: options.retry } : {}),
        ...(options.circuitBreaker ? { circuitBreaker: options.circuitBreaker } : {}),
        ...(options.onFail ? { onFail: options.onFail } : {}),
        ...(options.benchmark ? { benchmark: options.benchmark } : {}),
        ...(options.compensateHandler ? { compensateHandler: options.compensateHandler } : {}),
      };
      mergedFn = (req) => fn(req);
      upsertFunctionMetadata(mergedFn, {
        name,
        kind: "transition",
        policy: attached?.policy,
        inputValidator: attached?.inputValidator,
      });
      upsertFunctionMetadata(mergedFn, {
        policy: explicitPolicy,
        ...(options.inputValidator
          ? { inputValidator: toSchemaValidator(options.inputValidator) }
          : {}),
      });
    }

    const finalMeta = getFunctionMetadata(mergedFn);
    this.transitions.set(name, {
      fn: mergedFn,
      policy: finalMeta?.policy ?? {},
      inputValidator: finalMeta?.inputValidator,
    });
    return this;
  }

  registerCompensate<TContext = any, TInput = any>(
    name: string,
    fn: CompensateFunction<TContext, TInput>
  ): this {
    this.compensations.set(name, fn);
    return this;
  }

  registerEffect<TContext = any>(name: string, fn: EffectFunction<TContext>): this {
    this.effects.set(name, fn);
    return this;
  }

  /**
   * Registers a named transaction lifecycle hook handler so it can be referenced directly
   * from `hooks:` in `.dfsm.yaml` or `MachineBuilder.hooks(...)`.
   */
  registerHook<TEvent = any>(name: string, fn: LifecycleHookFunction<TEvent>): this {
    this.hooks.set(name, fn);
    return this;
  }

  /**
   * Scans an object/service instance for methods decorated with `@DfsmTransition`,
   * `@DfsmCompensate`, `@DfsmEffect`, or `@DfsmHook` (along with stacked `@Retry`,
   * `@CircuitBreaker`, `@OnFail`, `@CompensateWith`, `@Benchmark`), binds `this`, and
   * registers them under optional `namespace`.
   */
  registerService(serviceInstance: object, namespace?: string): this {
    const memberKeys = new Set<string | symbol>(getDecoratedPrototypeMembers(serviceInstance));

    // Also inspect prototype property names directly so Stage-3 methods without run initializers still discover cleanly
    let proto = Object.getPrototypeOf(serviceInstance);
    while (proto && proto !== Object.prototype) {
      for (const propName of Object.getOwnPropertyNames(proto)) {
        if (propName === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(proto, propName);
        if (desc && typeof desc.value === "function" && getFunctionMetadata(desc.value)) {
          memberKeys.add(propName);
        }
      }
      proto = Object.getPrototypeOf(proto);
    }

    for (const ownKey of Object.keys(serviceInstance)) {
      const candidate = (serviceInstance as Record<string, unknown>)[ownKey];
      if (typeof candidate === "function" && getFunctionMetadata(candidate)) {
        memberKeys.add(ownKey);
      }
    }

    for (const key of memberKeys) {
      const method = (serviceInstance as Record<string | symbol, unknown>)[key];
      if (typeof method !== "function") continue;
      const meta = getFunctionMetadata(method);
      if (!meta) continue;

      const baseName = meta.name ?? String(key);
      const qualified = qualifyHandlerName(baseName, namespace);
      const boundFn = method.bind(serviceInstance);

      upsertFunctionMetadata(boundFn, {
        name: qualified,
        kind: meta.kind ?? "transition",
        policy: meta.policy,
        inputValidator: meta.inputValidator,
      });

      const kind = meta.kind ?? "transition";
      if (kind === "transition") {
        this.registerTransition(qualified, boundFn);
      } else if (kind === "compensate") {
        this.registerCompensate(qualified, boundFn);
      } else if (kind === "effect") {
        this.registerEffect(qualified, boundFn);
      } else if (kind === "hook") {
        this.registerHook(qualified, boundFn);
      }
    }

    return this;
  }

  /**
   * Registers inline services, transitions, compensations, effects, and lifecycle hooks
   * for a `MachineDefinition` using `bindings.namespace ?? def.registry.namespace`.
   */
  private applyMachineBindings(def: MachineDefinition, bindings?: MachineHandlerBindings): void {
    if (!bindings) return;
    const ns = bindings.namespace ?? def.registry.namespace;

    if (bindings.services) {
      for (const svc of bindings.services) {
        this.registerService(svc, ns);
      }
    }
    if (bindings.transitions) {
      for (const [name, fn] of Object.entries(bindings.transitions)) {
        this.registerTransition(qualifyHandlerName(name, ns), fn);
      }
    }
    if (bindings.compensations) {
      for (const [name, fn] of Object.entries(bindings.compensations)) {
        this.registerCompensate(qualifyHandlerName(name, ns), fn);
      }
    }
    if (bindings.effects) {
      for (const [name, fn] of Object.entries(bindings.effects)) {
        this.registerEffect(qualifyHandlerName(name, ns), fn);
      }
    }
    if (bindings.hooks) {
      for (const [name, fn] of Object.entries(bindings.hooks)) {
        this.registerHook(qualifyHandlerName(name, ns), fn);
      }
    }

    const shouldValidate = bindings.validateHandlersNow ?? def.registry.strict;
    if (shouldValidate) {
      this.validateMachineHandlers(def);
    }
  }

  /**
   * Validates that every transition, compensate, effect, and lifecycle hook handler
   * referenced by `def` is registered in `FSMRegistry`, throwing `UnregisteredHandlerError`
   * if any are missing.
   */
  validateMachineHandlers(def: MachineDefinition): void {
    const missing: string[] = [];
    const ns = def.registry.namespace;

    const checkEffects = (list: string[]) => {
      for (const eff of list) {
        if (!this.resolveEffect(eff, ns)) {
          missing.push(qualifyHandlerName(eff, ns));
        }
      }
    };

    checkEffects(def.effects);

    const hookSlots: LifecycleHookName[] = [
      "onStart",
      "beforeTransition",
      "afterTransition",
      "onCompensate",
      "onComplete",
      "onTerminal",
    ];
    for (const slot of hookSlots) {
      for (const ref of def.hooks[slot] ?? []) {
        if (!this.resolveHook(ref, ns)) {
          missing.push(qualifyHandlerName(ref, ns));
        }
      }
    }

    const checkEdge = (edge: MachineDefinition["states"][string]["on"][string]) => {
      if (edge.transition && !this.resolveTransition(edge.transition, ns)) {
        missing.push(qualifyHandlerName(edge.transition, ns));
      }
      const resolvedTx = edge.transition ? this.resolveTransition(edge.transition, ns) : undefined;
      const rawComp = resolvedTx?.entry.policy.compensateHandler ?? edge.compensate;
      if (rawComp && !this.resolveCompensate(rawComp, ns)) {
        missing.push(qualifyHandlerName(rawComp, ns));
      }
      checkEffects(edge.effects);
    };

    const walk = (node: MachineDefinition["states"][string]) => {
      checkEffects(node.entry);
      checkEffects(node.exit);
      for (const edge of Object.values(node.on)) {
        checkEdge(edge);
      }
      if (node.onDone) {
        checkEdge(node.onDone);
      }
      for (const child of Object.values(node.states)) {
        walk(child);
      }
    };

    for (const root of Object.values(def.states)) {
      walk(root);
    }

    if (missing.length > 0) {
      throw new UnregisteredHandlerError(def.id, [...new Set(missing)]);
    }
  }

  // ==========================================================================
  // Dual Machine Registration (YAML + Fluent MachineBuilder)
  // ==========================================================================

  registerYaml(yamlContent: string, bindings?: MachineHandlerBindings): MachineDefinition {
    const def = parseYamlMachine(yamlContent);
    this.machines.set(def.id, def);
    this.applyMachineBindings(def, bindings);
    return def;
  }

  registerYamlFile(filePath: string, bindings?: MachineHandlerBindings): MachineDefinition {
    const def = loadYamlMachineFromFile(filePath);
    this.machines.set(def.id, def);
    this.applyMachineBindings(def, bindings);
    return def;
  }

  registerBuilder<TContext = unknown>(
    builder: MachineBuilder<TContext>,
    bindings?: MachineHandlerBindings
  ): MachineDefinition {
    const def = builder.build();
    this.machines.set(def.id, def);
    this.applyMachineBindings(def, bindings);
    return def;
  }

  registerMachine(
    definition: MachineDefinition,
    bindings?: MachineHandlerBindings
  ): MachineDefinition {
    this.machines.set(definition.id, definition);
    this.applyMachineBindings(definition, bindings);
    return definition;
  }

  // ==========================================================================
  // Multi-Actor Creation (Each Actor Owns Its Internal Compiled Machine)
  // ==========================================================================

  /**
   * Instantiates and initializes a typed `DfsmActor<TContext>` bound to either:
   * - a registered `machineId` string in `FSMRegistry`,
   * - a raw DFSM YAML string (`dfsm: "1.0"`),
   * - a dedicated `MachineBuilder<TContext>`, or
   * - an inline `MachineDefinition`.
   */
  async createActor<TContext = unknown>(
    machineIdOrYamlOrBuilderOrDef: string | MachineBuilder<TContext> | MachineDefinition,
    config?: ActorConfig<TContext>
  ): Promise<DfsmActor<TContext>> {
    const actor = this.buildActorSync<TContext>(machineIdOrYamlOrBuilderOrDef, config);
    await actor.initialize();
    return actor;
  }

  /**
   * Synchronous Actor factory when caller prefers manual `await actor.initialize()`.
   */
  buildActorSync<TContext = unknown>(
    machineIdOrYamlOrBuilderOrDef: string | MachineBuilder<TContext> | MachineDefinition,
    config?: ActorConfig<TContext>
  ): DfsmActor<TContext> {
    let def: MachineDefinition;

    if (typeof machineIdOrYamlOrBuilderOrDef === "string") {
      const trimmed = machineIdOrYamlOrBuilderOrDef.trimStart();
      if (
        trimmed.startsWith("dfsm:") ||
        trimmed.startsWith("#") ||
        machineIdOrYamlOrBuilderOrDef.includes("\ndfsm:")
      ) {
        def = parseYamlMachine(machineIdOrYamlOrBuilderOrDef);
        this.machines.set(def.id, def);
      } else {
        const found = this.machines.get(machineIdOrYamlOrBuilderOrDef);
        if (!found) {
          throw new DfsmError(
            "DFSM_MACHINE_NOT_REGISTERED",
            `Machine '${machineIdOrYamlOrBuilderOrDef}' is not registered in FSMRegistry`
          );
        }
        def = found;
      }
    } else if (machineIdOrYamlOrBuilderOrDef instanceof MachineBuilder) {
      def = machineIdOrYamlOrBuilderOrDef.build();
      if (!this.machines.has(def.id)) {
        this.machines.set(def.id, def);
      }
    } else {
      def = machineIdOrYamlOrBuilderOrDef;
      if (!this.machines.has(def.id)) {
        this.machines.set(def.id, def);
      }
    }

    if (config?.bindings) {
      this.applyMachineBindings(def, { ...config.bindings, validateHandlersNow: false });
    }

    const actor = new DfsmActor<TContext>(
      def,
      this,
      {
        store: this.defaultStore,
        logger: this.logEngine,
        clock: this.clock,
        hooks: this.globalHooks,
        onClose: (actorId) => {
          this.activeActors.delete(actorId);
        },
      },
      config
    );

    this.activeActors.set(actor.actorId, actor);
    return actor;
  }

  // ==========================================================================
  // HandlerLookupProvider Implementation
  // ==========================================================================

  resolveTransition(
    rawName: string,
    namespace?: string
  ): { resolvedName: string; entry: RegisteredTransitionEntry } | undefined {
    if (namespace) {
      const qualified = qualifyHandlerName(rawName, namespace);
      const foundQual = this.transitions.get(qualified);
      if (foundQual) return { resolvedName: qualified, entry: foundQual };
    }
    const direct = this.transitions.get(rawName);
    return direct ? { resolvedName: rawName, entry: direct } : undefined;
  }

  resolveCompensate(
    rawName: string,
    namespace?: string
  ): { resolvedName: string; fn: CompensateFunction<any, any> } | undefined {
    if (namespace) {
      const qualified = qualifyHandlerName(rawName, namespace);
      const foundQual = this.compensations.get(qualified);
      if (foundQual) return { resolvedName: qualified, fn: foundQual };
    }
    const direct = this.compensations.get(rawName);
    return direct ? { resolvedName: rawName, fn: direct } : undefined;
  }

  resolveEffect(
    rawName: string,
    namespace?: string
  ): { resolvedName: string; fn: EffectFunction<any> } | undefined {
    if (namespace) {
      const qualified = qualifyHandlerName(rawName, namespace);
      const foundQual = this.effects.get(qualified);
      if (foundQual) return { resolvedName: qualified, fn: foundQual };
    }
    const direct = this.effects.get(rawName);
    return direct ? { resolvedName: rawName, fn: direct } : undefined;
  }

  resolveHook(
    rawName: string,
    namespace?: string
  ): { resolvedName: string; fn: LifecycleHookFunction<any> } | undefined {
    if (namespace) {
      const qualified = qualifyHandlerName(rawName, namespace);
      const foundQual = this.hooks.get(qualified);
      if (foundQual) return { resolvedName: qualified, fn: foundQual };
    }
    const direct = this.hooks.get(rawName);
    return direct ? { resolvedName: rawName, fn: direct } : undefined;
  }

  getGlobalPolicyDefaults(): PartialTransitionPolicy {
    return this.globalDefaults;
  }

  // ==========================================================================
  // Operational Introspection, Global In-Flight Queries & Force Cleanup
  // ==========================================================================

  listMachines(): MachineSummary[] {
    const actorCountByMachine = new Map<string, number>();
    for (const actor of this.activeActors.values()) {
      actorCountByMachine.set(
        actor.machineId,
        (actorCountByMachine.get(actor.machineId) ?? 0) + 1
      );
    }

    return [...this.machines.values()].map((m) => ({
      id: m.id,
      version: m.version,
      source: m.source,
      namespace: m.registry.namespace,
      stateCount: Object.keys(m.states).length,
      hasCustomErrorState: m.hasCustomErrorState,
      boundActorCount: actorCountByMachine.get(m.id) ?? 0,
    }));
  }

  getMachineDefinition(machineId: string): Readonly<MachineDefinition> | undefined {
    return this.machines.get(machineId);
  }

  /**
   * Returns all terminal (`type: "final"`) and `error` states for a registered machine.
   */
  getTerminalStates(machineId: string): MachineTerminalStatesSummary {
    const machine = this.machines.get(machineId);
    if (!machine) {
      throw new DfsmError(
        "DFSM_MACHINE_NOT_REGISTERED",
        `Machine '${machineId}' is not registered in FSMRegistry`
      );
    }
    const states = getTerminalStates(machine);
    return {
      machineId: machine.id,
      terminalStatuses: TERMINAL_STATUSES,
      nonTerminalStatuses: NON_TERMINAL_STATUSES,
      topLevelTerminalStates: states.filter((s) => s.isTopLevel).map((s) => s.path),
      states,
    };
  }

  /**
   * Computes and returns the normalized, deduplicated effective configuration for
   * all transitions in `machineId` (`Decorator > Transition YAML > Defaults YAML > SDK Default`).
   */
  getEffectiveConfig(machineId: string): EffectiveMachineConfig {
    // If an active actor exists for this machine, return its live config (including live CB states)
    for (const actor of this.activeActors.values()) {
      if (actor.machineId === machineId) {
        return actor.getEffectiveConfig();
      }
    }

    const machine = this.machines.get(machineId);
    if (!machine) {
      throw new DfsmError(
        "DFSM_MACHINE_NOT_REGISTERED",
        `Machine '${machineId}' is not registered in FSMRegistry`
      );
    }

    const tempBreakers = new CircuitBreakerManager(this.clock);
    const transitions: EffectiveTransitionConfig[] = [];
    const namespace = machine.registry.namespace;
    const registeredEffects = new Set<string>();
    const collectEffects = (list: string[]) => {
      for (const eff of list) {
        const res = this.resolveEffect(eff, namespace);
        if (res) registeredEffects.add(res.resolvedName);
      }
    };
    collectEffects(machine.effects);

    const resolvedHooks: Partial<Record<LifecycleHookName, string[]>> = {};
    const hookSlots: LifecycleHookName[] = [
      "onStart",
      "beforeTransition",
      "afterTransition",
      "onCompensate",
      "onComplete",
      "onTerminal",
    ];
    for (const slot of hookSlots) {
      const names = (machine.hooks[slot] ?? [])
        .map((ref) => this.resolveHook(ref, namespace)?.resolvedName)
        .filter((n): n is string => Boolean(n));
      if (names.length > 0) {
        resolvedHooks[slot] = names;
      }
    }

    const walk = (statePath: string, node: MachineDefinition["states"][string]) => {
      collectEffects(node.entry);
      collectEffects(node.exit);
      for (const [event, edge] of Object.entries(node.on)) {
        collectEffects(edge.effects);
        const resolvedTx = edge.transition
          ? this.resolveTransition(edge.transition, namespace)
          : undefined;
        const policy = normalizeTransitionPolicy({
          defaultBreakerKey: `${machine.id}:${statePath}:${event}`,
          globalDefaults: this.globalDefaults,
          machineDefaults: machine.defaults,
          transitionPolicy: edge.policy,
          decoratorPolicy: resolvedTx?.entry.policy,
        });
        const rawComp = policy.compensateHandler ?? edge.compensate;
        const resolvedComp = rawComp ? this.resolveCompensate(rawComp, namespace) : undefined;
        transitions.push({
          statePath,
          event,
          target: edge.target,
          resolvedTransitionHandler: resolvedTx?.resolvedName,
          resolvedCompensateHandler: resolvedComp?.resolvedName,
          policy,
          circuitBreakerState: tempBreakers.getStatus(policy.circuitBreaker.key),
        });
      }
      if (node.onDone) {
        collectEffects(node.onDone.effects);
      }
      for (const child of Object.values(node.states)) {
        walk(child.path, child);
      }
    };

    for (const root of Object.values(machine.states)) {
      walk(root.path, root);
    }

    return {
      machineId: machine.id,
      version: machine.version,
      source: machine.source,
      hasCustomErrorState: machine.hasCustomErrorState,
      maxEffectChainDepth: machine.maxEffectChainDepth ?? 25,
      resolvedHooks,
      registeredEffects: [...registeredEffects],
      transitions,
    };
  }

  listRegisteredHandlers(namespace?: string): HandlerDescriptor[] {
    const items: HandlerDescriptor[] = [];
    const matchesNs = (name: string) =>
      !namespace || name === namespace || name.startsWith(`${namespace}.`);

    for (const [name, entry] of this.transitions.entries()) {
      if (matchesNs(name)) {
        items.push({ name, kind: "transition", policy: entry.policy });
      }
    }
    for (const name of this.compensations.keys()) {
      if (matchesNs(name)) {
        items.push({ name, kind: "compensate" });
      }
    }
    for (const name of this.effects.keys()) {
      if (matchesNs(name)) {
        items.push({ name, kind: "effect" });
      }
    }
    for (const name of this.hooks.keys()) {
      if (matchesNs(name)) {
        items.push({ name, kind: "hook" });
      }
    }
    return items;
  }

  getRegistryConfig(): {
    defaultStoreDriver: string;
    registeredMachineCount: number;
    registeredHandlerCount: number;
    activeActorCount: number;
    globalDefaults: PartialTransitionPolicy;
  } {
    return {
      defaultStoreDriver: this.defaultStore.driverName,
      registeredMachineCount: this.machines.size,
      registeredHandlerCount:
        this.transitions.size +
        this.compensations.size +
        this.effects.size +
        this.hooks.size,
      activeActorCount: this.activeActors.size,
      globalDefaults: { ...this.globalDefaults },
    };
  }

  listActors(): ActorSummary[] {
    return [...this.activeActors.values()].map((actor) => {
      const cfg = actor.getActorConfig();
      const sched = actor.getSchedulerStatus();
      return {
        actorId: actor.actorId,
        machineId: actor.machineId,
        schedulerEnabled: cfg.scheduler.enabled,
        schedulerRunning: sched.isRunning,
        recoveryPolicy: cfg.recovery,
      };
    });
  }

  /**
   * Counts all **non-terminal** transactions (`IDLE`, `IN_FLIGHT`, `COMPENSATING`) across
   * the default store, optionally scoped to `machineId`.
   */
  async getGlobalActiveCount(machineId?: string): Promise<number> {
    await this.defaultStore.initialize();
    return this.defaultStore.countTransactions({
      machineId,
      statuses: [...NON_TERMINAL_STATUSES],
    });
  }

  async getGlobalInFlightCount(filter?: {
    machineId?: string;
    stuckOnly?: boolean;
    stuckThresholdMs?: number;
  }): Promise<number> {
    await this.defaultStore.initialize();
    const threshold = filter?.stuckThresholdMs ?? 30000;
    return this.defaultStore.countTransactions({
      machineId: filter?.machineId,
      statuses: ["IN_FLIGHT", "COMPENSATING"],
      ...(filter?.stuckOnly ? { stuckBeforeTimestamp: this.clock.now() - threshold } : {}),
    });
  }

  async getInFlightSummary(stuckThresholdMs = 30000): Promise<InFlightStats> {
    await this.defaultStore.initialize();
    const now = this.clock.now();
    const rows = await this.defaultStore.queryTransactions(
      { statuses: [...NON_TERMINAL_STATUSES] },
      now,
      stuckThresholdMs
    );

    const byMachine: InFlightStats["byMachine"] = {};
    let totalIdle = 0;
    let totalInFlight = 0;
    let totalCompensating = 0;
    let totalStuck = 0;

    for (const r of rows) {
      let bucket = byMachine[r.machineId];
      if (!bucket) {
        bucket = { idle: 0, inFlight: 0, compensating: 0, nonTerminal: 0, stuck: 0 };
        byMachine[r.machineId] = bucket;
      }
      bucket.nonTerminal++;
      if (r.status === "IDLE") {
        totalIdle++;
        bucket.idle++;
      } else if (r.status === "IN_FLIGHT") {
        totalInFlight++;
        bucket.inFlight++;
      } else if (r.status === "COMPENSATING") {
        totalCompensating++;
        bucket.compensating++;
      }
      if (r.isStuck) {
        totalStuck++;
        bucket.stuck++;
      }
    }

    return {
      totalIdle,
      totalInFlight,
      totalCompensating,
      totalNonTerminal: totalIdle + totalInFlight + totalCompensating,
      totalStuck,
      byMachine,
    };
  }

  async forceCleanUp(options?: ForceCleanUpOptions): Promise<CleanUpReport> {
    await this.defaultStore.initialize();
    const now = this.clock.now();
    const action: CleanUpAction = options?.action ?? "DELETE";
    const dryRun = options?.dryRun ?? false;
    const includeInFlight = options?.includeInFlight ?? false;
    const threshold = options?.stuckThresholdMs ?? 30000;

    const statuses: TransactionStatus[] =
      options?.statuses ??
      (includeInFlight
        ? ["IDLE", "IN_FLIGHT", "COMPENSATING", "COMPLETED", "FAILED", "COMPENSATED"]
        : ["COMPLETED", "FAILED", "COMPENSATED"]);

    const candidates = await this.defaultStore.queryTransactions(
      {
        machineId: options?.machineId,
        actorId: options?.actorId,
        transactionIds: options?.transactionIds,
        statuses,
        ...(options?.stuckOnly ? { stuckBeforeTimestamp: now - threshold } : {}),
        ...(options?.olderThanMs !== undefined
          ? { olderThanTimestamp: now - options.olderThanMs }
          : {}),
      },
      now,
      threshold
    );

    const report: CleanUpReport = {
      scanned: candidates.length,
      matched: candidates.length,
      deleted: [],
      markedFailed: [],
      compensated: [],
      unlocked: [],
      dryRun,
      errors: [],
    };

    if (dryRun || candidates.length === 0) return report;

    if (action === "DELETE") {
      const ids = candidates.map((c) => c.transactionId);
      await this.defaultStore.deleteTransactions(ids);
      report.deleted.push(...ids);
      return report;
    }

    for (const item of candidates) {
      try {
        if (action === "MARK_FAIL") {
          await this.defaultStore.updateTransaction(item.transactionId, item.version, {
            stateValue: "error",
            status: "FAILED",
            activeStep: null,
            lastError: "Marked FAILED via FSMRegistry.forceCleanUp",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: this.clock.now(),
          });
          report.markedFailed.push(item.transactionId);
        } else if (action === "FORCE_UNLOCK") {
          await this.defaultStore.updateTransaction(item.transactionId, item.version, {
            status: "IDLE",
            activeStep: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: this.clock.now(),
          });
          report.unlocked.push(item.transactionId);
        } else if (action === "COMPENSATE") {
          // Delegate to bound actor if available so registered compensators execute with machine namespace
          const matchingActor = [...this.activeActors.values()].find(
            (a) => a.machineId === item.machineId
          );
          if (matchingActor) {
            const sub = await matchingActor.forceCleanUpTransaction(
              item.transactionId,
              "COMPENSATE"
            );
            report.compensated.push(...sub.compensated);
            report.errors.push(...sub.errors);
          } else {
            await this.defaultStore.updateTransaction(item.transactionId, item.version, {
              stateValue: "error",
              status: "COMPENSATED",
              activeStep: null,
              lastError: "Compensated via FSMRegistry.forceCleanUp",
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: this.clock.now(),
            });
            report.compensated.push(item.transactionId);
          }
        }
      } catch (err) {
        report.errors.push({
          transactionId: item.transactionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return report;
  }

  async shutdown(): Promise<void> {
    for (const actor of [...this.activeActors.values()]) {
      await actor.close();
    }
    this.activeActors.clear();
    await this.defaultStore.close();
  }
}

setDecoratorAutoRegisterHook((kind, name, fn) => {
  const reg = FSMRegistry.getInstance();
  if (kind === "transition") {
    reg.registerTransition(name, fn as TransitionFunction);
  } else if (kind === "compensate") {
    reg.registerCompensate(name, fn as CompensateFunction);
  } else if (kind === "effect") {
    reg.registerEffect(name, fn as EffectFunction);
  } else {
    reg.registerHook(name, fn as LifecycleHookFunction);
  }
});

