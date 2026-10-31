package io.github.eklabdev.dfsm.policy;

/**
 * Canonical deduplicated transition policy produced by {@link PolicyMerger}
 * ({@code Code Decorator > Transition YAML > Machine Defaults > SDK Default}).
 */
public record NormalizedTransitionPolicy(
        RetryPolicy retry,
        CircuitBreakerPolicy circuitBreaker,
        OnFailPolicy onFail,
        BenchmarkPolicy benchmark,
        String compensateHandler
) {
    public record BackoffPolicy(
            BackoffStrategy strategy,
            long initialDelayMs,
            long maxDelayMs,
            double multiplier
    ) {}

    public record RetryPolicy(
            int maxAttempts,
            BackoffPolicy backoff
    ) {}

    public record CircuitBreakerPolicy(
            boolean enabled,
            int failureThreshold,
            int slidingWindowSize,
            long openDurationMs,
            int halfOpenMaxCalls
    ) {}

    public record OnFailPolicy(
            boolean compensate,
            String target
    ) {}

    public record BenchmarkPolicy(
            boolean enabled
    ) {}

    public static NormalizedTransitionPolicy sdkDefault() {
        return new NormalizedTransitionPolicy(
                new RetryPolicy(1, new BackoffPolicy(BackoffStrategy.EXPONENTIAL, 100L, 5000L, 2.0)),
                new CircuitBreakerPolicy(false, 5, 10, 30_000L, 1),
                new OnFailPolicy(false, "error"),
                new BenchmarkPolicy(true),
                null
        );
    }
}

