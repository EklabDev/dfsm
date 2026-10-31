import type { BenchmarkLogEngine } from "../logger.js";
import type {
  Clock,
  NormalizedTransitionPolicy,
  StateValue,
  TransactionContext,
  TransitionFunction,
  TransitionOutput,
} from "../types.js";
import { enforceValidation, type SchemaValidator } from "../validation.js";
import { CircuitBreakerInstance } from "./circuit-breaker.js";
import { runWithRetryPolicy } from "./retry.js";

export interface PipelineExecutionContext<TContext = any, TInput = any> {
  transactionId: string;
  machineId: string;
  actorId: string;
  event: string;
  transitionHandlerName?: string;
  currentState: StateValue;
  input: TInput;
  contextData: TContext;
  startedAt: number;
  metadata: Record<string, unknown>;
}

export type PipelineExecutionOutcome<TContext = any, TOutput = any> =
  | {
      ok: true;
      output: TransitionOutput<TContext, TOutput>;
      nextContext: TContext;
      attempts: number;
    }
  | {
      ok: false;
      error: Error;
      compensateRequested: boolean;
      fallbackTarget: string;
      attempts: number;
    };

/**
 * GoF Decorator Component interface for transition execution.
 */
export interface TransitionComponent<TContext = any, TInput = any, TOutput = any> {
  execute(
    execCtx: PipelineExecutionContext<TContext, TInput>,
    attempt?: number
  ): Promise<PipelineExecutionOutcome<TContext, TOutput>>;
}

/**
 * Leaf GoF Component: executes the user's custom `TransitionFunction` (or declarative pass-through)
 * and enforces post-transition `TContext` validation.
 */
export class UserFunctionComponent<TContext = any, TInput = any, TOutput = any>
  implements TransitionComponent<TContext, TInput, TOutput>
{
  constructor(
    private readonly fn: TransitionFunction<TContext, TInput, TOutput> | undefined,
    private readonly contextValidator?: SchemaValidator<TContext>
  ) {}

  async execute(
    execCtx: PipelineExecutionContext<TContext, TInput>,
    attempt = 1
  ): Promise<PipelineExecutionOutcome<TContext, TOutput>> {
    if (!this.fn) {
      return {
        ok: true,
        output: {},
        nextContext: execCtx.contextData,
        attempts: attempt,
      };
    }

    // Clone contextData when structuredClone is possible so failed attempts never corrupt prior state
    let workingData: TContext;
    try {
      workingData = structuredClone(execCtx.contextData);
    } catch {
      workingData = execCtx.contextData;
    }

    const txContext: TransactionContext<TContext> = {
      transactionId: execCtx.transactionId,
      machineId: execCtx.machineId,
      actorId: execCtx.actorId,
      event: execCtx.event,
      attempt,
      startedAt: execCtx.startedAt,
      data: workingData,
      metadata: execCtx.metadata,
    };

    const rawResult = await this.fn({
      currentState: execCtx.currentState,
      input: execCtx.input,
      context: txContext,
    });

    const output: TransitionOutput<TContext, TOutput> =
      rawResult && typeof rawResult === "object" ? rawResult : {};

    const candidateContext =
      output.context !== undefined ? output.context : txContext.data;

    const validatedContext = enforceValidation("context", candidateContext, this.contextValidator);

    return {
      ok: true,
      output,
      nextContext: validatedContext,
      attempts: attempt,
    };
  }
}

/**
 * GoF Decorator 1 (Innermost wrapper): Single deduplicated Retry + Backoff loop.
 */
export class RetryBackoffDecorator<TContext = any, TInput = any, TOutput = any>
  implements TransitionComponent<TContext, TInput, TOutput>
{
  constructor(
    private readonly inner: TransitionComponent<TContext, TInput, TOutput>,
    private readonly policy: NormalizedTransitionPolicy,
    private readonly clock: Clock
  ) {}

  async execute(
    execCtx: PipelineExecutionContext<TContext, TInput>
  ): Promise<PipelineExecutionOutcome<TContext, TOutput>> {
    const { result, attempts } = await runWithRetryPolicy(
      this.policy.retry,
      this.clock,
      (attempt) => this.inner.execute(execCtx, attempt)
    );
    return {
      ...result,
      attempts,
    };
  }
}

/**
 * GoF Decorator 2: Circuit Breaker protection around retryable invocation.
 */
export class CircuitBreakerDecorator<TContext = any, TInput = any, TOutput = any>
  implements TransitionComponent<TContext, TInput, TOutput>
{
  constructor(
    private readonly inner: TransitionComponent<TContext, TInput, TOutput>,
    private readonly breaker: CircuitBreakerInstance
  ) {}

  async execute(
    execCtx: PipelineExecutionContext<TContext, TInput>
  ): Promise<PipelineExecutionOutcome<TContext, TOutput>> {
    return this.breaker.execute(() => this.inner.execute(execCtx));
  }
}

/**
 * GoF Decorator 3: Catches terminal runtime failure and resolves `onFail.compensate`
 * and `onFail.target` (defaulting to machine's `error` state).
 */
export class FallbackCompensateDecorator<TContext = any, TInput = any, TOutput = any>
  implements TransitionComponent<TContext, TInput, TOutput>
{
  constructor(
    private readonly inner: TransitionComponent<TContext, TInput, TOutput>,
    private readonly policy: NormalizedTransitionPolicy
  ) {}

  async execute(
    execCtx: PipelineExecutionContext<TContext, TInput>
  ): Promise<PipelineExecutionOutcome<TContext, TOutput>> {
    try {
      return await this.inner.execute(execCtx);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const attempts =
        typeof (err as Record<string, unknown>)?.__dfsmAttempts === "number"
          ? ((err as Record<string, unknown>).__dfsmAttempts as number)
          : 1;
      return {
        ok: false,
        error,
        compensateRequested: this.policy.onFail.compensate,
        fallbackTarget: this.policy.onFail.target || "error",
        attempts,
      };
    }
  }
}

/**
 * GoF Decorator 4 (Outermost wrapper): Measures execution latency and emits benchmark telemetry
 * via the pluggable `BenchmarkLogEngine` once the final target state is resolved by the Actor.
 */
export class BenchmarkDecorator<TContext = any, TInput = any, TOutput = any>
  implements TransitionComponent<TContext, TInput, TOutput>
{
  constructor(
    private readonly inner: TransitionComponent<TContext, TInput, TOutput>,
    private readonly policy: NormalizedTransitionPolicy,
    private readonly clock: Clock,
    private readonly logger: BenchmarkLogEngine
  ) {}

  async executeWithTelemetry(
    execCtx: PipelineExecutionContext<TContext, TInput>,
    resolveFinalStateAndCompensate: (
      outcome: PipelineExecutionOutcome<TContext, TOutput>
    ) => Promise<{
      finalState: StateValue;
      compensated: boolean;
    }>
  ): Promise<{
    outcome: PipelineExecutionOutcome<TContext, TOutput>;
    finalState: StateValue;
    compensated: boolean;
  }> {
    const t0 = this.clock.now();
    const outcome = await this.inner.execute(execCtx);
    const { finalState, compensated } = await resolveFinalStateAndCompensate(outcome);
    const durationMs = Math.max(0, this.clock.now() - t0);

    if (this.policy.benchmark.enabled) {
      const logOutcome = outcome.ok
        ? "SUCCESS"
        : compensated
          ? "COMPENSATED"
          : finalState !== "error"
            ? "FALLBACK"
            : "FAILED";

      await this.logger.recordTransition({
        timestamp: this.clock.now(),
        transactionId: execCtx.transactionId,
        machineId: execCtx.machineId,
        actorId: execCtx.actorId,
        event: execCtx.event,
        transitionHandler: execCtx.transitionHandlerName,
        fromState: execCtx.currentState,
        toState: finalState,
        attempts: outcome.attempts,
        durationMs,
        outcome: logOutcome,
        ...(outcome.ok ? {} : { error: outcome.error.message }),
      });
    }

    return { outcome, finalState, compensated };
  }

  async execute(
    execCtx: PipelineExecutionContext<TContext, TInput>
  ): Promise<PipelineExecutionOutcome<TContext, TOutput>> {
    return this.inner.execute(execCtx);
  }
}

/**
 * Materializes a single deduplicated GoF Decorator pipeline from a `NormalizedTransitionPolicy`.
 */
export function buildDecoratedPipeline<TContext = any, TInput = any, TOutput = any>(params: {
  fn: TransitionFunction<TContext, TInput, TOutput> | undefined;
  policy: NormalizedTransitionPolicy;
  breaker: CircuitBreakerInstance;
  clock: Clock;
  logger: BenchmarkLogEngine;
  inputValidator?: SchemaValidator<TInput>;
  contextValidator?: SchemaValidator<TContext>;
}): {
  pipeline: BenchmarkDecorator<TContext, TInput, TOutput>;
  validateInput: (rawInput: unknown) => TInput;
} {
  const leaf = new UserFunctionComponent<TContext, TInput, TOutput>(
    params.fn,
    params.contextValidator
  );
  const withRetry = new RetryBackoffDecorator(leaf, params.policy, params.clock);
  const withBreaker = new CircuitBreakerDecorator(withRetry, params.breaker);
  const withFallback = new FallbackCompensateDecorator(withBreaker, params.policy);
  const withBenchmark = new BenchmarkDecorator(
    withFallback,
    params.policy,
    params.clock,
    params.logger
  );

  return {
    pipeline: withBenchmark,
    validateInput: (rawInput: unknown) =>
      enforceValidation("input", rawInput, params.inputValidator),
  };
}

