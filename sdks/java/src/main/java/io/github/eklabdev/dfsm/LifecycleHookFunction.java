package io.github.eklabdev.dfsm;

@FunctionalInterface
public interface LifecycleHookFunction<TEvent> {
    void onHook(TEvent event) throws Exception;
}

