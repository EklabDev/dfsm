package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.runtime.DfsmActor;

/**
 * Context passed to every {@code @DfsmEffect} handler (`entry`, `exit`, post-step `effects`,
 * and routed sub-effects). Exposes {@link #actor()} and {@link #runEffect(String, Object)}
 * so an effect can act as a conditional {@code if / else} router and trigger automatic next transitions.
 */
public record EffectRequest<TContext>(
        String transactionId,
        String machineId,
        String actorId,
        StateValue state,
        TContext context,
        String effectName,
        Object payload,
        DfsmActor<TContext> actor,
        EffectDispatcher dispatcher
) {
    @FunctionalInterface
    public interface EffectDispatcher {
        void dispatch(String effectHandlerName, Object payload) throws Exception;
    }

    public void runEffect(String effectHandlerName) {
        runEffect(effectHandlerName, null);
    }

    public void runEffect(String effectHandlerName, Object subPayload) {
        if (dispatcher == null) {
            throw new IllegalStateException("No EffectDispatcher bound on EffectRequest");
        }
        try {
            dispatcher.dispatch(effectHandlerName, subPayload);
        } catch (RuntimeException re) {
            throw re;
        } catch (Exception ex) {
            throw new RuntimeException(ex);
        }
    }
}

