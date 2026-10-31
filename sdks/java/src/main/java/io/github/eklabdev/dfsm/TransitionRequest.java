package io.github.eklabdev.dfsm;

public record TransitionRequest<TContext, TInput>(
        StateValue currentState,
        TInput input,
        TransactionContext<TContext> context
) {
    public TContext data() {
        return context != null ? context.data() : null;
    }
}

