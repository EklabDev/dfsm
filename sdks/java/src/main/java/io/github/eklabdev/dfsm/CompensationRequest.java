package io.github.eklabdev.dfsm;

public record CompensationRequest<TContext>(
        String transactionId,
        String machineId,
        String actorId,
        int stepSeq,
        StateValue fromState,
        Object inputSnapshot,
        TContext contextBefore,
        TContext currentContext,
        String failureError
) {}

