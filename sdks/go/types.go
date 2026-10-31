package dfsm

import (
	"context"
)

type TransactionStatus string

const (
	StatusIdle         TransactionStatus = "IDLE"
	StatusInFlight     TransactionStatus = "IN_FLIGHT"
	StatusCompensating TransactionStatus = "COMPENSATING"
	StatusCompensated  TransactionStatus = "COMPENSATED"
	StatusCompleted    TransactionStatus = "COMPLETED"
	StatusFailed       TransactionStatus = "FAILED"
)

type HookType string

const (
	HookOnStart          HookType = "onStart"
	HookBeforeTransition HookType = "beforeTransition"
	HookAfterTransition  HookType = "afterTransition"
	HookOnCompensate     HookType = "onCompensate"
	HookOnComplete       HookType = "onComplete"
	HookOnTerminal       HookType = "onTerminal"
)

type ForceCleanUpAction string

const (
	ActionCompensate ForceCleanUpAction = "COMPENSATE"
	ActionMarkFail   ForceCleanUpAction = "MARK_FAIL"
	ActionDelete     ForceCleanUpAction = "DELETE"
	ActionContinue   ForceCleanUpAction = "CONTINUE"
)

type IDfsmActor interface {
	MachineId() string
	Transition(ctx context.Context, txId string, eventName string, input any) (*TransitionExecutionResult, error)
	GetState(ctx context.Context, txId string) (*ActorStateRecord, error)
	GetAvailableEvents(state StateValue) []string
	GetTerminalStates() []string
}

type TransitionRequest[TContext any, TInput any] struct {
	TransactionId string
	Data          TContext
	Input         TInput
	CurrentState  StateValue
	EventName     string
	Meta          map[string]any
}

type TransitionOutput[TContext any, TOutput any] struct {
	Context        TContext
	Output         TOutput
	ContextUpdated bool
}

func OutputWithContext[TContext any, TOutput any](ctx TContext) TransitionOutput[TContext, TOutput] {
	var zeroOut TOutput
	return TransitionOutput[TContext, TOutput]{
		Context:        ctx,
		Output:         zeroOut,
		ContextUpdated: true,
	}
}

func OutputWithResult[TContext any, TOutput any](ctx TContext, output TOutput) TransitionOutput[TContext, TOutput] {
	return TransitionOutput[TContext, TOutput]{
		Context:        ctx,
		Output:         output,
		ContextUpdated: true,
	}
}

func OutputEmpty[TContext any, TOutput any]() TransitionOutput[TContext, TOutput] {
	var zeroCtx TContext
	var zeroOut TOutput
	return TransitionOutput[TContext, TOutput]{
		Context:        zeroCtx,
		Output:         zeroOut,
		ContextUpdated: false,
	}
}

type CompensationRequest[TContext any] struct {
	TransactionId string
	Context       TContext
	StepName      string
	InputSnapshot any
	FromState     StateValue
	TargetState   StateValue
}

type EffectRequest[TContext any] struct {
	TransactionId string
	Context       TContext
	EventName     string
	State         StateValue
	Actor         IDfsmActor
	RunEffectFunc func(ctx context.Context, effectName string, payload any) error
}

func (req EffectRequest[TContext]) RunEffect(ctx context.Context, effectName string, payload any) error {
	if req.RunEffectFunc != nil {
		return req.RunEffectFunc(ctx, effectName, payload)
	}
	return nil
}

// Lifecycle Events
type OnStartEvent struct {
	TransactionId  string
	InitialState   StateValue
	InitialContext any
}

type BeforeTransitionEvent struct {
	TransactionId string
	CurrentState  StateValue
	EventName     string
	Input         any
}

type AfterTransitionEvent struct {
	TransactionId    string
	EventName        string
	PreviousState    StateValue
	CurrentState     StateValue
	Status           TransactionStatus
	CompensatedSteps int
}

type OnCompensateEvent struct {
	TransactionId  string
	StepName       string
	FromState      StateValue
	TargetState    StateValue
	StepsRemaining int
}

type OnCompleteEvent struct {
	TransactionId string
	FinalState    StateValue
	FinalContext  any
}

type OnTerminalEvent struct {
	TransactionId string
	FinalState    StateValue
	Status        TransactionStatus
	FinalContext  any
}

// Persistence records
type SagaStepRecord struct {
	StepId             string     `json:"stepId" bson:"step_id"`
	StepName           string     `json:"stepName" bson:"step_name"`
	CompensateHandler  string     `json:"compensateHandler" bson:"compensate_handler"`
	FromState          StateValue `json:"fromState" bson:"from_state"`
	TargetState        StateValue `json:"targetState" bson:"target_state"`
	InputSnapshotJson  string     `json:"inputSnapshotJson,omitempty" bson:"input_snapshot_json,omitempty"`
	ContextBeforeJson  string     `json:"contextBeforeJson,omitempty" bson:"context_before_json,omitempty"`
	Timestamp          int64      `json:"timestamp" bson:"timestamp"`
}

type TransactionRecord struct {
	TransactionId  string            `json:"transactionId" bson:"_id"`
	MachineId      string            `json:"machineId" bson:"machine_id"`
	CurrentState   StateValue        `json:"currentState" bson:"current_state"`
	Status         TransactionStatus `json:"status" bson:"status"`
	ContextJson    string            `json:"contextJson" bson:"context_json"`
	Version        int64             `json:"version" bson:"version"`
	CreatedAt      int64             `json:"createdAt" bson:"created_at"`
	UpdatedAt      int64             `json:"updatedAt" bson:"updated_at"`
	LeaseExpiresAt *int64            `json:"leaseExpiresAt,omitempty" bson:"lease_expires_at,omitempty"`
	LeaseOwner     *string           `json:"leaseOwner,omitempty" bson:"lease_owner,omitempty"`
	SagaStack      []SagaStepRecord  `json:"sagaStack,omitempty" bson:"saga_stack,omitempty"`
}

type ActorStateRecord struct {
	TransactionId   string            `json:"transactionId"`
	MachineId       string            `json:"machineId"`
	CurrentState    StateValue        `json:"currentState"`
	Status          TransactionStatus `json:"status"`
	Context         any               `json:"context"`
	Version         int64             `json:"version"`
	CreatedAt       int64             `json:"createdAt"`
	UpdatedAt       int64             `json:"updatedAt"`
	AvailableEvents []string          `json:"availableEvents"`
	SagaStackDepth  int               `json:"sagaStackDepth"`
}

type TransitionExecutionResult struct {
	TransactionId    string            `json:"transactionId"`
	EventName        string            `json:"eventName"`
	PreviousState    StateValue        `json:"previousState"`
	CurrentState     StateValue        `json:"currentState"`
	Status           TransactionStatus `json:"status"`
	OutputValue      any               `json:"outputValue,omitempty"`
	CompensatedSteps int               `json:"compensatedSteps"`
	RollbackOccurred bool              `json:"rollbackOccurred"`
}

type ActiveTransactionSummary struct {
	TransactionId string            `json:"transactionId"`
	MachineId     string            `json:"machineId"`
	CurrentState  StateValue        `json:"currentState"`
	Status        TransactionStatus `json:"status"`
	Version       int64             `json:"version"`
	CreatedAt     int64             `json:"createdAt"`
	UpdatedAt     int64             `json:"updatedAt"`
}

type StatusBreakdown struct {
	Idle         int `json:"idle"`
	InFlight     int `json:"inFlight"`
	Compensating int `json:"compensating"`
	Compensated  int `json:"compensated"`
	Completed    int `json:"completed"`
	Failed       int `json:"failed"`
}

type InFlightSummary struct {
	TotalInFlight    int             `json:"totalInFlight"`
	NonTerminalCount int             `json:"nonTerminalCount"`
	TerminalStates   []string        `json:"terminalStates"`
	Breakdown        StatusBreakdown `json:"breakdown"`
}

type ForceCleanUpOptions struct {
	Action          ForceCleanUpAction `json:"action"`
	TransactionIds  []string           `json:"transactionIds,omitempty"`
	IncludeInFlight bool               `json:"includeInFlight"`
	StuckOnly       bool               `json:"stuckOnly"`
	OlderThanMs     *int64             `json:"olderThanMs,omitempty"`
	DryRun          bool               `json:"dryRun"`
	Limit           int                `json:"limit"`
}

type ForceCleanUpResult struct {
	MatchedCount          int                `json:"matchedCount"`
	ProcessedCount        int                `json:"processedCount"`
	DryRun                bool               `json:"dryRun"`
	Action                ForceCleanUpAction `json:"action"`
	AffectedTransactionIds []string          `json:"affectedTransactionIds"`
}

