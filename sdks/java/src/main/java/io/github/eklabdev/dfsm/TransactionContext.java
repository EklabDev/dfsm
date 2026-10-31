package io.github.eklabdev.dfsm;

import java.util.Map;

/**
 * Rich transaction execution context passed to every {@link TransitionFunction}.
 */
public record TransactionContext<TContext>(
        String transactionId,
        String machineId,
        String actorId,
        String event,
        int attempt,
        long startedAt,
        TContext data,
        Map<String, Object> metadata
) {}

