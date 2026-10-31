use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_attempts: usize,
    pub backoff_ms: u64,
    pub backoff_factor: f64,
    pub max_backoff_ms: u64,
    pub backoff: String,
    pub jitter: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 1,
            backoff_ms: 100,
            backoff_factor: 2.0,
            max_backoff_ms: 10000,
            backoff: "EXPONENTIAL".to_string(),
            jitter: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitBreakerPolicy {
    pub enabled: bool,
    pub failure_threshold: usize,
    pub recovery_timeout_ms: u64,
    pub half_open_success_threshold: usize,
}

impl Default for CircuitBreakerPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            failure_threshold: 5,
            recovery_timeout_ms: 30000,
            half_open_success_threshold: 2,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnFailPolicy {
    pub target: Option<String>,
    pub compensate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkPolicy {
    pub enabled: bool,
    pub warn_threshold_ms: u64,
}

impl Default for BenchmarkPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            warn_threshold_ms: 1000,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionPolicy {
    pub retry: RetryPolicy,
    pub circuit_breaker: Option<CircuitBreakerPolicy>,
    pub on_fail: Option<OnFailPolicy>,
    pub compensate_with: Option<String>,
    pub benchmark: BenchmarkPolicy,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialTransitionPolicy {
    pub retry_max_attempts: Option<usize>,
    pub retry_backoff_ms: Option<u64>,
    pub retry_backoff_factor: Option<f64>,
    pub retry_max_backoff_ms: Option<u64>,
    pub retry_backoff: Option<String>,
    pub retry_jitter: Option<bool>,
    pub retry_defined: bool,

    pub cb_enabled: Option<bool>,
    pub cb_failure_threshold: Option<usize>,
    pub cb_recovery_timeout_ms: Option<u64>,
    pub cb_half_open_success: Option<usize>,
    pub cb_defined: bool,

    pub on_fail_target: Option<String>,
    pub on_fail_compensate: Option<bool>,
    pub on_fail_defined: bool,

    pub compensate_with: Option<String>,
    pub benchmark_enabled: Option<bool>,
    pub benchmark_warn_ms: Option<u64>,
}

impl PartialTransitionPolicy {
    pub fn from_value(val: &serde_json::Value) -> Self {
        let mut policy = Self::default();
        if let serde_json::Value::Object(map) = val {
            // Check nested "retry"
            if let Some(r) = map.get("retry") {
                policy.retry_defined = true;
                if let Some(ma) = r.get("maxAttempts").and_then(|v| v.as_u64()) {
                    policy.retry_max_attempts = Some(ma as usize);
                } else if let Some(ma) = r.as_u64() {
                    policy.retry_max_attempts = Some(ma as usize);
                }
                if let Some(bm) = r.get("backoffMs").and_then(|v| v.as_u64()) {
                    policy.retry_backoff_ms = Some(bm);
                }
                if let Some(bf) = r.get("backoffFactor").and_then(|v| v.as_f64()) {
                    policy.retry_backoff_factor = Some(bf);
                }
                if let Some(mm) = r.get("maxBackoffMs").and_then(|v| v.as_u64()) {
                    policy.retry_max_backoff_ms = Some(mm);
                }
                if let Some(bo) = r.get("backoff") {
                    if let Some(s) = bo.as_str() {
                        policy.retry_backoff = Some(s.to_uppercase());
                    } else if let Some(bo_obj) = bo.as_object() {
                        if let Some(s) = bo_obj.get("strategy").and_then(|v| v.as_str()) {
                            policy.retry_backoff = Some(s.to_uppercase());
                        }
                        if let Some(idm) = bo_obj.get("initialDelayMs").and_then(|v| v.as_u64()) {
                            policy.retry_backoff_ms = Some(idm);
                        }
                        if let Some(mdm) = bo_obj.get("maxDelayMs").and_then(|v| v.as_u64()) {
                            policy.retry_max_backoff_ms = Some(mdm);
                        }
                        if let Some(mul) = bo_obj.get("multiplier").and_then(|v| v.as_f64()) {
                            policy.retry_backoff_factor = Some(mul);
                        }
                    }
                }
                if let Some(j) = r.get("jitter").and_then(|v| v.as_bool()) {
                    policy.retry_jitter = Some(j);
                }
            } else if let Some(ma) = map.get("retryMaxAttempts").and_then(|v| v.as_u64()) {
                policy.retry_defined = true;
                policy.retry_max_attempts = Some(ma as usize);
            }

            // Check nested "circuitBreaker"
            if let Some(cb) = map.get("circuitBreaker") {
                policy.cb_defined = true;
                if let Some(en) = cb.get("enabled").and_then(|v| v.as_bool()) {
                    policy.cb_enabled = Some(en);
                }
                if let Some(ft) = cb.get("failureThreshold").and_then(|v| v.as_u64()) {
                    policy.cb_failure_threshold = Some(ft as usize);
                }
                if let Some(rt) = cb
                    .get("recoveryTimeoutMs")
                    .or_else(|| cb.get("openDurationMs"))
                    .and_then(|v| v.as_u64())
                {
                    policy.cb_recovery_timeout_ms = Some(rt);
                }
                if let Some(st) = cb
                    .get("halfOpenSuccessThreshold")
                    .or_else(|| cb.get("halfOpenMaxCalls"))
                    .and_then(|v| v.as_u64())
                {
                    policy.cb_half_open_success = Some(st as usize);
                }
            }

            // Check nested "onFail"
            if let Some(of) = map.get("onFail") {
                policy.on_fail_defined = true;
                if let Some(tgt) = of.get("target").and_then(|v| v.as_str()) {
                    policy.on_fail_target = Some(tgt.to_string());
                }
                if let Some(c) = of.get("compensate").and_then(|v| v.as_bool()) {
                    policy.on_fail_compensate = Some(c);
                }
            }

            // Check compensate / compensateWith
            if let Some(cw) = map
                .get("compensateWith")
                .or_else(|| map.get("compensate"))
                .and_then(|v| v.as_str())
            {
                policy.compensate_with = Some(cw.to_string());
            }

            // Direct flattened fields
            if let Some(ma) = map.get("retryMaxAttempts").and_then(|v| v.as_u64()) {
                policy.retry_max_attempts = Some(ma as usize);
                policy.retry_defined = true;
            }
            if let Some(bm) = map.get("retryBackoffMs").and_then(|v| v.as_u64()) {
                policy.retry_backoff_ms = Some(bm);
            }
            if let Some(bf) = map.get("retryBackoffFactor").and_then(|v| v.as_f64()) {
                policy.retry_backoff_factor = Some(bf);
            }
            if let Some(mm) = map.get("retryMaxBackoffMs").and_then(|v| v.as_u64()) {
                policy.retry_max_backoff_ms = Some(mm);
            }
            if let Some(bo) = map.get("retryBackoff").and_then(|v| v.as_str()) {
                policy.retry_backoff = Some(bo.to_string());
            }
            if let Some(j) = map.get("retryJitter").and_then(|v| v.as_bool()) {
                policy.retry_jitter = Some(j);
            }
            if let Some(rd) = map.get("retryDefined").and_then(|v| v.as_bool()) {
                policy.retry_defined = rd;
            }
            if let Some(cbe) = map.get("cbEnabled").and_then(|v| v.as_bool()) {
                policy.cb_enabled = Some(cbe);
            }
            if let Some(cbd) = map.get("cbDefined").and_then(|v| v.as_bool()) {
                policy.cb_defined = cbd;
            }
            if let Some(ofd) = map.get("onFailDefined").and_then(|v| v.as_bool()) {
                policy.on_fail_defined = ofd;
            }
        }
        policy
    }
}

impl<'de> Deserialize<'de> for PartialTransitionPolicy {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let val = serde_json::Value::deserialize(deserializer)?;
        Ok(Self::from_value(&val))
    }
}

pub struct PolicyMerger;

impl PolicyMerger {
    pub fn merge(layers: &[Option<&PartialTransitionPolicy>]) -> TransitionPolicy {
        let mut def = TransitionPolicy::default();

        // 1. Retry: Pick the first layer that explicitly defines retry (non-multiplying!)
        for l_opt in layers {
            if let Some(l) = l_opt {
                if l.retry_defined || l.retry_max_attempts.is_some() {
                    if let Some(ma) = l.retry_max_attempts {
                        def.retry.max_attempts = ma;
                    }
                    if let Some(b) = l.retry_backoff_ms {
                        def.retry.backoff_ms = b;
                    }
                    if let Some(bf) = l.retry_backoff_factor {
                        def.retry.backoff_factor = bf;
                    }
                    if let Some(mba) = l.retry_max_backoff_ms {
                        def.retry.max_backoff_ms = mba;
                    }
                    if let Some(ref bo) = l.retry_backoff {
                        def.retry.backoff = bo.clone();
                    }
                    if let Some(j) = l.retry_jitter {
                        def.retry.jitter = j;
                    }
                    break;
                }
            }
        }

        // 2. Circuit Breaker
        for l_opt in layers {
            if let Some(l) = l_opt {
                if l.cb_defined
                    || l.cb_failure_threshold.is_some()
                    || l.cb_enabled.is_some()
                    || l.cb_recovery_timeout_ms.is_some()
                {
                    let mut cb = CircuitBreakerPolicy::default();
                    if let Some(en) = l.cb_enabled {
                        cb.enabled = en;
                    }
                    if let Some(ft) = l.cb_failure_threshold {
                        cb.failure_threshold = ft;
                    }
                    if let Some(rt) = l.cb_recovery_timeout_ms {
                        cb.recovery_timeout_ms = rt;
                    }
                    if let Some(st) = l.cb_half_open_success {
                        cb.half_open_success_threshold = st;
                    }
                    def.circuit_breaker = Some(cb);
                    break;
                }
            }
        }

        // 3. OnFail
        for l_opt in layers {
            if let Some(l) = l_opt {
                if l.on_fail_defined
                    || l.on_fail_target.is_some()
                    || l.on_fail_compensate.is_some()
                {
                    let mut of = OnFailPolicy::default();
                    if let Some(ref tgt) = l.on_fail_target {
                        of.target = Some(tgt.clone());
                    }
                    if let Some(c) = l.on_fail_compensate {
                        of.compensate = c;
                    }
                    def.on_fail = Some(of);
                    break;
                }
            }
        }

        // 4. CompensateWith
        for l_opt in layers {
            if let Some(l) = l_opt {
                if let Some(ref cw) = l.compensate_with {
                    def.compensate_with = Some(cw.clone());
                    break;
                }
            }
        }

        def
    }
}
