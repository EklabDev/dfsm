package io.github.eklabdev.dfsm.runtime;

import io.github.eklabdev.dfsm.ActorLifecycleHooks;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.AfterTransitionEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.BeforeTransitionEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnCompensateEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnCompleteEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnStartEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnTerminalEvent;
import io.github.eklabdev.dfsm.Clock;
import io.github.eklabdev.dfsm.CompensationRequest;
import io.github.eklabdev.dfsm.DfsmModels.ActiveStepInfo;
import io.github.eklabdev.dfsm.DfsmModels.CompensationEntryRecord;
import io.github.eklabdev.dfsm.DfsmModels.EffectiveMachineConfig;
import io.github.eklabdev.dfsm.DfsmModels.EffectiveTransitionConfig;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpAction;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpOptions;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpReport;
import io.github.eklabdev.dfsm.DfsmModels.InFlightFilter;
import io.github.eklabdev.dfsm.DfsmModels.OnRestartMode;
import io.github.eklabdev.dfsm.DfsmModels.RecoveryConfig;
import io.github.eklabdev.dfsm.DfsmModels.SchedulerConfig;
import io.github.eklabdev.dfsm.DfsmModels.SchedulerStatus;
import io.github.eklabdev.dfsm.DfsmModels.StatusBreakdown;
import io.github.eklabdev.dfsm.DfsmModels.SweepReport;
import io.github.eklabdev.dfsm.DfsmModels.TerminalStatesInfo;
import io.github.eklabdev.dfsm.DfsmModels.TransactionRecord;
import io.github.eklabdev.dfsm.DfsmModels.TransactionSnapshot;
import io.github.eklabdev.dfsm.DfsmModels.TransactionSummary;
import io.github.eklabdev.dfsm.EffectRequest;
import io.github.eklabdev.dfsm.JsonCodec;
import io.github.eklabdev.dfsm.LifecycleHookFunction;
import io.github.eklabdev.dfsm.LifecycleHookName;
import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.TransitionExecutionResult;
import io.github.eklabdev.dfsm.definition.MachineDefinition;
import io.github.eklabdev.dfsm.definition.MachineDefinition.StateNodeIR;
import io.github.eklabdev.dfsm.definition.MachineDefinition.TransitionEdgeIR;
import io.github.eklabdev.dfsm.engine.StatechartEngine;
import io.github.eklabdev.dfsm.engine.StatechartEngine.AppliedTransition;
import io.github.eklabdev.dfsm.engine.StatechartEngine.InitialResolution;
import io.github.eklabdev.dfsm.engine.StatechartEngine.MatchedTransition;
import io.github.eklabdev.dfsm.error.DfsmException;
import io.github.eklabdev.dfsm.error.InvalidTransitionException;
import io.github.eklabdev.dfsm.error.MaxEffectChainDepthException;
import io.github.eklabdev.dfsm.error.TransactionNotFoundException;
import io.github.eklabdev.dfsm.error.UnregisteredHandlerException;
import io.github.eklabdev.dfsm.policy.CircuitBreakerInstance;
import io.github.eklabdev.dfsm.policy.DecoratedPipeline;
import io.github.eklabdev.dfsm.policy.DecoratedPipeline.ExecutionContext;
import io.github.eklabdev.dfsm.policy.DecoratedPipeline.ExecutionOutcome;
import io.github.eklabdev.dfsm.policy.DecoratedPipeline.FinalResolution;
import io.github.eklabdev.dfsm.policy.NormalizedTransitionPolicy;
import io.github.eklabdev.dfsm.policy.PolicyMerger;
import io.github.eklabdev.dfsm.runtime.HandlerResolver.ResolvedCompensation;
import io.github.eklabdev.dfsm.runtime.HandlerResolver.ResolvedEffect;
import io.github.eklabdev.dfsm.runtime.HandlerResolver.ResolvedHook;
import io.github.eklabdev.dfsm.runtime.HandlerResolver.ResolvedTransition;
import io.github.eklabdev.dfsm.store.StateStore;
import io.github.eklabdev.dfsm.store.StateStore.NewCompensationEntry;
import io.github.eklabdev.dfsm.store.StateStore.StatusQueryFilter;
import io.github.eklabdev.dfsm.store.StateStore.TransactionPatch;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import io.github.eklabdev.dfsm.validation.JakartaSchemaValidator;
import io.github.eklabdev.dfsm.validation.SchemaValidator;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Durable Finite State Machine Actor owning a compiled {@link MachineDefinition},
 * generic {@code TContext} codec &amp; Jakarta validator, deduplicated GoF resilience pipelines,
 * Saga LIFO compensation stack, lifecycle hooks, conditional effect routing, and recovery scheduler.
 */
public final class DfsmActor<TContext> implements AutoCloseable {
    public static final int DEFAULT_MAX_EFFECT_CHAIN_DEPTH = 25;

    private record CompiledBinding<TContext>(
            String statePath,
            TransitionEdgeIR edge,
            String resolvedTransitionName,
            String resolvedCompensateName,
            NormalizedTransitionPolicy policy,
            CircuitBreakerInstance breaker,
            DecoratedPipeline<TContext, Object, Object> pipeline
    ) {}

    private record EffectInvocation(String name, Object payload) {}

    private final String actorId;
    private final MachineDefinition machine;
    private final Class<TContext> contextClass;
    private final StateStore store;
    private final HandlerResolver handlers;
    private final Clock clock;
    private final BenchmarkLogEngine logger;
    private final SchemaValidator<TContext> contextValidator;
    private final RecoveryConfig recoveryConfig;
    private volatile SchedulerConfig schedulerConfig;
    private final int maxEffectChainDepth;
    private final Runnable onCloseCallback;

    private final Map<String, CompiledBinding<TContext>> compiledBindings = new LinkedHashMap<>();
    private final List<ActorLifecycleHooks<TContext>> hookSubscribers = new CopyOnWriteArrayList<>();
    private final Map<LifecycleHookName, List<String>> resolvedMachineHooks = new EnumMap<>(LifecycleHookName.class);
    private final Set<String> registeredEffectNames = new TreeSet<>();

    private final Map<String, Integer> effectChainDepthByTx = new ConcurrentHashMap<>();
    private final Map<String, Long> txTransitionRevision = new ConcurrentHashMap<>();

    private ScheduledExecutorService schedulerExecutor;
    private ScheduledFuture<?> scheduledTask;
    private volatile Long lastSweepAt;
    private volatile Long nextSweepAt;
    private volatile SweepReport lastSweepReport;
    private volatile boolean initialized = false;
    private volatile boolean closed = false;

    public DfsmActor(
            MachineDefinition machine,
            Class<TContext> contextClass,
            HandlerResolver handlers,
            StateStore defaultStore,
            BenchmarkLogEngine defaultLogger,
            Clock defaultClock,
            List<ActorLifecycleHooks<Object>> globalHooks,
            ActorConfig<TContext> config,
            Runnable onCloseCallback
    ) {
        ActorConfig<TContext> cfg = config != null ? config : ActorConfig.defaults();
        this.actorId = cfg.actorId() != null && !cfg.actorId().isBlank()
                ? cfg.actorId()
                : machine.id() + "-actor-" + UUID.randomUUID().toString().substring(0, 8);
        this.machine = machine;
        this.contextClass = contextClass != null ? contextClass : uncheckedObjectClass();
        this.handlers = handlers;
        this.store = cfg.store() != null ? cfg.store() : defaultStore;
        this.clock = cfg.clock() != null ? cfg.clock() : defaultClock;
        this.logger = cfg.logEngine() != null ? cfg.logEngine() : defaultLogger;
        this.recoveryConfig = cfg.recovery() != null ? cfg.recovery() : RecoveryConfig.defaults();
        this.schedulerConfig = cfg.scheduler() != null ? cfg.scheduler() : SchedulerConfig.defaults();
        this.maxEffectChainDepth = cfg.maxEffectChainDepth() != null
                ? cfg.maxEffectChainDepth()
                : (machine.maxEffectChainDepth() != null ? machine.maxEffectChainDepth() : DEFAULT_MAX_EFFECT_CHAIN_DEPTH);
        this.onCloseCallback = onCloseCallback;

        if (cfg.contextValidator() != null) {
            this.contextValidator = cfg.contextValidator();
        } else if (!cfg.disableDefaultJakartaValidation()
                && this.contextClass != Object.class
                && !Map.class.isAssignableFrom(this.contextClass)) {
            this.contextValidator = JakartaSchemaValidator.shared();
        } else {
            this.contextValidator = null;
        }

        // 1. Global FSMRegistry hooks
        if (globalHooks != null) {
            for (ActorLifecycleHooks<Object> gh : globalHooks) {
                if (gh != null) {
                    this.hookSubscribers.add(adaptGlobalHook(gh));
                }
            }
        }

        // 2. Compile transitions, compensations, effects, and YAML/Builder hooks (strictly validated!)
        compileMachineBindings();

        // 3. ActorConfig inline hooks
        if (cfg.hooks() != null) {
            this.hookSubscribers.add(cfg.hooks());
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> Class<T> uncheckedObjectClass() {
        return (Class<T>) Object.class;
    }

    @SuppressWarnings("unchecked")
    private ActorLifecycleHooks<TContext> adaptGlobalHook(ActorLifecycleHooks<Object> g) {
        return new ActorLifecycleHooks<>(
                g.onStart() != null ? e -> g.onStart().onHook((OnStartEvent<Object>) (Object) e) : null,
                g.beforeTransition() != null ? e -> g.beforeTransition().onHook((BeforeTransitionEvent<Object>) (Object) e) : null,
                g.afterTransition() != null ? e -> g.afterTransition().onHook((AfterTransitionEvent<Object>) (Object) e) : null,
                g.onCompensate() != null ? e -> g.onCompensate().onHook((OnCompensateEvent<Object>) (Object) e) : null,
                g.onComplete() != null ? e -> g.onComplete().onHook((OnCompleteEvent<Object>) (Object) e) : null,
                g.onTerminal() != null ? e -> g.onTerminal().onHook((OnTerminalEvent<Object>) (Object) e) : null
        );
    }

    private String bindingKey(String statePath, String event) {
        return statePath + "::" + event;
    }

    private void compileMachineBindings() {
        String ns = machine.registry().namespace();
        boolean strict = machine.registry().strict();

        for (StateNodeIR state : machine.states().values()) {
            compileNodeRecursive(state, ns, strict);
        }

        // Validate machine-level routed sub-effects (`effects: [...]` in YAML / MachineBuilder)
        for (String eff : machine.effects()) {
            ResolvedEffect resolved = handlers.resolveEffect(eff, ns);
            if (resolved == null && strict) {
                throw new UnregisteredHandlerException(
                        machine.id(), "effect", MachineDefinition.qualifyHandlerName(eff, ns)
                );
            }
            if (resolved != null) {
                registeredEffectNames.add(resolved.resolvedName());
            }
        }

        // Resolve & bind YAML/Builder-declared `hooks:` (`@DfsmHook`)
        ActorLifecycleHooks.Builder<TContext> yamlHookBuilder = ActorLifecycleHooks.builder();
        boolean anyYamlHooks = false;

        for (LifecycleHookName slot : LifecycleHookName.values()) {
            List<String> names = machine.hooks().get(slot);
            if (names == null || names.isEmpty()) continue;

            List<LifecycleHookFunction<Object>> fns = new ArrayList<>();
            List<String> resolvedIds = new ArrayList<>();
            for (String hookRef : names) {
                ResolvedHook rh = handlers.resolveHook(hookRef, ns);
                if (rh == null) {
                    if (strict) {
                        throw new UnregisteredHandlerException(
                                machine.id(), "hook (" + slot.yamlKey() + ")",
                                MachineDefinition.qualifyHandlerName(hookRef, ns)
                        );
                    }
                    continue;
                }
                fns.add(rh.fn());
                resolvedIds.add(rh.resolvedName());
            }

            if (!fns.isEmpty()) {
                anyYamlHooks = true;
                resolvedMachineHooks.put(slot, List.copyOf(resolvedIds));
                LifecycleHookFunction<Object> chained = evt -> {
                    for (LifecycleHookFunction<Object> fn : fns) {
                        fn.onHook(evt);
                    }
                };
                switch (slot) {
                    case ON_START -> yamlHookBuilder.onStart(chained::onHook);
                    case BEFORE_TRANSITION -> yamlHookBuilder.beforeTransition(chained::onHook);
                    case AFTER_TRANSITION -> yamlHookBuilder.afterTransition(chained::onHook);
                    case ON_COMPENSATE -> yamlHookBuilder.onCompensate(chained::onHook);
                    case ON_COMPLETE -> yamlHookBuilder.onComplete(chained::onHook);
                    case ON_TERMINAL -> yamlHookBuilder.onTerminal(chained::onHook);
                }
            }
        }

        if (anyYamlHooks) {
            this.hookSubscribers.add(yamlHookBuilder.build());
        }
    }

    private void compileNodeRecursive(StateNodeIR node, String ns, boolean strict) {
        for (String eff : node.entry()) {
            verifyEffect(eff, ns, strict);
        }
        for (String eff : node.exit()) {
            verifyEffect(eff, ns, strict);
        }

        for (Map.Entry<String, TransitionEdgeIR> e : node.on().entrySet()) {
            compileEdge(node.path(), e.getKey(), e.getValue(), ns, strict);
        }
        if (node.onDone() != null) {
            compileEdge(node.path(), "$onDone", node.onDone(), ns, strict);
        }

        for (StateNodeIR child : node.states().values()) {
            compileNodeRecursive(child, ns, strict);
        }
    }

    private void verifyEffect(String eff, String ns, boolean strict) {
        ResolvedEffect resolved = handlers.resolveEffect(eff, ns);
        if (resolved == null && strict) {
            throw new UnregisteredHandlerException(
                    machine.id(), "effect", MachineDefinition.qualifyHandlerName(eff, ns)
            );
        }
        if (resolved != null) {
            registeredEffectNames.add(resolved.resolvedName());
        }
    }

    private void compileEdge(String statePath, String event, TransitionEdgeIR edge, String ns, boolean strict) {
        ResolvedTransition resolvedTransition = null;
        if (edge.transition() != null && !edge.transition().isBlank()) {
            resolvedTransition = handlers.resolveTransition(edge.transition(), ns);
            if (resolvedTransition == null && strict) {
                throw new UnregisteredHandlerException(
                        machine.id(), "transition", MachineDefinition.qualifyHandlerName(edge.transition(), ns)
                );
            }
        }

        NormalizedTransitionPolicy normalized = PolicyMerger.normalize(
                handlers.globalDefaultPolicy(),
                machine.defaults(),
                edge.policy(),
                resolvedTransition != null ? resolvedTransition.decoratorPolicy() : null
        );

        String compRef = normalized.compensateHandler() != null
                ? normalized.compensateHandler()
                : edge.compensate();
        String resolvedCompName = null;
        if (compRef != null && !compRef.isBlank()) {
            ResolvedCompensation rc = handlers.resolveCompensate(compRef, ns);
            if (rc == null && strict) {
                throw new UnregisteredHandlerException(
                        machine.id(), "compensate", MachineDefinition.qualifyHandlerName(compRef, ns)
                );
            }
            resolvedCompName = rc != null ? rc.resolvedName() : compRef;
        }

        for (String eff : edge.effects()) {
            verifyEffect(eff, ns, strict);
        }

        String key = bindingKey(statePath, event);
        CircuitBreakerInstance breaker = new CircuitBreakerInstance(
                machine.id() + ":" + key,
                normalized.circuitBreaker(),
                clock
        );

        final HandlerResolver.ResolvedTransition targetTransition = resolvedTransition;
        DecoratedPipeline<TContext, Object, Object> pipeline = new DecoratedPipeline<>(
                targetTransition != null
                        ? req -> uncheckedCastOutput(resolvedTransitionInvocable(targetTransition, req))
                        : null,
                normalized,
                breaker,
                clock,
                logger,
                contextClass,
                contextValidator,
                resolvedTransition != null ? resolvedTransition.inputClass() : null,
                resolvedTransition != null ? resolvedTransition.inputValidator() : null
        );

        compiledBindings.put(key, new CompiledBinding<>(
                statePath,
                edge,
                resolvedTransition != null ? resolvedTransition.resolvedName() : null,
                resolvedCompName,
                normalized,
                breaker,
                pipeline
        ));
    }

    @SuppressWarnings("unchecked")
    private static <TContext> Object resolvedTransitionInvocable(
            ResolvedTransition rt,
            io.github.eklabdev.dfsm.TransitionRequest<TContext, Object> req
    ) throws Exception {
        return rt.fn().apply((io.github.eklabdev.dfsm.TransitionRequest<Object, Object>) (Object) req);
    }

    @SuppressWarnings("unchecked")
    private static <TContext> io.github.eklabdev.dfsm.TransitionOutput<TContext, Object> uncheckedCastOutput(Object raw) {
        return (io.github.eklabdev.dfsm.TransitionOutput<TContext, Object>) raw;
    }

    public synchronized void initialize() {
        if (initialized) {
            return;
        }
        store.initialize();
        initialized = true;

        if (recoveryConfig.enabled()) {
            runRecoverySweep(recoveryConfig.stuckThresholdMs(), null);
        }
        if (schedulerConfig.enabled()) {
            startScheduler();
        }
    }

    private void ensureReady() {
        if (closed) {
            throw new DfsmException("DFSM_ACTOR_CLOSED", "Actor '" + actorId + "' is closed");
        }
        if (!initialized) {
            initialize();
        }
    }

    public String getActorId() {
        return actorId;
    }

    public String getMachineId() {
        return machine.id();
    }

    public MachineDefinition getLoadedMachine() {
        return machine;
    }

    public Runnable addHooks(ActorLifecycleHooks<TContext> hooks) {
        if (hooks != null) {
            hookSubscribers.add(hooks);
        }
        return () -> hookSubscribers.remove(hooks);
    }

    public EffectiveMachineConfig getEffectiveConfig() {
        List<EffectiveTransitionConfig> txList = new ArrayList<>();
        for (CompiledBinding<TContext> b : compiledBindings.values()) {
            txList.add(new EffectiveTransitionConfig(
                    b.statePath(),
                    b.edge().event(),
                    b.edge().target(),
                    b.resolvedTransitionName(),
                    b.resolvedCompensateName(),
                    b.policy(),
                    b.breaker().getStatus()
            ));
        }
        return new EffectiveMachineConfig(
                machine.id(),
                machine.version(),
                machine.source(),
                machine.hasCustomErrorState(),
                maxEffectChainDepth,
                Collections.unmodifiableMap(new EnumMap<>(resolvedMachineHooks)),
                List.copyOf(registeredEffectNames),
                List.copyOf(txList)
        );
    }

    public List<String> getAvailableEvents(StateValue stateValue) {
        return StatechartEngine.getAvailableEvents(machine, stateValue);
    }

    public TerminalStatesInfo getTerminalStates() {
        return StatechartEngine.getTerminalStatesInfo(machine);
    }

    public String startTransaction(TContext initialContext) {
        return startTransaction(initialContext, null);
    }

    public String startTransaction(TContext initialContext, String customTransactionId) {
        ensureReady();
        TContext validatedInitial = SchemaValidator.enforce("initialContext", initialContext, contextValidator);
        String txId = (customTransactionId != null && !customTransactionId.isBlank())
                ? customTransactionId
                : UUID.randomUUID().toString();
        long now = clock.now();

        InitialResolution init = StatechartEngine.resolveInitialState(machine);
        TransactionStatus status = StatechartEngine.resolveSettledTransactionStatus(
                machine, init.stateValue(), false
        );

        store.createTransaction(new TransactionRecord<>(
                txId,
                machine.id(),
                machine.version(),
                actorId,
                init.stateValue(),
                validatedInitial,
                status,
                null,
                null,
                1L,
                null,
                null,
                now,
                now
        ));

        emitOnStart(new OnStartEvent<>(
                txId, machine.id(), actorId, init.stateValue(), status, validatedInitial, this
        ));
        emitSettledTerminalHooks(txId, init.stateValue(), status, validatedInitial, null);

        List<EffectInvocation> initEffects = init.entryEffects().stream()
                .map(n -> new EffectInvocation(n, null))
                .toList();
        invokeEffects(txId, init.stateValue(), validatedInitial, initEffects);
        return txId;
    }

    public <TOutput> TransitionExecutionResult<TContext, TOutput> transition(
            String transactionId,
            String event
    ) {
        return transition(transactionId, event, null, Map.of());
    }

    public <TInput, TOutput> TransitionExecutionResult<TContext, TOutput> transition(
            String transactionId,
            String event,
            TInput input
    ) {
        return transition(transactionId, event, input, Map.of());
    }

    public <TInput, TOutput> TransitionExecutionResult<TContext, TOutput> transition(
            String transactionId,
            String event,
            TInput input,
            Map<String, Object> metadata
    ) {
        ensureReady();
        TransactionSnapshot<TContext> snapshot = store.getTransaction(transactionId, contextClass);
        if (snapshot == null || !snapshot.machineId().equals(machine.id())) {
            throw new TransactionNotFoundException(transactionId);
        }
        return executeTransitionOnSnapshot(snapshot, event, input, metadata != null ? metadata : Map.of());
    }

    @SuppressWarnings("unchecked")
    private <TInput, TOutput> TransitionExecutionResult<TContext, TOutput> executeTransitionOnSnapshot(
            TransactionSnapshot<TContext> snapshot,
            String event,
            TInput rawInput,
            Map<String, Object> metadata
    ) {
        StateValue previousState = snapshot.stateValue();
        List<MatchedTransition> matches = StatechartEngine.resolveTransitionsForEvent(machine, previousState, event);
        if (matches.isEmpty()) {
            throw new InvalidTransitionException(
                    machine.id(), event, previousState, getAvailableEvents(previousState)
            );
        }

        // 1. Validate caller input BEFORE mutating state, firing hooks, consuming retries, or tripping CB
        List<Object> validatedInputs = new ArrayList<>(matches.size());
        for (MatchedTransition m : matches) {
            CompiledBinding<TContext> binding = compiledBindings.get(bindingKey(m.sourceNode().path(), m.edge().event()));
            validatedInputs.add(binding.pipeline().validateInput(rawInput));
        }

        // 2. Emit beforeTransition hook
        emitBeforeTransition(new BeforeTransitionEvent<>(
                snapshot.transactionId(),
                machine.id(),
                actorId,
                event,
                !validatedInputs.isEmpty() ? validatedInputs.get(0) : rawInput,
                previousState,
                snapshot.context(),
                this
        ));

        // 3. Persist IN_FLIGHT step lease
        long stepStartedAt = clock.now();
        long currentVersion = snapshot.version();
        if (snapshot.status() != TransactionStatus.IN_FLIGHT) {
            currentVersion = store.updateTransaction(
                    snapshot.transactionId(),
                    currentVersion,
                    TransactionPatch.<TContext>builder(stepStartedAt)
                            .status(TransactionStatus.IN_FLIGHT)
                            .activeStep(new ActiveStepInfo(event, rawInput, stepStartedAt))
                            .lease(actorId, stepStartedAt + Math.max(30_000L, recoveryConfig.stuckThresholdMs()))
                            .build(),
                    List.of()
            );
        }

        StateValue workingState = previousState;
        TContext workingContext = snapshot.context();
        TOutput lastReturnValue = null;
        List<EffectInvocation> pendingEffects = new ArrayList<>();
        List<NewCompensationEntry> pendingCompensations = new ArrayList<>();

        for (int i = 0; i < matches.size(); i++) {
            MatchedTransition match = matches.get(i);
            Object validatedInput = validatedInputs.get(i);
            CompiledBinding<TContext> binding = compiledBindings.get(
                    bindingKey(match.sourceNode().path(), match.edge().event())
            );

            TContext contextBeforeStep = JsonCodec.deepClone(workingContext, contextClass);
            StateValue stateBeforeStep = workingState;

            final StateValue currentWorkingStateSnapshot = workingState;
            final TContext currentWorkingContextSnapshot = workingContext;
            final long versionBeforeStep = currentVersion;

            final class MutableStepState {
                StateValue nextState = currentWorkingStateSnapshot;
                TContext nextCtx = currentWorkingContextSnapshot;
                TOutput outVal = null;
                int compensatedSteps = 0;
                TransactionStatus failStatus = null;
                String failErr = null;
                long updatedVersion = versionBeforeStep;
            }
            MutableStepState ms = new MutableStepState();

            var telemetryRes = binding.pipeline().executeWithTelemetry(
                    new ExecutionContext<>(
                            snapshot.transactionId(),
                            machine.id(),
                            actorId,
                            event,
                            binding.resolvedTransitionName(),
                            workingState,
                            validatedInput,
                            workingContext,
                            stepStartedAt,
                            metadata
                    ),
                    (ExecutionOutcome<TContext, Object> execOutcome) -> {
                        if (execOutcome.ok()) {
                            String effectiveTarget = execOutcome.output().targetState() != null
                                    ? execOutcome.output().targetState()
                                    : binding.edge().target();
                            if (effectiveTarget != null && !effectiveTarget.isBlank()) {
                                AppliedTransition applied = StatechartEngine.applyTargetTransition(
                                        machine, ms.nextState, match.sourceNode().path(), effectiveTarget
                                );
                                ms.nextState = applied.nextStateValue();
                                applied.exitEffects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                                binding.edge().effects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                                if (execOutcome.output().effects() != null) {
                                    execOutcome.output().effects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                                }
                                applied.entryEffects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                            } else {
                                binding.edge().effects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                                if (execOutcome.output().effects() != null) {
                                    execOutcome.output().effects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                                }
                            }

                            ms.nextCtx = execOutcome.nextContext();
                            if (execOutcome.output().value() != null) {
                                ms.outVal = (TOutput) execOutcome.output().value();
                            }

                            if (binding.resolvedCompensateName() != null) {
                                pendingCompensations.add(new NewCompensationEntry(
                                        snapshot.transactionId(),
                                        binding.resolvedTransitionName() != null
                                                ? binding.resolvedTransitionName()
                                                : match.sourceNode().path() + "." + event,
                                        binding.resolvedCompensateName(),
                                        stateBeforeStep,
                                        validatedInput,
                                        contextBeforeStep,
                                        clock.now()
                                ));
                            }
                            return new FinalResolution(ms.nextState, false);
                        }

                        // Failure branch
                        if (!pendingCompensations.isEmpty()) {
                            List<NewCompensationEntry> toFlush = new ArrayList<>(pendingCompensations);
                            pendingCompensations.clear();
                            ms.updatedVersion = store.updateTransaction(
                                    snapshot.transactionId(),
                                    ms.updatedVersion,
                                    TransactionPatch.<TContext>builder(clock.now()).build(),
                                    toFlush
                            );
                        }

                        ms.failErr = execOutcome.error() != null
                                ? execOutcome.error().getMessage()
                                : "Transition failed";
                        boolean didCompensate = false;

                        if (execOutcome.compensateRequested()) {
                            ms.updatedVersion = store.updateTransaction(
                                    snapshot.transactionId(),
                                    ms.updatedVersion,
                                    TransactionPatch.<TContext>builder(clock.now())
                                            .status(TransactionStatus.COMPENSATING)
                                            .lastError(ms.failErr)
                                            .build(),
                                    List.of()
                            );
                            UnwindResult unwind = unwindCompensationStack(
                                    snapshot.transactionId(), ms.nextCtx, ms.failErr
                            );
                            ms.nextCtx = unwind.updatedContext();
                            ms.compensatedSteps = unwind.compensatedCount();
                            didCompensate = true;
                        }

                        AppliedTransition fbApplied = StatechartEngine.applyTargetTransition(
                                machine, ms.nextState, match.sourceNode().path(), execOutcome.fallbackTarget()
                        );
                        ms.nextState = fbApplied.nextStateValue();
                        pendingEffects.clear();
                        fbApplied.exitEffects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                        fbApplied.entryEffects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));

                        ms.failStatus = StatechartEngine.resolveSettledTransactionStatus(
                                machine, ms.nextState, didCompensate
                        );
                        return new FinalResolution(ms.nextState, didCompensate);
                    }
            );

            workingState = ms.nextState;
            workingContext = ms.nextCtx;
            currentVersion = ms.updatedVersion;
            if (ms.outVal != null) {
                lastReturnValue = ms.outVal;
            }

            if (!telemetryRes.outcome().ok()) {
                TransactionStatus settledFailStatus = ms.failStatus != null ? ms.failStatus : TransactionStatus.FAILED;
                String errMsg = ms.failErr != null ? ms.failErr : "Transition failed";
                long completedAt = clock.now();

                store.updateTransaction(
                        snapshot.transactionId(),
                        currentVersion,
                        TransactionPatch.<TContext>builder(completedAt)
                                .stateValue(workingState)
                                .context(workingContext)
                                .status(settledFailStatus)
                                .activeStep(null)
                                .lastError(errMsg)
                                .lease(null, null)
                                .build(),
                        List.of()
                );
                bumpRevision(snapshot.transactionId());

                emitAfterTransition(new AfterTransitionEvent<>(
                        snapshot.transactionId(),
                        machine.id(),
                        actorId,
                        event,
                        !validatedInputs.isEmpty() ? validatedInputs.get(0) : rawInput,
                        previousState,
                        workingState,
                        settledFailStatus,
                        null,
                        workingContext,
                        ms.compensatedSteps,
                        Math.max(0L, completedAt - stepStartedAt),
                        errMsg,
                        this
                ));
                emitSettledTerminalHooks(
                        snapshot.transactionId(), workingState, settledFailStatus, workingContext, errMsg
                );

                long revBefore = getRevision(snapshot.transactionId());
                invokeEffects(snapshot.transactionId(), workingState, workingContext, pendingEffects);
                boolean nestedChanged = getRevision(snapshot.transactionId()) != revBefore;
                if (!effectChainDepthByTx.containsKey(snapshot.transactionId())) {
                    txTransitionRevision.remove(snapshot.transactionId());
                }

                if (nestedChanged) {
                    TransactionSnapshot<TContext> latest = store.getTransaction(snapshot.transactionId(), contextClass);
                    if (latest != null) {
                        return new TransitionExecutionResult<>(
                                snapshot.transactionId(),
                                previousState,
                                latest.stateValue(),
                                latest.status(),
                                null,
                                latest.context(),
                                ms.compensatedSteps,
                                latest.lastError()
                        );
                    }
                }

                return new TransitionExecutionResult<>(
                        snapshot.transactionId(),
                        previousState,
                        workingState,
                        settledFailStatus,
                        null,
                        workingContext,
                        ms.compensatedSteps,
                        errMsg
                );
            }
        }

        // 4. Cascade automatic `onDone` transitions for completed compound / parallel containers
        int safetyCounter = 0;
        while (safetyCounter++ < 20) {
            MatchedTransition pendingDone = StatechartEngine.findPendingOnDone(machine, workingState);
            if (pendingDone == null) break;

            CompiledBinding<TContext> doneBinding = compiledBindings.get(
                    bindingKey(pendingDone.sourceNode().path(), "$onDone")
            );
            if (doneBinding != null && doneBinding.resolvedTransitionName() != null) {
                ExecutionOutcome<TContext, Object> doneOut = doneBinding.pipeline().execute(new ExecutionContext<>(
                        snapshot.transactionId(),
                        machine.id(),
                        actorId,
                        "$onDone",
                        doneBinding.resolvedTransitionName(),
                        workingState,
                        null,
                        workingContext,
                        clock.now(),
                        metadata
                ));
                if (doneOut.ok()) {
                    workingContext = doneOut.nextContext();
                    if (doneOut.output().effects() != null) {
                        doneOut.output().effects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                    }
                }
            }

            if (pendingDone.edge().target() != null && !pendingDone.edge().target().isBlank()) {
                AppliedTransition appliedDone = StatechartEngine.applyTargetTransition(
                        machine, workingState, pendingDone.sourceNode().path(), pendingDone.edge().target()
                );
                workingState = appliedDone.nextStateValue();
                appliedDone.exitEffects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                pendingDone.edge().effects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                appliedDone.entryEffects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
            } else {
                pendingDone.edge().effects().forEach(n -> pendingEffects.add(new EffectInvocation(n, null)));
                break;
            }
        }

        TransactionStatus finalStatus = StatechartEngine.resolveSettledTransactionStatus(machine, workingState, false);
        long completedAt = clock.now();

        store.updateTransaction(
                snapshot.transactionId(),
                currentVersion,
                TransactionPatch.<TContext>builder(completedAt)
                        .stateValue(workingState)
                        .context(workingContext)
                        .status(finalStatus)
                        .activeStep(null)
                        .lastError(null)
                        .lease(null, null)
                        .build(),
                pendingCompensations
        );
        bumpRevision(snapshot.transactionId());

        emitAfterTransition(new AfterTransitionEvent<>(
                snapshot.transactionId(),
                machine.id(),
                actorId,
                event,
                !validatedInputs.isEmpty() ? validatedInputs.get(0) : rawInput,
                previousState,
                workingState,
                finalStatus,
                lastReturnValue,
                workingContext,
                0,
                Math.max(0L, completedAt - stepStartedAt),
                null,
                this
        ));
        emitSettledTerminalHooks(snapshot.transactionId(), workingState, finalStatus, workingContext, null);

        long revBefore = getRevision(snapshot.transactionId());
        invokeEffects(snapshot.transactionId(), workingState, workingContext, pendingEffects);
        boolean nestedChanged = getRevision(snapshot.transactionId()) != revBefore;
        if (!effectChainDepthByTx.containsKey(snapshot.transactionId())) {
            txTransitionRevision.remove(snapshot.transactionId());
        }

        if (nestedChanged) {
            TransactionSnapshot<TContext> latest = store.getTransaction(snapshot.transactionId(), contextClass);
            if (latest != null) {
                return new TransitionExecutionResult<>(
                        snapshot.transactionId(),
                        previousState,
                        latest.stateValue(),
                        latest.status(),
                        lastReturnValue,
                        latest.context(),
                        0,
                        latest.lastError()
                );
            }
        }

        return new TransitionExecutionResult<>(
                snapshot.transactionId(),
                previousState,
                workingState,
                finalStatus,
                lastReturnValue,
                workingContext,
                0,
                null
        );
    }

    private record UnwindResultInternal<C>(C updatedContext, int compensatedCount) {}

    private final class UnwindResult {
        private final TContext updatedContext;
        private final int compensatedCount;

        UnwindResult(TContext updatedContext, int compensatedCount) {
            this.updatedContext = updatedContext;
            this.compensatedCount = compensatedCount;
        }

        TContext updatedContext() { return updatedContext; }
        int compensatedCount() { return compensatedCount; }
    }

    @SuppressWarnings("unchecked")
    private UnwindResult unwindCompensationStack(
            String transactionId,
            TContext currentContext,
            String failureError
    ) {
        List<CompensationEntryRecord> stack = store.getUncompensatedStack(transactionId);
        TContext ctx = currentContext;
        int count = 0;

        for (CompensationEntryRecord entry : stack) {
            ResolvedCompensation rc = handlers.resolveCompensate(
                    entry.compensateKey(), machine.registry().namespace()
            );
            if (rc != null) {
                TContext ctxBeforeTyped = JsonCodec.convertValue(entry.contextBefore(), contextClass);
                try {
                    Object updated = rc.fn().compensate(new CompensationRequest<>(
                            transactionId,
                            machine.id(),
                            actorId,
                            entry.stepSeq(),
                            entry.fromState(),
                            entry.inputSnapshot(),
                            ctxBeforeTyped,
                            ctx,
                            failureError
                    ));
                    if (updated != null) {
                        if (contextClass.isInstance(updated)) {
                            ctx = contextClass.cast(updated);
                        } else if (updated instanceof Map<?, ?>) {
                            ctx = JsonCodec.convertValue(updated, contextClass);
                        }
                    }
                } catch (RuntimeException re) {
                    throw re;
                } catch (Exception ex) {
                    throw new RuntimeException(ex);
                }
            }
            store.markCompensationExecuted(transactionId, entry.stepSeq(), clock.now());
            emitOnCompensate(new OnCompensateEvent<>(
                    transactionId,
                    machine.id(),
                    actorId,
                    entry.stepSeq(),
                    rc != null ? rc.resolvedName() : entry.compensateKey(),
                    entry.fromState(),
                    entry.inputSnapshot(),
                    ctx,
                    failureError,
                    this
            ));
            count++;
        }

        return new UnwindResult(ctx, count);
    }

    private void invokeEffects(
            String transactionId,
            StateValue fallbackState,
            TContext fallbackContext,
            List<EffectInvocation> effects
    ) {
        if (effects == null || effects.isEmpty()) {
            return;
        }
        for (EffectInvocation eff : effects) {
            invokeSingleEffect(transactionId, fallbackState, fallbackContext, eff.name(), eff.payload(), true);
        }
    }

    @SuppressWarnings("unchecked")
    private void invokeSingleEffect(
            String transactionId,
            StateValue fallbackState,
            TContext fallbackContext,
            String handlerName,
            Object payload,
            boolean refreshFromStore
    ) {
        int currentDepth = effectChainDepthByTx.getOrDefault(transactionId, 0);
        if (currentDepth >= maxEffectChainDepth) {
            throw new MaxEffectChainDepthException(transactionId, maxEffectChainDepth);
        }

        String ns = machine.registry().namespace();
        ResolvedEffect resolved = handlers.resolveEffect(handlerName, ns);
        if (resolved == null) {
            if (machine.registry().strict()) {
                throw new UnregisteredHandlerException(
                        machine.id(), "effect", MachineDefinition.qualifyHandlerName(handlerName, ns)
                );
            }
            return;
        }

        effectChainDepthByTx.put(transactionId, currentDepth + 1);
        try {
            StateValue effectiveState = fallbackState;
            TContext effectiveCtx = fallbackContext;
            if (refreshFromStore && getRevision(transactionId) > 0) {
                TransactionSnapshot<TContext> latest = store.getTransaction(transactionId, contextClass);
                if (latest != null) {
                    effectiveState = latest.stateValue();
                    effectiveCtx = latest.context();
                }
            }

            final StateValue stateForSub = effectiveState;
            final TContext ctxForSub = effectiveCtx;

            EffectRequest<Object> req = new EffectRequest<>(
                    transactionId,
                    machine.id(),
                    actorId,
                    effectiveState,
                    effectiveCtx,
                    resolved.resolvedName(),
                    payload,
                    (DfsmActor<Object>) (Object) this,
                    (subEffectName, subPayload) -> invokeSingleEffect(
                            transactionId, stateForSub, ctxForSub, subEffectName, subPayload, true
                    )
            );
            resolved.fn().execute(req);
        } catch (RuntimeException re) {
            throw re;
        } catch (Exception ex) {
            throw new RuntimeException(ex);
        } finally {
            int nextDepth = effectChainDepthByTx.getOrDefault(transactionId, 1) - 1;
            if (nextDepth <= 0) {
                effectChainDepthByTx.remove(transactionId);
            } else {
                effectChainDepthByTx.put(transactionId, nextDepth);
            }
        }
    }

    private void bumpRevision(String txId) {
        txTransitionRevision.merge(txId, 1L, Long::sum);
    }

    private long getRevision(String txId) {
        return txTransitionRevision.getOrDefault(txId, 0L);
    }

    private void emitOnStart(OnStartEvent<TContext> e) {
        for (ActorLifecycleHooks<TContext> sub : hookSubscribers) {
            if (sub.onStart() != null) runHookSafe(() -> sub.onStart().onHook(e));
        }
    }

    private void emitBeforeTransition(BeforeTransitionEvent<TContext> e) {
        for (ActorLifecycleHooks<TContext> sub : hookSubscribers) {
            if (sub.beforeTransition() != null) runHookSafe(() -> sub.beforeTransition().onHook(e));
        }
    }

    private void emitAfterTransition(AfterTransitionEvent<TContext> e) {
        for (ActorLifecycleHooks<TContext> sub : hookSubscribers) {
            if (sub.afterTransition() != null) runHookSafe(() -> sub.afterTransition().onHook(e));
        }
    }

    private void emitOnCompensate(OnCompensateEvent<TContext> e) {
        for (ActorLifecycleHooks<TContext> sub : hookSubscribers) {
            if (sub.onCompensate() != null) runHookSafe(() -> sub.onCompensate().onHook(e));
        }
    }

    private void emitSettledTerminalHooks(
            String txId,
            StateValue finalState,
            TransactionStatus status,
            TContext ctx,
            String error
    ) {
        if (status == TransactionStatus.COMPLETED) {
            OnCompleteEvent<TContext> ce = new OnCompleteEvent<>(
                    txId, machine.id(), actorId, finalState, ctx, this
            );
            for (ActorLifecycleHooks<TContext> sub : hookSubscribers) {
                if (sub.onComplete() != null) runHookSafe(() -> sub.onComplete().onHook(ce));
            }
        }
        if (status.isTerminal()) {
            OnTerminalEvent<TContext> te = new OnTerminalEvent<>(
                    txId, machine.id(), actorId, finalState, status, ctx, error, this
            );
            for (ActorLifecycleHooks<TContext> sub : hookSubscribers) {
                if (sub.onTerminal() != null) runHookSafe(() -> sub.onTerminal().onHook(te));
            }
        }
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private static void runHookSafe(ThrowingRunnable r) {
        try {
            r.run();
        } catch (RuntimeException re) {
            throw re;
        } catch (Exception ex) {
            throw new RuntimeException(ex);
        }
    }

    // =========================================================================
    // Queries, Non-Terminal ("Active") Inspection, Recovery Scheduler & Cleanup
    // =========================================================================

    public TransactionSnapshot<TContext> getTransaction(String transactionId) {
        ensureReady();
        return store.getTransaction(transactionId, contextClass);
    }

    public long getActiveCount() {
        ensureReady();
        return store.countByStatuses(new StatusQueryFilter(
                machine.id(), null, TransactionStatus.NON_TERMINAL_STATUSES, null, 0, 0
        ));
    }

    public List<TransactionSummary<TContext>> listActiveTransactions() {
        return listActiveTransactions(200, 0);
    }

    public List<TransactionSummary<TContext>> listActiveTransactions(int limit, int offset) {
        ensureReady();
        return store.listByStatuses(
                new StatusQueryFilter(
                        machine.id(), null, TransactionStatus.NON_TERMINAL_STATUSES, null, limit, offset
                ),
                clock.now(),
                recoveryConfig.stuckThresholdMs(),
                contextClass
        );
    }

    public StatusBreakdown getStatusBreakdown() {
        ensureReady();
        Map<TransactionStatus, Long> counts = store.getStatusCounts(machine.id());
        long nonTerm = 0L;
        long term = 0L;
        for (Map.Entry<TransactionStatus, Long> e : counts.entrySet()) {
            if (e.getKey().isNonTerminal()) {
                nonTerm += e.getValue();
            } else {
                term += e.getValue();
            }
        }
        return new StatusBreakdown(nonTerm, term, counts);
    }

    public long getInFlightCount() {
        return getInFlightCount(null);
    }

    public long getInFlightCount(InFlightFilter filter) {
        ensureReady();
        InFlightFilter scoped = scopeFilter(filter);
        return store.countInFlight(scoped, clock.now(), recoveryConfig.stuckThresholdMs());
    }

    public List<TransactionSummary<TContext>> listInFlightTransactions() {
        return listInFlightTransactions(null);
    }

    public List<TransactionSummary<TContext>> listInFlightTransactions(InFlightFilter filter) {
        ensureReady();
        InFlightFilter scoped = scopeFilter(filter);
        return store.listInFlight(scoped, clock.now(), recoveryConfig.stuckThresholdMs(), contextClass);
    }

    private InFlightFilter scopeFilter(InFlightFilter f) {
        if (f == null) {
            return new InFlightFilter(machine.id(), null, false, true, null, 200, 0);
        }
        return new InFlightFilter(
                machine.id(),
                f.actorId(),
                f.stuckOnly(),
                f.includeCompensating(),
                f.stateEquals(),
                f.limit(),
                f.offset()
        );
    }

    public SchedulerConfig getSchedulerConfig() {
        return schedulerConfig;
    }

    public RecoveryConfig getRecoveryConfig() {
        return recoveryConfig;
    }

    public SchedulerStatus getSchedulerStatus() {
        boolean running = scheduledTask != null && !scheduledTask.isCancelled();
        return new SchedulerStatus(
                schedulerConfig.enabled(),
                running,
                schedulerConfig.sweepIntervalMs(),
                schedulerConfig.stuckThresholdMs(),
                schedulerConfig.retentionMs(),
                lastSweepAt,
                nextSweepAt,
                lastSweepReport
        );
    }

    public synchronized void updateSchedulerConfig(SchedulerConfig updated) {
        this.schedulerConfig = updated;
        stopScheduler();
        if (updated.enabled() && !closed) {
            startScheduler();
        }
    }

    public synchronized void startScheduler() {
        if (closed) return;
        stopScheduler();
        this.schedulerConfig = new SchedulerConfig(
                true,
                schedulerConfig.sweepIntervalMs(),
                schedulerConfig.stuckThresholdMs(),
                schedulerConfig.retentionMs(),
                schedulerConfig.batchSize()
        );
        this.schedulerExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "dfsm-scheduler-" + actorId);
            t.setDaemon(true);
            return t;
        });
        long interval = Math.max(50L, schedulerConfig.sweepIntervalMs());
        this.nextSweepAt = clock.now() + interval;
        this.scheduledTask = schedulerExecutor.scheduleAtFixedRate(
                this::safeBackgroundSweep,
                interval,
                interval,
                TimeUnit.MILLISECONDS
        );
    }

    public synchronized void stopScheduler() {
        if (scheduledTask != null) {
            scheduledTask.cancel(false);
            scheduledTask = null;
        }
        if (schedulerExecutor != null) {
            schedulerExecutor.shutdownNow();
            schedulerExecutor = null;
        }
        nextSweepAt = null;
    }

    private void safeBackgroundSweep() {
        try {
            triggerSweepNow();
        } catch (Exception ignored) {}
    }

    public SweepReport triggerSweepNow() {
        ensureReady();
        SweepReport report = runRecoverySweep(
                schedulerConfig.stuckThresholdMs(),
                schedulerConfig.retentionMs()
        );
        this.lastSweepAt = report.sweptAt();
        if (scheduledTask != null && !scheduledTask.isCancelled()) {
            this.nextSweepAt = report.sweptAt() + schedulerConfig.sweepIntervalMs();
        }
        this.lastSweepReport = report;
        return report;
    }

    private SweepReport runRecoverySweep(long stuckThresholdMs, Long retentionMs) {
        long now = clock.now();
        List<TransactionSummary<TContext>> stuckList = store.listInFlight(
                new InFlightFilter(machine.id(), null, true, true, null, schedulerConfig.batchSize(), 0),
                now,
                stuckThresholdMs,
                contextClass
        );

        Map<String, String> actions = new LinkedHashMap<>();
        int recoveredCount = 0;

        for (TransactionSummary<TContext> summary : stuckList) {
            OnRestartMode mode = resolveRecoveryMode(summary.stateValue());
            actions.put(summary.transactionId(), mode.name());
            if (mode == OnRestartMode.STOP) {
                continue;
            }
            applyRecoveryMode(summary.transactionId(), mode);
            recoveredCount++;
        }

        int purgedCount = 0;
        if (retentionMs != null && retentionMs >= 0) {
            List<TransactionSummary<TContext>> expired = store.listByStatuses(
                    new StatusQueryFilter(
                            machine.id(),
                            null,
                            TransactionStatus.TERMINAL_STATUSES,
                            now - retentionMs,
                            schedulerConfig.batchSize(),
                            0
                    ),
                    now,
                    stuckThresholdMs,
                    contextClass
            );
            for (TransactionSummary<TContext> exp : expired) {
                if (store.deleteTransaction(exp.transactionId(), exp.version())) {
                    purgedCount++;
                }
            }
        }

        return new SweepReport(now, recoveredCount, purgedCount, Map.copyOf(actions));
    }

    private OnRestartMode resolveRecoveryMode(StateValue sv) {
        if (recoveryConfig.perStateActions() != null && sv.isLeaf()) {
            OnRestartMode override = recoveryConfig.perStateActions().get(sv.asLeaf());
            if (override != null) {
                return override;
            }
        }
        return recoveryConfig.defaultAction() != null ? recoveryConfig.defaultAction() : OnRestartMode.STOP;
    }

    private void applyRecoveryMode(String txId, OnRestartMode mode) {
        TransactionSnapshot<TContext> snap = store.getTransaction(txId, contextClass);
        if (snap == null) return;

        switch (mode) {
            case STOP -> {}
            case DELETE -> store.deleteTransaction(txId, snap.version());
            case MARK_FAIL -> store.updateTransaction(
                    txId,
                    snap.version(),
                    TransactionPatch.<TContext>builder(clock.now())
                            .stateValue(StateValue.of("error"))
                            .status(TransactionStatus.FAILED)
                            .activeStep(null)
                            .lastError("Marked FAILED by recovery policy")
                            .lease(null, null)
                            .build(),
                    List.of()
            );
            case COMPENSATE -> {
                long v = store.updateTransaction(
                        txId,
                        snap.version(),
                        TransactionPatch.<TContext>builder(clock.now())
                                .status(TransactionStatus.COMPENSATING)
                                .build(),
                        List.of()
                );
                UnwindResult unwind = unwindCompensationStack(
                        txId, snap.context(), "Compensated by recovery policy"
                );
                store.updateTransaction(
                        txId,
                        v,
                        TransactionPatch.<TContext>builder(clock.now())
                                .stateValue(StateValue.of("error"))
                                .context(unwind.updatedContext())
                                .status(TransactionStatus.COMPENSATED)
                                .activeStep(null)
                                .lastError("Compensated by recovery policy")
                                .lease(null, null)
                                .build(),
                        List.of()
                );
            }
            case CONTINUE -> {
                ActiveStepInfo activeStep = snap.activeStep();
                long v = store.updateTransaction(
                        txId,
                        snap.version(),
                        TransactionPatch.<TContext>builder(clock.now())
                                .status(TransactionStatus.IDLE)
                                .activeStep(null)
                                .lease(null, null)
                                .build(),
                        List.of()
                );
                if (activeStep != null && activeStep.event() != null) {
                    TransactionSnapshot<TContext> unlocked = store.getTransaction(txId, contextClass);
                    if (unlocked != null && unlocked.version() == v) {
                        executeTransitionOnSnapshot(unlocked, activeStep.event(), activeStep.input(), Map.of());
                    }
                }
            }
        }
    }

    public ForceCleanUpReport forceCleanUp(ForceCleanUpOptions options) {
        ensureReady();
        ForceCleanUpOptions opts = options != null ? options : ForceCleanUpOptions.defaults();
        long now = clock.now();
        Long cutoff = opts.olderThanMs() != null ? (now - opts.olderThanMs()) : null;

        List<TransactionSummary<TContext>> candidates;
        if (opts.stuckOnly()) {
            candidates = store.listInFlight(
                    new InFlightFilter(machine.id(), null, true, true, null, opts.limit(), 0),
                    now,
                    recoveryConfig.stuckThresholdMs(),
                    contextClass
            );
        } else {
            Set<TransactionStatus> targetStatuses = new LinkedHashSet<>(
                    opts.statuses() != null && !opts.statuses().isEmpty()
                            ? opts.statuses()
                            : TransactionStatus.TERMINAL_STATUSES
            );
            if (opts.includeInFlight()) {
                targetStatuses.add(TransactionStatus.IN_FLIGHT);
                targetStatuses.add(TransactionStatus.COMPENSATING);
            } else {
                targetStatuses.remove(TransactionStatus.IN_FLIGHT);
                targetStatuses.remove(TransactionStatus.COMPENSATING);
            }
            candidates = store.listByStatuses(
                    new StatusQueryFilter(
                            machine.id(), null, List.copyOf(targetStatuses), cutoff, opts.limit(), 0
                    ),
                    now,
                    recoveryConfig.stuckThresholdMs(),
                    contextClass
            );
        }

        List<String> matchedIds = candidates.stream().map(TransactionSummary::transactionId).toList();
        if (opts.dryRun()) {
            return new ForceCleanUpReport(true, opts.action(), matchedIds.size(), 0, matchedIds);
        }

        int affected = 0;
        for (TransactionSummary<TContext> c : candidates) {
            if (forceCleanUpTransaction(c.transactionId(), opts.action())) {
                affected++;
            }
        }
        return new ForceCleanUpReport(false, opts.action(), matchedIds.size(), affected, matchedIds);
    }

    public boolean forceCleanUpTransaction(String transactionId, ForceCleanUpAction action) {
        ensureReady();
        TransactionSnapshot<TContext> snap = store.getTransaction(transactionId, contextClass);
        if (snap == null) return false;

        switch (action) {
            case DELETE -> {
                return store.deleteTransaction(transactionId, snap.version());
            }
            case MARK_FAIL -> {
                store.updateTransaction(
                        transactionId,
                        snap.version(),
                        TransactionPatch.<TContext>builder(clock.now())
                                .stateValue(StateValue.of("error"))
                                .status(TransactionStatus.FAILED)
                                .activeStep(null)
                                .lastError("Marked FAILED via forceCleanUp")
                                .lease(null, null)
                                .build(),
                        List.of()
                );
                return true;
            }
            case COMPENSATE -> {
                applyRecoveryMode(transactionId, OnRestartMode.COMPENSATE);
                return true;
            }
            case FORCE_UNLOCK -> {
                store.updateTransaction(
                        transactionId,
                        snap.version(),
                        TransactionPatch.<TContext>builder(clock.now())
                                .status(TransactionStatus.IDLE)
                                .activeStep(null)
                                .lease(null, null)
                                .build(),
                        List.of()
                );
                return true;
            }
        }
        return false;
    }

    @Override
    public synchronized void close() {
        if (closed) return;
        closed = true;
        stopScheduler();
        if (onCloseCallback != null) {
            onCloseCallback.run();
        }
    }
}
