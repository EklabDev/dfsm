package io.github.eklabdev.dfsm;

@FunctionalInterface
public interface EffectFunction<TContext> {
    void execute(EffectRequest<TContext> request) throws Exception;
}

