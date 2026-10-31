import type {
  CompensateFunction,
  EffectFunction,
  LifecycleHookFunction,
  PartialBackoffPolicy,
  PartialCircuitBreakerPolicy,
  PartialOnFailPolicy,
  PartialRetryPolicy,
  PartialTransitionPolicy,
  TransitionFunction,
} from "../types.js";
import { toSchemaValidator, type SchemaValidator, type ValidatorInput } from "../validation.js";
import {
  recordDecoratedPrototypeMember,
  upsertFunctionMetadata,
  type AttachedHandlerMetadata,
} from "./metadata.js";

export interface DfsmTransitionDecoratorOptions<TInput = any> extends PartialTransitionPolicy {
  name?: string;
  inputValidator?: ValidatorInput<TInput>;
  /**
   * When true, automatically registers the standalone/static function into `FSMRegistry.getInstance()`
   * if a `name` is provided. Instance methods are registered via `registry.registerService(instance)`.
   */
  autoRegister?: boolean;
}

// Lazy hook populated by FSMRegistry so standalone autoRegister works without circular imports
let autoRegisterHook:
  | ((
      kind: "transition" | "compensate" | "effect" | "hook",
      name: string,
      fn: Function
    ) => void)
  | null = null;

/** @internal */
export function setDecoratorAutoRegisterHook(
  hook: (
    kind: "transition" | "compensate" | "effect" | "hook",
    name: string,
    fn: Function
  ) => void
): void {
  autoRegisterHook = hook;
}

/**
 * Universal method decorator helper supporting BOTH:
 * 1. TC39 Stage-3 Decorators `(value: Function, context: ClassMethodDecoratorContext)`
 * 2. Legacy TypeScript `experimentalDecorators` `(target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor)`
 */
function createMethodDecorator(
  applyMeta: (fn: Function, memberName: string) => AttachedHandlerMetadata
): any {
  return function universalDecorator(arg1: any, arg2: any, arg3?: PropertyDescriptor): any {
    // TC39 Stage-3 Decorator: (value, context)
    if (
      typeof arg1 === "function" &&
      typeof arg2 === "object" &&
      arg2 !== null &&
      "kind" in arg2 &&
      arg2.kind === "method"
    ) {
      const fn = arg1 as Function;
      const memberName = String(arg2.name);
      applyMeta(fn, memberName);
      if (typeof arg2.addInitializer === "function") {
        arg2.addInitializer(function (this: any) {
          if (this && typeof this === "object") {
            recordDecoratedPrototypeMember(this, arg2.name);
          }
        });
      }
      return fn;
    }

    // Legacy TypeScript Experimental Decorator: (target, propertyKey, descriptor)
    if (arg3 && typeof arg3.value === "function") {
      const fn = arg3.value as Function;
      const memberName = String(arg2);
      applyMeta(fn, memberName);
      if (arg1 && (typeof arg1 === "object" || typeof arg1 === "function")) {
        recordDecoratedPrototypeMember(arg1, arg2);
      }
      return arg3;
    }

    throw new TypeError("DFSM decorators must be applied to class methods or via decorateTransition().");
  };
}

export function DfsmTransition<TInput = any>(
  nameOrOptions?: string | DfsmTransitionDecoratorOptions<TInput>
): any {
  const opts: DfsmTransitionDecoratorOptions<TInput> =
    typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions ?? {};

  return createMethodDecorator((fn, memberName) => {
    const resolvedName = opts.name ?? memberName;
    const policy: PartialTransitionPolicy = {
      ...(opts.retry ? { retry: opts.retry } : {}),
      ...(opts.circuitBreaker ? { circuitBreaker: opts.circuitBreaker } : {}),
      ...(opts.onFail ? { onFail: opts.onFail } : {}),
      ...(opts.benchmark ? { benchmark: opts.benchmark } : {}),
      ...(opts.compensateHandler ? { compensateHandler: opts.compensateHandler } : {}),
    };
    const meta = upsertFunctionMetadata(fn, {
      name: resolvedName,
      kind: "transition",
      inputValidator: toSchemaValidator(opts.inputValidator),
      autoRegister: opts.autoRegister,
      policy,
    });
    if (opts.autoRegister && resolvedName && autoRegisterHook) {
      autoRegisterHook("transition", resolvedName, fn);
    }
    return meta;
  });
}

export function Retry(maxAttemptsOrPolicy: number | PartialRetryPolicy): any {
  const retryPolicy: PartialRetryPolicy =
    typeof maxAttemptsOrPolicy === "number"
      ? { maxAttempts: maxAttemptsOrPolicy }
      : maxAttemptsOrPolicy;
  return createMethodDecorator((fn) =>
    upsertFunctionMetadata(fn, { policy: { retry: retryPolicy } })
  );
}

export function Backoff(backoff: PartialBackoffPolicy): any {
  return createMethodDecorator((fn) =>
    upsertFunctionMetadata(fn, { policy: { retry: { backoff } } })
  );
}

export function CircuitBreaker(policy?: PartialCircuitBreakerPolicy): any {
  return createMethodDecorator((fn) =>
    upsertFunctionMetadata(fn, {
      policy: { circuitBreaker: { enabled: true, ...policy } },
    })
  );
}

export function OnFail(policy: PartialOnFailPolicy): any {
  return createMethodDecorator((fn) =>
    upsertFunctionMetadata(fn, { policy: { onFail: policy } })
  );
}

export function CompensateWith(compensateHandlerName: string): any {
  return createMethodDecorator((fn) =>
    upsertFunctionMetadata(fn, { policy: { compensateHandler: compensateHandlerName } })
  );
}

export function Benchmark(enabled = true): any {
  return createMethodDecorator((fn) =>
    upsertFunctionMetadata(fn, { policy: { benchmark: { enabled } } })
  );
}

export interface DfsmNamedHandlerDecoratorOptions {
  name?: string;
  autoRegister?: boolean;
}

export function DfsmCompensate(nameOrOptions?: string | DfsmNamedHandlerDecoratorOptions): any {
  const opts = typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions ?? {};
  return createMethodDecorator((fn, memberName) => {
    const resolvedName = opts.name ?? memberName;
    const meta = upsertFunctionMetadata(fn, {
      name: resolvedName,
      kind: "compensate",
      autoRegister: opts.autoRegister,
    });
    if (opts.autoRegister && resolvedName && autoRegisterHook) {
      autoRegisterHook("compensate", resolvedName, fn);
    }
    return meta;
  });
}

export function DfsmEffect(nameOrOptions?: string | DfsmNamedHandlerDecoratorOptions): any {
  const opts = typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions ?? {};
  return createMethodDecorator((fn, memberName) => {
    const resolvedName = opts.name ?? memberName;
    const meta = upsertFunctionMetadata(fn, {
      name: resolvedName,
      kind: "effect",
      autoRegister: opts.autoRegister,
    });
    if (opts.autoRegister && resolvedName && autoRegisterHook) {
      autoRegisterHook("effect", resolvedName, fn);
    }
    return meta;
  });
}

/**
 * Marks a service method as a DFSM Transaction Lifecycle Hook handler (`onStart`,
 * `beforeTransition`, `afterTransition`, `onCompensate`, `onComplete`, `onTerminal`)
 * so it can be referenced directly from `hooks:` in `.dfsm.yaml` or `MachineBuilder.hooks(...)`.
 */
export function DfsmHook(nameOrOptions?: string | DfsmNamedHandlerDecoratorOptions): any {
  const opts = typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions ?? {};
  return createMethodDecorator((fn, memberName) => {
    const resolvedName = opts.name ?? memberName;
    const meta = upsertFunctionMetadata(fn, {
      name: resolvedName,
      kind: "hook",
      autoRegister: opts.autoRegister,
    });
    if (opts.autoRegister && resolvedName && autoRegisterHook) {
      autoRegisterHook("hook", resolvedName, fn);
    }
    return meta;
  });
}

// ============================================================================
// Functional Composable Decorators (for standalone functions & lambdas)
// ============================================================================

export type TransitionModifier<TInput = any> = (fn: Function) => void;

export function withRetry(maxAttemptsOrPolicy: number | PartialRetryPolicy): TransitionModifier {
  const retry: PartialRetryPolicy =
    typeof maxAttemptsOrPolicy === "number"
      ? { maxAttempts: maxAttemptsOrPolicy }
      : maxAttemptsOrPolicy;
  return (fn) => {
    upsertFunctionMetadata(fn, { policy: { retry } });
  };
}

export function withBackoff(backoff: PartialBackoffPolicy): TransitionModifier {
  return (fn) => {
    upsertFunctionMetadata(fn, { policy: { retry: { backoff } } });
  };
}

export function withCircuitBreaker(policy?: PartialCircuitBreakerPolicy): TransitionModifier {
  return (fn) => {
    upsertFunctionMetadata(fn, {
      policy: { circuitBreaker: { enabled: true, ...policy } },
    });
  };
}

export function withOnFail(policy: PartialOnFailPolicy): TransitionModifier {
  return (fn) => {
    upsertFunctionMetadata(fn, { policy: { onFail: policy } });
  };
}

export function withCompensation(compensateHandlerName: string): TransitionModifier {
  return (fn) => {
    upsertFunctionMetadata(fn, { policy: { compensateHandler: compensateHandlerName } });
  };
}

export function withBenchmark(enabled = true): TransitionModifier {
  return (fn) => {
    upsertFunctionMetadata(fn, { policy: { benchmark: { enabled } } });
  };
}

export function withInputValidator<TInput>(
  validator: ValidatorInput<TInput>
): TransitionModifier<TInput> {
  const resolved: SchemaValidator<TInput> | undefined = toSchemaValidator(validator);
  return (fn) => {
    upsertFunctionMetadata(fn, { inputValidator: resolved });
  };
}

/**
 * Wraps a standalone user `TransitionFunction` with declarative policy modifiers
 * without creating nested duplicate runtime loops. Metadata is normalized and merged
 * with YAML/Builder policies inside `FSMRegistry`.
 */
export function decorateTransition<TContext = any, TInput = any, TOutput = any>(
  fn: TransitionFunction<TContext, TInput, TOutput>,
  ...modifiers: Array<TransitionModifier<TInput>>
): TransitionFunction<TContext, TInput, TOutput> {
  // Clone wrapper function reference so the same underlying fn can be decorated differently if desired
  const wrapped: TransitionFunction<TContext, TInput, TOutput> = (req) => fn(req);
  upsertFunctionMetadata(wrapped, { kind: "transition" });
  for (const mod of modifiers) {
    mod(wrapped);
  }
  return wrapped;
}

export function decorateCompensate<TContext = any, TInput = any>(
  name: string,
  fn: CompensateFunction<TContext, TInput>
): CompensateFunction<TContext, TInput> {
  const wrapped: CompensateFunction<TContext, TInput> = (req) => fn(req);
  upsertFunctionMetadata(wrapped, { name, kind: "compensate" });
  return wrapped;
}

export function decorateEffect<TContext = any>(
  name: string,
  fn: EffectFunction<TContext>
): EffectFunction<TContext> {
  const wrapped: EffectFunction<TContext> = (req) => fn(req);
  upsertFunctionMetadata(wrapped, { name, kind: "effect" });
  return wrapped;
}

export function decorateHook<TEvent = any>(
  name: string,
  fn: LifecycleHookFunction<TEvent>
): LifecycleHookFunction<TEvent> {
  const wrapped: LifecycleHookFunction<TEvent> = (event) => fn(event);
  upsertFunctionMetadata(wrapped, { name, kind: "hook" });
  return wrapped;
}

