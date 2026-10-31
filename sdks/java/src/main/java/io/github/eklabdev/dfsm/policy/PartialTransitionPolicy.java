package io.github.eklabdev.dfsm.policy;

/**
 * Partial transition policy where {@code null} fields mean "not explicitly specified at this layer",
 * enabling leaf-by-leaf deduplicated policy merging across Code Annotations, Transition YAML,
 * Machine Defaults YAML, and SDK Defaults.
 */
public record PartialTransitionPolicy(
        PartialRetry retry,
        PartialCircuitBreaker circuitBreaker,
        PartialOnFail onFail,
        PartialBenchmark benchmark,
        String compensateHandler
) {
    public static final PartialTransitionPolicy EMPTY = new PartialTransitionPolicy(null, null, null, null, null);

    public record PartialBackoff(
            BackoffStrategy strategy,
            Long initialDelayMs,
            Long maxDelayMs,
            Double multiplier
    ) {}

    public record PartialRetry(
            Integer maxAttempts,
            PartialBackoff backoff
    ) {}

    public record PartialCircuitBreaker(
            Boolean enabled,
            Integer failureThreshold,
            Integer slidingWindowSize,
            Long openDurationMs,
            Integer halfOpenMaxCalls
    ) {}

    public record PartialOnFail(
            Boolean compensate,
            String target
    ) {}

    public record PartialBenchmark(
            Boolean enabled
    ) {}

    public PartialTransitionPolicy withRetry(PartialRetry newRetry) {
        PartialRetry merged = this.retry == null ? newRetry : new PartialRetry(
                newRetry.maxAttempts() != null ? newRetry.maxAttempts() : this.retry.maxAttempts(),
                mergeBackoff(this.retry.backoff(), newRetry.backoff())
        );
        return new PartialTransitionPolicy(merged, circuitBreaker, onFail, benchmark, compensateHandler);
    }

    public PartialTransitionPolicy withBackoff(PartialBackoff newBackoff) {
        PartialRetry merged = this.retry == null
                ? new PartialRetry(null, newBackoff)
                : new PartialRetry(this.retry.maxAttempts(), mergeBackoff(this.retry.backoff(), newBackoff));
        return new PartialTransitionPolicy(merged, circuitBreaker, onFail, benchmark, compensateHandler);
    }

    public PartialTransitionPolicy withCircuitBreaker(PartialCircuitBreaker cb) {
        return new PartialTransitionPolicy(retry, cb, onFail, benchmark, compensateHandler);
    }

    public PartialTransitionPolicy withOnFail(PartialOnFail of) {
        return new PartialTransitionPolicy(retry, circuitBreaker, of, benchmark, compensateHandler);
    }

    public PartialTransitionPolicy withBenchmark(PartialBenchmark bm) {
        return new PartialTransitionPolicy(retry, circuitBreaker, onFail, bm, compensateHandler);
    }

    public PartialTransitionPolicy withCompensateHandler(String handler) {
        return new PartialTransitionPolicy(retry, circuitBreaker, onFail, benchmark, handler);
    }

    private static PartialBackoff mergeBackoff(PartialBackoff base, PartialBackoff over) {
        if (base == null) return over;
        if (over == null) return base;
        return new PartialBackoff(
                over.strategy() != null ? over.strategy() : base.strategy(),
                over.initialDelayMs() != null ? over.initialDelayMs() : base.initialDelayMs(),
                over.maxDelayMs() != null ? over.maxDelayMs() : base.maxDelayMs(),
                over.multiplier() != null ? over.multiplier() : base.multiplier()
        );
    }
}

