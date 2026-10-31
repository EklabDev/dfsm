package io.github.eklabdev.dfsm;

@FunctionalInterface
public interface CompensationFunction<TContext> {
    TContext compensate(CompensationRequest<TContext> request) throws Exception;
}

