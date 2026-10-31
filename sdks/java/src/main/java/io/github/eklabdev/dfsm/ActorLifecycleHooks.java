package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.runtime.DfsmActor;

/**
 * All 6 DFSM v1.0 Transaction Lifecycle Hooks (`onStart`, `beforeTransition`, `afterTransition`,
 * `onCompensate`, `onComplete`, `onTerminal`) and their strongly typed event payloads.
 */
public record ActorLifecycleHooks<TContext>(
        LifecycleHookFunction<OnStartEvent<TContext>> onStart,
        LifecycleHookFunction<BeforeTransitionEvent<TContext>> beforeTransition,
        LifecycleHookFunction<AfterTransitionEvent<TContext>> afterTransition,
        LifecycleHookFunction<OnCompensateEvent<TContext>> onCompensate,
        LifecycleHookFunction<OnCompleteEvent<TContext>> onComplete,
        LifecycleHookFunction<OnTerminalEvent<TContext>> onTerminal
) {
    public record OnStartEvent<TContext>(
            String transactionId,
            String machineId,
            String actorId,
            StateValue initialState,
            TransactionStatus status,
            TContext context,
            DfsmActor<TContext> actor
    ) {}

    public record BeforeTransitionEvent<TContext>(
            String transactionId,
            String machineId,
            String actorId,
            String event,
            Object input,
            StateValue currentState,
            TContext context,
            DfsmActor<TContext> actor
    ) {}

    public record AfterTransitionEvent<TContext>(
            String transactionId,
            String machineId,
            String actorId,
            String event,
            Object input,
            StateValue previousState,
            StateValue currentState,
            TransactionStatus status,
            Object value,
            TContext context,
            int compensatedSteps,
            long durationMs,
            String error,
            DfsmActor<TContext> actor
    ) {}

    public record OnCompensateEvent<TContext>(
            String transactionId,
            String machineId,
            String actorId,
            int stepSeq,
            String compensateHandler,
            StateValue fromState,
            Object inputSnapshot,
            TContext updatedContext,
            String reason,
            DfsmActor<TContext> actor
    ) {}

    public record OnCompleteEvent<TContext>(
            String transactionId,
            String machineId,
            String actorId,
            StateValue finalState,
            TContext context,
            DfsmActor<TContext> actor
    ) {}

    public record OnTerminalEvent<TContext>(
            String transactionId,
            String machineId,
            String actorId,
            StateValue finalState,
            TransactionStatus status,
            TContext context,
            String error,
            DfsmActor<TContext> actor
    ) {}

    public static <C> Builder<C> builder() {
        return new Builder<>();
    }

    public static final class Builder<C> {
        private LifecycleHookFunction<OnStartEvent<C>> onStart;
        private LifecycleHookFunction<BeforeTransitionEvent<C>> beforeTransition;
        private LifecycleHookFunction<AfterTransitionEvent<C>> afterTransition;
        private LifecycleHookFunction<OnCompensateEvent<C>> onCompensate;
        private LifecycleHookFunction<OnCompleteEvent<C>> onComplete;
        private LifecycleHookFunction<OnTerminalEvent<C>> onTerminal;

        public Builder<C> onStart(LifecycleHookFunction<OnStartEvent<C>> fn) {
            this.onStart = fn;
            return this;
        }

        public Builder<C> beforeTransition(LifecycleHookFunction<BeforeTransitionEvent<C>> fn) {
            this.beforeTransition = fn;
            return this;
        }

        public Builder<C> afterTransition(LifecycleHookFunction<AfterTransitionEvent<C>> fn) {
            this.afterTransition = fn;
            return this;
        }

        public Builder<C> onCompensate(LifecycleHookFunction<OnCompensateEvent<C>> fn) {
            this.onCompensate = fn;
            return this;
        }

        public Builder<C> onComplete(LifecycleHookFunction<OnCompleteEvent<C>> fn) {
            this.onComplete = fn;
            return this;
        }

        public Builder<C> onTerminal(LifecycleHookFunction<OnTerminalEvent<C>> fn) {
            this.onTerminal = fn;
            return this;
        }

        public ActorLifecycleHooks<C> build() {
            return new ActorLifecycleHooks<>(
                    onStart, beforeTransition, afterTransition, onCompensate, onComplete, onTerminal
            );
        }
    }
}

