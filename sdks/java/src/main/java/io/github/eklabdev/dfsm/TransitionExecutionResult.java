package io.github.eklabdev.dfsm;

public record TransitionExecutionResult<TContext, TOutput>(
        String transactionId,
        StateValue previousState,
        StateValue currentState,
        TransactionStatus status,
        TOutput value,
        TContext context,
        int compensatedSteps,
        String error
) {}

