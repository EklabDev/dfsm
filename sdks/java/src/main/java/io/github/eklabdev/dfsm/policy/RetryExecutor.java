package io.github.eklabdev.dfsm.policy;

import io.github.eklabdev.dfsm.Clock;

import java.util.concurrent.ThreadLocalRandom;
import java.util.function.IntFunction;

/**
 * Single deduplicated Retry + Backoff executor.
 */
public final class RetryExecutor {
    private RetryExecutor() {}

    public record RetryResult<R>(R result, int attempts) {}

    public static final class ExhaustedRetryException extends RuntimeException {
        private final int attempts;

        public ExhaustedRetryException(Throwable cause, int attempts) {
            super(cause.getMessage(), cause);
            this.attempts = attempts;
        }

        public int getAttempts() {
            return attempts;
        }
    }

    public static <R> RetryResult<R> execute(
            NormalizedTransitionPolicy.RetryPolicy policy,
            Clock clock,
            IntFunction<R> operation
    ) {
        int maxAttempts = Math.max(1, policy.maxAttempts());
        Throwable lastError = null;

        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                R value = operation.apply(attempt);
                return new RetryResult<>(value, attempt);
            } catch (Throwable err) {
                lastError = err;
                if (attempt < maxAttempts) {
                    long delay = computeDelayMs(policy.backoff(), attempt);
                    clock.sleep(delay);
                }
            }
        }

        throw new ExhaustedRetryException(lastError, maxAttempts);
    }

    public static long computeDelayMs(NormalizedTransitionPolicy.BackoffPolicy backoff, int failedAttempt) {
        long base = backoff.initialDelayMs();
        long max = Math.max(base, backoff.maxDelayMs());
        double mult = Math.max(1.0, backoff.multiplier());

        long raw = switch (backoff.strategy()) {
            case FIXED -> base;
            case LINEAR -> base * Math.max(1, failedAttempt);
            case EXPONENTIAL, EXPONENTIAL_JITTER ->
                    Math.round(base * Math.pow(mult, Math.max(0, failedAttempt - 1)));
        };

        long capped = Math.min(max, Math.max(0L, raw));
        if (backoff.strategy() == BackoffStrategy.EXPONENTIAL_JITTER && capped > 0) {
            double jitterFactor = 0.5 + ThreadLocalRandom.current().nextDouble() * 0.5;
            return Math.round(capped * jitterFactor);
        }
        return capped;
    }
}

