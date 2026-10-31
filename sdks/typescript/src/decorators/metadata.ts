import type { PartialTransitionPolicy } from "../types.js";
import type { SchemaValidator } from "../validation.js";

export interface AttachedHandlerMetadata {
  name?: string;
  kind?: "transition" | "compensate" | "effect" | "hook";
  policy: PartialTransitionPolicy;
  inputValidator?: SchemaValidator<any>;
  autoRegister?: boolean;
}

const FUNCTION_META = new WeakMap<Function, AttachedHandlerMetadata>();
const CLASS_MEMBER_KEYS = new WeakMap<object, Set<string | symbol>>();

function mergePartialInto(
  target: PartialTransitionPolicy,
  patch: PartialTransitionPolicy
): PartialTransitionPolicy {
  const mergedRetry =
    target.retry || patch.retry
      ? {
          ...target.retry,
          ...patch.retry,
          ...(target.retry?.backoff || patch.retry?.backoff
            ? {
                backoff: {
                  ...target.retry?.backoff,
                  ...patch.retry?.backoff,
                },
              }
            : {}),
        }
      : undefined;

  return {
    ...target,
    ...patch,
    ...(mergedRetry ? { retry: mergedRetry } : {}),
    ...(target.circuitBreaker || patch.circuitBreaker
      ? { circuitBreaker: { ...target.circuitBreaker, ...patch.circuitBreaker } }
      : {}),
    ...(target.onFail || patch.onFail
      ? { onFail: { ...target.onFail, ...patch.onFail } }
      : {}),
    ...(target.benchmark || patch.benchmark
      ? { benchmark: { ...target.benchmark, ...patch.benchmark } }
      : {}),
  };
}

export function upsertFunctionMetadata(
  fn: Function,
  update: Partial<Omit<AttachedHandlerMetadata, "policy">> & { policy?: PartialTransitionPolicy }
): AttachedHandlerMetadata {
  const existing = FUNCTION_META.get(fn) ?? { policy: {} };
  const next: AttachedHandlerMetadata = {
    ...existing,
    ...(update.name !== undefined ? { name: update.name } : {}),
    ...(update.kind !== undefined ? { kind: update.kind } : {}),
    ...(update.inputValidator !== undefined ? { inputValidator: update.inputValidator } : {}),
    ...(update.autoRegister !== undefined ? { autoRegister: update.autoRegister } : {}),
    policy: update.policy ? mergePartialInto(existing.policy, update.policy) : existing.policy,
  };
  FUNCTION_META.set(fn, next);
  return next;
}

export function getFunctionMetadata(fn: Function): AttachedHandlerMetadata | undefined {
  return FUNCTION_META.get(fn);
}

export function recordDecoratedPrototypeMember(protoOrCtor: object, key: string | symbol): void {
  let set = CLASS_MEMBER_KEYS.get(protoOrCtor);
  if (!set) {
    set = new Set();
    CLASS_MEMBER_KEYS.set(protoOrCtor, set);
  }
  set.add(key);
}

export function getDecoratedPrototypeMembers(instance: object): Array<string | symbol> {
  const collected = new Set<string | symbol>();
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    const keys = CLASS_MEMBER_KEYS.get(proto);
    if (keys) {
      for (const k of keys) collected.add(k);
    }
    proto = Object.getPrototypeOf(proto);
  }
  const ownKeys = CLASS_MEMBER_KEYS.get(instance);
  if (ownKeys) {
    for (const k of ownKeys) collected.add(k);
  }
  return [...collected];
}

