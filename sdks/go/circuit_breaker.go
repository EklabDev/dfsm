package dfsm

import (
	"fmt"
	"sync"
)

type CircuitBreakerState string

const (
	CircuitClosed   CircuitBreakerState = "CLOSED"
	CircuitOpen     CircuitBreakerState = "OPEN"
	CircuitHalfOpen CircuitBreakerState = "HALF_OPEN"
)

type CircuitBreakerInstance struct {
	mu                   sync.Mutex
	policy               *CircuitBreakerPolicy
	clock                Clock
	state                CircuitBreakerState
	consecutiveFailures  int
	consecutiveSuccesses int
	openedAtMs           int64
}

func NewCircuitBreakerInstance(policy *CircuitBreakerPolicy, clock Clock) *CircuitBreakerInstance {
	return &CircuitBreakerInstance{
		policy: policy,
		clock:  clock,
		state:  CircuitClosed,
	}
}

func (cb *CircuitBreakerInstance) State() CircuitBreakerState {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.state
}

func (cb *CircuitBreakerInstance) BeforeExecution(handlerName string) error {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	now := cb.clock.NowMs()
	if cb.state == CircuitOpen {
		if now-cb.openedAtMs >= int64(cb.policy.RecoveryTimeoutMs) {
			cb.state = CircuitHalfOpen
			cb.consecutiveSuccesses = 0
		} else {
			waitMs := int64(cb.policy.RecoveryTimeoutMs) - (now - cb.openedAtMs)
			return CircuitOpenError{
				HandlerName: handlerName,
				Message:     fmt.Sprintf("circuit breaker is OPEN for handler '%s'. Wait %dms before retry", handlerName, waitMs),
			}
		}
	}
	return nil
}

func (cb *CircuitBreakerInstance) OnSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state == CircuitHalfOpen {
		cb.consecutiveSuccesses++
		if cb.consecutiveSuccesses >= cb.policy.HalfOpenSuccessThreshold {
			cb.state = CircuitClosed
			cb.consecutiveFailures = 0
			cb.consecutiveSuccesses = 0
		}
	} else if cb.state == CircuitClosed {
		cb.consecutiveFailures = 0
	}
}

func (cb *CircuitBreakerInstance) OnFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	now := cb.clock.NowMs()
	if cb.state == CircuitHalfOpen {
		cb.state = CircuitOpen
		cb.openedAtMs = now
		cb.consecutiveFailures++
	} else if cb.state == CircuitClosed {
		cb.consecutiveFailures++
		if cb.consecutiveFailures >= cb.policy.FailureThreshold {
			cb.state = CircuitOpen
			cb.openedAtMs = now
		}
	}
}
