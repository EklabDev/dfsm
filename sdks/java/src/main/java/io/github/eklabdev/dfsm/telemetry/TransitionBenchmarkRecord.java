package io.github.eklabdev.dfsm.telemetry;

import io.github.eklabdev.dfsm.StateValue;

public record TransitionBenchmarkRecord(
        long timestamp,
        String transactionId,
        String machineId,
        String actorId,
        String event,
        String transitionHandler,
        StateValue fromState,
        StateValue toState,
        int attempts,
        long durationMs,
        BenchmarkOutcome outcome,
        String error
) {}

