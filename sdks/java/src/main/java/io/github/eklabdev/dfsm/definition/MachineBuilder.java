package io.github.eklabdev.dfsm.definition;

import io.github.eklabdev.dfsm.LifecycleHookName;
import io.github.eklabdev.dfsm.definition.MachineDefinition.MachineHooksIR;
import io.github.eklabdev.dfsm.definition.MachineDefinition.RegistryBindingIR;
import io.github.eklabdev.dfsm.definition.MachineDefinition.StateNodeIR;
import io.github.eklabdev.dfsm.definition.MachineDefinition.TransitionEdgeIR;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Fluent programmatic {@code MachineBuilder<TContext>} compiling to the exact same {@link MachineDefinition}
 * AST as {@link YamlMachineParser}.
 */
public final class MachineBuilder<TContext> {
    private final String id;
    private String version = "1.0.0";
    private String description;
    private StateNodeType rootType = StateNodeType.COMPOUND;
    private String initial;
    private RegistryBindingIR registry = new RegistryBindingIR(null, true);
    private PartialTransitionPolicy defaults = PartialTransitionPolicy.EMPTY;
    private final Map<LifecycleHookName, List<String>> hooks = new EnumMap<>(LifecycleHookName.class);
    private final List<String> effects = new ArrayList<>();
    private Integer maxEffectChainDepth;
    private final Map<String, StateNodeIR> states = new LinkedHashMap<>();

    private MachineBuilder(String id) {
        this.id = id;
    }

    public static <C> MachineBuilder<C> create(String machineId) {
        return new MachineBuilder<>(machineId);
    }

    public MachineBuilder<TContext> version(String v) {
        this.version = v;
        return this;
    }

    public MachineBuilder<TContext> description(String desc) {
        this.description = desc;
        return this;
    }

    public MachineBuilder<TContext> initial(String stateKey) {
        this.initial = stateKey;
        this.rootType = StateNodeType.COMPOUND;
        return this;
    }

    public MachineBuilder<TContext> parallelRoot() {
        this.rootType = StateNodeType.PARALLEL;
        this.initial = null;
        return this;
    }

    public MachineBuilder<TContext> registry(String namespace, boolean strict) {
        this.registry = new RegistryBindingIR(namespace, strict);
        return this;
    }

    public MachineBuilder<TContext> namespace(String namespace) {
        this.registry = new RegistryBindingIR(namespace, this.registry.strict());
        return this;
    }

    public MachineBuilder<TContext> defaults(PartialTransitionPolicy defaultPolicy) {
        this.defaults = defaultPolicy != null ? defaultPolicy : PartialTransitionPolicy.EMPTY;
        return this;
    }

    public MachineBuilder<TContext> hook(LifecycleHookName slot, String... handlerNames) {
        List<String> list = hooks.computeIfAbsent(slot, k -> new ArrayList<>());
        for (String h : handlerNames) {
            if (h != null && !h.isBlank() && !list.contains(h)) {
                list.add(h);
            }
        }
        return this;
    }

    public MachineBuilder<TContext> effects(String... effectHandlerNames) {
        for (String eff : effectHandlerNames) {
            if (eff != null && !eff.isBlank() && !effects.contains(eff)) {
                effects.add(eff);
            }
        }
        return this;
    }

    public MachineBuilder<TContext> maxEffectChainDepth(int maxDepth) {
        this.maxEffectChainDepth = maxDepth;
        return this;
    }

    public MachineBuilder<TContext> state(String key, Consumer<StateBuilder> configurator) {
        StateBuilder sb = new StateBuilder(key, key, StateNodeType.ATOMIC);
        if (configurator != null) {
            configurator.accept(sb);
        }
        states.put(key, sb.build());
        return this;
    }

    public MachineBuilder<TContext> compoundState(
            String key,
            String initialChild,
            Consumer<StateBuilder> configurator
    ) {
        StateBuilder sb = new StateBuilder(key, key, StateNodeType.COMPOUND).initial(initialChild);
        if (configurator != null) {
            configurator.accept(sb);
        }
        states.put(key, sb.build());
        return this;
    }

    public MachineBuilder<TContext> parallelState(String key, Consumer<StateBuilder> configurator) {
        StateBuilder sb = new StateBuilder(key, key, StateNodeType.PARALLEL);
        if (configurator != null) {
            configurator.accept(sb);
        }
        states.put(key, sb.build());
        return this;
    }

    public MachineBuilder<TContext> finalState(String key) {
        return finalState(key, null);
    }

    public MachineBuilder<TContext> finalState(String key, Consumer<StateBuilder> configurator) {
        StateBuilder sb = new StateBuilder(key, key, StateNodeType.FINAL);
        if (configurator != null) {
            configurator.accept(sb);
        }
        states.put(key, sb.build());
        return this;
    }

    public MachineBuilder<TContext> errorState(Consumer<StateBuilder> configurator) {
        StateBuilder sb = new StateBuilder("error", "error", StateNodeType.ATOMIC);
        if (configurator != null) {
            configurator.accept(sb);
        }
        states.put("error", sb.build());
        return this;
    }

    public MachineDefinition build() {
        MachineHooksIR hooksIR = new MachineHooksIR(
                List.copyOf(hooks.getOrDefault(LifecycleHookName.ON_START, List.of())),
                List.copyOf(hooks.getOrDefault(LifecycleHookName.BEFORE_TRANSITION, List.of())),
                List.copyOf(hooks.getOrDefault(LifecycleHookName.AFTER_TRANSITION, List.of())),
                List.copyOf(hooks.getOrDefault(LifecycleHookName.ON_COMPENSATE, List.of())),
                List.copyOf(hooks.getOrDefault(LifecycleHookName.ON_COMPLETE, List.of())),
                List.copyOf(hooks.getOrDefault(LifecycleHookName.ON_TERMINAL, List.of()))
        );

        return MachineDefinition.finalizeAndValidate(
                id,
                version,
                description,
                "builder",
                rootType,
                initial,
                registry,
                defaults,
                hooksIR,
                effects,
                maxEffectChainDepth,
                states
        );
    }

    public static final class TransitionBuilder {
        private final String event;
        private String target;
        private String transition;
        private String compensate;
        private final List<String> effects = new ArrayList<>();
        private String description;
        private PartialTransitionPolicy policy = PartialTransitionPolicy.EMPTY;

        private TransitionBuilder(String event) {
            this.event = event;
        }

        public TransitionBuilder target(String targetState) {
            this.target = targetState;
            return this;
        }

        public TransitionBuilder transition(String handlerName) {
            this.transition = handlerName;
            return this;
        }

        public TransitionBuilder compensate(String compensateHandlerName) {
            this.compensate = compensateHandlerName;
            this.policy = this.policy.withCompensateHandler(compensateHandlerName);
            return this;
        }

        public TransitionBuilder effects(String... effectNames) {
            this.effects.addAll(Arrays.asList(effectNames));
            return this;
        }

        public TransitionBuilder description(String desc) {
            this.description = desc;
            return this;
        }

        public TransitionBuilder policy(PartialTransitionPolicy p) {
            this.policy = p != null ? p : PartialTransitionPolicy.EMPTY;
            if (this.compensate != null) {
                this.policy = this.policy.withCompensateHandler(this.compensate);
            }
            return this;
        }

        public TransitionBuilder retry(int maxAttempts) {
            this.policy = this.policy.withRetry(new PartialTransitionPolicy.PartialRetry(maxAttempts, null));
            return this;
        }

        public TransitionBuilder onFail(boolean compensateOnFail, String fallbackTarget) {
            this.policy = this.policy.withOnFail(new PartialTransitionPolicy.PartialOnFail(
                    compensateOnFail, fallbackTarget
            ));
            return this;
        }

        TransitionEdgeIR build() {
            return new TransitionEdgeIR(
                    event,
                    target,
                    transition,
                    compensate,
                    List.copyOf(effects),
                    description,
                    policy
            );
        }
    }

    public static final class StateBuilder {
        private final String key;
        private final String path;
        private StateNodeType type;
        private String description;
        private String initial;
        private final List<String> entry = new ArrayList<>();
        private final List<String> exit = new ArrayList<>();
        private final Map<String, TransitionEdgeIR> on = new LinkedHashMap<>();
        private TransitionEdgeIR onDone;
        private final Map<String, StateNodeIR> children = new LinkedHashMap<>();

        StateBuilder(String key, String path, StateNodeType type) {
            this.key = key;
            this.path = path;
            this.type = type;
        }

        public StateBuilder type(StateNodeType t) {
            this.type = t;
            return this;
        }

        public StateBuilder description(String desc) {
            this.description = desc;
            return this;
        }

        public StateBuilder initial(String childKey) {
            this.initial = childKey;
            if (this.type == StateNodeType.ATOMIC) {
                this.type = StateNodeType.COMPOUND;
            }
            return this;
        }

        public StateBuilder entry(String... effectNames) {
            this.entry.addAll(Arrays.asList(effectNames));
            return this;
        }

        public StateBuilder exit(String... effectNames) {
            this.exit.addAll(Arrays.asList(effectNames));
            return this;
        }

        public StateBuilder on(String event, String targetState) {
            on.put(event, new TransitionBuilder(event).target(targetState).build());
            return this;
        }

        public StateBuilder on(String event, String targetState, String transitionHandler) {
            on.put(event, new TransitionBuilder(event).target(targetState).transition(transitionHandler).build());
            return this;
        }

        public StateBuilder on(String event, Consumer<TransitionBuilder> configurator) {
            TransitionBuilder tb = new TransitionBuilder(event);
            configurator.accept(tb);
            on.put(event, tb.build());
            return this;
        }

        public StateBuilder onDone(String targetState) {
            this.onDone = new TransitionBuilder("$onDone").target(targetState).build();
            return this;
        }

        public StateBuilder onDone(Consumer<TransitionBuilder> configurator) {
            TransitionBuilder tb = new TransitionBuilder("$onDone");
            configurator.accept(tb);
            this.onDone = tb.build();
            return this;
        }

        public StateBuilder state(String childKey, Consumer<StateBuilder> configurator) {
            if (this.type == StateNodeType.ATOMIC) {
                this.type = StateNodeType.COMPOUND;
            }
            StateBuilder child = new StateBuilder(childKey, path + "." + childKey, StateNodeType.ATOMIC);
            if (configurator != null) {
                configurator.accept(child);
            }
            children.put(childKey, child.build());
            return this;
        }

        public StateBuilder compoundState(
                String childKey,
                String grandInitial,
                Consumer<StateBuilder> configurator
        ) {
            if (this.type == StateNodeType.ATOMIC) {
                this.type = StateNodeType.COMPOUND;
            }
            StateBuilder child = new StateBuilder(childKey, path + "." + childKey, StateNodeType.COMPOUND)
                    .initial(grandInitial);
            if (configurator != null) {
                configurator.accept(child);
            }
            children.put(childKey, child.build());
            return this;
        }

        public StateBuilder parallelState(String childKey, Consumer<StateBuilder> configurator) {
            if (this.type == StateNodeType.ATOMIC) {
                this.type = StateNodeType.COMPOUND;
            }
            StateBuilder child = new StateBuilder(childKey, path + "." + childKey, StateNodeType.PARALLEL);
            if (configurator != null) {
                configurator.accept(child);
            }
            children.put(childKey, child.build());
            return this;
        }

        public StateBuilder finalState(String childKey) {
            if (this.type == StateNodeType.ATOMIC) {
                this.type = StateNodeType.COMPOUND;
            }
            children.put(childKey, new StateBuilder(childKey, path + "." + childKey, StateNodeType.FINAL).build());
            return this;
        }

        StateNodeIR build() {
            return new StateNodeIR(
                    key,
                    path,
                    type,
                    description,
                    initial,
                    List.copyOf(entry),
                    List.copyOf(exit),
                    Collections.unmodifiableMap(new LinkedHashMap<>(on)),
                    onDone,
                    Collections.unmodifiableMap(new LinkedHashMap<>(children)),
                    false
            );
        }
    }
}

