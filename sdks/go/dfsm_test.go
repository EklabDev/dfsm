package dfsm

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type TestOrderContext struct {
	OrderID    string   `json:"orderId"`
	Amount     float64  `json:"amount"`
	Customer   string   `json:"customer"`
	Trace      []string `json:"trace"`
	StatusDesc string   `json:"statusDesc"`
}

type TestOrderInput struct {
	Amount float64 `json:"amount" validate:"required,min=1"`
	Email  string  `json:"email" validate:"required,email"`
}

func TestStructValidator(t *testing.T) {
	v := StructTagValidator{}

	// Valid input
	valid := TestOrderInput{Amount: 100, Email: "test@example.com"}
	assert.NoError(t, v.Validate(valid, "TestOrderInput"))

	// Invalid amount (< 1)
	invAmt := TestOrderInput{Amount: 0, Email: "test@example.com"}
	err := v.Validate(invAmt, "TestOrderInput")
	assert.Error(t, err)
	var valErr ValidationError
	assert.True(t, errors.As(err, &valErr))

	// Invalid email
	invEmail := TestOrderInput{Amount: 50, Email: "not-an-email"}
	err = v.Validate(invEmail, "TestOrderInput")
	assert.Error(t, err)

	// Missing email
	missEmail := TestOrderInput{Amount: 50}
	err = v.Validate(missEmail, "TestOrderInput")
	assert.Error(t, err)
}

func TestCircuitBreaker(t *testing.T) {
	vc := NewVirtualClock(time.Now().UnixMilli())
	cb := NewCircuitBreakerInstance(&CircuitBreakerPolicy{
		FailureThreshold:         2,
		RecoveryTimeoutMs:        1000,
		HalfOpenSuccessThreshold: 1,
	}, vc)

	assert.Equal(t, CircuitClosed, cb.State())
	assert.NoError(t, cb.BeforeExecution("test"))

	// Record 1 failure
	cb.OnFailure()
	assert.Equal(t, CircuitClosed, cb.State())
	assert.NoError(t, cb.BeforeExecution("test"))

	// Record 2nd failure -> Open
	cb.OnFailure()
	assert.Equal(t, CircuitOpen, cb.State())
	assert.Error(t, cb.BeforeExecution("test"))

	// Advance clock past reset timeout -> HalfOpen
	vc.Advance(1500)
	assert.NoError(t, cb.BeforeExecution("test")) // triggers transition to HalfOpen
	assert.Equal(t, CircuitHalfOpen, cb.State())

	// Record success -> Closed
	cb.OnSuccess()
	assert.Equal(t, CircuitClosed, cb.State())
	assert.NoError(t, cb.BeforeExecution("test"))
}

func TestPolicyMerger(t *testing.T) {
	attempts5 := 5
	attempts3 := 3
	backoff200 := 200
	timeout5000 := 5000

	codePol := &PartialTransitionPolicy{
		RetryMaxAttempts: &attempts5,
		RetryDefined:     true,
	}
	yamlTransPol := &PartialTransitionPolicy{
		RetryMaxAttempts:    &attempts3,
		RetryBackoffMs:      &backoff200,
		CbRecoveryTimeoutMs: &timeout5000,
		RetryDefined:        true,
		CbDefined:           true,
	}

	merged := MergePolicies(codePol, yamlTransPol)
	assert.Equal(t, 5, merged.Retry.MaxAttempts)        // code overrides
	assert.Equal(t, 100, merged.Retry.BackoffMs)       // non-multiplying retries kept code level (or default)
	assert.NotNil(t, merged.CircuitBreaker)
	assert.Equal(t, 5000, merged.CircuitBreaker.RecoveryTimeoutMs) // inherited from yaml
}

func TestActorLifecycleAndHooks(t *testing.T) {
	yamlDef := `
dfsm: "1.0"
id: "lifecycle-test"
version: "1.0.0"
initial: "idle"
states:
  idle:
    on:
      START: "running"
  running:
    on:
      COMPLETE: "finished"
  finished:
    type: "final"
`
	ctx := context.Background()
	machine, err := ParseYamlMachine(yamlDef)
	require.NoError(t, err)

	reg := NewFSMRegistry()
	var hookCalls []string
	var mu sync.Mutex
	logHook := func(name string) {
		mu.Lock()
		defer mu.Unlock()
		hookCalls = append(hookCalls, name)
	}

	reg.RegisterOnStart(func() {
		logHook("onStart")
	})
	reg.RegisterBeforeTransition(func() {
		logHook("beforeTransition")
	})
	reg.RegisterAfterTransition(func() {
		logHook("afterTransition")
	})
	reg.RegisterOnTerminal(func() {
		logHook("onTerminal")
	})

	actor := NewDfsmActor[TestOrderContext](machine, reg)
	txId := "test-actor-1"

	// Step 1: START
	res, err := actor.Transition(ctx, txId, "START", nil)
	require.NoError(t, err)
	assert.Equal(t, "running", res.CurrentState.String())

	// Step 2: COMPLETE
	res, err = actor.Transition(ctx, txId, "COMPLETE", nil)
	require.NoError(t, err)
	assert.Equal(t, "finished", res.CurrentState.String())

	state, err := actor.GetState(ctx, txId)
	require.NoError(t, err)
	assert.Equal(t, StatusCompleted, state.Status)

	expected := []string{
		"onStart",
		"beforeTransition",
		"afterTransition",
		"beforeTransition",
		"afterTransition",
		"onTerminal",
	}
	assert.Equal(t, expected, hookCalls)
}

func TestConditionalEffectRouting(t *testing.T) {
	yamlDef := `
dfsm: "1.0"
id: "effect-routing-test"
version: "1.0.0"
initial: "checking"
states:
  checking:
    on:
      CHECK:
        target: "deciding"
  deciding:
    entry:
      - "evaluateOrder"
    on:
      APPROVE: "approved"
      REJECT: "rejected"
  approved:
    type: "final"
  rejected:
    type: "final"
`
	ctx := context.Background()
	machine, err := ParseYamlMachine(yamlDef)
	require.NoError(t, err)

	reg := NewFSMRegistry()
	reg.RegisterEffect("evaluateOrder", func(ctx context.Context, req EffectRequest[TestOrderContext]) error {
		if req.Context.Amount > 500 {
			_, err := req.Actor.Transition(ctx, req.TransactionId, "APPROVE", nil)
			return err
		}
		_, err := req.Actor.Transition(ctx, req.TransactionId, "REJECT", nil)
		return err
	})

	reg.RegisterTransition("CHECK", func(ctx context.Context, req TransitionRequest[TestOrderContext, any]) (TransitionOutput[TestOrderContext, any], error) {
		inputAmt, ok := req.Input.(float64)
		if ok {
			req.Data.Amount = inputAmt
		}
		return OutputWithContext[TestOrderContext, any](req.Data), nil
	}, nil)

	actor := NewDfsmActor[TestOrderContext](machine, reg)

	// Test approve path (> 500)
	resApprove, err := actor.Transition(ctx, "order-approve", "CHECK", 1000.0)
	require.NoError(t, err)
	// After CHECK -> deciding -> entry effect runs evaluateOrder -> sends APPROVE -> final "approved"
	stateApprove, err := actor.GetState(ctx, "order-approve")
	require.NoError(t, err)
	assert.Equal(t, "approved", stateApprove.CurrentState.String())
	assert.Equal(t, StatusCompleted, stateApprove.Status)
	_ = resApprove

	// Test reject path (<= 500)
	resReject, err := actor.Transition(ctx, "order-reject", "CHECK", 250.0)
	require.NoError(t, err)
	stateReject, err := actor.GetState(ctx, "order-reject")
	require.NoError(t, err)
	assert.Equal(t, "rejected", stateReject.CurrentState.String())
	assert.Equal(t, StatusCompleted, stateReject.Status)
	_ = resReject
}

func TestActorOpsAPIs(t *testing.T) {
	yamlDef := `
dfsm: "1.0"
id: "order-machine"
version: "1.0.0"
initial: "processing"
states:
  processing:
    on:
      FINISH: "completed"
  completed:
    type: "final"
`
	ctx := context.Background()
	machine, err := ParseYamlMachine(yamlDef)
	require.NoError(t, err)

	reg := NewFSMRegistry()
	actor := NewDfsmActor[TestOrderContext](machine, reg)

	now := time.Now().UnixMilli()

	// 1. In-flight transaction
	require.NoError(t, reg.Store.CreateTransaction(ctx, &TransactionRecord{
		TransactionId: "act-1",
		MachineId:     "order-machine",
		CurrentState:  Leaf("processing"),
		Status:        StatusInFlight,
		ContextJson:   "{}",
		Version:       1,
		CreatedAt:     now - 10000,
		UpdatedAt:     now - 10000,
	}))

	// 2. Completed transaction
	require.NoError(t, reg.Store.CreateTransaction(ctx, &TransactionRecord{
		TransactionId: "term-1",
		MachineId:     "order-machine",
		CurrentState:  Leaf("completed"),
		Status:        StatusCompleted,
		ContextJson:   "{}",
		Version:       1,
		CreatedAt:     now - 20000,
		UpdatedAt:     now - 20000,
	}))

	// 3. Old stuck in-flight transaction (> 1 hour old)
	require.NoError(t, reg.Store.CreateTransaction(ctx, &TransactionRecord{
		TransactionId: "orph-1",
		MachineId:     "order-machine",
		CurrentState:  Leaf("processing"),
		Status:        StatusInFlight,
		ContextJson:   "{}",
		Version:       1,
		CreatedAt:     now - 7200000,
		UpdatedAt:     now - 7200000,
	}))

	// Check status breakdown
	breakdown, err := actor.GetStatusBreakdown(ctx)
	require.NoError(t, err)
	assert.Equal(t, 2, breakdown.InFlight)
	assert.Equal(t, 1, breakdown.Completed)

	// Check InFlightSummary
	summary, err := actor.GetInFlightSummary(ctx)
	require.NoError(t, err)
	assert.Equal(t, 2, summary.TotalInFlight)
	assert.Contains(t, summary.TerminalStates, "completed")

	// Force cleanup stuck transactions older than 30 minutes
	olderThan30m := int64(1800000)
	cleanRes, err := actor.ForceCleanUp(ctx, ForceCleanUpOptions{
		OlderThanMs: &olderThan30m,
		StuckOnly:   true,
		Action:      ActionMarkFail,
	})
	require.NoError(t, err)
	assert.Equal(t, 1, cleanRes.ProcessedCount)
	assert.Contains(t, cleanRes.AffectedTransactionIds, "orph-1")

	// Verify orph-1 is now marked failed
	orphState, err := actor.GetState(ctx, "orph-1")
	require.NoError(t, err)
	assert.Equal(t, StatusFailed, orphState.Status)

	// Clean up term-1 with ActionDelete
	cleanDel, err := actor.ForceCleanUp(ctx, ForceCleanUpOptions{
		TransactionIds: []string{"term-1"},
		Action:         ActionDelete,
	})
	require.NoError(t, err)
	assert.Equal(t, 1, cleanDel.ProcessedCount)

	_, err = actor.GetState(ctx, "term-1")
	assert.Error(t, err)
}
