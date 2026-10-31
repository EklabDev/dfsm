use crate::clock::Clock;
use crate::error::DfsmError;
use crate::policy::CircuitBreakerPolicy;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

struct Inner {
    state: CircuitState,
    consecutive_failures: usize,
    consecutive_successes: usize,
    opened_at_ms: i64,
}

pub struct CircuitBreakerInstance {
    policy: CircuitBreakerPolicy,
    clock: Arc<dyn Clock>,
    inner: Mutex<Inner>,
}

impl CircuitBreakerInstance {
    pub fn new(policy: CircuitBreakerPolicy, clock: Arc<dyn Clock>) -> Self {
        Self {
            policy,
            clock,
            inner: Mutex::new(Inner {
                state: CircuitState::Closed,
                consecutive_failures: 0,
                consecutive_successes: 0,
                opened_at_ms: 0,
            }),
        }
    }

    pub fn state(&self) -> CircuitState {
        self.inner.lock().unwrap().state
    }

    pub fn before_execution(&self, handler_name: &str) -> Result<(), DfsmError> {
        let mut inner = self.inner.lock().unwrap();
        let now = self.clock.now_ms();

        if inner.state == CircuitState::Open {
            if now - inner.opened_at_ms >= self.policy.recovery_timeout_ms as i64 {
                inner.state = CircuitState::HalfOpen;
                inner.consecutive_successes = 0;
            } else {
                let wait_ms = self.policy.recovery_timeout_ms as i64 - (now - inner.opened_at_ms);
                return Err(DfsmError::CircuitOpen {
                    handler: handler_name.to_string(),
                    wait_ms,
                });
            }
        }
        Ok(())
    }

    pub fn on_success(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.state == CircuitState::HalfOpen {
            inner.consecutive_successes += 1;
            if inner.consecutive_successes >= self.policy.half_open_success_threshold {
                inner.state = CircuitState::Closed;
                inner.consecutive_failures = 0;
                inner.consecutive_successes = 0;
            }
        } else if inner.state == CircuitState::Closed {
            inner.consecutive_failures = 0;
        }
    }

    pub fn on_failure(&self) {
        let mut inner = self.inner.lock().unwrap();
        let now = self.clock.now_ms();

        if inner.state == CircuitState::HalfOpen {
            inner.state = CircuitState::Open;
            inner.opened_at_ms = now;
            inner.consecutive_failures += 1;
        } else if inner.state == CircuitState::Closed {
            inner.consecutive_failures += 1;
            if inner.consecutive_failures >= self.policy.failure_threshold {
                inner.state = CircuitState::Open;
                inner.opened_at_ms = now;
            }
        }
    }
}

