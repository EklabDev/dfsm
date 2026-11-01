from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class RetryPolicy:
    max_attempts: int = 1
    backoff_ms: int = 100
    backoff_factor: float = 2.0
    max_backoff_ms: int = 10000
    backoff: str = "EXPONENTIAL"
    jitter: bool = False


@dataclass
class CircuitBreakerPolicy:
    enabled: bool = True
    failure_threshold: int = 5
    recovery_timeout_ms: int = 30000
    half_open_success_threshold: int = 2


@dataclass
class OnFailPolicy:
    target: Optional[str] = None
    compensate: bool = False


@dataclass
class BenchmarkPolicy:
    enabled: bool = True
    warn_threshold_ms: int = 1000


@dataclass
class TransitionPolicy:
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    circuit_breaker: Optional[CircuitBreakerPolicy] = None
    on_fail: Optional[OnFailPolicy] = None
    compensate_with: Optional[str] = None
    benchmark: BenchmarkPolicy = field(default_factory=BenchmarkPolicy)


@dataclass
class PartialTransitionPolicy:
    retry_max_attempts: Optional[int] = None
    retry_backoff_ms: Optional[int] = None
    retry_backoff_factor: Optional[float] = None
    retry_max_backoff_ms: Optional[int] = None
    retry_backoff: Optional[str] = None
    retry_jitter: Optional[bool] = None
    retry_defined: bool = False

    cb_enabled: Optional[bool] = None
    cb_failure_threshold: Optional[int] = None
    cb_recovery_timeout_ms: Optional[int] = None
    cb_half_open_success: Optional[int] = None
    cb_defined: bool = False

    on_fail_target: Optional[str] = None
    on_fail_compensate: Optional[bool] = None
    on_fail_defined: bool = False

    compensate_with: Optional[str] = None
    benchmark_enabled: Optional[bool] = None
    benchmark_warn_ms: Optional[int] = None

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "PartialTransitionPolicy":
        policy = cls()
        if not data or not isinstance(data, dict):
            return policy

        # Nested "retry"
        if "retry" in data:
            policy.retry_defined = True
            r = data["retry"]
            if isinstance(r, (int, float)):
                policy.retry_max_attempts = int(r)
            elif isinstance(r, dict):
                if "maxAttempts" in r:
                    policy.retry_max_attempts = int(r["maxAttempts"])
                if "backoffMs" in r:
                    policy.retry_backoff_ms = int(r["backoffMs"])
                if "backoffFactor" in r:
                    policy.retry_backoff_factor = float(r["backoffFactor"])
                if "maxBackoffMs" in r:
                    policy.retry_max_backoff_ms = int(r["maxBackoffMs"])
                if "jitter" in r:
                    policy.retry_jitter = bool(r["jitter"])
                if "backoff" in r:
                    bo = r["backoff"]
                    if isinstance(bo, str):
                        policy.retry_backoff = bo.upper()
                    elif isinstance(bo, dict):
                        if "strategy" in bo:
                            policy.retry_backoff = str(bo["strategy"]).upper()
                        if "initialDelayMs" in bo:
                            policy.retry_backoff_ms = int(bo["initialDelayMs"])
                        if "maxDelayMs" in bo:
                            policy.retry_max_backoff_ms = int(bo["maxDelayMs"])
                        if "multiplier" in bo:
                            policy.retry_backoff_factor = float(bo["multiplier"])
        elif "retryMaxAttempts" in data:
            policy.retry_defined = True
            policy.retry_max_attempts = int(data["retryMaxAttempts"])

        # Nested "circuitBreaker"
        if "circuitBreaker" in data and isinstance(data["circuitBreaker"], dict):
            policy.cb_defined = True
            cb = data["circuitBreaker"]
            if "enabled" in cb:
                policy.cb_enabled = bool(cb["enabled"])
            if "failureThreshold" in cb:
                policy.cb_failure_threshold = int(cb["failureThreshold"])
            if "recoveryTimeoutMs" in cb:
                policy.cb_recovery_timeout_ms = int(cb["recoveryTimeoutMs"])
            elif "openDurationMs" in cb:
                policy.cb_recovery_timeout_ms = int(cb["openDurationMs"])
            if "halfOpenSuccessThreshold" in cb:
                policy.cb_half_open_success = int(cb["halfOpenSuccessThreshold"])
            elif "halfOpenMaxCalls" in cb:
                policy.cb_half_open_success = int(cb["halfOpenMaxCalls"])

        # Nested "onFail"
        if "onFail" in data and isinstance(data["onFail"], dict):
            policy.on_fail_defined = True
            of = data["onFail"]
            if "target" in of:
                policy.on_fail_target = str(of["target"])
            if "compensate" in of:
                policy.on_fail_compensate = bool(of["compensate"])

        # Direct compensate / compensateWith
        if "compensateWith" in data and data["compensateWith"]:
            policy.compensate_with = str(data["compensateWith"])
        elif "compensate" in data and isinstance(data["compensate"], str):
            policy.compensate_with = str(data["compensate"])

        # Flat fields
        if "cbEnabled" in data:
            policy.cb_enabled = bool(data["cbEnabled"])
            policy.cb_defined = True
        if "cbDefined" in data:
            policy.cb_defined = bool(data["cbDefined"])
        if "onFailDefined" in data:
            policy.on_fail_defined = bool(data["onFailDefined"])
        if "onFailTarget" in data:
            policy.on_fail_target = str(data["onFailTarget"])
            policy.on_fail_defined = True
        if "onFailCompensate" in data:
            policy.on_fail_compensate = bool(data["onFailCompensate"])
            policy.on_fail_defined = True

        return policy


class PolicyMerger:
    @staticmethod
    def merge(layers: List[Optional[PartialTransitionPolicy]]) -> TransitionPolicy:
        merged = TransitionPolicy()

        # 1. Retry: Pick the first layer that explicitly defines retry (non-multiplying!)
        for l in layers:
            if l and (l.retry_defined or l.retry_max_attempts is not None):
                if l.retry_max_attempts is not None:
                    merged.retry.max_attempts = l.retry_max_attempts
                if l.retry_backoff_ms is not None:
                    merged.retry.backoff_ms = l.retry_backoff_ms
                if l.retry_backoff_factor is not None:
                    merged.retry.backoff_factor = l.retry_backoff_factor
                if l.retry_max_backoff_ms is not None:
                    merged.retry.max_backoff_ms = l.retry_max_backoff_ms
                if l.retry_backoff is not None:
                    merged.retry.backoff = l.retry_backoff
                if l.retry_jitter is not None:
                    merged.retry.jitter = l.retry_jitter
                break

        # 2. Circuit Breaker
        for l in layers:
            if l and (l.cb_defined or l.cb_failure_threshold is not None or l.cb_enabled is not None or l.cb_recovery_timeout_ms is not None):
                cb = CircuitBreakerPolicy()
                if l.cb_enabled is not None:
                    cb.enabled = l.cb_enabled
                if l.cb_failure_threshold is not None:
                    cb.failure_threshold = l.cb_failure_threshold
                if l.cb_recovery_timeout_ms is not None:
                    cb.recovery_timeout_ms = l.cb_recovery_timeout_ms
                if l.cb_half_open_success is not None:
                    cb.half_open_success_threshold = l.cb_half_open_success
                merged.circuit_breaker = cb
                break

        # 3. OnFail
        for l in layers:
            if l and (l.on_fail_defined or l.on_fail_target is not None or l.on_fail_compensate is not None):
                of = OnFailPolicy()
                if l.on_fail_target is not None:
                    of.target = l.on_fail_target
                if l.on_fail_compensate is not None:
                    of.compensate = l.on_fail_compensate
                merged.on_fail = of
                break

        # 4. CompensateWith
        for l in layers:
            if l and l.compensate_with is not None:
                merged.compensate_with = l.compensate_with
                break

        return merged

