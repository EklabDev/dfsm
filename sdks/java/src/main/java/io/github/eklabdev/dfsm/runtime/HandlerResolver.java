package io.github.eklabdev.dfsm.runtime;

import io.github.eklabdev.dfsm.CompensationFunction;
import io.github.eklabdev.dfsm.EffectFunction;
import io.github.eklabdev.dfsm.LifecycleHookFunction;
import io.github.eklabdev.dfsm.TransitionFunction;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.validation.SchemaValidator;

/**
 * Internal handler lookup contract implemented by {@link FSMRegistry}.
 */
public interface HandlerResolver {
    record ResolvedTransition(
            String resolvedName,
            TransitionFunction<Object, Object, Object> fn,
            PartialTransitionPolicy decoratorPolicy,
            Class<Object> inputClass,
            SchemaValidator<Object> inputValidator
    ) {}

    record ResolvedCompensation(
            String resolvedName,
            CompensationFunction<Object> fn
    ) {}

    record ResolvedEffect(
            String resolvedName,
            EffectFunction<Object> fn
    ) {}

    record ResolvedHook(
            String resolvedName,
            LifecycleHookFunction<Object> fn
    ) {}

    ResolvedTransition resolveTransition(String name, String namespace);

    ResolvedCompensation resolveCompensate(String name, String namespace);

    ResolvedEffect resolveEffect(String name, String namespace);

    ResolvedHook resolveHook(String name, String namespace);

    PartialTransitionPolicy globalDefaultPolicy();
}

