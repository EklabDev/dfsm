package io.github.eklabdev.dfsm;

import java.util.concurrent.atomic.AtomicLong;

/**
 * Pluggable time and sleep provider for deterministic retry backoff, circuit breaker cooldowns,
 * and stuck lease expiration testing.
 */
public interface Clock {
    long now();

    default void sleep(long millis) {
        if (millis <= 0) {
            return;
        }
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Interrupted during backoff sleep", e);
        }
    }

    static Clock system() {
        return SystemClock.INSTANCE;
    }

    enum SystemClock implements Clock {
        INSTANCE;

        @Override
        public long now() {
            return System.currentTimeMillis();
        }
    }

    /**
     * Deterministic virtual clock for fast, flake-free unit tests.
     */
    final class VirtualClock implements Clock {
        private final AtomicLong currentMs;

        public VirtualClock(long initialEpochMs) {
            this.currentMs = new AtomicLong(initialEpochMs);
        }

        @Override
        public long now() {
            return currentMs.get();
        }

        @Override
        public void sleep(long millis) {
            if (millis > 0) {
                currentMs.addAndGet(millis);
            }
        }

        public long advance(long deltaMs) {
            return currentMs.addAndGet(deltaMs);
        }

        public void set(long epochMs) {
            currentMs.set(epochMs);
        }
    }
}

