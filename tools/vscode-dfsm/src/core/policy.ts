import type {
  NormalizedTransitionPolicy,
  PartialTransitionPolicy,
  PolicyFieldSources
} from './types';

/**
 * Canonical SDK built-in defaults from SPECIFICATION.md Section 3.
 */
export const SDK_DEFAULT_POLICY: NormalizedTransitionPolicy = {
  retry: {
    maxAttempts: 1,
    backoff: {
      strategy: 'exponential',
      initialDelayMs: 100,
      maxDelayMs: 5000,
      multiplier: 2.0
    }
  },
  circuitBreaker: {
    enabled: false,
    failureThreshold: 5,
    slidingWindowSize: 10,
    openDurationMs: 30000,
    halfOpenMaxCalls: 1
  },
  onFail: {
    compensate: false,
    target: 'error'
  },
  benchmark: {
    enabled: true
  }
};

export interface MergedPolicyResult {
  policy: NormalizedTransitionPolicy;
  sources: PolicyFieldSources;
}

/**
 * Performs explicit-field leaf-by-leaf deep merge across:
 *   SDK Built-in Defaults <- Machine `defaults` <- Transition YAML
 * per SPECIFICATION.md Section 3.
 */
export function mergeTransitionPolicies(
  machineDefaults?: PartialTransitionPolicy,
  transitionPolicy?: PartialTransitionPolicy
): MergedPolicyResult {
  const policy: NormalizedTransitionPolicy = {
    retry: {
      maxAttempts: SDK_DEFAULT_POLICY.retry.maxAttempts,
      backoff: { ...SDK_DEFAULT_POLICY.retry.backoff }
    },
    circuitBreaker: { ...SDK_DEFAULT_POLICY.circuitBreaker },
    onFail: { ...SDK_DEFAULT_POLICY.onFail },
    benchmark: { ...SDK_DEFAULT_POLICY.benchmark }
  };

  const sources: PolicyFieldSources = {
    'retry.maxAttempts': 'sdk',
    'retry.backoff.strategy': 'sdk',
    'retry.backoff.initialDelayMs': 'sdk',
    'retry.backoff.maxDelayMs': 'sdk',
    'retry.backoff.multiplier': 'sdk',
    'circuitBreaker.enabled': 'sdk',
    'circuitBreaker.failureThreshold': 'sdk',
    'circuitBreaker.slidingWindowSize': 'sdk',
    'circuitBreaker.openDurationMs': 'sdk',
    'circuitBreaker.halfOpenMaxCalls': 'sdk',
    'onFail.compensate': 'sdk',
    'onFail.target': 'sdk',
    'benchmark.enabled': 'sdk'
  };

  const applyLayer = (
    layer: PartialTransitionPolicy | undefined,
    layerName: 'defaults' | 'transition'
  ) => {
    if (!layer) return;

    if (layer.retry) {
      if (layer.retry.maxAttempts !== undefined) {
        policy.retry.maxAttempts = layer.retry.maxAttempts;
        sources['retry.maxAttempts'] = layerName;
      }
      if (layer.retry.backoff) {
        const b = layer.retry.backoff;
        if (b.strategy !== undefined) {
          policy.retry.backoff.strategy = b.strategy;
          sources['retry.backoff.strategy'] = layerName;
        }
        if (b.initialDelayMs !== undefined) {
          policy.retry.backoff.initialDelayMs = b.initialDelayMs;
          sources['retry.backoff.initialDelayMs'] = layerName;
        }
        if (b.maxDelayMs !== undefined) {
          policy.retry.backoff.maxDelayMs = b.maxDelayMs;
          sources['retry.backoff.maxDelayMs'] = layerName;
        }
        if (b.multiplier !== undefined) {
          policy.retry.backoff.multiplier = b.multiplier;
          sources['retry.backoff.multiplier'] = layerName;
        }
      }
    }

    if (layer.circuitBreaker) {
      const cb = layer.circuitBreaker;
      if (cb.enabled !== undefined) {
        policy.circuitBreaker.enabled = cb.enabled;
        sources['circuitBreaker.enabled'] = layerName;
      }
      if (cb.key !== undefined) {
        policy.circuitBreaker.key = cb.key;
        sources['circuitBreaker.key'] = layerName;
      }
      if (cb.failureThreshold !== undefined) {
        policy.circuitBreaker.failureThreshold = cb.failureThreshold;
        sources['circuitBreaker.failureThreshold'] = layerName;
      }
      if (cb.slidingWindowSize !== undefined) {
        policy.circuitBreaker.slidingWindowSize = cb.slidingWindowSize;
        sources['circuitBreaker.slidingWindowSize'] = layerName;
      }
      if (cb.openDurationMs !== undefined) {
        policy.circuitBreaker.openDurationMs = cb.openDurationMs;
        sources['circuitBreaker.openDurationMs'] = layerName;
      }
      if (cb.halfOpenMaxCalls !== undefined) {
        policy.circuitBreaker.halfOpenMaxCalls = cb.halfOpenMaxCalls;
        sources['circuitBreaker.halfOpenMaxCalls'] = layerName;
      }
    }

    if (layer.onFail) {
      if (layer.onFail.compensate !== undefined) {
        policy.onFail.compensate = layer.onFail.compensate;
        sources['onFail.compensate'] = layerName;
      }
      if (layer.onFail.target !== undefined) {
        policy.onFail.target = layer.onFail.target;
        sources['onFail.target'] = layerName;
      }
    }

    if (layer.benchmark) {
      if (layer.benchmark.enabled !== undefined) {
        policy.benchmark.enabled = layer.benchmark.enabled;
        sources['benchmark.enabled'] = layerName;
      }
    }
  };

  applyLayer(machineDefaults, 'defaults');
  applyLayer(transitionPolicy, 'transition');

  return { policy, sources };
}
