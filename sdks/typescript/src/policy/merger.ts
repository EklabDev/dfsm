import type {
  NormalizedBackoffPolicy,
  NormalizedBenchmarkPolicy,
  NormalizedCircuitBreakerPolicy,
  NormalizedOnFailPolicy,
  NormalizedRetryPolicy,
  NormalizedTransitionPolicy,
  PartialTransitionPolicy,
} from "../types.js";

export const SDK_DEFAULT_POLICY: Omit<NormalizedTransitionPolicy, "circuitBreaker"> & {
  circuitBreaker: Omit<NormalizedCircuitBreakerPolicy, "key">;
} = {
  retry: {
    maxAttempts: 1,
    backoff: {
      strategy: "exponential",
      initialDelayMs: 100,
      maxDelayMs: 5000,
      multiplier: 2.0,
    },
  },
  circuitBreaker: {
    enabled: false,
    failureThreshold: 5,
    slidingWindowSize: 10,
    openDurationMs: 30000,
    halfOpenMaxCalls: 1,
  },
  onFail: {
    compensate: false,
    target: "error",
  },
  benchmark: {
    enabled: true,
  },
};

export interface PolicyMergeInputs {
  defaultBreakerKey: string;
  globalDefaults?: PartialTransitionPolicy;
  machineDefaults?: PartialTransitionPolicy;
  transitionPolicy?: PartialTransitionPolicy;
  decoratorPolicy?: PartialTransitionPolicy;
}

/**
 * Normalizes and deduplicates policies across all four layers using strict explicit-field
 * precedence:
 *   `decoratorPolicy` > `transitionPolicy` (YAML/Builder) > `machineDefaults` > `globalDefaults` > `SDK_DEFAULT_POLICY`
 *
 * Ensures overlapping features (e.g., `retry: 4` in Decorator vs `retry: 3` in YAML)
 * collapse into a single normalized setting (`maxAttempts: 4`) while preserving
 * non-overlapping features (e.g., `circuitBreaker` from YAML + `onFail` from Decorator).
 */
export function normalizeTransitionPolicy(inputs: PolicyMergeInputs): NormalizedTransitionPolicy {
  const layers: Array<PartialTransitionPolicy | undefined> = [
    inputs.globalDefaults,
    inputs.machineDefaults,
    inputs.transitionPolicy,
    inputs.decoratorPolicy,
  ];

  const backoff: NormalizedBackoffPolicy = { ...SDK_DEFAULT_POLICY.retry.backoff };
  const retry: NormalizedRetryPolicy = {
    maxAttempts: SDK_DEFAULT_POLICY.retry.maxAttempts,
    backoff,
  };
  const circuitBreaker: NormalizedCircuitBreakerPolicy = {
    ...SDK_DEFAULT_POLICY.circuitBreaker,
    key: inputs.defaultBreakerKey,
  };
  const onFail: NormalizedOnFailPolicy = { ...SDK_DEFAULT_POLICY.onFail };
  const benchmark: NormalizedBenchmarkPolicy = { ...SDK_DEFAULT_POLICY.benchmark };
  let compensateHandler: string | undefined;

  for (const layer of layers) {
    if (!layer) continue;

    if (layer.retry) {
      if (layer.retry.maxAttempts !== undefined) {
        retry.maxAttempts = layer.retry.maxAttempts;
      }
      if (layer.retry.retryIf !== undefined) {
        retry.retryIf = layer.retry.retryIf;
      }
      if (layer.retry.backoff) {
        if (layer.retry.backoff.strategy !== undefined) {
          backoff.strategy = layer.retry.backoff.strategy;
        }
        if (layer.retry.backoff.initialDelayMs !== undefined) {
          backoff.initialDelayMs = layer.retry.backoff.initialDelayMs;
        }
        if (layer.retry.backoff.maxDelayMs !== undefined) {
          backoff.maxDelayMs = layer.retry.backoff.maxDelayMs;
        }
        if (layer.retry.backoff.multiplier !== undefined) {
          backoff.multiplier = layer.retry.backoff.multiplier;
        }
      }
    }

    if (layer.circuitBreaker) {
      if (layer.circuitBreaker.enabled !== undefined) {
        circuitBreaker.enabled = layer.circuitBreaker.enabled;
      }
      if (layer.circuitBreaker.key !== undefined) {
        circuitBreaker.key = layer.circuitBreaker.key;
      }
      if (layer.circuitBreaker.failureThreshold !== undefined) {
        circuitBreaker.failureThreshold = layer.circuitBreaker.failureThreshold;
      }
      if (layer.circuitBreaker.slidingWindowSize !== undefined) {
        circuitBreaker.slidingWindowSize = layer.circuitBreaker.slidingWindowSize;
      }
      if (layer.circuitBreaker.openDurationMs !== undefined) {
        circuitBreaker.openDurationMs = layer.circuitBreaker.openDurationMs;
      }
      if (layer.circuitBreaker.halfOpenMaxCalls !== undefined) {
        circuitBreaker.halfOpenMaxCalls = layer.circuitBreaker.halfOpenMaxCalls;
      }
    }

    if (layer.onFail) {
      if (layer.onFail.compensate !== undefined) {
        onFail.compensate = layer.onFail.compensate;
      }
      if (layer.onFail.target !== undefined) {
        onFail.target = layer.onFail.target;
      }
    }

    if (layer.benchmark?.enabled !== undefined) {
      benchmark.enabled = layer.benchmark.enabled;
    }

    if (layer.compensateHandler !== undefined) {
      compensateHandler = layer.compensateHandler;
    }
  }

  return {
    retry,
    circuitBreaker,
    onFail,
    benchmark,
    ...(compensateHandler !== undefined ? { compensateHandler } : {}),
  };
}

