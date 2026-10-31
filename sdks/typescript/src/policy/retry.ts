import { ValidationError, CircuitOpenError } from "../errors.js";
import type { Clock, NormalizedBackoffPolicy, NormalizedRetryPolicy } from "../types.js";

export function computeBackoffDelayMs(
  retryIndex: number, // 1 for delay after 1st failure, 2 after 2nd failure...
  backoff: NormalizedBackoffPolicy,
  randomFn: () => number = Math.random
): number {
  const { strategy, initialDelayMs, maxDelayMs, multiplier } = backoff;
  if (initialDelayMs <= 0 || maxDelayMs <= 0) return 0;

  let raw: number;
  switch (strategy) {
    case "fixed":
      raw = initialDelayMs;
      break;
    case "linear":
      raw = initialDelayMs * retryIndex;
      break;
    case "exponential":
      raw = initialDelayMs * Math.pow(multiplier, Math.max(0, retryIndex - 1));
      break;
    case "exponential_jitter": {
      const ceiling = Math.min(
        maxDelayMs,
        initialDelayMs * Math.pow(multiplier, Math.max(0, retryIndex - 1))
      );
      // Full jitter in [ceiling * 0.5, ceiling] for bounded deterministic progress
      raw = ceiling * (0.5 + 0.5 * randomFn());
      break;
    }
  }

  return Math.min(maxDelayMs, Math.max(0, Math.round(raw)));
}

export function isRetryableByDefault(err: unknown): boolean {
  if (err instanceof ValidationError) return false;
  if (err instanceof CircuitOpenError) return false;
  return true;
}

export async function runWithRetryPolicy<T>(
  policy: NormalizedRetryPolicy,
  clock: Clock,
  operation: (attempt: number) => Promise<T>,
  randomFn?: () => number
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = Math.max(1, policy.maxAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation(attempt);
      return { result, attempts: attempt };
    } catch (err) {
      lastError = err;
      const canRetry =
        attempt < maxAttempts &&
        isRetryableByDefault(err) &&
        (policy.retryIf ? policy.retryIf(err) : true);

      if (!canRetry) {
        if (err && typeof err === "object") {
          (err as Record<string, unknown>).__dfsmAttempts = attempt;
        }
        throw err;
      }

      const delayMs = computeBackoffDelayMs(attempt, policy.backoff, randomFn);
      if (delayMs > 0) {
        await clock.sleep(delayMs);
      }
    }
  }

  throw lastError;
}

