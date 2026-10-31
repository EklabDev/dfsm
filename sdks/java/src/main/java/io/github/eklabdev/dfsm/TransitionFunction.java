package io.github.eklabdev.dfsm;

@FunctionalInterface
public interface TransitionFunction<TContext, TInput, TOutput> {
    TransitionOutput<TContext, TOutput> apply(TransitionRequest<TContext, TInput> request) throws Exception;
}

