package io.github.eklabdev.dfsm.runtime;

import io.github.eklabdev.dfsm.ActorLifecycleHooks;
import io.github.eklabdev.dfsm.Clock;
import io.github.eklabdev.dfsm.DfsmModels.RecoveryConfig;
import io.github.eklabdev.dfsm.DfsmModels.SchedulerConfig;
import io.github.eklabdev.dfsm.store.StateStore;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import io.github.eklabdev.dfsm.validation.SchemaValidator;

/**
 * Configuration options for instantiating a {@link DfsmActor}.
 */
public record ActorConfig<TContext>(
        String actorId,
        StateStore store,
        SchemaValidator<TContext> contextValidator,
        boolean disableDefaultJakartaValidation,
        BenchmarkLogEngine logEngine,
        Clock clock,
        RecoveryConfig recovery,
        SchedulerConfig scheduler,
        ActorLifecycleHooks<TContext> hooks,
        Integer maxEffectChainDepth,
        MachineHandlerBindings bindings
) {
    public static <C> ActorConfig<C> defaults() {
        return new Builder<C>().build();
    }

    public static <C> Builder<C> builder() {
        return new Builder<>();
    }

    public static final class Builder<C> {
        private String actorId;
        private StateStore store;
        private SchemaValidator<C> contextValidator;
        private boolean disableDefaultJakartaValidation = false;
        private BenchmarkLogEngine logEngine;
        private Clock clock;
        private RecoveryConfig recovery;
        private SchedulerConfig scheduler;
        private ActorLifecycleHooks<C> hooks;
        private Integer maxEffectChainDepth;
        private MachineHandlerBindings bindings;

        public Builder<C> actorId(String id) {
            this.actorId = id;
            return this;
        }

        public Builder<C> store(StateStore store) {
            this.store = store;
            return this;
        }

        public Builder<C> contextValidator(SchemaValidator<C> validator) {
            this.contextValidator = validator;
            return this;
        }

        public Builder<C> disableDefaultJakartaValidation(boolean disable) {
            this.disableDefaultJakartaValidation = disable;
            return this;
        }

        public Builder<C> logEngine(BenchmarkLogEngine logger) {
            this.logEngine = logger;
            return this;
        }

        public Builder<C> clock(Clock clock) {
            this.clock = clock;
            return this;
        }

        public Builder<C> recovery(RecoveryConfig recovery) {
            this.recovery = recovery;
            return this;
        }

        public Builder<C> scheduler(SchedulerConfig scheduler) {
            this.scheduler = scheduler;
            return this;
        }

        public Builder<C> hooks(ActorLifecycleHooks<C> hooks) {
            this.hooks = hooks;
            return this;
        }

        public Builder<C> maxEffectChainDepth(int maxDepth) {
            this.maxEffectChainDepth = maxDepth;
            return this;
        }

        public Builder<C> bindings(MachineHandlerBindings bindings) {
            this.bindings = bindings;
            return this;
        }

        public ActorConfig<C> build() {
            return new ActorConfig<>(
                    actorId,
                    store,
                    contextValidator,
                    disableDefaultJakartaValidation,
                    logEngine,
                    clock,
                    recovery,
                    scheduler,
                    hooks,
                    maxEffectChainDepth,
                    bindings
            );
        }
    }
}

