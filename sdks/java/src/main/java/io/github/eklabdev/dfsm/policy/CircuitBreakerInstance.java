package io.github.eklabdev.dfsm.policy;

import io.github.eklabdev.dfsm.Clock;
import io.github.eklabdev.dfsm.error.CircuitOpenException;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.function.Supplier;

/**
 * Thread-safe sliding-window Circuit Breaker (`CLOSED` / `OPEN` / `HALF_OPEN`) scoped per Actor transition.
 */
public final class CircuitBreakerInstance {
    private final String key;
    private final NormalizedTransitionPolicy.CircuitBreakerPolicy policy;
    private final Clock clock;

    private CircuitStatus status = CircuitStatus.CLOSED;
    private long openedAt = 0L;
    private int halfOpenInFlightOrSuccess = 0;
    private final Deque<Boolean> slidingWindow = new ArrayDeque<>();

    public CircuitBreakerInstance(
            String key,
            NormalizedTransitionPolicy.CircuitBreakerPolicy policy,
            Clock clock
    ) {
        this.key = key;
        this.policy = policy;
        this.clock = clock;
    }

    public synchronized CircuitStatus getStatus() {
        if (!policy.enabled()) {
            return CircuitStatus.CLOSED;
        }
        if (status == CircuitStatus.OPEN && (clock.now() - openedAt) >= policy.openDurationMs()) {
            status = CircuitStatus.HALF_OPEN;
            halfOpenInFlightOrSuccess = 0;
        }
        return status;
    }

    public <R> R execute(Supplier<R> fn) {
        if (!policy.enabled()) {
            return fn.get();
        }

        synchronized (this) {
            CircuitStatus current = getStatus();
            if (current == CircuitStatus.OPEN) {
                throw new CircuitOpenException(key);
            }
        }

        try {
            R res = fn.get();
            recordSuccess();
            return res;
        } catch (RuntimeException ex) {
            recordFailure();
            throw ex;
        }
    }

    private synchronized void recordSuccess() {
        if (status == CircuitStatus.HALF_OPEN) {
            halfOpenInFlightOrSuccess++;
            if (halfOpenInFlightOrSuccess >= policy.halfOpenMaxCalls()) {
                status = CircuitStatus.CLOSED;
                slidingWindow.clear();
                halfOpenInFlightOrSuccess = 0;
            }
            return;
        }
        pushOutcome(true);
    }

    private synchronized void recordFailure() {
        if (status == CircuitStatus.HALF_OPEN) {
            tripOpen();
            return;
        }
        pushOutcome(false);
        long failures = slidingWindow.stream().filter(ok -> !ok).count();
        if (failures >= policy.failureThreshold()) {
            tripOpen();
        }
    }

    private void pushOutcome(boolean success) {
        slidingWindow.addLast(success);
        while (slidingWindow.size() > policy.slidingWindowSize()) {
            slidingWindow.removeFirst();
        }
    }

    private void tripOpen() {
        status = CircuitStatus.OPEN;
        openedAt = clock.now();
        halfOpenInFlightOrSuccess = 0;
    }

    public synchronized void reset() {
        status = CircuitStatus.CLOSED;
        slidingWindow.clear();
        openedAt = 0L;
        halfOpenInFlightOrSuccess = 0;
    }
}

