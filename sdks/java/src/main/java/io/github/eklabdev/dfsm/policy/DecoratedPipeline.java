package io.github.eklabdev.dfsm.policy;

import io.github.eklabdev.dfsm.Clock;
import io.github.eklabdev.dfsm.JsonCodec;
import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionContext;
import io.github.eklabdev.dfsm.TransitionFunction;
import io.github.eklabdev.dfsm.TransitionOutput;
import io.github.eklabdev.dfsm.TransitionRequest;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import io.github.eklabdev.dfsm.telemetry.BenchmarkOutcome;
import io.github.eklabdev.dfsm.telemetry.TransitionBenchmarkRecord;
import io.github.eklabdev.dfsm.validation.SchemaValidator;

import java.util.Map;
import java.util.function.Function;

/**
 * Materializes a single deduplicated GoF Decorator chain from a {@link NormalizedTransitionPolicy}:
 * {@code InputValidator -> BenchmarkDecorator -> FallbackCompensateDecorator -> CircuitBreakerDecorator -> RetryBackoffDecorator -> UserFunctionComponent + ContextValidator}.
 */
public final class DecoratedPipeline<TContext, TInput, TOutput> {

    public record ExecutionContext<TContext, TInput>(
            String transactionId,
            String machineId,
            String actorId,
            String event,
            String transitionHandlerName,
            StateValue currentState,
            TInput input,
            TContext contextData,
            long startedAt,
            Map<String, Object> metadata
    ) {}

    public record ExecutionOutcome<TContext, TOutput>(
            boolean ok,
            TransitionOutput<TContext, TOutput> output,
            TContext nextContext,
            Throwable error,
            boolean compensateRequested,
            String fallbackTarget,
            int attempts
    ) {
        public static <C, O> ExecutionOutcome<C, O> success(
                TransitionOutput<C, O> output,
                C nextContext,
                int attempts
        ) {
            return new ExecutionOutcome<>(true, output, nextContext, null, false, null, attempts);
        }

        public static <C, O> ExecutionOutcome<C, O> failure(
                Throwable error,
                boolean compensateRequested,
                String fallbackTarget,
                int attempts
        ) {
            return new ExecutionOutcome<>(false, null, null, error, compensateRequested, fallbackTarget, attempts);
        }
    }

    public record FinalResolution(StateValue finalState, boolean compensated) {}

    public record TelemetryResult<TContext, TOutput>(
            ExecutionOutcome<TContext, TOutput> outcome,
            StateValue finalState,
            boolean compensated
    ) {}

    @FunctionalInterface
    public interface TransitionComponent<TContext, TInput, TOutput> {
        ExecutionOutcome<TContext, TOutput> execute(ExecutionContext<TContext, TInput> ctx, int attempt);
    }

    /**
     * Leaf GoF Component: executes user {@link TransitionFunction} and post-step {@code ContextValidator}.
     */
    public static final class UserFunctionComponent<TContext, TInput, TOutput>
            implements TransitionComponent<TContext, TInput, TOutput> {
        private final TransitionFunction<TContext, TInput, TOutput> fn;
        private final Class<TContext> contextClass;
        private final SchemaValidator<TContext> contextValidator;

        public UserFunctionComponent(
                TransitionFunction<TContext, TInput, TOutput> fn,
                Class<TContext> contextClass,
                SchemaValidator<TContext> contextValidator
        ) {
            this.fn = fn;
            this.contextClass = contextClass;
            this.contextValidator = contextValidator;
        }

        @Override
        public ExecutionOutcome<TContext, TOutput> execute(ExecutionContext<TContext, TInput> ctx, int attempt) {
            if (fn == null) {
                return ExecutionOutcome.success(TransitionOutput.empty(), ctx.contextData(), attempt);
            }

            TContext clonedData = JsonCodec.deepClone(ctx.contextData(), contextClass);
            TransactionContext<TContext> txCtx = new TransactionContext<>(
                    ctx.transactionId(),
                    ctx.machineId(),
                    ctx.actorId(),
                    ctx.event(),
                    attempt,
                    ctx.startedAt(),
                    clonedData,
                    ctx.metadata()
            );

            try {
                TransitionOutput<TContext, TOutput> rawOut = fn.apply(
                        new TransitionRequest<>(ctx.currentState(), ctx.input(), txCtx)
                );
                TransitionOutput<TContext, TOutput> out = rawOut != null ? rawOut : TransitionOutput.empty();
                TContext candidate = out.context() != null ? out.context() : txCtx.data();
                TContext validated = SchemaValidator.enforce("context", candidate, contextValidator);
                return ExecutionOutcome.success(out, validated, attempt);
            } catch (RuntimeException re) {
                throw re;
            } catch (Exception checked) {
                throw new RuntimeException(checked.getMessage(), checked);
            }
        }
    }

    /**
     * GoF Decorator 1 (Innermost): Single deduplicated Retry + Backoff loop.
     */
    public static final class RetryBackoffDecorator<TContext, TInput, TOutput>
            implements TransitionComponent<TContext, TInput, TOutput> {
        private final TransitionComponent<TContext, TInput, TOutput> inner;
        private final NormalizedTransitionPolicy policy;
        private final Clock clock;

        public RetryBackoffDecorator(
                TransitionComponent<TContext, TInput, TOutput> inner,
                NormalizedTransitionPolicy policy,
                Clock clock
        ) {
            this.inner = inner;
            this.policy = policy;
            this.clock = clock;
        }

        @Override
        public ExecutionOutcome<TContext, TOutput> execute(ExecutionContext<TContext, TInput> ctx, int attempt) {
            RetryExecutor.RetryResult<ExecutionOutcome<TContext, TOutput>> rr = RetryExecutor.execute(
                    policy.retry(),
                    clock,
                    att -> inner.execute(ctx, att)
            );
            ExecutionOutcome<TContext, TOutput> res = rr.result();
            return ExecutionOutcome.success(res.output(), res.nextContext(), rr.attempts());
        }
    }

    /**
     * GoF Decorator 2: Circuit Breaker protection around retryable invocation.
     */
    public static final class CircuitBreakerDecorator<TContext, TInput, TOutput>
            implements TransitionComponent<TContext, TInput, TOutput> {
        private final TransitionComponent<TContext, TInput, TOutput> inner;
        private final CircuitBreakerInstance breaker;

        public CircuitBreakerDecorator(
                TransitionComponent<TContext, TInput, TOutput> inner,
                CircuitBreakerInstance breaker
        ) {
            this.inner = inner;
            this.breaker = breaker;
        }

        @Override
        public ExecutionOutcome<TContext, TOutput> execute(ExecutionContext<TContext, TInput> ctx, int attempt) {
            return breaker.execute(() -> inner.execute(ctx, attempt));
        }
    }

    /**
     * GoF Decorator 3: Catches terminal runtime failure and resolves {@code onFail.compensate} &amp; {@code onFail.target}.
     */
    public static final class FallbackCompensateDecorator<TContext, TInput, TOutput>
            implements TransitionComponent<TContext, TInput, TOutput> {
        private final TransitionComponent<TContext, TInput, TOutput> inner;
        private final NormalizedTransitionPolicy policy;

        public FallbackCompensateDecorator(
                TransitionComponent<TContext, TInput, TOutput> inner,
                NormalizedTransitionPolicy policy
        ) {
            this.inner = inner;
            this.policy = policy;
        }

        @Override
        public ExecutionOutcome<TContext, TOutput> execute(ExecutionContext<TContext, TInput> ctx, int attempt) {
            try {
                return inner.execute(ctx, attempt);
            } catch (RetryExecutor.ExhaustedRetryException ex) {
                Throwable root = ex.getCause() != null ? ex.getCause() : ex;
                String target = policy.onFail().target() != null && !policy.onFail().target().isBlank()
                        ? policy.onFail().target()
                        : "error";
                return ExecutionOutcome.failure(root, policy.onFail().compensate(), target, ex.getAttempts());
            } catch (Throwable err) {
                String target = policy.onFail().target() != null && !policy.onFail().target().isBlank()
                        ? policy.onFail().target()
                        : "error";
                return ExecutionOutcome.failure(err, policy.onFail().compensate(), target, 1);
            }
        }
    }

    private final TransitionComponent<TContext, TInput, TOutput> chain;
    private final NormalizedTransitionPolicy policy;
    private final Clock clock;
    private final BenchmarkLogEngine logger;
    private final Class<TInput> inputClass;
    private final SchemaValidator<TInput> inputValidator;

    public DecoratedPipeline(
            TransitionFunction<TContext, TInput, TOutput> fn,
            NormalizedTransitionPolicy policy,
            CircuitBreakerInstance breaker,
            Clock clock,
            BenchmarkLogEngine logger,
            Class<TContext> contextClass,
            SchemaValidator<TContext> contextValidator,
            Class<TInput> inputClass,
            SchemaValidator<TInput> inputValidator
    ) {
        this.policy = policy;
        this.clock = clock;
        this.logger = logger;
        this.inputClass = inputClass;
        this.inputValidator = inputValidator;

        TransitionComponent<TContext, TInput, TOutput> leaf =
                new UserFunctionComponent<>(fn, contextClass, contextValidator);
        TransitionComponent<TContext, TInput, TOutput> retry =
                new RetryBackoffDecorator<>(leaf, policy, clock);
        TransitionComponent<TContext, TInput, TOutput> cb =
                new CircuitBreakerDecorator<>(retry, breaker);
        this.chain = new FallbackCompensateDecorator<>(cb, policy);
    }

    @SuppressWarnings("unchecked")
    public TInput validateInput(Object rawInput) {
        TInput coerced = inputClass != null && inputClass != Object.class && inputClass != Void.class
                ? JsonCodec.convertValue(rawInput, inputClass)
                : (TInput) rawInput;
        return SchemaValidator.enforce("input", coerced, inputValidator);
    }

    public ExecutionOutcome<TContext, TOutput> execute(ExecutionContext<TContext, TInput> ctx) {
        return chain.execute(ctx, 1);
    }

    /**
     * GoF Decorator 4 (Outermost): BenchmarkDecorator wrapping execution + target/compensation resolution.
     */
    public TelemetryResult<TContext, TOutput> executeWithTelemetry(
            ExecutionContext<TContext, TInput> ctx,
            Function<ExecutionOutcome<TContext, TOutput>, FinalResolution> resolver
    ) {
        long t0 = clock.now();
        ExecutionOutcome<TContext, TOutput> outcome = chain.execute(ctx, 1);
        FinalResolution res = resolver.apply(outcome);
        long durationMs = Math.max(0L, clock.now() - t0);

        if (policy.benchmark().enabled() && logger != null) {
            BenchmarkOutcome bmOutcome = outcome.ok()
                    ? BenchmarkOutcome.SUCCESS
                    : res.compensated()
                        ? BenchmarkOutcome.COMPENSATED
                        : !StateValue.of("error").equals(res.finalState())
                            ? BenchmarkOutcome.FALLBACK
                            : BenchmarkOutcome.FAILED;

            logger.recordTransition(new TransitionBenchmarkRecord(
                    clock.now(),
                    ctx.transactionId(),
                    ctx.machineId(),
                    ctx.actorId(),
                    ctx.event(),
                    ctx.transitionHandlerName(),
                    ctx.currentState(),
                    res.finalState(),
                    outcome.attempts(),
                    durationMs,
                    bmOutcome,
                    outcome.ok() ? null : (outcome.error() != null ? outcome.error().getMessage() : "unknown")
            ));
        }

        return new TelemetryResult<>(outcome, res.finalState(), res.compensated());
    }
}

