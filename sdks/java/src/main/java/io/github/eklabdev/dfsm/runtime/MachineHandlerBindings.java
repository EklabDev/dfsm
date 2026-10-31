package io.github.eklabdev.dfsm.runtime;

import io.github.eklabdev.dfsm.CompensationFunction;
import io.github.eklabdev.dfsm.EffectFunction;
import io.github.eklabdev.dfsm.LifecycleHookFunction;
import io.github.eklabdev.dfsm.TransitionFunction;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Inline handler &amp; service bindings passed on FSM machine registration or actor creation
 * ({@code registry.registerYaml(yaml, bindings)} / {@code registry.createActor(yaml, Ctx.class, config)}).
 */
public final class MachineHandlerBindings {
    private String namespace;
    private final List<Object> services = new ArrayList<>();
    private final Map<String, TransitionFunction<?, ?, ?>> transitions = new LinkedHashMap<>();
    private final Map<String, CompensationFunction<?>> compensations = new LinkedHashMap<>();
    private final Map<String, EffectFunction<?>> effects = new LinkedHashMap<>();
    private final Map<String, LifecycleHookFunction<?>> hooks = new LinkedHashMap<>();
    private Boolean validateHandlersNow;

    public static MachineHandlerBindings ofServices(Object... serviceInstances) {
        return builder().services(serviceInstances).build();
    }

    public static Builder builder() {
        return new Builder();
    }

    public String getNamespace() {
        return namespace;
    }

    public List<Object> getServices() {
        return List.copyOf(services);
    }

    public Map<String, TransitionFunction<?, ?, ?>> getTransitions() {
        return Map.copyOf(transitions);
    }

    public Map<String, CompensationFunction<?>> getCompensations() {
        return Map.copyOf(compensations);
    }

    public Map<String, EffectFunction<?>> getEffects() {
        return Map.copyOf(effects);
    }

    public Map<String, LifecycleHookFunction<?>> getHooks() {
        return Map.copyOf(hooks);
    }

    public Boolean getValidateHandlersNow() {
        return validateHandlersNow;
    }

    public static final class Builder {
        private final MachineHandlerBindings target = new MachineHandlerBindings();

        public Builder namespace(String ns) {
            target.namespace = ns;
            return this;
        }

        public Builder services(Object... serviceInstances) {
            target.services.addAll(Arrays.asList(serviceInstances));
            return this;
        }

        public <C, I, O> Builder transition(String name, TransitionFunction<C, I, O> fn) {
            target.transitions.put(name, fn);
            return this;
        }

        public <C> Builder compensate(String name, CompensationFunction<C> fn) {
            target.compensations.put(name, fn);
            return this;
        }

        public <C> Builder effect(String name, EffectFunction<C> fn) {
            target.effects.put(name, fn);
            return this;
        }

        public <E> Builder hook(String name, LifecycleHookFunction<E> fn) {
            target.hooks.put(name, fn);
            return this;
        }

        public Builder validateHandlersNow(boolean validate) {
            target.validateHandlersNow = validate;
            return this;
        }

        public MachineHandlerBindings build() {
            return target;
        }
    }
}

