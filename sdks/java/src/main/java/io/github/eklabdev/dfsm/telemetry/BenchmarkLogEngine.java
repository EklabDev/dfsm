package io.github.eklabdev.dfsm.telemetry;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Pluggable benchmark &amp; audit telemetry log engine invoked by {@code BenchmarkDecorator}.
 */
@FunctionalInterface
public interface BenchmarkLogEngine {
    void recordTransition(TransitionBenchmarkRecord record);

    static BenchmarkLogEngine noop() {
        return record -> {};
    }

    static BenchmarkLogEngine slf4j() {
        Logger log = LoggerFactory.getLogger("io.github.eklabdev.dfsm.benchmark");
        return r -> log.info(
                "[DFSM-BENCHMARK] tx={} machine={} actor={} event={} handler={} {} -> {} attempts={} durationMs={} outcome={}{}",
                r.transactionId(),
                r.machineId(),
                r.actorId(),
                r.event(),
                r.transitionHandler() != null ? r.transitionHandler() : "(declarative)",
                r.fromState(),
                r.toState(),
                r.attempts(),
                r.durationMs(),
                r.outcome(),
                r.error() != null ? " error=" + r.error() : ""
        );
    }

    final class InMemory implements BenchmarkLogEngine {
        private final List<TransitionBenchmarkRecord> records = new CopyOnWriteArrayList<>();

        @Override
        public void recordTransition(TransitionBenchmarkRecord record) {
            records.add(record);
        }

        public List<TransitionBenchmarkRecord> getRecords() {
            return List.copyOf(records);
        }

        public void clear() {
            records.clear();
        }
    }
}

