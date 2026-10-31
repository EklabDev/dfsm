package io.github.eklabdev.dfsm.annotation;

import io.github.eklabdev.dfsm.TransitionFunction;
import io.github.eklabdev.dfsm.TransitionOutput;
import io.github.eklabdev.dfsm.TransitionRequest;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.validation.SchemaValidator;

/**
 * Wraps a {@link TransitionFunction} together with its decorator-defined {@link PartialTransitionPolicy},
 * {@code inputClass}, and optional pre-step {@link SchemaValidator}.
 */
public final class DecoratedTransition<TContext, TInput, TOutput>
        implements TransitionFunction<TContext, TInput, TOutput> {
    private final String name;
    private final TransitionFunction<TContext, TInput, TOutput> delegate;
    private final PartialTransitionPolicy policy;
    private final Class<TInput> inputClass;
    private final SchemaValidator<TInput> inputValidator;

    public DecoratedTransition(
            String name,
            TransitionFunction<TContext, TInput, TOutput> delegate,
            PartialTransitionPolicy policy,
            Class<TInput> inputClass,
            SchemaValidator<TInput> inputValidator
    ) {
        this.name = name;
        this.delegate = delegate;
        this.policy = policy != null ? policy : PartialTransitionPolicy.EMPTY;
        this.inputClass = inputClass;
        this.inputValidator = inputValidator;
    }

    public String getName() {
        return name;
    }

    public TransitionFunction<TContext, TInput, TOutput> getDelegate() {
        return delegate;
    }

    public PartialTransitionPolicy getPolicy() {
        return policy;
    }

    public Class<TInput> getInputClass() {
        return inputClass;
    }

    public SchemaValidator<TInput> getInputValidator() {
        return inputValidator;
    }

    @Override
    public TransitionOutput<TContext, TOutput> apply(TransitionRequest<TContext, TInput> request) throws Exception {
        return delegate.apply(request);
    }
}

