package io.github.eklabdev.dfsm.policy;

import java.util.List;

/**
 * Normalizes and deduplicates policies from lowest to highest priority:
 * {@code SDK Default <- Global Default <- Machine Defaults YAML <- Transition YAML <- Code Annotation/Decorator}.
 */
public final class PolicyMerger {
    private PolicyMerger() {}

    public static NormalizedTransitionPolicy normalize(
            PartialTransitionPolicy globalDefaults,
            PartialTransitionPolicy machineDefaults,
            PartialTransitionPolicy transitionYamlPolicy,
            PartialTransitionPolicy decoratorPolicy
    ) {
        NormalizedTransitionPolicy acc = NormalizedTransitionPolicy.sdkDefault();
        List<PartialTransitionPolicy> layers = List.of(
                globalDefaults != null ? globalDefaults : PartialTransitionPolicy.EMPTY,
                machineDefaults != null ? machineDefaults : PartialTransitionPolicy.EMPTY,
                transitionYamlPolicy != null ? transitionYamlPolicy : PartialTransitionPolicy.EMPTY,
                decoratorPolicy != null ? decoratorPolicy : PartialTransitionPolicy.EMPTY
        );

        for (PartialTransitionPolicy layer : layers) {
            acc = applyLayer(acc, layer);
        }
        return acc;
    }

    private static NormalizedTransitionPolicy applyLayer(
            NormalizedTransitionPolicy base,
            PartialTransitionPolicy layer
    ) {
        if (layer == null) {
            return base;
        }

        NormalizedTransitionPolicy.RetryPolicy retry = base.retry();
        if (layer.retry() != null) {
            int maxAttempts = layer.retry().maxAttempts() != null
                    ? Math.max(1, layer.retry().maxAttempts())
                    : retry.maxAttempts();
            NormalizedTransitionPolicy.BackoffPolicy bo = retry.backoff();
            if (layer.retry().backoff() != null) {
                PartialTransitionPolicy.PartialBackoff pbo = layer.retry().backoff();
                bo = new NormalizedTransitionPolicy.BackoffPolicy(
                        pbo.strategy() != null ? pbo.strategy() : bo.strategy(),
                        pbo.initialDelayMs() != null ? Math.max(0L, pbo.initialDelayMs()) : bo.initialDelayMs(),
                        pbo.maxDelayMs() != null ? Math.max(0L, pbo.maxDelayMs()) : bo.maxDelayMs(),
                        pbo.multiplier() != null ? Math.max(1.0, pbo.multiplier()) : bo.multiplier()
                );
            }
            retry = new NormalizedTransitionPolicy.RetryPolicy(maxAttempts, bo);
        }

        NormalizedTransitionPolicy.CircuitBreakerPolicy cb = base.circuitBreaker();
        if (layer.circuitBreaker() != null) {
            PartialTransitionPolicy.PartialCircuitBreaker pcb = layer.circuitBreaker();
            cb = new NormalizedTransitionPolicy.CircuitBreakerPolicy(
                    pcb.enabled() != null ? pcb.enabled() : cb.enabled(),
                    pcb.failureThreshold() != null ? Math.max(1, pcb.failureThreshold()) : cb.failureThreshold(),
                    pcb.slidingWindowSize() != null ? Math.max(1, pcb.slidingWindowSize()) : cb.slidingWindowSize(),
                    pcb.openDurationMs() != null ? Math.max(1L, pcb.openDurationMs()) : cb.openDurationMs(),
                    pcb.halfOpenMaxCalls() != null ? Math.max(1, pcb.halfOpenMaxCalls()) : cb.halfOpenMaxCalls()
            );
        }

        NormalizedTransitionPolicy.OnFailPolicy onFail = base.onFail();
        if (layer.onFail() != null) {
            PartialTransitionPolicy.PartialOnFail pof = layer.onFail();
            onFail = new NormalizedTransitionPolicy.OnFailPolicy(
                    pof.compensate() != null ? pof.compensate() : onFail.compensate(),
                    pof.target() != null && !pof.target().isBlank() ? pof.target() : onFail.target()
            );
        }

        NormalizedTransitionPolicy.BenchmarkPolicy benchmark = base.benchmark();
        if (layer.benchmark() != null && layer.benchmark().enabled() != null) {
            benchmark = new NormalizedTransitionPolicy.BenchmarkPolicy(layer.benchmark().enabled());
        }

        String compensateHandler = layer.compensateHandler() != null && !layer.compensateHandler().isBlank()
                ? layer.compensateHandler()
                : base.compensateHandler();

        return new NormalizedTransitionPolicy(retry, cb, onFail, benchmark, compensateHandler);
    }
}

