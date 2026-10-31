import { randomUUID } from "node:crypto";
import {
  qualifyHandlerName,
  type MachineDefinition,
  type StateNodeIR,
  type TransitionEdgeIR,
} from "../definition/ir.js";
import {
  ActorStoppedByRecoveryError,
  DfsmError,
  InvalidTransitionError,
  TransactionNotFoundError,
  UnregisteredHandlerError,
} from "../errors.js";
import type { BenchmarkLogEngine } from "../logger.js";
import { CircuitBreakerManager } from "../policy/circuit-breaker.js";
import { normalizeTransitionPolicy } from "../policy/merger.js";
import { buildDecoratedPipeline, type BenchmarkDecorator } from "../policy/pipeline.js";
import {
  applyTargetTransition,
  findPendingOnDone,
  getAvailableEvents,
  getTerminalStates,
  resolveInitialState,
  resolveSettledTransactionStatus,
  resolveTransitionsForEvent,
} from "../engine/statechart.js";
import type { StateStore } from "../store/store.js";
import {
  isTerminalStatus,
  NON_TERMINAL_STATUSES,
  systemClock,
  TERMINAL_STATUSES,
  type ActorLifecycleHooks,
  type ActorSchedulerConfig,
  type AfterTransitionHookEvent,
  type BeforeTransitionHookEvent,
  type CleanUpAction,
  type CleanUpReport,
  type Clock,
  type CompensateFunction,
  type EffectFunction,
  type EffectInvocation,
  type EffectiveMachineConfig,
  type EffectiveTransitionConfig,
  type ForceCleanUpOptions,
  type InFlightRecoveryConfig,
  type LifecycleHookFunction,
  type LifecycleHookName,
  type MachineTerminalStatesSummary,
  type NormalizedTransitionPolicy,
  type OnCompensateHookEvent,
  type OnCompleteHookEvent,
  type OnRestartMode,
  type OnTerminalHookEvent,
  type OnTransactionStartHookEvent,
  type PartialTransitionPolicy,
  type RecoverySweepReport,
  type SchedulerStatus,
  type StateValue,
  type StatusBreakdown,
  type TransactionSnapshot,
  type TransactionStatus,
  type TransactionSummary,
  type TransitionExecutionResult,
  type TransitionFunction,
} from "../types.js";
import {
  enforceValidation,
  toSchemaValidator,
  type SchemaValidator,
  type ValidatorInput,
} from "../validation.js";

export interface RegisteredTransitionEntry {
  fn: TransitionFunction<any, any, any>;
  policy: PartialTransitionPolicy;
  inputValidator?: SchemaValidator<any>;
}

export interface HandlerLookupProvider {
  resolveTransition(
    rawName: string,
    namespace?: string
  ): { resolvedName: string; entry: RegisteredTransitionEntry } | undefined;
  resolveCompensate(
    rawName: string,
    namespace?: string
  ): { resolvedName: string; fn: CompensateFunction<any, any> } | undefined;
  resolveEffect(
    rawName: string,
    namespace?: string
  ): { resolvedName: string; fn: EffectFunction<any> } | undefined;
  resolveHook(
    rawName: string,
    namespace?: string
  ): { resolvedName: string; fn: LifecycleHookFunction<any> } | undefined;
  getGlobalPolicyDefaults(): PartialTransitionPolicy;
}

interface CompiledTransitionBinding<TContext = any> {
  statePath: string;
  event: string;
  edge: TransitionEdgeIR;
  resolvedTransitionName?: string;
  resolvedCompensateName?: string;
  policy: NormalizedTransitionPolicy;
  pipeline: BenchmarkDecorator<TContext, any, any>;
  validateInput: (rawInput: unknown) => any;
}

export interface MachineHandlerBindings {
  /**
   * Optional namespace override when registering handlers; defaults to the machine's `registry.namespace`.
   */
  namespace?: string;
  /**
   * Decorated service instances (`@DfsmTransition`, `@DfsmCompensate`, `@DfsmEffect`, `@DfsmHook`)
   * registered into `FSMRegistry` upon machine/actor creation.
   */
  services?: object[];
  transitions?: Record<string, TransitionFunction<any, any, any>>;
  compensations?: Record<string, CompensateFunction<any, any>>;
  effects?: Record<string, EffectFunction<any>>;
  hooks?: Record<string, LifecycleHookFunction<any>>;
  /**
   * When provided on `registerYaml` / `registerBuilder` / `registerMachine`, validates all
   * referenced handlers immediately upon machine registration (defaults to `machine.registry.strict`).
   */
  validateHandlersNow?: boolean;
}

export interface ActorConfig<TContext = unknown> {
  actorId?: string;
  store?: StateStore;
  logEngine?: BenchmarkLogEngine;
  clock?: Clock;
  contextValidator?: ValidatorInput<TContext>;
  inputValidators?: Record<string, ValidatorInput<any>>;
  recovery?: InFlightRecoveryConfig;
  scheduler?: Partial<ActorSchedulerConfig>;
  /**
   * Optional handler/service/effect/hook registrations to register into `FSMRegistry`
   * right when creating this actor's machine.
   */
  bindings?: MachineHandlerBindings;
  /**
   * Optional transaction lifecycle hooks (`onStart`, `beforeTransition`, `afterTransition`,
   * `onCompensate`, `onComplete`, `onTerminal`).
   */
  hooks?: ActorLifecycleHooks<TContext>;
  /**
   * Maximum nested effect/auto-transition chain depth per transaction before aborting
   * with `DFSM_MAX_EFFECT_CHAIN_DEPTH` (overrides YAML `maxEffectChainDepth`, default `25`).
   */
  maxEffectChainDepth?: number;
}

export interface ResolvedActorConfiguration {
  actorId: string;
  machineId: string;
  machineVersion: string;
  storeDriver: string;
  hasContextValidator: boolean;
  recovery: Required<Omit<InFlightRecoveryConfig, "stateActions">> & {
    stateActions: Record<string, OnRestartMode>;
  };
  scheduler: ActorSchedulerConfig;
}

export class DfsmActor<TContext = unknown> {
  public readonly actorId: string;
  public readonly machineId: string;

  private readonly machine: MachineDefinition;
  private readonly handlers: HandlerLookupProvider;
  private readonly store: StateStore;
  private readonly logger: BenchmarkLogEngine;
  private readonly clock: Clock;
  private readonly breakerManager: CircuitBreakerManager;
  private readonly contextValidator?: SchemaValidator<TContext>;
  private readonly eventInputValidators = new Map<string, SchemaValidator<any>>();
  private readonly compiledBindings = new Map<string, CompiledTransitionBinding<TContext>>();

  private readonly recoveryConfig: Required<Omit<InFlightRecoveryConfig, "stateActions">> & {
    stateActions: Record<string, OnRestartMode>;
  };

  private schedulerConfig: ActorSchedulerConfig;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInProgress = false;
  private lastRunAt: number | null = null;
  private nextRunAt: number | null = null;
  private totalSweeps = 0;
  private totalRecoveredCount = 0;
  private totalRetentionCleanedCount = 0;
  private lastSweepReport: RecoverySweepReport | null = null;
  private initialized = false;
  private stoppedByRecovery = false;
  private readonly onCloseCallback?: (actorId: string) => void;
  private readonly maxEffectChainDepth: number;
  private readonly hookSubscriptions: ActorLifecycleHooks<TContext>[] = [];
  private readonly resolvedHookNames: Partial<Record<LifecycleHookName, string[]>> = {};
  private readonly resolvedEffectNames = new Set<string>();
  private readonly effectChainDepthByTx = new Map<string, number>();
  private readonly txTransitionRevision = new Map<string, number>();

  constructor(
    machine: MachineDefinition,
    handlers: HandlerLookupProvider,
    defaults: {
      store: StateStore;
      logger: BenchmarkLogEngine;
      clock?: Clock;
      hooks?: ActorLifecycleHooks<any>;
      onClose?: (actorId: string) => void;
    },
    config?: ActorConfig<TContext>
  ) {
    this.machine = machine;
    this.machineId = machine.id;
    this.actorId = config?.actorId ?? `${machine.id}-actor-${randomUUID().slice(0, 8)}`;
    this.handlers = handlers;
    this.store = config?.store ?? defaults.store;
    this.logger = config?.logEngine ?? defaults.logger;
    this.clock = config?.clock ?? defaults.clock ?? systemClock;
    this.breakerManager = new CircuitBreakerManager(this.clock);
    this.contextValidator = toSchemaValidator(config?.contextValidator);
    this.onCloseCallback = defaults.onClose;
    this.maxEffectChainDepth = Math.max(
      1,
      config?.maxEffectChainDepth ?? machine.maxEffectChainDepth ?? 25
    );

    if (defaults.hooks) {
      this.hookSubscriptions.push(defaults.hooks as ActorLifecycleHooks<TContext>);
    }

    if (config?.inputValidators) {
      for (const [eventOrHandler, val] of Object.entries(config.inputValidators)) {
        const schemaVal = toSchemaValidator(val);
        if (schemaVal) {
          this.eventInputValidators.set(eventOrHandler, schemaVal);
        }
      }
    }

    this.recoveryConfig = {
      enabled: config?.recovery?.enabled ?? true,
      stuckThresholdMs: config?.recovery?.stuckThresholdMs ?? 30000,
      defaultAction: config?.recovery?.defaultAction ?? "MARK_FAIL",
      stateActions: { ...(config?.recovery?.stateActions ?? {}) },
      haltActorOnStop: config?.recovery?.haltActorOnStop ?? false,
    };

    this.schedulerConfig = {
      enabled: config?.scheduler?.enabled ?? false,
      sweepIntervalMs: config?.scheduler?.sweepIntervalMs ?? 15000,
      stuckThresholdMs:
        config?.scheduler?.stuckThresholdMs ?? this.recoveryConfig.stuckThresholdMs,
      retentionMs: config?.scheduler?.retentionMs,
      batchSize: config?.scheduler?.batchSize ?? 100,
    };

    // Compile YAML/Builder transitions, compensations, effects, and lifecycle hooks first
    this.compileMachineBindings();

    // Actor-level inline hooks subscribe after global + YAML/Builder hooks
    if (config?.hooks) {
      this.hookSubscriptions.push(config.hooks);
    }
  }

  private bindingKey(statePath: string, event: string): string {
    return `${statePath}::${event}`;
  }

  private compileMachineBindings(): void {
    const missingHandlers: string[] = [];
    const namespace = this.machine.registry.namespace;
    const strict = this.machine.registry.strict;

    const verifyEffectList = (effects: string[]) => {
      for (const eff of effects) {
        const found = this.handlers.resolveEffect(eff, namespace);
        if (!found && strict) {
          missingHandlers.push(qualifyHandlerName(eff, namespace));
        } else if (found) {
          this.resolvedEffectNames.add(found.resolvedName);
        }
      }
    };

    // 1. Verify machine-level declared effects (e.g. conditional sub-effects invoked via runEffect)
    verifyEffectList(this.machine.effects);

    // 2. Resolve and bind YAML/Builder-declared lifecycle hooks (`hooks:` block)
    const hookSlots: LifecycleHookName[] = [
      "onStart",
      "beforeTransition",
      "afterTransition",
      "onCompensate",
      "onComplete",
      "onTerminal",
    ];
    const compiledYamlHooks: ActorLifecycleHooks<TContext> = {};
    let hasAnyYamlHook = false;

    for (const slot of hookSlots) {
      const refs = this.machine.hooks[slot] ?? [];
      if (refs.length === 0) continue;

      const resolvedFns: LifecycleHookFunction<any>[] = [];
      const resolvedNames: string[] = [];
      for (const ref of refs) {
        const foundHook = this.handlers.resolveHook(ref, namespace);
        if (!foundHook && strict) {
          missingHandlers.push(qualifyHandlerName(ref, namespace));
        } else if (foundHook) {
          resolvedFns.push(foundHook.fn);
          resolvedNames.push(foundHook.resolvedName);
        }
      }

      if (resolvedNames.length > 0) {
        this.resolvedHookNames[slot] = resolvedNames;
        hasAnyYamlHook = true;
        (compiledYamlHooks as Record<LifecycleHookName, LifecycleHookFunction<any>>)[slot] =
          async (evt: unknown) => {
            for (const fn of resolvedFns) {
              await fn(evt);
            }
          };
      }
    }

    if (hasAnyYamlHook) {
      this.hookSubscriptions.push(compiledYamlHooks);
    }

    const compileEdge = (statePath: string, event: string, edge: TransitionEdgeIR) => {
      let resolvedTx:
        | { resolvedName: string; entry: RegisteredTransitionEntry }
        | undefined;
      if (edge.transition) {
        resolvedTx = this.handlers.resolveTransition(edge.transition, namespace);
        if (!resolvedTx && strict) {
          missingHandlers.push(qualifyHandlerName(edge.transition, namespace));
        }
      }

      const decoratorPolicy = resolvedTx?.entry.policy;
      const defaultBreakerKey = `${this.machine.id}:${statePath}:${event}`;
      const normalizedPolicy = normalizeTransitionPolicy({
        defaultBreakerKey,
        globalDefaults: this.handlers.getGlobalPolicyDefaults(),
        machineDefaults: this.machine.defaults,
        transitionPolicy: edge.policy,
        decoratorPolicy,
      });

      const rawCompensateName = normalizedPolicy.compensateHandler ?? edge.compensate;
      let resolvedCompName: string | undefined;
      if (rawCompensateName) {
        const foundComp = this.handlers.resolveCompensate(rawCompensateName, namespace);
        if (!foundComp && strict) {
          missingHandlers.push(qualifyHandlerName(rawCompensateName, namespace));
        } else if (foundComp) {
          resolvedCompName = foundComp.resolvedName;
        }
      }

      verifyEffectList(edge.effects);

      const inputValidator =
        this.eventInputValidators.get(event) ??
        (edge.transition ? this.eventInputValidators.get(edge.transition) : undefined) ??
        resolvedTx?.entry.inputValidator;

      const breaker = this.breakerManager.getOrCreate(normalizedPolicy.circuitBreaker);

      const { pipeline, validateInput } = buildDecoratedPipeline<TContext, any, any>({
        fn: resolvedTx?.entry.fn,
        policy: normalizedPolicy,
        breaker,
        clock: this.clock,
        logger: this.logger,
        inputValidator,
        contextValidator: this.contextValidator,
      });

      this.compiledBindings.set(this.bindingKey(statePath, event), {
        statePath,
        event,
        edge,
        resolvedTransitionName: resolvedTx?.resolvedName,
        resolvedCompensateName: resolvedCompName,
        policy: normalizedPolicy,
        pipeline,
        validateInput,
      });
    };

    const walkState = (node: StateNodeIR) => {
      verifyEffectList(node.entry);
      verifyEffectList(node.exit);

      for (const [event, edge] of Object.entries(node.on)) {
        compileEdge(node.path, event, edge);
      }
      if (node.onDone) {
        compileEdge(node.path, "$onDone", node.onDone);
      }
      for (const child of Object.values(node.states)) {
        walkState(child);
      }
    };

    for (const rootState of Object.values(this.machine.states)) {
      walkState(rootState);
    }

    if (missingHandlers.length > 0) {
      throw new UnregisteredHandlerError(this.machine.id, [...new Set(missingHandlers)]);
    }
  }

  /**
   * Initializes the underlying `StateStore`, runs startup in-flight recovery if enabled,
   * and starts the periodic background scheduler if enabled.
   */
  async initialize(): Promise<RecoverySweepReport | null> {
    if (this.initialized) return this.lastSweepReport;
    await this.store.initialize();
    this.initialized = true;

    let report: RecoverySweepReport | null = null;
    if (this.recoveryConfig.enabled) {
      report = await this.executeRecoverySweep(this.recoveryConfig.stuckThresholdMs);
    }

    if (this.schedulerConfig.enabled) {
      this.startScheduler();
    }

    return report;
  }

  private async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (this.stoppedByRecovery) {
      throw new ActorStoppedByRecoveryError(this.actorId, []);
    }
  }

  /**
   * Registers an `ActorLifecycleHooks` listener on this actor and returns an unsubscribe function.
   */
  addHooks(hooks: ActorLifecycleHooks<TContext>): () => void {
    this.hookSubscriptions.push(hooks);
    return () => {
      const idx = this.hookSubscriptions.indexOf(hooks);
      if (idx >= 0) {
        this.hookSubscriptions.splice(idx, 1);
      }
    };
  }

  private getTransitionRevision(txId: string): number {
    return this.txTransitionRevision.get(txId) ?? 0;
  }

  private bumpTransitionRevision(txId: string): void {
    this.txTransitionRevision.set(txId, this.getTransitionRevision(txId) + 1);
  }

  private async emitOnStart(event: OnTransactionStartHookEvent<TContext>): Promise<void> {
    for (const sub of [...this.hookSubscriptions]) {
      await sub.onStart?.(event);
    }
  }

  private async emitBeforeTransition(event: BeforeTransitionHookEvent<TContext>): Promise<void> {
    for (const sub of [...this.hookSubscriptions]) {
      await sub.beforeTransition?.(event);
    }
  }

  private async emitAfterTransition(event: AfterTransitionHookEvent<TContext>): Promise<void> {
    for (const sub of [...this.hookSubscriptions]) {
      await sub.afterTransition?.(event);
    }
  }

  private async emitOnCompensate(event: OnCompensateHookEvent<TContext>): Promise<void> {
    for (const sub of [...this.hookSubscriptions]) {
      await sub.onCompensate?.(event);
    }
  }

  private async emitSettledTerminalHooks(
    transactionId: string,
    finalState: StateValue,
    status: TransactionStatus,
    context: TContext,
    error?: string
  ): Promise<void> {
    if (!isTerminalStatus(status)) return;

    if (status === "COMPLETED") {
      const completeEvt: OnCompleteHookEvent<TContext> = {
        transactionId,
        machineId: this.machine.id,
        actorId: this.actorId,
        finalState,
        context,
        actor: this,
      };
      for (const sub of [...this.hookSubscriptions]) {
        await sub.onComplete?.(completeEvt);
      }
    }

    const terminalEvt: OnTerminalHookEvent<TContext> = {
      transactionId,
      machineId: this.machine.id,
      actorId: this.actorId,
      finalState,
      status: status as "COMPLETED" | "COMPENSATED" | "FAILED",
      context,
      ...(error !== undefined ? { error } : {}),
      actor: this,
    };
    for (const sub of [...this.hookSubscriptions]) {
      await sub.onTerminal?.(terminalEvt);
    }
  }

  /**
   * Instantiates a new durable `Transaction` for this Actor's machine and immediately
   * writes the initial state + validated `initialContext` to `StateStore`.
   */
  async startTransaction(
    initialContext: TContext,
    customTransactionId?: string
  ): Promise<string> {
    await this.ensureReady();

    const validatedInitial = enforceValidation(
      "initialContext",
      initialContext,
      this.contextValidator
    );

    const txId = customTransactionId ?? randomUUID();
    const now = this.clock.now();
    const { stateValue, entryEffects } = resolveInitialState(this.machine);
    const status = resolveSettledTransactionStatus(this.machine, stateValue, false);

    await this.store.createTransaction<TContext>({
      transactionId: txId,
      machineId: this.machine.id,
      machineVersion: this.machine.version,
      actorId: this.actorId,
      stateValue,
      context: validatedInitial,
      status,
      activeStep: null,
      lastError: null,
      version: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.emitOnStart({
      transactionId: txId,
      machineId: this.machine.id,
      actorId: this.actorId,
      initialState: stateValue,
      status,
      context: validatedInitial,
      actor: this,
    });
    await this.emitSettledTerminalHooks(txId, stateValue, status, validatedInitial);

    await this.invokeEffects(txId, stateValue, validatedInitial, entryEffects);
    return txId;
  }

  /**
   * Advances `transactionId` on `event` with `input`, executing the normalized decorator pipeline,
   * pushing to the durable Saga compensation stack, and persisting state + context atomically.
   */
  async transition<TInput = unknown, TOutput = unknown>(
    transactionId: string,
    event: string,
    input?: TInput,
    metadata: Record<string, unknown> = {}
  ): Promise<TransitionExecutionResult<TContext, TOutput>> {
    await this.ensureReady();

    const snapshot = await this.store.getTransaction<TContext>(transactionId);
    if (!snapshot || snapshot.machineId !== this.machine.id) {
      throw new TransactionNotFoundError(transactionId);
    }

    return this.executeTransitionOnSnapshot<TInput, TOutput>(snapshot, event, input as TInput, metadata);
  }

  private async executeTransitionOnSnapshot<TInput = unknown, TOutput = unknown>(
    snapshot: TransactionSnapshot<TContext>,
    event: string,
    rawInput: TInput,
    metadata: Record<string, unknown>
  ): Promise<TransitionExecutionResult<TContext, TOutput>> {
    const previousState = snapshot.stateValue;
    const matches = resolveTransitionsForEvent(this.machine, previousState, event);

    if (matches.length === 0) {
      throw new InvalidTransitionError(
        this.machine.id,
        event,
        previousState,
        this.getAvailableEvents(previousState)
      );
    }

    // 1. Validate caller input BEFORE mutating state, consuming retries, or tripping circuit breakers
    const validatedInputs: any[] = [];
    for (const match of matches) {
      const binding = this.compiledBindings.get(
        this.bindingKey(match.sourceNode.path, match.edge.event)
      )!;
      validatedInputs.push(binding.validateInput(rawInput));
    }

    await this.emitBeforeTransition({
      transactionId: snapshot.transactionId,
      machineId: this.machine.id,
      actorId: this.actorId,
      event,
      input: validatedInputs[0] ?? rawInput,
      currentState: previousState,
      context: snapshot.context,
      actor: this,
    });

    // 2. Mark transaction IN_FLIGHT with active step lease
    const stepStartedAt = this.clock.now();
    let currentVersion = snapshot.version;
    if (snapshot.status !== "IN_FLIGHT") {
      currentVersion = await this.store.updateTransaction<TContext>(
        snapshot.transactionId,
        currentVersion,
        {
          status: "IN_FLIGHT",
          activeStep: { event, input: rawInput, startedAt: stepStartedAt },
          leaseOwner: this.actorId,
          leaseExpiresAt: stepStartedAt + Math.max(30000, this.recoveryConfig.stuckThresholdMs),
          updatedAt: stepStartedAt,
        }
      );
    }

    let workingState: StateValue = previousState;
    let workingContext: TContext = snapshot.context;
    let lastReturnValue: TOutput | undefined = undefined;
    const pendingEffects: Array<string | EffectInvocation> = [];
    const pendingCompensations: Array<{
      transactionId: string;
      transitionKey: string;
      compensateKey: string;
      fromState: StateValue;
      inputSnapshot: unknown;
      contextBefore: unknown;
      createdAt: number;
      compensatedAt: null;
    }> = [];

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const validatedInput = validatedInputs[i];
      const binding = this.compiledBindings.get(
        this.bindingKey(match.sourceNode.path, match.edge.event)
      )!;

      const contextBeforeStep = this.safeClone(workingContext);
      const stateBeforeStep = this.safeClone(workingState);

      let compensatedStepsCount = 0;
      let settledStatusAfterFail: TransactionStatus | null = null;
      let failErrorMessage: string | undefined;

      const { outcome } = await binding.pipeline.executeWithTelemetry(
        {
          transactionId: snapshot.transactionId,
          machineId: this.machine.id,
          actorId: this.actorId,
          event,
          transitionHandlerName: binding.resolvedTransitionName,
          currentState: workingState,
          input: validatedInput,
          contextData: workingContext,
          startedAt: stepStartedAt,
          metadata,
        },
        async (execOutcome) => {
          if (execOutcome.ok) {
            const effectiveTarget = execOutcome.output.targetState ?? binding.edge.target;
            if (effectiveTarget) {
              const applied = applyTargetTransition(
                this.machine,
                workingState,
                match.sourceNode.path,
                effectiveTarget
              );
              workingState = applied.nextStateValue;
              pendingEffects.push(...applied.exitEffects);
              pendingEffects.push(...binding.edge.effects);
              if (execOutcome.output.effects) {
                pendingEffects.push(...execOutcome.output.effects);
              }
              pendingEffects.push(...applied.entryEffects);
            } else {
              pendingEffects.push(...binding.edge.effects);
              if (execOutcome.output.effects) {
                pendingEffects.push(...execOutcome.output.effects);
              }
            }

            workingContext = execOutcome.nextContext;
            if (execOutcome.output.value !== undefined) {
              lastReturnValue = execOutcome.output.value as TOutput;
            }

            if (binding.resolvedCompensateName) {
              pendingCompensations.push({
                transactionId: snapshot.transactionId,
                transitionKey:
                  binding.resolvedTransitionName ?? `${match.sourceNode.path}.${event}`,
                compensateKey: binding.resolvedCompensateName,
                fromState: stateBeforeStep,
                inputSnapshot: validatedInput,
                contextBefore: contextBeforeStep,
                createdAt: this.clock.now(),
                compensatedAt: null,
              });
            }

            return { finalState: workingState, compensated: false };
          }

          // Failure branch! First persist any compensations accumulated earlier in this parallel broadcast
          if (pendingCompensations.length > 0) {
            currentVersion = await this.store.updateTransaction(
              snapshot.transactionId,
              currentVersion,
              { updatedAt: this.clock.now() },
              pendingCompensations.splice(0, pendingCompensations.length)
            );
          }

          failErrorMessage = execOutcome.error.message;
          let didCompensate = false;

          if (execOutcome.compensateRequested) {
            currentVersion = await this.store.updateTransaction<TContext>(
              snapshot.transactionId,
              currentVersion,
              {
                status: "COMPENSATING",
                lastError: failErrorMessage,
                updatedAt: this.clock.now(),
              }
            );
            const unwindRes = await this.unwindCompensationStack(
              snapshot.transactionId,
              workingContext,
              failErrorMessage
            );
            workingContext = unwindRes.updatedContext;
            compensatedStepsCount = unwindRes.compensatedCount;
            didCompensate = true;
          }

          const fallbackApplied = applyTargetTransition(
            this.machine,
            workingState,
            match.sourceNode.path,
            execOutcome.fallbackTarget
          );
          workingState = fallbackApplied.nextStateValue;
          pendingEffects.length = 0;
          pendingEffects.push(...fallbackApplied.exitEffects, ...fallbackApplied.entryEffects);

          settledStatusAfterFail = resolveSettledTransactionStatus(
            this.machine,
            workingState,
            didCompensate
          );

          return { finalState: workingState, compensated: didCompensate };
        }
      );

      if (!outcome.ok) {
        const failSettledStatus = settledStatusAfterFail ?? "FAILED";
        const resolvedErrorMsg = failErrorMessage ?? outcome.error.message;
        const completedAt = this.clock.now();

        currentVersion = await this.store.updateTransaction<TContext>(
          snapshot.transactionId,
          currentVersion,
          {
            stateValue: workingState,
            context: workingContext,
            status: failSettledStatus,
            activeStep: null,
            lastError: resolvedErrorMsg,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: completedAt,
          }
        );
        this.bumpTransitionRevision(snapshot.transactionId);

        await this.emitAfterTransition({
          transactionId: snapshot.transactionId,
          machineId: this.machine.id,
          actorId: this.actorId,
          event,
          input: validatedInputs[0] ?? rawInput,
          previousState,
          currentState: workingState,
          status: failSettledStatus,
          value: undefined,
          context: workingContext,
          compensatedSteps: compensatedStepsCount,
          durationMs: Math.max(0, completedAt - stepStartedAt),
          error: resolvedErrorMsg,
          actor: this,
        });
        await this.emitSettledTerminalHooks(
          snapshot.transactionId,
          workingState,
          failSettledStatus,
          workingContext,
          resolvedErrorMsg
        );

        const revBeforeEffects = this.getTransitionRevision(snapshot.transactionId);
        await this.invokeEffects(snapshot.transactionId, workingState, workingContext, pendingEffects);
        const nestedChangedAfterFail =
          this.getTransitionRevision(snapshot.transactionId) !== revBeforeEffects;
        if (!this.effectChainDepthByTx.has(snapshot.transactionId)) {
          this.txTransitionRevision.delete(snapshot.transactionId);
        }

        if (nestedChangedAfterFail) {
          const latestSnap = await this.store.getTransaction<TContext>(snapshot.transactionId);
          if (latestSnap) {
            return {
              transactionId: snapshot.transactionId,
              previousState,
              currentState: latestSnap.stateValue,
              status: latestSnap.status,
              value: undefined,
              context: latestSnap.context,
              compensatedSteps: compensatedStepsCount,
              ...(latestSnap.lastError ? { error: latestSnap.lastError } : {}),
            };
          }
        }

        return {
          transactionId: snapshot.transactionId,
          previousState,
          currentState: workingState,
          status: failSettledStatus,
          value: undefined,
          context: workingContext,
          compensatedSteps: compensatedStepsCount,
          error: resolvedErrorMsg,
        };
      }
    }

    // 3. Evaluate automatic cascading `onDone` transitions for completed compound / parallel containers
    let safetyCounter = 0;
    while (safetyCounter++ < 20) {
      const pendingDone = findPendingOnDone(this.machine, workingState);
      if (!pendingDone) break;

      const doneBinding = this.compiledBindings.get(
        this.bindingKey(pendingDone.sourceNode.path, "$onDone")
      );
      if (doneBinding && doneBinding.resolvedTransitionName) {
        const doneOutcome = await doneBinding.pipeline.execute({
          transactionId: snapshot.transactionId,
          machineId: this.machine.id,
          actorId: this.actorId,
          event: "$onDone",
          transitionHandlerName: doneBinding.resolvedTransitionName,
          currentState: workingState,
          input: undefined,
          contextData: workingContext,
          startedAt: this.clock.now(),
          metadata,
        });
        if (doneOutcome.ok) {
          workingContext = doneOutcome.nextContext;
          if (doneOutcome.output.effects) {
            pendingEffects.push(...doneOutcome.output.effects);
          }
        }
      }

      if (pendingDone.edge.target) {
        const appliedDone = applyTargetTransition(
          this.machine,
          workingState,
          pendingDone.sourceNode.path,
          pendingDone.edge.target
        );
        workingState = appliedDone.nextStateValue;
        pendingEffects.push(...appliedDone.exitEffects);
        pendingEffects.push(...pendingDone.edge.effects);
        pendingEffects.push(...appliedDone.entryEffects);
      } else {
        pendingEffects.push(...pendingDone.edge.effects);
        break;
      }
    }

    const finalStatus = resolveSettledTransactionStatus(this.machine, workingState, false);
    const completedAt = this.clock.now();

    await this.store.updateTransaction<TContext>(
      snapshot.transactionId,
      currentVersion,
      {
        stateValue: workingState,
        context: workingContext,
        status: finalStatus,
        activeStep: null,
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: completedAt,
      },
      pendingCompensations
    );
    this.bumpTransitionRevision(snapshot.transactionId);

    await this.emitAfterTransition({
      transactionId: snapshot.transactionId,
      machineId: this.machine.id,
      actorId: this.actorId,
      event,
      input: validatedInputs[0] ?? rawInput,
      previousState,
      currentState: workingState,
      status: finalStatus,
      value: lastReturnValue,
      context: workingContext,
      compensatedSteps: 0,
      durationMs: Math.max(0, completedAt - stepStartedAt),
      actor: this,
    });
    await this.emitSettledTerminalHooks(
      snapshot.transactionId,
      workingState,
      finalStatus,
      workingContext
    );

    const revBeforeEffects = this.getTransitionRevision(snapshot.transactionId);
    await this.invokeEffects(snapshot.transactionId, workingState, workingContext, pendingEffects);
    const nestedChanged = this.getTransitionRevision(snapshot.transactionId) !== revBeforeEffects;
    if (!this.effectChainDepthByTx.has(snapshot.transactionId)) {
      this.txTransitionRevision.delete(snapshot.transactionId);
    }

    if (nestedChanged) {
      const latestSnap = await this.store.getTransaction<TContext>(snapshot.transactionId);
      if (latestSnap) {
        return {
          transactionId: snapshot.transactionId,
          previousState,
          currentState: latestSnap.stateValue,
          status: latestSnap.status,
          value: lastReturnValue,
          context: latestSnap.context,
          compensatedSteps: 0,
          ...(latestSnap.lastError ? { error: latestSnap.lastError } : {}),
        };
      }
    }

    return {
      transactionId: snapshot.transactionId,
      previousState,
      currentState: workingState,
      status: finalStatus,
      value: lastReturnValue,
      context: workingContext,
      compensatedSteps: 0,
    };
  }

  private async unwindCompensationStack(
    transactionId: string,
    currentContext: TContext,
    failureError?: string
  ): Promise<{ updatedContext: TContext; compensatedCount: number }> {
    const stack = await this.store.getUncompensatedStack(transactionId);
    let ctx = currentContext;
    let count = 0;

    // `getUncompensatedStack` already returns entries ordered `stepSeq DESC` (strict LIFO)
    for (const entry of stack) {
      const resolvedComp = this.handlers.resolveCompensate(
        entry.compensateKey,
        this.machine.registry.namespace
      );
      if (resolvedComp) {
        const updated = await resolvedComp.fn({
          transactionId,
          machineId: this.machine.id,
          actorId: this.actorId,
          stepSeq: entry.stepSeq,
          fromState: entry.fromState,
          inputSnapshot: entry.inputSnapshot,
          contextBefore: entry.contextBefore as TContext,
          currentContext: ctx,
          failureError,
        });
        if (updated !== undefined) {
          ctx = updated as TContext;
        }
      }
      await this.store.markCompensationExecuted(transactionId, entry.stepSeq, this.clock.now());
      await this.emitOnCompensate({
        transactionId,
        machineId: this.machine.id,
        actorId: this.actorId,
        stepSeq: entry.stepSeq,
        compensateHandler: resolvedComp?.resolvedName ?? entry.compensateKey,
        fromState: entry.fromState,
        inputSnapshot: entry.inputSnapshot,
        updatedContext: ctx,
        reason: failureError,
        actor: this,
      });
      count++;
    }

    return { updatedContext: ctx, compensatedCount: count };
  }

  private async invokeSingleEffect(
    transactionId: string,
    fallbackState: StateValue,
    fallbackContext: TContext,
    handlerName: string,
    payload: unknown,
    baselineRevision: number
  ): Promise<void> {
    const resolved = this.handlers.resolveEffect(handlerName, this.machine.registry.namespace);
    if (!resolved) {
      if (this.machine.registry.strict) {
        throw new UnregisteredHandlerError(this.machine.id, [
          qualifyHandlerName(handlerName, this.machine.registry.namespace),
        ]);
      }
      return;
    }

    const nextDepth = (this.effectChainDepthByTx.get(transactionId) ?? 0) + 1;
    if (nextDepth > this.maxEffectChainDepth) {
      throw new DfsmError(
        "DFSM_MAX_EFFECT_CHAIN_DEPTH",
        `Effect / automatic transition chain exceeded maximum depth (${this.maxEffectChainDepth}) for transaction '${transactionId}' while invoking effect '${resolved.resolvedName}'`
      );
    }

    let effectiveState = fallbackState;
    let effectiveContext = fallbackContext;
    if (this.getTransitionRevision(transactionId) !== baselineRevision) {
      const latest = await this.store.getTransaction<TContext>(transactionId);
      if (latest) {
        effectiveState = latest.stateValue;
        effectiveContext = latest.context;
      }
    }

    this.effectChainDepthByTx.set(transactionId, nextDepth);
    try {
      await resolved.fn({
        transactionId,
        machineId: this.machine.id,
        actorId: this.actorId,
        state: effectiveState,
        context: effectiveContext,
        payload,
        actor: this,
        runEffect: async (subEffectName: string, subPayload?: unknown) => {
          await this.invokeSingleEffect(
            transactionId,
            effectiveState,
            effectiveContext,
            subEffectName,
            subPayload,
            baselineRevision
          );
        },
      });
    } finally {
      const remaining = (this.effectChainDepthByTx.get(transactionId) ?? 1) - 1;
      if (remaining <= 0) {
        this.effectChainDepthByTx.delete(transactionId);
      } else {
        this.effectChainDepthByTx.set(transactionId, remaining);
      }
    }
  }

  private async invokeEffects(
    transactionId: string,
    state: StateValue,
    context: TContext,
    effects: Array<string | EffectInvocation>
  ): Promise<void> {
    const baselineRevision = this.getTransitionRevision(transactionId);
    for (const item of effects) {
      const handlerName = typeof item === "string" ? item : item.handler;
      const payload = typeof item === "string" ? undefined : item.payload;
      await this.invokeSingleEffect(
        transactionId,
        state,
        context,
        handlerName,
        payload,
        baselineRevision
      );
    }
  }

  private resolveRecoveryModeForState(stateValue: StateValue): OnRestartMode {
    const topKey =
      typeof stateValue === "string" ? stateValue : Object.keys(stateValue)[0] ?? "";
    if (topKey && this.recoveryConfig.stateActions[topKey]) {
      return this.recoveryConfig.stateActions[topKey]!;
    }
    const serialized = typeof stateValue === "string" ? stateValue : JSON.stringify(stateValue);
    if (this.recoveryConfig.stateActions[serialized]) {
      return this.recoveryConfig.stateActions[serialized]!;
    }
    return this.recoveryConfig.defaultAction;
  }

  private async executeRecoverySweep(stuckThresholdMs: number): Promise<RecoverySweepReport> {
    const now = this.clock.now();
    const report: RecoverySweepReport = {
      sweptAt: now,
      scannedInFlight: 0,
      stuckDetected: 0,
      actionsTaken: {
        STOP: [],
        MARK_FAIL: [],
        DELETE: [],
        COMPENSATE: [],
        CONTINUE: [],
      },
      retentionDeleted: 0,
      errors: [],
    };

    const inFlightList = await this.store.queryTransactions<TContext>(
      {
        machineId: this.machine.id,
        statuses: ["IN_FLIGHT", "COMPENSATING"],
        limit: this.schedulerConfig.batchSize,
      },
      now,
      stuckThresholdMs
    );

    report.scannedInFlight = inFlightList.length;
    const stopIds: string[] = [];

    for (const item of inFlightList) {
      if (!item.isStuck) continue;
      report.stuckDetected++;

      const action = this.resolveRecoveryModeForState(item.stateValue);

      try {
        switch (action) {
          case "STOP": {
            report.actionsTaken.STOP.push(item.transactionId);
            stopIds.push(item.transactionId);
            await this.logger.logRecovery?.(
              this.actorId,
              `Stuck transaction '${item.transactionId}' encountered STOP policy`,
              { state: item.stateValue }
            );
            break;
          }

          case "DELETE": {
            await this.store.deleteTransactions([item.transactionId]);
            report.actionsTaken.DELETE.push(item.transactionId);
            break;
          }

          case "MARK_FAIL": {
            await this.store.updateTransaction(item.transactionId, item.version, {
              stateValue: "error",
              status: "FAILED",
              activeStep: null,
              lastError: "Marked FAILED by Actor stuck-transaction recovery",
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: this.clock.now(),
            });
            report.actionsTaken.MARK_FAIL.push(item.transactionId);
            break;
          }

          case "COMPENSATE": {
            let ver = await this.store.updateTransaction(item.transactionId, item.version, {
              status: "COMPENSATING",
              updatedAt: this.clock.now(),
            });
            const unwound = await this.unwindCompensationStack(
              item.transactionId,
              item.context,
              "Compensated by Actor stuck-transaction recovery"
            );
            ver = await this.store.updateTransaction(item.transactionId, ver, {
              stateValue: "error",
              context: unwound.updatedContext,
              status: "COMPENSATED",
              activeStep: null,
              lastError: "Compensated by Actor stuck-transaction recovery",
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: this.clock.now(),
            });
            void ver;
            report.actionsTaken.COMPENSATE.push(item.transactionId);
            break;
          }

          case "CONTINUE": {
            const fullSnap = await this.store.getTransaction<TContext>(item.transactionId);
            if (!fullSnap) break;

            if (fullSnap.activeStep) {
              // Restore IDLE lock first, then replay the interrupted active step!
              const unlockedVer = await this.store.updateTransaction(
                fullSnap.transactionId,
                fullSnap.version,
                {
                  status: "IDLE",
                  activeStep: null,
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  updatedAt: this.clock.now(),
                }
              );
              const refreshed = { ...fullSnap, status: "IDLE" as const, version: unlockedVer };
              await this.executeTransitionOnSnapshot(
                refreshed,
                fullSnap.activeStep.event,
                fullSnap.activeStep.input,
                { recoveredByActor: this.actorId }
              );
            } else {
              await this.store.updateTransaction(fullSnap.transactionId, fullSnap.version, {
                status: "IDLE",
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: this.clock.now(),
              });
            }
            report.actionsTaken.CONTINUE.push(item.transactionId);
            break;
          }
        }
      } catch (err) {
        report.errors.push({
          transactionId: item.transactionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Optional retention cleanup for terminal transactions
    if (this.schedulerConfig.retentionMs !== undefined && this.schedulerConfig.retentionMs >= 0) {
      const cutoff = now - this.schedulerConfig.retentionMs;
      const expiredTerminal = await this.store.queryTransactions(
        {
          machineId: this.machine.id,
          statuses: ["COMPLETED", "FAILED", "COMPENSATED"],
          olderThanTimestamp: cutoff,
          limit: this.schedulerConfig.batchSize,
        },
        now,
        stuckThresholdMs
      );
      if (expiredTerminal.length > 0) {
        report.retentionDeleted = await this.store.deleteTransactions(
          expiredTerminal.map((t) => t.transactionId)
        );
      }
    }

    this.lastRunAt = now;
    this.totalSweeps++;
    this.totalRecoveredCount +=
      report.actionsTaken.DELETE.length +
      report.actionsTaken.MARK_FAIL.length +
      report.actionsTaken.COMPENSATE.length +
      report.actionsTaken.CONTINUE.length;
    this.totalRetentionCleanedCount += report.retentionDeleted;
    this.lastSweepReport = report;

    if (stopIds.length > 0 && this.recoveryConfig.haltActorOnStop) {
      this.stoppedByRecovery = true;
      throw new ActorStoppedByRecoveryError(this.actorId, stopIds);
    }

    return report;
  }

  // ==========================================================================
  // Operational Introspection, Scheduler Control & Force Cleanup APIs
  // ==========================================================================

  getActorConfig(): Readonly<ResolvedActorConfiguration> {
    return Object.freeze({
      actorId: this.actorId,
      machineId: this.machine.id,
      machineVersion: this.machine.version,
      storeDriver: this.store.driverName,
      hasContextValidator: Boolean(this.contextValidator),
      recovery: {
        ...this.recoveryConfig,
        stateActions: { ...this.recoveryConfig.stateActions },
      },
      scheduler: { ...this.schedulerConfig },
    });
  }

  getLoadedMachine(): {
    definition: Readonly<MachineDefinition>;
    effectiveConfig: EffectiveMachineConfig;
  } {
    return {
      definition: this.machine,
      effectiveConfig: this.getEffectiveConfig(),
    };
  }

  getEffectiveConfig(): EffectiveMachineConfig {
    const transitions: EffectiveTransitionConfig[] = [];
    for (const b of this.compiledBindings.values()) {
      if (b.event === "$onDone" && !b.edge.transition && !b.edge.target) continue;
      transitions.push({
        statePath: b.statePath,
        event: b.event,
        target: b.edge.target,
        resolvedTransitionHandler: b.resolvedTransitionName,
        resolvedCompensateHandler: b.resolvedCompensateName,
        policy: structuredClonePolicy(b.policy),
        circuitBreakerState: this.breakerManager.getStatus(b.policy.circuitBreaker.key),
      });
    }
    return {
      machineId: this.machine.id,
      version: this.machine.version,
      source: this.machine.source,
      hasCustomErrorState: this.machine.hasCustomErrorState,
      maxEffectChainDepth: this.maxEffectChainDepth,
      resolvedHooks: structuredCloneHooksMap(this.resolvedHookNames),
      registeredEffects: [...this.resolvedEffectNames],
      transitions,
    };
  }

  resetCircuitBreaker(key?: string): void {
    this.breakerManager.reset(key);
  }

  /**
   * Lists all valid event names accepted from `stateValue` on this actor's machine.
   */
  getAvailableEvents(stateValue: StateValue): string[] {
    return getAvailableEvents(this.machine, stateValue);
  }

  /**
   * Returns all terminal (`type: "final"`) and `error` states defined on this actor's machine,
   * along with the canonical terminal (`COMPLETED`, `COMPENSATED`, `FAILED`) and non-terminal
   * (`IDLE`, `IN_FLIGHT`, `COMPENSATING`) status sets.
   */
  getTerminalStates(): MachineTerminalStatesSummary {
    const states = getTerminalStates(this.machine);
    return {
      machineId: this.machine.id,
      terminalStatuses: TERMINAL_STATUSES,
      nonTerminalStatuses: NON_TERMINAL_STATUSES,
      topLevelTerminalStates: states.filter((s) => s.isTopLevel).map((s) => s.path),
      states,
    };
  }

  /**
   * Counts all **non-terminal** transactions (`IDLE`, `IN_FLIGHT`, `COMPENSATING`) for this
   * actor's machine — including transactions paused in an intermediate `IDLE` state awaiting
   * their next event.
   */
  async getActiveCount(filter?: { state?: StateValue }): Promise<number> {
    await this.store.initialize();
    return this.store.countTransactions({
      machineId: this.machine.id,
      statuses: [...NON_TERMINAL_STATUSES],
      ...(filter?.state !== undefined ? { stateEquals: filter.state } : {}),
    });
  }

  /**
   * Lists all **non-terminal** transactions (`IDLE`, `IN_FLIGHT`, `COMPENSATING`) for this
   * actor's machine, ordered by `updatedAt DESC`.
   */
  async listActiveTransactions(options?: {
    limit?: number;
    offset?: number;
  }): Promise<TransactionSummary<TContext>[]> {
    await this.store.initialize();
    const now = this.clock.now();
    return this.store.queryTransactions<TContext>(
      {
        machineId: this.machine.id,
        statuses: [...NON_TERMINAL_STATUSES],
        limit: options?.limit,
        offset: options?.offset,
      },
      now,
      this.recoveryConfig.stuckThresholdMs
    );
  }

  /**
   * Queries transactions for this actor's machine filtered by optional `statuses`.
   */
  async listTransactions(options?: {
    statuses?: TransactionStatus[];
    limit?: number;
    offset?: number;
  }): Promise<TransactionSummary<TContext>[]> {
    await this.store.initialize();
    const now = this.clock.now();
    return this.store.queryTransactions<TContext>(
      {
        machineId: this.machine.id,
        ...(options?.statuses ? { statuses: options.statuses } : {}),
        limit: options?.limit,
        offset: options?.offset,
      },
      now,
      this.recoveryConfig.stuckThresholdMs
    );
  }

  /**
   * Returns a live breakdown of transaction counts across all 6 `TransactionStatus` values,
   * grouped into `nonTerminalCount` (`IDLE + IN_FLIGHT + COMPENSATING`) and
   * `terminalCount` (`COMPLETED + COMPENSATED + FAILED`).
   */
  async getStatusBreakdown(): Promise<StatusBreakdown> {
    await this.store.initialize();
    const allStatuses: TransactionStatus[] = [
      "IDLE",
      "IN_FLIGHT",
      "COMPENSATING",
      "COMPLETED",
      "COMPENSATED",
      "FAILED",
    ];
    const counts = await Promise.all(
      allStatuses.map((status) =>
        this.store.countTransactions({
          machineId: this.machine.id,
          statuses: [status],
        })
      )
    );
    const byStatus = {
      IDLE: counts[0] ?? 0,
      IN_FLIGHT: counts[1] ?? 0,
      COMPENSATING: counts[2] ?? 0,
      COMPLETED: counts[3] ?? 0,
      COMPENSATED: counts[4] ?? 0,
      FAILED: counts[5] ?? 0,
    };
    return {
      nonTerminalCount: byStatus.IDLE + byStatus.IN_FLIGHT + byStatus.COMPENSATING,
      terminalCount: byStatus.COMPLETED + byStatus.COMPENSATED + byStatus.FAILED,
      byStatus,
    };
  }

  async getInFlightCount(filter?: {
    stuckOnly?: boolean;
    state?: StateValue;
    includeCompensating?: boolean;
  }): Promise<number> {
    await this.store.initialize();
    const statuses: TransactionStatus[] =
      filter?.includeCompensating === false ? ["IN_FLIGHT"] : ["IN_FLIGHT", "COMPENSATING"];

    return this.store.countTransactions({
      machineId: this.machine.id,
      statuses,
      ...(filter?.stuckOnly
        ? { stuckBeforeTimestamp: this.clock.now() - this.recoveryConfig.stuckThresholdMs }
        : {}),
      ...(filter?.state !== undefined ? { stateEquals: filter.state } : {}),
    });
  }

  async listInFlightTransactions(options?: {
    stuckOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<TransactionSummary<TContext>[]> {
    await this.store.initialize();
    const now = this.clock.now();
    return this.store.queryTransactions<TContext>(
      {
        machineId: this.machine.id,
        statuses: ["IN_FLIGHT", "COMPENSATING"],
        ...(options?.stuckOnly
          ? { stuckBeforeTimestamp: now - this.recoveryConfig.stuckThresholdMs }
          : {}),
        limit: options?.limit,
        offset: options?.offset,
      },
      now,
      this.recoveryConfig.stuckThresholdMs
    );
  }

  async getTransaction(transactionId: string): Promise<TransactionSnapshot<TContext> | null> {
    await this.store.initialize();
    const snap = await this.store.getTransaction<TContext>(transactionId);
    if (!snap || snap.machineId !== this.machine.id) return null;
    return snap;
  }

  getSchedulerConfig(): Readonly<ActorSchedulerConfig> {
    return Object.freeze({ ...this.schedulerConfig });
  }

  getSchedulerStatus(): SchedulerStatus {
    return {
      isRunning: this.schedulerTimer !== null,
      config: this.getSchedulerConfig(),
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      totalSweeps: this.totalSweeps,
      totalRecoveredCount: this.totalRecoveredCount,
      totalRetentionCleanedCount: this.totalRetentionCleanedCount,
      lastSweepReport: this.lastSweepReport,
    };
  }

  updateSchedulerConfig(patch: Partial<ActorSchedulerConfig>): Readonly<ActorSchedulerConfig> {
    const wasRunning = this.schedulerTimer !== null;
    if (wasRunning) {
      this.stopScheduler();
    }

    this.schedulerConfig = {
      ...this.schedulerConfig,
      ...patch,
    };

    if (this.schedulerConfig.enabled) {
      this.startScheduler();
    }

    return this.getSchedulerConfig();
  }

  startScheduler(): void {
    if (this.schedulerTimer !== null) return;
    this.schedulerConfig.enabled = true;
    const interval = Math.max(25, this.schedulerConfig.sweepIntervalMs);
    this.nextRunAt = this.clock.now() + interval;

    this.schedulerTimer = setInterval(() => {
      if (this.sweepInProgress) return;
      this.sweepInProgress = true;
      this.executeRecoverySweep(this.schedulerConfig.stuckThresholdMs)
        .catch((err) => {
          void this.logger.logRecovery?.(
            this.actorId,
            `Background scheduler sweep failed: ${err instanceof Error ? err.message : String(err)}`
          );
        })
        .finally(() => {
          this.sweepInProgress = false;
          if (this.schedulerTimer !== null) {
            this.nextRunAt = this.clock.now() + interval;
          }
        });
    }, interval);

    this.schedulerTimer.unref?.();
  }

  stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.nextRunAt = null;
  }

  async triggerSweepNow(): Promise<RecoverySweepReport> {
    await this.store.initialize();
    return this.executeRecoverySweep(this.schedulerConfig.stuckThresholdMs);
  }

  async forceCleanUpTransaction(
    transactionId: string,
    action: CleanUpAction = "DELETE"
  ): Promise<CleanUpReport> {
    return this.forceCleanUp({
      transactionIds: [transactionId],
      includeInFlight: true,
      action,
    });
  }

  async forceCleanUp(options?: Omit<ForceCleanUpOptions, "machineId">): Promise<CleanUpReport> {
    await this.store.initialize();
    const now = this.clock.now();
    const action: CleanUpAction = options?.action ?? "DELETE";
    const dryRun = options?.dryRun ?? false;
    const includeInFlight = options?.includeInFlight ?? false;
    const threshold = options?.stuckThresholdMs ?? this.recoveryConfig.stuckThresholdMs;

    const statuses: TransactionStatus[] =
      options?.statuses ??
      (includeInFlight
        ? ["IDLE", "IN_FLIGHT", "COMPENSATING", "COMPLETED", "FAILED", "COMPENSATED"]
        : ["COMPLETED", "FAILED", "COMPENSATED"]);

    const candidates = await this.store.queryTransactions<TContext>(
      {
        machineId: this.machine.id,
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

    if (dryRun || candidates.length === 0) {
      return report;
    }

    if (action === "DELETE") {
      const ids = candidates.map((c) => c.transactionId);
      await this.store.deleteTransactions(ids);
      report.deleted.push(...ids);
      return report;
    }

    for (const item of candidates) {
      try {
        if (action === "MARK_FAIL") {
          await this.store.updateTransaction(item.transactionId, item.version, {
            stateValue: "error",
            status: "FAILED",
            activeStep: null,
            lastError: "Marked FAILED via administrative forceCleanUp",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: this.clock.now(),
          });
          report.markedFailed.push(item.transactionId);
        } else if (action === "FORCE_UNLOCK") {
          await this.store.updateTransaction(item.transactionId, item.version, {
            status: "IDLE",
            activeStep: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: this.clock.now(),
          });
          report.unlocked.push(item.transactionId);
        } else if (action === "COMPENSATE") {
          const ver = await this.store.updateTransaction(item.transactionId, item.version, {
            status: "COMPENSATING",
            updatedAt: this.clock.now(),
          });
          const unwound = await this.unwindCompensationStack(
            item.transactionId,
            item.context,
            "Compensated via administrative forceCleanUp"
          );
          await this.store.updateTransaction(item.transactionId, ver, {
            stateValue: "error",
            context: unwound.updatedContext,
            status: "COMPENSATED",
            activeStep: null,
            lastError: "Compensated via administrative forceCleanUp",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: this.clock.now(),
          });
          report.compensated.push(item.transactionId);
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

  async close(): Promise<void> {
    this.stopScheduler();
    this.onCloseCallback?.(this.actorId);
  }

  private safeClone<V>(val: V): V {
    try {
      return structuredClone(val);
    } catch {
      return val;
    }
  }
}

function structuredCloneHooksMap(
  hooks: Partial<Record<LifecycleHookName, string[]>>
): Partial<Record<LifecycleHookName, string[]>> {
  const out: Partial<Record<LifecycleHookName, string[]>> = {};
  for (const [k, v] of Object.entries(hooks) as Array<[LifecycleHookName, string[] | undefined]>) {
    if (v) out[k] = [...v];
  }
  return out;
}

function structuredClonePolicy(policy: NormalizedTransitionPolicy): NormalizedTransitionPolicy {
  return {
    retry: {
      maxAttempts: policy.retry.maxAttempts,
      backoff: { ...policy.retry.backoff },
      ...(policy.retry.retryIf ? { retryIf: policy.retry.retryIf } : {}),
    },
    circuitBreaker: { ...policy.circuitBreaker },
    onFail: { ...policy.onFail },
    benchmark: { ...policy.benchmark },
    ...(policy.compensateHandler ? { compensateHandler: policy.compensateHandler } : {}),
  };
}

