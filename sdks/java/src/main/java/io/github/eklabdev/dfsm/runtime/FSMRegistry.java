package io.github.eklabdev.dfsm.runtime;

import io.github.eklabdev.dfsm.ActorLifecycleHooks;
import io.github.eklabdev.dfsm.Clock;
import io.github.eklabdev.dfsm.CompensationFunction;
import io.github.eklabdev.dfsm.DfsmModels.ActorSummary;
import io.github.eklabdev.dfsm.DfsmModels.EffectiveMachineConfig;
import io.github.eklabdev.dfsm.DfsmModels.EffectiveTransitionConfig;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpOptions;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpReport;
import io.github.eklabdev.dfsm.DfsmModels.HandlerDescriptor;
import io.github.eklabdev.dfsm.DfsmModels.HandlerKind;
import io.github.eklabdev.dfsm.DfsmModels.InFlightFilter;
import io.github.eklabdev.dfsm.DfsmModels.InFlightSummary;
import io.github.eklabdev.dfsm.DfsmModels.MachineSummary;
import io.github.eklabdev.dfsm.EffectFunction;
import io.github.eklabdev.dfsm.LifecycleHookFunction;
import io.github.eklabdev.dfsm.LifecycleHookName;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.TransitionFunction;
import io.github.eklabdev.dfsm.annotation.AnnotationScanner;
import io.github.eklabdev.dfsm.annotation.AnnotationScanner.ScannedService;
import io.github.eklabdev.dfsm.annotation.DecoratedTransition;
import io.github.eklabdev.dfsm.definition.MachineBuilder;
import io.github.eklabdev.dfsm.definition.MachineDefinition;
import io.github.eklabdev.dfsm.definition.MachineDefinition.StateNodeIR;
import io.github.eklabdev.dfsm.definition.MachineDefinition.TransitionEdgeIR;
import io.github.eklabdev.dfsm.definition.YamlMachineParser;
import io.github.eklabdev.dfsm.error.DfsmException;
import io.github.eklabdev.dfsm.error.UnregisteredHandlerException;
import io.github.eklabdev.dfsm.policy.CircuitStatus;
import io.github.eklabdev.dfsm.policy.NormalizedTransitionPolicy;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.policy.PolicyMerger;
import io.github.eklabdev.dfsm.store.H2StateStore;
import io.github.eklabdev.dfsm.store.StateStore;
import io.github.eklabdev.dfsm.store.StateStore.StatusQueryFilter;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import io.github.eklabdev.dfsm.validation.SchemaValidator;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Singleton (and hermetically instantiable) DFSM Registry managing transition, compensation,
 * effect, and lifecycle hook handlers, compiled {@link MachineDefinition}s (from YAML or {@link MachineBuilder}),
 * and multi-actor {@link DfsmActor} instances.
 */
public final class FSMRegistry implements HandlerResolver, AutoCloseable {
    private static volatile FSMRegistry SINGLETON;

    private record TransitionEntry(
            String name,
            TransitionFunction<Object, Object, Object> fn,
            PartialTransitionPolicy policy,
            Class<Object> inputClass,
            SchemaValidator<Object> inputValidator
    ) {}

    private StateStore store;
    private BenchmarkLogEngine logEngine;
    private Clock clock;
    private PartialTransitionPolicy defaultPolicy;
    private final List<ActorLifecycleHooks<Object>> globalHooks = new CopyOnWriteArrayList<>();

    private final Map<String, TransitionEntry> transitions = new ConcurrentHashMap<>();
    private final Map<String, CompensationFunction<Object>> compensations = new ConcurrentHashMap<>();
    private final Map<String, EffectFunction<Object>> effects = new ConcurrentHashMap<>();
    private final Map<String, LifecycleHookFunction<Object>> hooks = new ConcurrentHashMap<>();

    private final Map<String, MachineDefinition> machines = new ConcurrentHashMap<>();
    private final Map<String, DfsmActor<?>> activeActors = new ConcurrentHashMap<>();

    public FSMRegistry() {
        this(new H2StateStore(), BenchmarkLogEngine.noop(), Clock.system(), PartialTransitionPolicy.EMPTY, null);
    }

    public FSMRegistry(StateStore store) {
        this(store, BenchmarkLogEngine.noop(), Clock.system(), PartialTransitionPolicy.EMPTY, null);
    }

    public FSMRegistry(
            StateStore store,
            BenchmarkLogEngine logEngine,
            Clock clock,
            PartialTransitionPolicy defaultPolicy,
            ActorLifecycleHooks<Object> globalHook
    ) {
        this.store = store != null ? store : new H2StateStore();
        this.logEngine = logEngine != null ? logEngine : BenchmarkLogEngine.noop();
        this.clock = clock != null ? clock : Clock.system();
        this.defaultPolicy = defaultPolicy != null ? defaultPolicy : PartialTransitionPolicy.EMPTY;
        if (globalHook != null) {
            this.globalHooks.add(globalHook);
        }
    }

    public static FSMRegistry getInstance() {
        if (SINGLETON == null) {
            synchronized (FSMRegistry.class) {
                if (SINGLETON == null) {
                    SINGLETON = new FSMRegistry();
                }
            }
        }
        return SINGLETON;
    }

    public static synchronized void resetInstance() {
        if (SINGLETON != null) {
            SINGLETON.shutdown();
            SINGLETON = null;
        }
    }

    public synchronized FSMRegistry configure(
            StateStore newStore,
            BenchmarkLogEngine newLogEngine,
            Clock newClock,
            PartialTransitionPolicy newDefaultPolicy
    ) {
        if (newStore != null) this.store = newStore;
        if (newLogEngine != null) this.logEngine = newLogEngine;
        if (newClock != null) this.clock = newClock;
        if (newDefaultPolicy != null) this.defaultPolicy = newDefaultPolicy;
        return this;
    }

    public FSMRegistry addGlobalHooks(ActorLifecycleHooks<Object> hook) {
        if (hook != null) {
            this.globalHooks.add(hook);
        }
        return this;
    }

    // =========================================================================
    // Handler & Service Registration
    // =========================================================================

    @SuppressWarnings("unchecked")
    public <TContext, TInput, TOutput> FSMRegistry registerTransition(
            String name,
            TransitionFunction<TContext, TInput, TOutput> fn
    ) {
        if (fn instanceof DecoratedTransition<TContext, TInput, TOutput> dt) {
            transitions.put(name, new TransitionEntry(
                    name,
                    (TransitionFunction<Object, Object, Object>) (Object) dt.getDelegate(),
                    dt.getPolicy(),
                    (Class<Object>) dt.getInputClass(),
                    (SchemaValidator<Object>) dt.getInputValidator()
            ));
        } else {
            transitions.put(name, new TransitionEntry(
                    name,
                    (TransitionFunction<Object, Object, Object>) (Object) fn,
                    PartialTransitionPolicy.EMPTY,
                    null,
                    null
            ));
        }
        return this;
    }

    public <TContext, TInput, TOutput> FSMRegistry registerTransition(
            DecoratedTransition<TContext, TInput, TOutput> decorated
    ) {
        if (decorated.getName() == null || decorated.getName().isBlank()) {
            throw new IllegalArgumentException("DecoratedTransition must declare a handler name via .named(...)");
        }
        return registerTransition(decorated.getName(), decorated);
    }

    @SuppressWarnings("unchecked")
    public <TContext> FSMRegistry registerCompensate(String name, CompensationFunction<TContext> fn) {
        compensations.put(name, (CompensationFunction<Object>) fn);
        return this;
    }

    @SuppressWarnings("unchecked")
    public <TContext> FSMRegistry registerEffect(String name, EffectFunction<TContext> fn) {
        effects.put(name, (EffectFunction<Object>) fn);
        return this;
    }

    @SuppressWarnings("unchecked")
    public <TEvent> FSMRegistry registerHook(String name, LifecycleHookFunction<TEvent> fn) {
        hooks.put(name, (LifecycleHookFunction<Object>) fn);
        return this;
    }

    public FSMRegistry registerService(Object serviceInstance) {
        return registerService(serviceInstance, null);
    }

    public FSMRegistry registerService(Object serviceInstance, String namespace) {
        ScannedService scanned = AnnotationScanner.scan(serviceInstance);
        for (DecoratedTransition<Object, Object, Object> dt : scanned.transitions()) {
            String qualified = MachineDefinition.qualifyHandlerName(dt.getName(), namespace);
            registerTransition(qualified, dt);
        }
        for (AnnotationScanner.NamedCompensation nc : scanned.compensations()) {
            String qualified = MachineDefinition.qualifyHandlerName(nc.name(), namespace);
            registerCompensate(qualified, nc.fn());
        }
        for (AnnotationScanner.NamedEffect ne : scanned.effects()) {
            String qualified = MachineDefinition.qualifyHandlerName(ne.name(), namespace);
            registerEffect(qualified, ne.fn());
        }
        for (AnnotationScanner.NamedHook nh : scanned.hooks()) {
            String qualified = MachineDefinition.qualifyHandlerName(nh.name(), namespace);
            registerHook(qualified, nh.fn());
        }
        return this;
    }

    private void applyMachineBindings(MachineDefinition def, MachineHandlerBindings bindings) {
        if (bindings == null) return;
        String ns = bindings.getNamespace() != null ? bindings.getNamespace() : def.registry().namespace();

        for (Object svc : bindings.getServices()) {
            registerService(svc, ns);
        }
        bindings.getTransitions().forEach((name, fn) ->
                registerTransition(MachineDefinition.qualifyHandlerName(name, ns), fn));
        bindings.getCompensations().forEach((name, fn) ->
                registerCompensate(MachineDefinition.qualifyHandlerName(name, ns), fn));
        bindings.getEffects().forEach((name, fn) ->
                registerEffect(MachineDefinition.qualifyHandlerName(name, ns), fn));
        bindings.getHooks().forEach((name, fn) ->
                registerHook(MachineDefinition.qualifyHandlerName(name, ns), fn));
    }

    public void validateMachineHandlers(MachineDefinition def) {
        if (!def.registry().strict()) {
            return;
        }
        String ns = def.registry().namespace();
        for (StateNodeIR state : def.states().values()) {
            validateNodeHandlers(def.id(), state, ns);
        }
        for (String eff : def.effects()) {
            if (resolveEffect(eff, ns) == null) {
                throw new UnregisteredHandlerException(
                        def.id(), "effect", MachineDefinition.qualifyHandlerName(eff, ns)
                );
            }
        }
        for (LifecycleHookName slot : LifecycleHookName.values()) {
            for (String hookRef : def.hooks().get(slot)) {
                if (resolveHook(hookRef, ns) == null) {
                    throw new UnregisteredHandlerException(
                            def.id(), "hook (" + slot.yamlKey() + ")",
                            MachineDefinition.qualifyHandlerName(hookRef, ns)
                    );
                }
            }
        }
    }

    private void validateNodeHandlers(String machineId, StateNodeIR node, String ns) {
        for (String eff : node.entry()) {
            if (resolveEffect(eff, ns) == null) {
                throw new UnregisteredHandlerException(machineId, "effect", MachineDefinition.qualifyHandlerName(eff, ns));
            }
        }
        for (String eff : node.exit()) {
            if (resolveEffect(eff, ns) == null) {
                throw new UnregisteredHandlerException(machineId, "effect", MachineDefinition.qualifyHandlerName(eff, ns));
            }
        }
        for (TransitionEdgeIR edge : node.on().values()) {
            validateEdgeHandlers(machineId, edge, ns);
        }
        if (node.onDone() != null) {
            validateEdgeHandlers(machineId, node.onDone(), ns);
        }
        for (StateNodeIR child : node.states().values()) {
            validateNodeHandlers(machineId, child, ns);
        }
    }

    private void validateEdgeHandlers(String machineId, TransitionEdgeIR edge, String ns) {
        ResolvedTransition rt = null;
        if (edge.transition() != null && !edge.transition().isBlank()) {
            rt = resolveTransition(edge.transition(), ns);
            if (rt == null) {
                throw new UnregisteredHandlerException(
                        machineId, "transition", MachineDefinition.qualifyHandlerName(edge.transition(), ns)
                );
            }
        }
        String compRef = (rt != null && rt.decoratorPolicy().compensateHandler() != null)
                ? rt.decoratorPolicy().compensateHandler()
                : edge.compensate();
        if (compRef != null && !compRef.isBlank() && resolveCompensate(compRef, ns) == null) {
            throw new UnregisteredHandlerException(
                    machineId, "compensate", MachineDefinition.qualifyHandlerName(compRef, ns)
            );
        }
        for (String eff : edge.effects()) {
            if (resolveEffect(eff, ns) == null) {
                throw new UnregisteredHandlerException(machineId, "effect", MachineDefinition.qualifyHandlerName(eff, ns));
            }
        }
    }

    // =========================================================================
    // Machine Registration (YAML + Builder)
    // =========================================================================

    public MachineDefinition registerYaml(String yamlContent) {
        return registerYaml(yamlContent, null);
    }

    public MachineDefinition registerYaml(String yamlContent, MachineHandlerBindings bindings) {
        MachineDefinition def = YamlMachineParser.parseYaml(yamlContent);
        return registerMachine(def, bindings);
    }

    public MachineDefinition registerYamlFile(Path path) {
        return registerYamlFile(path, null);
    }

    public MachineDefinition registerYamlFile(Path path, MachineHandlerBindings bindings) {
        MachineDefinition def = YamlMachineParser.parseYamlFile(path);
        return registerMachine(def, bindings);
    }

    public MachineDefinition registerYamlResource(String classpathResource, MachineHandlerBindings bindings) {
        try (InputStream in = FSMRegistry.class.getClassLoader().getResourceAsStream(classpathResource)) {
            if (in == null) {
                throw new DfsmException("DFSM_RESOURCE_NOT_FOUND", "Classpath resource not found: " + classpathResource);
            }
            String yaml = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            return registerYaml(yaml, bindings);
        } catch (IOException e) {
            throw new DfsmException("DFSM_RESOURCE_IO_ERROR", "Failed reading resource: " + classpathResource, e);
        }
    }

    public <TContext> MachineDefinition registerBuilder(MachineBuilder<TContext> builder) {
        return registerBuilder(builder, null);
    }

    public <TContext> MachineDefinition registerBuilder(
            MachineBuilder<TContext> builder,
            MachineHandlerBindings bindings
    ) {
        return registerMachine(builder.build(), bindings);
    }

    public MachineDefinition registerMachine(MachineDefinition def, MachineHandlerBindings bindings) {
        if (bindings != null) {
            applyMachineBindings(def, bindings);
            boolean shouldValidate = bindings.getValidateHandlersNow() != null
                    ? bindings.getValidateHandlersNow()
                    : def.registry().strict();
            if (shouldValidate) {
                validateMachineHandlers(def);
            }
        }
        machines.put(def.id(), def);
        return def;
    }

    // =========================================================================
    // Actor Creation
    // =========================================================================

    public <TContext> DfsmActor<TContext> createActor(String machineIdOrYaml, Class<TContext> contextClass) {
        return createActor(machineIdOrYaml, contextClass, null);
    }

    public <TContext> DfsmActor<TContext> createActor(
            String machineIdOrYaml,
            Class<TContext> contextClass,
            ActorConfig<TContext> config
    ) {
        MachineDefinition def = resolveOrRegisterMachine(machineIdOrYaml);
        if (config != null && config.bindings() != null) {
            applyMachineBindings(def, config.bindings());
        }

        final String[] holderId = new String[1];
        DfsmActor<TContext> actor = new DfsmActor<>(
                def,
                contextClass,
                this,
                store,
                logEngine,
                clock,
                globalHooks,
                config,
                () -> {
                    if (holderId[0] != null) {
                        activeActors.remove(holderId[0]);
                    }
                }
        );
        holderId[0] = actor.getActorId();
        actor.initialize();
        activeActors.put(actor.getActorId(), actor);
        return actor;
    }

    private MachineDefinition resolveOrRegisterMachine(String machineIdOrYaml) {
        MachineDefinition existing = machines.get(machineIdOrYaml);
        if (existing != null) {
            return existing;
        }
        if (machineIdOrYaml != null && (machineIdOrYaml.contains("\n") || machineIdOrYaml.contains("dfsm:"))) {
            MachineDefinition parsed = YamlMachineParser.parseYaml(machineIdOrYaml);
            machines.put(parsed.id(), parsed);
            return parsed;
        }
        throw new DfsmException("DFSM_MACHINE_NOT_FOUND",
                "Machine '" + machineIdOrYaml + "' is not registered in FSMRegistry");
    }

    // =========================================================================
    // HandlerResolver Implementation
    // =========================================================================

    @Override
    public ResolvedTransition resolveTransition(String name, String namespace) {
        String qualified = MachineDefinition.qualifyHandlerName(name, namespace);
        TransitionEntry entry = transitions.get(qualified);
        if (entry == null) {
            entry = transitions.get(name);
        }
        if (entry == null) return null;
        return new ResolvedTransition(entry.name(), entry.fn(), entry.policy(), entry.inputClass(), entry.inputValidator());
    }

    @Override
    public ResolvedCompensation resolveCompensate(String name, String namespace) {
        String qualified = MachineDefinition.qualifyHandlerName(name, namespace);
        CompensationFunction<Object> fn = compensations.get(qualified);
        if (fn != null) {
            return new ResolvedCompensation(qualified, fn);
        }
        fn = compensations.get(name);
        return fn != null ? new ResolvedCompensation(name, fn) : null;
    }

    @Override
    public ResolvedEffect resolveEffect(String name, String namespace) {
        String qualified = MachineDefinition.qualifyHandlerName(name, namespace);
        EffectFunction<Object> fn = effects.get(qualified);
        if (fn != null) {
            return new ResolvedEffect(qualified, fn);
        }
        fn = effects.get(name);
        return fn != null ? new ResolvedEffect(name, fn) : null;
    }

    @Override
    public ResolvedHook resolveHook(String name, String namespace) {
        String qualified = MachineDefinition.qualifyHandlerName(name, namespace);
        LifecycleHookFunction<Object> fn = hooks.get(qualified);
        if (fn != null) {
            return new ResolvedHook(qualified, fn);
        }
        fn = hooks.get(name);
        return fn != null ? new ResolvedHook(name, fn) : null;
    }

    @Override
    public PartialTransitionPolicy globalDefaultPolicy() {
        return defaultPolicy;
    }

    // =========================================================================
    // Registry Introspection & Global Control Plane
    // =========================================================================

    public MachineDefinition getMachineDefinition(String machineId) {
        return machines.get(machineId);
    }

    public List<MachineSummary> listMachines() {
        List<MachineSummary> out = new ArrayList<>();
        for (MachineDefinition m : machines.values()) {
            int boundCount = (int) activeActors.values().stream()
                    .filter(a -> a.getMachineId().equals(m.id()))
                    .count();
            int explicitStates = (int) m.states().values().stream()
                    .filter(s -> !s.isImplicitError())
                    .count();
            out.add(new MachineSummary(
                    m.id(),
                    m.version(),
                    m.source(),
                    m.registry().namespace(),
                    explicitStates,
                    m.hasCustomErrorState(),
                    boundCount
            ));
        }
        return List.copyOf(out);
    }

    public List<HandlerDescriptor> listRegisteredHandlers() {
        return listRegisteredHandlers(null);
    }

    public List<HandlerDescriptor> listRegisteredHandlers(String namespaceFilter) {
        List<HandlerDescriptor> out = new ArrayList<>();
        String prefix = (namespaceFilter != null && !namespaceFilter.isBlank()) ? namespaceFilter + "." : null;

        transitions.forEach((k, v) -> {
            if (prefix == null || k.startsWith(prefix)) {
                out.add(new HandlerDescriptor(k, HandlerKind.TRANSITION, v.policy()));
            }
        });
        compensations.keySet().forEach(k -> {
            if (prefix == null || k.startsWith(prefix)) {
                out.add(new HandlerDescriptor(k, HandlerKind.COMPENSATE, null));
            }
        });
        effects.keySet().forEach(k -> {
            if (prefix == null || k.startsWith(prefix)) {
                out.add(new HandlerDescriptor(k, HandlerKind.EFFECT, null));
            }
        });
        hooks.keySet().forEach(k -> {
            if (prefix == null || k.startsWith(prefix)) {
                out.add(new HandlerDescriptor(k, HandlerKind.HOOK, null));
            }
        });
        return out;
    }

    public EffectiveMachineConfig getEffectiveConfig(String machineId) {
        for (DfsmActor<?> actor : activeActors.values()) {
            if (actor.getMachineId().equals(machineId)) {
                return actor.getEffectiveConfig();
            }
        }
        MachineDefinition def = machines.get(machineId);
        if (def == null) {
            throw new DfsmException("DFSM_MACHINE_NOT_FOUND", "Machine '" + machineId + "' not found");
        }
        String ns = def.registry().namespace();
        List<EffectiveTransitionConfig> txConfigs = new ArrayList<>();
        Set<String> effSet = new TreeSet<>(def.effects().stream()
                .map(e -> MachineDefinition.qualifyHandlerName(e, ns)).toList());
        collectStaticEffective(def, def.states().values(), ns, txConfigs, effSet);

        Map<LifecycleHookName, List<String>> resHooks = new EnumMap<>(LifecycleHookName.class);
        for (LifecycleHookName slot : LifecycleHookName.values()) {
            List<String> raw = def.hooks().get(slot);
            if (!raw.isEmpty()) {
                resHooks.put(slot, raw.stream().map(h -> MachineDefinition.qualifyHandlerName(h, ns)).toList());
            }
        }
        return new EffectiveMachineConfig(
                def.id(),
                def.version(),
                def.source(),
                def.hasCustomErrorState(),
                def.maxEffectChainDepth() != null ? def.maxEffectChainDepth() : DfsmActor.DEFAULT_MAX_EFFECT_CHAIN_DEPTH,
                Collections.unmodifiableMap(resHooks),
                List.copyOf(effSet),
                List.copyOf(txConfigs)
        );
    }

    private void collectStaticEffective(
            MachineDefinition def,
            Iterable<StateNodeIR> nodes,
            String ns,
            List<EffectiveTransitionConfig> out,
            Set<String> effSet
    ) {
        for (StateNodeIR node : nodes) {
            node.entry().forEach(e -> effSet.add(MachineDefinition.qualifyHandlerName(e, ns)));
            node.exit().forEach(e -> effSet.add(MachineDefinition.qualifyHandlerName(e, ns)));
            for (Map.Entry<String, TransitionEdgeIR> entry : node.on().entrySet()) {
                TransitionEdgeIR edge = entry.getValue();
                ResolvedTransition rt = edge.transition() != null ? resolveTransition(edge.transition(), ns) : null;
                NormalizedTransitionPolicy norm = PolicyMerger.normalize(
                        defaultPolicy, def.defaults(), edge.policy(), rt != null ? rt.decoratorPolicy() : null
                );
                String compRef = norm.compensateHandler() != null ? norm.compensateHandler() : edge.compensate();
                ResolvedCompensation rc = compRef != null ? resolveCompensate(compRef, ns) : null;
                out.add(new EffectiveTransitionConfig(
                        node.path(),
                        entry.getKey(),
                        edge.target(),
                        rt != null ? rt.resolvedName() : edge.transition(),
                        rc != null ? rc.resolvedName() : compRef,
                        norm,
                        CircuitStatus.CLOSED
                ));
            }
            collectStaticEffective(def, node.states().values(), ns, out, effSet);
        }
    }

    public List<ActorSummary> listActors() {
        return activeActors.values().stream()
                .map(a -> new ActorSummary(
                        a.getActorId(),
                        a.getMachineId(),
                        a.getSchedulerConfig().enabled(),
                        a.getRecoveryConfig().defaultAction()
                ))
                .toList();
    }

    public long getGlobalActiveCount() {
        return getGlobalActiveCount(null);
    }

    public long getGlobalActiveCount(String machineId) {
        store.initialize();
        return store.countByStatuses(new StatusQueryFilter(
                machineId, null, TransactionStatus.NON_TERMINAL_STATUSES, null, 0, 0
        ));
    }

    public long getGlobalInFlightCount(InFlightFilter filter) {
        store.initialize();
        return store.countInFlight(
                filter != null ? filter : InFlightFilter.all(),
                clock.now(),
                30_000L
        );
    }

    public InFlightSummary getInFlightSummary() {
        store.initialize();
        long now = clock.now();
        long inFlight = store.countInFlight(new InFlightFilter(null, null, false, false, null, 0, 0), now, 30_000L);
        long totalIncComp = store.countInFlight(InFlightFilter.all(), now, 30_000L);
        long compensating = Math.max(0L, totalIncComp - inFlight);
        long stuck = store.countInFlight(InFlightFilter.onlyStuck(), now, 30_000L);

        Map<String, Long> byMachine = new LinkedHashMap<>();
        for (String mId : machines.keySet()) {
            long c = store.countInFlight(new InFlightFilter(mId, null, false, true, null, 0, 0), now, 30_000L);
            byMachine.put(mId, c);
        }
        return new InFlightSummary(inFlight, compensating, stuck, Map.copyOf(byMachine));
    }

    public Map<String, ForceCleanUpReport> forceCleanUp(ForceCleanUpOptions options) {
        Map<String, ForceCleanUpReport> reports = new LinkedHashMap<>();
        for (DfsmActor<?> actor : activeActors.values()) {
            reports.put(actor.getActorId(), actor.forceCleanUp(options));
        }
        return reports;
    }

    public synchronized void shutdown() {
        for (DfsmActor<?> actor : new ArrayList<>(activeActors.values())) {
            actor.close();
        }
        activeActors.clear();
        store.close();
    }

    @Override
    public void close() {
        shutdown();
    }
}
