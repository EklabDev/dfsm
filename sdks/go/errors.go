package dfsm

import (
	"fmt"
	"strings"
)

type DfsmError interface {
	error
	isDfsmError()
}

type baseDfsmError struct{}

func (b baseDfsmError) isDfsmError() {}

// ValidationError represents validation failure on TInput or TContext.
type ValidationError struct {
	baseDfsmError
	Message string
	Errors  []string
}

func (e ValidationError) Error() string {
	if len(e.Errors) > 0 {
		return fmt.Sprintf("%s: %s", e.Message, strings.Join(e.Errors, "; "))
	}
	return e.Message
}

// InvalidTransitionError represents an event rejected because no valid transition exists.
type InvalidTransitionError struct {
	baseDfsmError
	CurrentState StateValue
	EventName    string
	Message      string
}

func (e InvalidTransitionError) Error() string {
	return e.Message
}

// CircuitOpenError represents rejected execution because the circuit breaker is OPEN.
type CircuitOpenError struct {
	baseDfsmError
	HandlerName string
	Message     string
}

func (e CircuitOpenError) Error() string {
	return e.Message
}

// TransactionNotFoundError represents a transaction missing in StateStore.
type TransactionNotFoundError struct {
	baseDfsmError
	TransactionId string
}

func (e TransactionNotFoundError) Error() string {
	return fmt.Sprintf("transaction '%s' not found in state store", e.TransactionId)
}

// StaleTransactionVersionError represents optimistic concurrency conflict.
type StaleTransactionVersionError struct {
	baseDfsmError
	TransactionId   string
	ExpectedVersion int64
	ActualVersion   int64
}

func (e StaleTransactionVersionError) Error() string {
	return fmt.Sprintf("optimistic concurrency conflict on transaction '%s': expected version %d, but found %d",
		e.TransactionId, e.ExpectedVersion, e.ActualVersion)
}

// MaxEffectChainDepthError represents recursive effect chain loop guard tripping.
type MaxEffectChainDepthError struct {
	baseDfsmError
	MaxDepth int
	Message  string
}

func (e MaxEffectChainDepthError) Error() string {
	return e.Message
}

