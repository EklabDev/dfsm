package dfsm

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"strings"
	"sync"
	"time"
)

type depthContextKey struct{}

type DfsmActor[TContext any] struct {
	machine         *MachineDefinition
	registry        *FSMRegistry
	circuitBreakers sync.Map // string -> *CircuitBreakerInstance
}

func NewDfsmActor[TContext any](machine *MachineDefinition, registry *FSMRegistry) *DfsmActor[TContext] {
	return &DfsmActor[TContext]{
		machine:  machine,
		registry: registry,
	}
}

func (a *DfsmActor[TContext]) MachineId() string {
	return a.machine.Id
}

func (a *DfsmActor[TContext]) GetAvailableEvents(state StateValue) []string {
	return GetAvailableEvents(a.machine, state)
}

func (a *DfsmActor[TContext]) GetTerminalStates() []string {
	return GetTerminalStates(a.machine)
}

func (a *DfsmActor[TContext]) GetState(ctx context.Context, txId string) (*ActorStateRecord, error) {
	rec, err := a.registry.Store.GetTransaction(ctx, txId)
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return nil, TransactionNotFoundError{TransactionId: txId}
	}

	var userCtx TContext
	if rec.ContextJson != "" && rec.ContextJson != "{}" {
		_ = json.Unmarshal([]byte(rec.ContextJson), &userCtx)
	}

	avail := GetAvailableEvents(a.machine, rec.CurrentState)

	return &ActorStateRecord{
		TransactionId:   rec.TransactionId,
		MachineId:       rec.MachineId,
		CurrentState:    rec.CurrentState,
		Status:          rec.Status,
		Context:         userCtx,
		Version:         rec.Version,
		CreatedAt:       rec.CreatedAt,
		UpdatedAt:       rec.UpdatedAt,
		AvailableEvents: avail,
		SagaStackDepth:  len(rec.SagaStack),
	}, nil
}

func (a *DfsmActor[TContext]) Transition(ctx context.Context, txId string, eventName string, input any) (*TransitionExecutionResult, error) {
	// 1. Guard effect chain depth
	currentDepth := 0
	if val := ctx.Value(depthContextKey{}); val != nil {
		currentDepth = val.(int)
	}
	if currentDepth >= a.machine.MaxEffectChainDepth {
		return nil, MaxEffectChainDepthError{
			MaxDepth: a.machine.MaxEffectChainDepth,
			Message:  fmt.Sprintf("maximum effect chain depth of %d exceeded in transaction '%s' during event '%s'", a.machine.MaxEffectChainDepth, txId, eventName),
		}
	}

	// 2. Load or initialize transaction
	rec, err := a.registry.Store.GetTransaction(ctx, txId)
	if err != nil {
		return nil, err
	}

	now := a.registry.Clock.NowMs()
	var zeroCtx TContext

	if rec == nil {
		initVal, entryEffects := ResolveInitialState(a.machine)
		ctxBytes, _ := json.Marshal(zeroCtx)
		rec = &TransactionRecord{
			TransactionId: txId,
			MachineId:     a.machine.Id,
			CurrentState:  initVal,
			Status:        StatusIdle,
			ContextJson:   string(ctxBytes),
			Version:       1,
			CreatedAt:     now,
			UpdatedAt:     now,
		}
		if err := a.registry.Store.CreateTransaction(ctx, rec); err != nil {
			return nil, err
		}

		// Fire onStart hook
		a.fireHook(ctx, HookOnStart, OnStartEvent{
			TransactionId:  txId,
			InitialState:   rec.CurrentState,
			InitialContext: zeroCtx,
		})

		// Run initial entry effects
		for _, eff := range entryEffects {
			_ = a.runEffectInternal(ctx, txId, zeroCtx, eventName, rec.CurrentState, eff, nil)
		}
	}

	// 3. Terminal state check
	if rec.Status == StatusCompleted || rec.Status == StatusFailed {
		return nil, InvalidTransitionError{
			CurrentState: rec.CurrentState,
			EventName:    eventName,
			Message:      fmt.Sprintf("cannot process event '%s' because transaction '%s' is already in terminal status '%s' (state: %s)", eventName, txId, rec.Status, rec.CurrentState),
		}
	}

	// 4. Resolve transition
	matchedList := ResolveTransitionsForEvent(a.machine, rec.CurrentState, eventName)
	if len(matchedList) == 0 {
		return nil, InvalidTransitionError{
			CurrentState: rec.CurrentState,
			EventName:    eventName,
			Message:      fmt.Sprintf("no transition found for event '%s' from state '%s' in machine '%s'", eventName, rec.CurrentState, a.machine.Id),
		}
	}

	matched := matchedList[0]
	handlerName := matched.Edge.Handler
	if handlerName == "" {
		handlerName = eventName
	}

	hFunc, codePolicy, _ := a.registry.GetTransition(handlerName)

	// Pre-flight validation & input coercion
	coercedInput := input
	if hFunc != nil && input != nil {
		fnType := reflect.TypeOf(hFunc)
		if fnType.NumIn() > 0 {
			paramType := fnType.In(0)
			if paramType.Kind() == reflect.Struct || (paramType.Kind() == reflect.Pointer && paramType.Elem().Kind() == reflect.Struct) {
				if fld, ok := paramType.FieldByName("Input"); ok {
					expectedType := fld.Type
					if reflect.TypeOf(input) != expectedType {
						jsonBytes, _ := json.Marshal(input)
						newVal := reflect.New(expectedType)
						if err := json.Unmarshal(jsonBytes, newVal.Interface()); err == nil {
							coercedInput = newVal.Elem().Interface()
						}
					}
				}
			}
		}
	}

	if coercedInput != nil && a.registry.Validator != nil {
		if err := a.registry.Validator.Validate(coercedInput, fmt.Sprintf("input for event '%s'", eventName)); err != nil {
			return nil, err
		}
	}

	// 5. Merge policies
	policy := MergePolicies(codePolicy, matched.Edge.Policy, a.machine.Defaults, a.registry.GlobalPolicy)

	// 6. Fire beforeTransition hook
	a.fireHook(ctx, HookBeforeTransition, BeforeTransitionEvent{
		TransactionId: txId,
		CurrentState:  rec.CurrentState,
		EventName:     eventName,
		Input:         coercedInput,
	})

	// Mark IN_FLIGHT
	originalVersion := rec.Version
	rec.Status = StatusInFlight
	rec.UpdatedAt = a.registry.Clock.NowMs()
	rec.Version = originalVersion + 1
	if err := a.registry.Store.UpdateTransaction(ctx, rec, originalVersion); err != nil {
		return nil, err
	}
	inFlightVersion := rec.Version

	// 7. Execute Handler with Retry & Circuit Breaker
	var userCtx TContext
	if rec.ContextJson != "" && rec.ContextJson != "{}" {
		_ = json.Unmarshal([]byte(rec.ContextJson), &userCtx)
	}

	var cbInstance *CircuitBreakerInstance
	if policy.CircuitBreaker != nil {
		if val, ok := a.circuitBreakers.Load(handlerName); ok {
			cbInstance = val.(*CircuitBreakerInstance)
		} else {
			cbInstance = NewCircuitBreakerInstance(policy.CircuitBreaker, a.registry.Clock)
			a.circuitBreakers.Store(handlerName, cbInstance)
		}
	}

	startTime := time.Now()
	var lastErr error
	var handlerOutput any
	updatedCtx := userCtx
	contextUpdated := false
	attempts := 0

	if hFunc != nil {
		if cbInstance != nil {
			if err := cbInstance.BeforeExecution(handlerName); err != nil {
				return nil, err
			}
		}

		maxAttempts := policy.Retry.MaxAttempts
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			attempts = attempt
			outVal, newCtx, ctxUpd, err := a.invokeHandler(ctx, hFunc, txId, userCtx, coercedInput, rec.CurrentState, eventName)
			if err == nil {
				lastErr = nil
				handlerOutput = outVal
				if ctxUpd {
					updatedCtx = newCtx
					contextUpdated = true
				}
				if cbInstance != nil {
					cbInstance.OnSuccess()
				}
				break
			}
			lastErr = err
			if cbInstance != nil {
				cbInstance.OnFailure()
			}
			if attempt < maxAttempts {
				delay := a.calculateBackoffDelay(attempt, policy.Retry)
				a.registry.Clock.Sleep(time.Duration(delay) * time.Millisecond)
			}
		}
	} else {
		attempts = 1
	}

	durationMs := time.Since(startTime).Milliseconds()

	// 8. Handle Success
	if lastErr == nil {
		prevState := rec.CurrentState
		applied := ApplyTargetTransition(a.machine, rec.CurrentState, matched.SourcePath, matched.Edge.Target)
		rec.CurrentState = applied.NextStateValue

		originalContextJson := rec.ContextJson
		if contextUpdated {
			ctxBytes, _ := json.Marshal(updatedCtx)
			rec.ContextJson = string(ctxBytes)
		}

		// Push Saga step if compensation configured
		compHandler := policy.CompensateWith
		if compHandler != "" {
			var inSnap string
			if coercedInput != nil {
				b, _ := json.Marshal(coercedInput)
				inSnap = string(b)
			}
			step := SagaStepRecord{
				StepId:            fmt.Sprintf("step-%d", a.registry.Clock.NowMs()),
				StepName:          handlerName,
				CompensateHandler: compHandler,
				FromState:         prevState,
				TargetState:       rec.CurrentState,
				InputSnapshotJson: inSnap,
				ContextBeforeJson: originalContextJson,
				Timestamp:         a.registry.Clock.NowMs(),
			}
			_ = a.registry.Store.PushSagaStep(ctx, txId, step)
		}

		// Cascade onDone
		for {
			pendingOnDone := FindPendingOnDone(a.machine, rec.CurrentState)
			if pendingOnDone == nil {
				break
			}
			onDoneApplied := ApplyTargetTransition(a.machine, rec.CurrentState, pendingOnDone.SourcePath, pendingOnDone.Edge.Target)
			rec.CurrentState = onDoneApplied.NextStateValue
		}

		// Resolve settled status
		rec.Status = ResolveSettledStatus(a.machine, rec.CurrentState, false)
		rec.UpdatedAt = a.registry.Clock.NowMs()
		rec.Version = inFlightVersion + 1

		if err := a.registry.Store.UpdateTransaction(ctx, rec, inFlightVersion); err != nil {
			return nil, err
		}

		a.registry.Benchmark.Record(BenchmarkEvent{
			TransactionId: txId,
			MachineId:     a.machine.Id,
			EventName:     eventName,
			HandlerName:   handlerName,
			Attempts:      attempts,
			Outcome:       "SUCCESS",
			DurationMs:    durationMs,
			PreviousState: prevState,
			CurrentState:  rec.CurrentState,
		})

		a.fireHook(ctx, HookAfterTransition, AfterTransitionEvent{
			TransactionId:    txId,
			EventName:        eventName,
			PreviousState:    prevState,
			CurrentState:     rec.CurrentState,
			Status:           rec.Status,
			CompensatedSteps: 0,
		})

		if rec.Status == StatusCompleted {
			a.fireHook(ctx, HookOnComplete, OnCompleteEvent{
				TransactionId: txId,
				FinalState:    rec.CurrentState,
				FinalContext:  updatedCtx,
			})
			a.fireHook(ctx, HookOnTerminal, OnTerminalEvent{
				TransactionId: txId,
				FinalState:    rec.CurrentState,
				Status:        rec.Status,
				FinalContext:  updatedCtx,
			})
		}

		// Run exit and entry effects
		for _, eff := range applied.ExitEffects {
			_ = a.runEffectInternal(ctx, txId, updatedCtx, eventName, rec.CurrentState, eff, nil)
		}
		for _, eff := range applied.EntryEffects {
			_ = a.runEffectInternal(ctx, txId, updatedCtx, eventName, rec.CurrentState, eff, nil)
		}

		return &TransitionExecutionResult{
			TransactionId:    txId,
			EventName:        eventName,
			PreviousState:    prevState,
			CurrentState:     rec.CurrentState,
			Status:           rec.Status,
			OutputValue:      handlerOutput,
			CompensatedSteps: 0,
			RollbackOccurred: false,
		}, nil
	}

	// 9. Handle Failure & Saga Rollback
	a.registry.Benchmark.Record(BenchmarkEvent{
		TransactionId: txId,
		MachineId:     a.machine.Id,
		EventName:     eventName,
		HandlerName:   handlerName,
		Attempts:      attempts,
		Outcome:       "FAILED",
		DurationMs:    durationMs,
		PreviousState: rec.CurrentState,
		CurrentState:  rec.CurrentState,
		ErrorMessage:  lastErr.Error(),
	})

	compensatedSteps := 0
	rollbackTriggered := policy.OnFail != nil && policy.OnFail.Compensate

	if rollbackTriggered {
		rec.Status = StatusCompensating
		stack, _ := a.registry.Store.GetSagaStack(ctx, txId)
		remaining := len(stack)

		for remaining > 0 {
			step, _ := a.registry.Store.PopSagaStep(ctx, txId)
			if step == nil {
				break
			}
			compFunc, ok := a.registry.GetCompensate(step.CompensateHandler)
			if ok {
				var inSnap any
				if step.InputSnapshotJson != "" {
					_ = json.Unmarshal([]byte(step.InputSnapshotJson), &inSnap)
				}
				compReq := CompensationRequest[TContext]{
					TransactionId: txId,
					Context:       userCtx,
					StepName:      step.StepName,
					InputSnapshot: inSnap,
					FromState:     step.FromState,
					TargetState:   step.TargetState,
				}
				a.invokeCompensation(ctx, compFunc, compReq)
				if step.ContextBeforeJson != "" {
					_ = json.Unmarshal([]byte(step.ContextBeforeJson), &userCtx)
					rec.ContextJson = step.ContextBeforeJson
				}
			}
			compensatedSteps++
			remaining--
			a.fireHook(ctx, HookOnCompensate, OnCompensateEvent{
				TransactionId:  txId,
				StepName:       step.StepName,
				FromState:      step.FromState,
				TargetState:    step.TargetState,
				StepsRemaining: remaining,
			})
		}
	}

	failTarget := "error"
	if policy.OnFail != nil && policy.OnFail.Target != "" {
		failTarget = policy.OnFail.Target
	}

	failApplied := ApplyTargetTransition(a.machine, rec.CurrentState, matched.SourcePath, failTarget)
	rec.CurrentState = failApplied.NextStateValue
	rec.Status = ResolveSettledStatus(a.machine, rec.CurrentState, rollbackTriggered)
	rec.UpdatedAt = a.registry.Clock.NowMs()
	rec.Version = inFlightVersion + 1

	_ = a.registry.Store.UpdateTransaction(ctx, rec, inFlightVersion)

	a.fireHook(ctx, HookOnTerminal, OnTerminalEvent{
		TransactionId: txId,
		FinalState:    rec.CurrentState,
		Status:        rec.Status,
		FinalContext:  userCtx,
	})

	return &TransitionExecutionResult{
		TransactionId:    txId,
		EventName:        eventName,
		PreviousState:    rec.CurrentState,
		CurrentState:     rec.CurrentState,
		Status:           rec.Status,
		OutputValue:      nil,
		CompensatedSteps: compensatedSteps,
		RollbackOccurred: rollbackTriggered,
	}, nil
}

func (a *DfsmActor[TContext]) invokeHandler(
	ctx context.Context,
	hFunc any,
	txId string,
	userCtx TContext,
	input any,
	currentState StateValue,
	eventName string) (any, TContext, bool, error) {

	fnVal := reflect.ValueOf(hFunc)
	fnType := fnVal.Type()

	if fnType.NumIn() == 0 {
		res := fnVal.Call(nil)
		if len(res) == 0 {
			return nil, userCtx, false, nil
		}
		if len(res) == 1 && res[0].Type().Implements(reflect.TypeOf((*error)(nil)).Elem()) {
			if !res[0].IsNil() {
				return nil, userCtx, false, res[0].Interface().(error)
			}
			return nil, userCtx, false, nil
		}
		return res[0].Interface(), userCtx, false, nil
	}

	var inArgs []reflect.Value
	idx := 0
	if fnType.NumIn() > idx && fnType.In(idx).Implements(reflect.TypeOf((*context.Context)(nil)).Elem()) {
		inArgs = append(inArgs, reflect.ValueOf(ctx))
		idx++
	}

	if fnType.NumIn() > idx {
		targetType := fnType.In(idx)
		if targetType.Kind() == reflect.Struct {
			reqVal := reflect.New(targetType).Elem()
			if f := reqVal.FieldByName("TransactionId"); f.IsValid() && f.CanSet() {
				f.SetString(txId)
			}
			if f := reqVal.FieldByName("Data"); f.IsValid() && f.CanSet() {
				f.Set(reflect.ValueOf(userCtx))
			}
			if f := reqVal.FieldByName("CurrentState"); f.IsValid() && f.CanSet() {
				f.Set(reflect.ValueOf(currentState))
			}
			if f := reqVal.FieldByName("EventName"); f.IsValid() && f.CanSet() {
				f.SetString(eventName)
			}
			if f := reqVal.FieldByName("Input"); f.IsValid() && f.CanSet() && input != nil {
				inVal := reflect.ValueOf(input)
				if inVal.Type().AssignableTo(f.Type()) {
					f.Set(inVal)
				}
			}
			inArgs = append(inArgs, reqVal)
		} else if input != nil && reflect.TypeOf(input).AssignableTo(targetType) {
			inArgs = append(inArgs, reflect.ValueOf(input))
		} else {
			inArgs = append(inArgs, reflect.Zero(targetType))
		}
	}

	out := fnVal.Call(inArgs)
	if len(out) == 0 {
		return nil, userCtx, false, nil
	}

	last := out[len(out)-1]
	if last.Type().Implements(reflect.TypeOf((*error)(nil)).Elem()) {
		if !last.IsNil() {
			return nil, userCtx, false, last.Interface().(error)
		}
		out = out[:len(out)-1]
	}

	if len(out) == 0 {
		return nil, userCtx, false, nil
	}

	retVal := out[0].Interface()

	// Inspect TransitionOutput[TContext, TOutput]
	rVal := reflect.ValueOf(retVal)
	if rVal.Kind() == reflect.Struct {
		ctxUpdFld := rVal.FieldByName("ContextUpdated")
		ctxFld := rVal.FieldByName("Context")
		outFld := rVal.FieldByName("Output")
		if ctxUpdFld.IsValid() && ctxUpdFld.Bool() && ctxFld.IsValid() {
			var outAny any
			if outFld.IsValid() {
				outAny = outFld.Interface()
			}
			return outAny, ctxFld.Interface().(TContext), true, nil
		}
	}

	return retVal, userCtx, false, nil
}

func (a *DfsmActor[TContext]) invokeCompensation(ctx context.Context, compFunc any, req CompensationRequest[TContext]) {
	fnVal := reflect.ValueOf(compFunc)
	fnType := fnVal.Type()
	if fnType.NumIn() == 0 {
		fnVal.Call(nil)
		return
	}
	var args []reflect.Value
	idx := 0
	if fnType.NumIn() > idx && fnType.In(idx).Implements(reflect.TypeOf((*context.Context)(nil)).Elem()) {
		args = append(args, reflect.ValueOf(ctx))
		idx++
	}
	if fnType.NumIn() > idx {
		args = append(args, reflect.ValueOf(req))
	}
	fnVal.Call(args)
}

func (a *DfsmActor[TContext]) RunEffect(ctx context.Context, txId string, effectName string, payload any) error {
	rec, err := a.registry.Store.GetTransaction(ctx, txId)
	if err != nil {
		return err
	}
	if rec == nil {
		return TransactionNotFoundError{TransactionId: txId}
	}
	var userCtx TContext
	if rec.ContextJson != "" && rec.ContextJson != "{}" {
		_ = json.Unmarshal([]byte(rec.ContextJson), &userCtx)
	}
	return a.runEffectInternal(ctx, txId, userCtx, "EFFECT", rec.CurrentState, effectName, payload)
}

func (a *DfsmActor[TContext]) runEffectInternal(
	ctx context.Context,
	txId string,
	userCtx TContext,
	eventName string,
	state StateValue,
	effectName string,
	payload any) error {

	effHandler, ok := a.registry.GetEffect(effectName)
	if !ok {
		return nil
	}

	curDepth := 0
	if v := ctx.Value(depthContextKey{}); v != nil {
		curDepth = v.(int)
	}
	childCtx := context.WithValue(ctx, depthContextKey{}, curDepth+1)

	effReq := EffectRequest[TContext]{
		TransactionId: txId,
		Context:       userCtx,
		EventName:     eventName,
		State:         state,
		Actor:         a,
		RunEffectFunc: func(c context.Context, eff string, pl any) error {
			return a.runEffectInternal(childCtx, txId, userCtx, eventName, state, eff, pl)
		},
	}

	fnVal := reflect.ValueOf(effHandler)
	fnType := fnVal.Type()

	var args []reflect.Value
	idx := 0
	if fnType.NumIn() > idx && fnType.In(idx).Implements(reflect.TypeOf((*context.Context)(nil)).Elem()) {
		args = append(args, reflect.ValueOf(childCtx))
		idx++
	}
	if fnType.NumIn() > idx {
		args = append(args, reflect.ValueOf(effReq))
		idx++
	}
	if fnType.NumIn() > idx && payload != nil {
		args = append(args, reflect.ValueOf(payload))
	}

	out := fnVal.Call(args)
	if len(out) > 0 && out[len(out)-1].Type().Implements(reflect.TypeOf((*error)(nil)).Elem()) {
		if !out[len(out)-1].IsNil() {
			return out[len(out)-1].Interface().(error)
		}
	}
	return nil
}

func (a *DfsmActor[TContext]) fireHook(ctx context.Context, hookType HookType, eventPayload any) {
	hooks := a.registry.GetHooks(hookType)
	for _, h := range hooks {
		fnVal := reflect.ValueOf(h)
		fnType := fnVal.Type()
		numIn := fnType.NumIn()
		if numIn == 0 {
			fnVal.Call(nil)
		} else if numIn == 1 {
			argType := fnType.In(0)
			if eventPayload != nil && reflect.TypeOf(eventPayload).AssignableTo(argType) {
				fnVal.Call([]reflect.Value{reflect.ValueOf(eventPayload)})
			} else {
				fnVal.Call([]reflect.Value{reflect.Zero(argType)})
			}
		} else if numIn == 2 {
			var arg1, arg2 reflect.Value
			if fnType.In(0).Implements(reflect.TypeOf((*context.Context)(nil)).Elem()) {
				arg1 = reflect.ValueOf(ctx)
			} else {
				arg1 = reflect.Zero(fnType.In(0))
			}
			if eventPayload != nil && reflect.TypeOf(eventPayload).AssignableTo(fnType.In(1)) {
				arg2 = reflect.ValueOf(eventPayload)
			} else {
				arg2 = reflect.Zero(fnType.In(1))
			}
			fnVal.Call([]reflect.Value{arg1, arg2})
		}
	}
}

func (a *DfsmActor[TContext]) calculateBackoffDelay(attempt int, retry RetryPolicy) int64 {
	var delay float64
	if strings.EqualFold(retry.Backoff, "LINEAR") {
		delay = float64(retry.BackoffMs * attempt)
	} else if strings.EqualFold(retry.Backoff, "FIXED") {
		delay = float64(retry.BackoffMs)
	} else {
		// EXPONENTIAL
		delay = float64(retry.BackoffMs) * math.Pow(retry.BackoffFactor, float64(attempt-1))
	}

	if delay > float64(retry.MaxBackoffMs) {
		delay = float64(retry.MaxBackoffMs)
	}
	if retry.Jitter {
		delay = delay * (0.5 + rand.Float64()*0.5)
	}
	return int64(delay)
}

// --- Ops & Inspection APIs ---

func (a *DfsmActor[TContext]) GetActiveCount(ctx context.Context) (int, error) {
	list, err := a.registry.Store.ListActiveTransactions(ctx, a.machine.Id, 1000)
	if err != nil {
		return 0, err
	}
	return len(list), nil
}

func (a *DfsmActor[TContext]) ListActiveTransactions(ctx context.Context, limit int) ([]*ActiveTransactionSummary, error) {
	list, err := a.registry.Store.ListActiveTransactions(ctx, a.machine.Id, limit)
	if err != nil {
		return nil, err
	}
	var res []*ActiveTransactionSummary
	for _, r := range list {
		res = append(res, &ActiveTransactionSummary{
			TransactionId: r.TransactionId,
			MachineId:     r.MachineId,
			CurrentState:  r.CurrentState,
			Status:        r.Status,
			Version:       r.Version,
			CreatedAt:     r.CreatedAt,
			UpdatedAt:     r.UpdatedAt,
		})
	}
	return res, nil
}

func (a *DfsmActor[TContext]) GetStatusBreakdown(ctx context.Context) (*StatusBreakdown, error) {
	all, err := a.registry.Store.ListAllTransactions(ctx, a.machine.Id, 5000)
	if err != nil {
		return nil, err
	}
	var b StatusBreakdown
	for _, r := range all {
		switch r.Status {
		case StatusIdle:
			b.Idle++
		case StatusInFlight:
			b.InFlight++
		case StatusCompensating:
			b.Compensating++
		case StatusCompensated:
			b.Compensated++
		case StatusCompleted:
			b.Completed++
		case StatusFailed:
			b.Failed++
		}
	}
	return &b, nil
}

func (a *DfsmActor[TContext]) GetInFlightSummary(ctx context.Context) (*InFlightSummary, error) {
	b, err := a.GetStatusBreakdown(ctx)
	if err != nil {
		return nil, err
	}
	nonTerminal := b.Idle + b.InFlight + b.Compensating
	terminals := a.GetTerminalStates()
	return &InFlightSummary{
		TotalInFlight:    b.InFlight,
		NonTerminalCount: nonTerminal,
		TerminalStates:   terminals,
		Breakdown:        *b,
	}, nil
}

func (a *DfsmActor[TContext]) ForceCleanUp(ctx context.Context, opts ForceCleanUpOptions) (*ForceCleanUpResult, error) {
	var candidates []*TransactionRecord
	var err error
	if len(opts.TransactionIds) > 0 {
		for _, id := range opts.TransactionIds {
			rec, _ := a.registry.Store.GetTransaction(ctx, id)
			if rec != nil {
				candidates = append(candidates, rec)
			}
		}
	} else {
		candidates, err = a.registry.Store.ListActiveTransactions(ctx, a.machine.Id, opts.Limit)
		if err != nil {
			return nil, err
		}
	}

	now := a.registry.Clock.NowMs()
	var matched []*TransactionRecord
	for _, rec := range candidates {
		if opts.OlderThanMs != nil && (now-rec.UpdatedAt) < *opts.OlderThanMs {
			continue
		}
		if opts.StuckOnly && rec.Status != StatusInFlight && rec.Status != StatusCompensating {
			continue
		}
		matched = append(matched, rec)
	}

	var affectedIds []string
	for _, m := range matched {
		affectedIds = append(affectedIds, m.TransactionId)
	}

	if opts.DryRun {
		return &ForceCleanUpResult{
			MatchedCount:          len(matched),
			ProcessedCount:        0,
			DryRun:                true,
			Action:                opts.Action,
			AffectedTransactionIds: affectedIds,
		}, nil
	}

	processed := 0
	for _, rec := range matched {
		switch opts.Action {
		case ActionDelete:
			_ = a.registry.Store.DeleteTransaction(ctx, rec.TransactionId)
			processed++
		case ActionMarkFail:
			rec.Status = StatusFailed
			rec.CurrentState = Leaf("error")
			rec.UpdatedAt = now
			rec.Version++
			_ = a.registry.Store.UpdateTransaction(ctx, rec, rec.Version-1)
			processed++
		case ActionCompensate:
			for {
				step, _ := a.registry.Store.PopSagaStep(ctx, rec.TransactionId)
				if step == nil {
					break
				}
				compFunc, ok := a.registry.GetCompensate(step.CompensateHandler)
				if ok {
					var userCtx TContext
					if rec.ContextJson != "" && rec.ContextJson != "{}" {
						_ = json.Unmarshal([]byte(rec.ContextJson), &userCtx)
					}
					var inSnap any
					if step.InputSnapshotJson != "" {
						_ = json.Unmarshal([]byte(step.InputSnapshotJson), &inSnap)
					}
					a.invokeCompensation(ctx, compFunc, CompensationRequest[TContext]{
						TransactionId: rec.TransactionId,
						Context:       userCtx,
						StepName:      step.StepName,
						InputSnapshot: inSnap,
						FromState:     step.FromState,
						TargetState:   step.TargetState,
					})
				}
			}
			rec.Status = StatusFailed
			rec.CurrentState = Leaf("error")
			rec.UpdatedAt = now
			rec.Version++
			_ = a.registry.Store.UpdateTransaction(ctx, rec, rec.Version-1)
			processed++
		case ActionContinue:
			rec.Status = StatusIdle
			rec.UpdatedAt = now
			rec.Version++
			_ = a.registry.Store.UpdateTransaction(ctx, rec, rec.Version-1)
			processed++
		}
	}

	return &ForceCleanUpResult{
		MatchedCount:          len(matched),
		ProcessedCount:        processed,
		DryRun:                false,
		Action:                opts.Action,
		AffectedTransactionIds: affectedIds,
	}, nil
}
