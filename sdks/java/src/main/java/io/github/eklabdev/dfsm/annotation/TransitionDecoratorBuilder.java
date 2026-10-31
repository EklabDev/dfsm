package io.github.eklabdev.dfsm.annotation;

import io.github.eklabdev.dfsm.TransitionFunction;
import io.github.eklabdev.dfsm.policy.BackoffStrategy;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.validation.JakartaSchemaValidator;
import io.github.eklabdev.dfsm.validation.SchemaValidator;

/**
 * Composable functional Decorator Builder for standalone lambdas and method references
 * (equivalent to TypeScript's {@code decorateTransition(fn, withRetry(...), withCircuitBreaker(...))}).
 */
public final class TransitionDecoratorBuilder<TContext, TInput, TOutput> {
    private final TransitionFunction<TContext, TInput, TOutput> fn;
    private String name;
    private PartialTransitionPolicy policy = PartialTransitionPolicy.EMPTY;
    private Class<TInput> inputClass;
    private SchemaValidator<TInput> inputValidator;

    private TransitionDecoratorBuilder(TransitionFunction<TContext, TInput, TOutput> fn) {
        this.fn = fn;
    }

    public static <C, I, O> TransitionDecoratorBuilder<C, I, O> of(TransitionFunction<C, I, O> fn) {
        return new TransitionDecoratorBuilder<>(fn);
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> named(String handlerName) {
        this.name = handlerName;
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> inputType(Class<TInput> clazz) {
        this.inputClass = clazz;
        if (this.inputValidator == null) {
            this.inputValidator = JakartaSchemaValidator.shared();
        }
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> inputValidator(
            Class<TInput> clazz,
            SchemaValidator<TInput> validator
    ) {
        this.inputClass = clazz;
        this.inputValidator = validator;
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> inputValidator(SchemaValidator<TInput> validator) {
        this.inputValidator = validator;
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> retry(int maxAttempts) {
        this.policy = this.policy.withRetry(new PartialTransitionPolicy.PartialRetry(maxAttempts, null));
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> backoff(
            BackoffStrategy strategy,
            long initialDelayMs,
            long maxDelayMs,
            double multiplier
    ) {
        this.policy = this.policy.withBackoff(
                new PartialTransitionPolicy.PartialBackoff(strategy, initialDelayMs, maxDelayMs, multiplier)
        );
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> circuitBreaker(
            int failureThreshold,
            int slidingWindowSize,
            long openDurationMs,
            int halfOpenMaxCalls
    ) {
        this.policy = this.policy.withCircuitBreaker(new PartialTransitionPolicy.PartialCircuitBreaker(
                true, failureThreshold, slidingWindowSize, openDurationMs, halfOpenMaxCalls
        ));
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> circuitBreakerEnabled(boolean enabled) {
        this.policy = this.policy.withCircuitBreaker(new PartialTransitionPolicy.PartialCircuitBreaker(
                enabled, null, null, null, null
        ));
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> onFail(boolean compensate, String target) {
        this.policy = this.policy.withOnFail(new PartialTransitionPolicy.PartialOnFail(
                compensate, target != null && !target.isBlank() ? target : null
        ));
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> compensateWith(String compensateHandlerName) {
        this.policy = this.policy.withCompensateHandler(compensateHandlerName);
        return this;
    }

    public TransitionDecoratorBuilder<TContext, TInput, TOutput> benchmark(boolean enabled) {
        this.policy = this.policy.withBenchmark(new PartialTransitionPolicy.PartialBenchmark(enabled));
        return this;
    }

    public DecoratedTransition<TContext, TInput, TOutput> build() {
        return new DecoratedTransition<>(name, fn, policy, inputClass, inputValidator);
    }
}

