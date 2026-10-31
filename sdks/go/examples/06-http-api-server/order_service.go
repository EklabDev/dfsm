package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"

	"github.com/eklabdev/dfsm/sdks/go"
)

//go:embed order-fulfillment.dfsm.yaml
var rawMachineYaml string

type OrderFulfillmentService struct {
	registry *dfsm.FSMRegistry
	machine  *dfsm.MachineDefinition
	actor    *dfsm.DfsmActor[OrderContext]
}

func NewOrderFulfillmentService(store dfsm.StateStore) (*OrderFulfillmentService, error) {
	if store == nil {
		store = dfsm.NewMemoryStateStore()
	}

	machine, err := dfsm.ParseYamlMachine(rawMachineYaml)
	if err != nil {
		return nil, fmt.Errorf("failed to parse machine YAML: %w", err)
	}

	reg := dfsm.NewFSMRegistry(dfsm.WithStore(store))

	// Register Transitions
	reg.RegisterTransition("reserveInventory", func(ctx context.Context, req dfsm.TransitionRequest[OrderContext, any]) (dfsm.TransitionOutput[OrderContext, any], error) {
		req.Data.ItemsReserved = true
		req.Data.TraceLog = append(req.Data.TraceLog, "Stock reserved in warehouse")
		log.Printf("[DFSM-STEP] tx=%s | Items reserved in warehouse", req.TransactionId)
		return dfsm.OutputWithContext[OrderContext, any](req.Data), nil
	}, nil)

	reg.RegisterCompensate("releaseInventory", func(ctx context.Context, req dfsm.CompensationRequest[OrderContext]) {
		req.Context.ItemsReserved = false
		log.Printf("[DFSM-SAGA] tx=%s | Released warehouse inventory", req.TransactionId)
	})

	reg.RegisterTransition("cancelDraftOrder", func(ctx context.Context, req dfsm.TransitionRequest[OrderContext, any]) (dfsm.TransitionOutput[OrderContext, any], error) {
		req.Data.TraceLog = append(req.Data.TraceLog, "Draft order cancelled")
		log.Printf("[DFSM-STEP] tx=%s | Draft order cancelled", req.TransactionId)
		return dfsm.OutputWithContext[OrderContext, any](req.Data), nil
	}, nil)

	reg.RegisterTransition("authorizePayment", func(ctx context.Context, req dfsm.TransitionRequest[OrderContext, any]) (dfsm.TransitionOutput[OrderContext, any], error) {
		if req.Data.SimulateFailure {
			log.Printf("[DFSM-STEP] tx=%s | Simulating payment gateway failure!", req.TransactionId)
			return dfsm.OutputEmpty[OrderContext, any](), fmt.Errorf("payment gateway error: simulated failure")
		}
		req.Data.PaymentCharged = true
		req.Data.TraceLog = append(req.Data.TraceLog, fmt.Sprintf("Payment authorized: $%.2f", req.Data.Amount))
		log.Printf("[DFSM-STEP] tx=%s | Payment authorized for $%.2f", req.TransactionId, req.Data.Amount)
		return dfsm.OutputWithContext[OrderContext, any](req.Data), nil
	}, &dfsm.PartialTransitionPolicy{
		RetryMaxAttempts: func(i int) *int { return &i }(3),
		RetryDefined:     true,
	})

	reg.RegisterCompensate("refundPayment", func(ctx context.Context, req dfsm.CompensationRequest[OrderContext]) {
		req.Context.PaymentCharged = false
		log.Printf("[DFSM-SAGA] tx=%s | Payment refunded", req.TransactionId)
	})

	reg.RegisterTransition("completePacking", func(ctx context.Context, req dfsm.TransitionRequest[OrderContext, any]) (dfsm.TransitionOutput[OrderContext, any], error) {
		req.Data.PackComplete = true
		req.Data.TraceLog = append(req.Data.TraceLog, "Warehouse packing completed")
		log.Printf("[DFSM-STEP] tx=%s | Packing completed", req.TransactionId)
		return dfsm.OutputWithContext[OrderContext, any](req.Data), nil
	}, nil)

	reg.RegisterTransition("bookShippingCarrier", func(ctx context.Context, req dfsm.TransitionRequest[OrderContext, any]) (dfsm.TransitionOutput[OrderContext, any], error) {
		req.Data.CarrierBooked = true
		req.Data.TraceLog = append(req.Data.TraceLog, "Carrier booked (FedEx)")
		log.Printf("[DFSM-STEP] tx=%s | Carrier booked", req.TransactionId)
		return dfsm.OutputWithContext[OrderContext, any](req.Data), nil
	}, nil)

	reg.RegisterTransition("resetAfterError", func(ctx context.Context, req dfsm.TransitionRequest[OrderContext, any]) (dfsm.TransitionOutput[OrderContext, any], error) {
		req.Data.SimulateFailure = false
		req.Data.TraceLog = append(req.Data.TraceLog, "Order reset after error recovery")
		log.Printf("[DFSM-STEP] tx=%s | Reset after error", req.TransactionId)
		return dfsm.OutputWithContext[OrderContext, any](req.Data), nil
	}, nil)

	// Register Effects
	reg.RegisterEffect("evaluatePostReserveRouting", func(ctx context.Context, req dfsm.EffectRequest[OrderContext]) error {
		log.Printf("[DFSM-EFFECT] tx=%s | Evaluating post-reserve routing (autoAuthorize=%v)", req.TransactionId, req.Context.AutoAuthorize)
		if req.Context.AutoAuthorize {
			return req.RunEffect(ctx, "autoAuthorizeWalletEffect", nil)
		}
		return req.RunEffect(ctx, "awaitManualPaymentEffect", nil)
	})

	reg.RegisterEffect("autoAuthorizeWalletEffect", func(ctx context.Context, req dfsm.EffectRequest[OrderContext]) error {
		log.Printf("[DFSM-EFFECT] tx=%s | Auto-authorizing payment transition", req.TransactionId)
		_, err := req.Actor.Transition(ctx, req.TransactionId, "AUTHORIZE_PAYMENT", nil)
		return err
	})

	reg.RegisterEffect("awaitManualPaymentEffect", func(ctx context.Context, req dfsm.EffectRequest[OrderContext]) error {
		log.Printf("[DFSM-EFFECT] tx=%s | Awaiting manual payment event from user", req.TransactionId)
		return nil
	})

	reg.RegisterEffect("sendDeliveryNotification", func(ctx context.Context, req dfsm.EffectRequest[OrderContext]) error {
		log.Printf("[DFSM-EFFECT] tx=%s | Order delivered! Sent delivery notification to customer", req.TransactionId)
		return nil
	})

	reg.RegisterEffect("recordErrorAlert", func(ctx context.Context, req dfsm.EffectRequest[OrderContext]) error {
		log.Printf("[DFSM-EFFECT] tx=%s | Alert recorded in error state", req.TransactionId)
		return nil
	})

	// Register Hooks
	reg.RegisterOnStart(func() {
		log.Printf("[DFSM-HOOK] onStart triggered")
	})
	reg.RegisterBeforeTransition(func() {
		log.Printf("[DFSM-HOOK] beforeTransition triggered")
	})
	reg.RegisterAfterTransition(func() {
		log.Printf("[DFSM-HOOK] afterTransition triggered")
	})
	reg.RegisterOnCompensate(func() {
		log.Printf("[DFSM-HOOK] onCompensate triggered")
	})
	reg.RegisterOnComplete(func() {
		log.Printf("[DFSM-HOOK] onComplete triggered")
	})
	reg.RegisterOnTerminal(func() {
		log.Printf("[DFSM-HOOK] onTerminal triggered")
	})

	actor := dfsm.NewDfsmActor[OrderContext](machine, reg)

	return &OrderFulfillmentService{
		registry: reg,
		machine:  machine,
		actor:    actor,
	}, nil
}

func (s *OrderFulfillmentService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*OrderResponse, error) {
	// Initialize transaction record with customer context
	now := s.registry.Clock.NowMs()
	orderCtx := OrderContext{
		OrderId:         req.OrderId,
		Customer:        req.Customer,
		Amount:          req.Amount,
		AutoAuthorize:   req.AutoAuthorize,
		SimulateFailure: req.SimulateFailure,
		TraceLog:        []string{fmt.Sprintf("Order created for %s ($%.2f)", req.Customer, req.Amount)},
	}

	initVal, entryEffects := dfsm.ResolveInitialState(s.machine)

	// Initial store record
	rec := &dfsm.TransactionRecord{
		TransactionId: req.OrderId,
		MachineId:     s.machine.Id,
		CurrentState:  initVal,
		Status:        dfsm.StatusIdle,
		ContextJson:   "",
		Version:       1,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	// Save context json
	bytes, _ := json.Marshal(orderCtx)
	rec.ContextJson = string(bytes)

	if err := s.registry.Store.CreateTransaction(ctx, rec); err != nil {
		return nil, err
	}

	for _, eff := range entryEffects {
		_ = s.actor.RunEffect(ctx, req.OrderId, eff, nil)
	}

	return s.GetOrder(ctx, req.OrderId)
}

func (s *OrderFulfillmentService) GetOrder(ctx context.Context, orderId string) (*OrderResponse, error) {
	st, err := s.actor.GetState(ctx, orderId)
	if err != nil {
		return nil, err
	}

	var userCtx OrderContext
	if st.Context != nil {
		if c, ok := st.Context.(OrderContext); ok {
			userCtx = c
		}
	}

	return &OrderResponse{
		OrderId:         st.TransactionId,
		MachineId:       s.machine.Id,
		CurrentState:    st.CurrentState.String(),
		Status:          st.Status,
		AvailableEvents: st.AvailableEvents,
		SagaStackDepth:  st.SagaStackDepth,
		Version:         st.Version,
		CreatedAt:       st.CreatedAt,
		UpdatedAt:       st.UpdatedAt,
		Context:         userCtx,
		MachineYaml:     rawMachineYaml,
	}, nil
}

func (s *OrderFulfillmentService) ExecuteTransition(ctx context.Context, orderId string, event string, payload any) (*OrderResponse, error) {
	_, err := s.actor.Transition(ctx, orderId, event, payload)
	if err != nil {
		// Even on error, return the latest state
		resp, getErr := s.GetOrder(ctx, orderId)
		if getErr == nil {
			return resp, err
		}
		return nil, err
	}
	return s.GetOrder(ctx, orderId)
}

func (s *OrderFulfillmentService) GetMachine() *MachineResponse {
	return &MachineResponse{
		MachineId:           s.machine.Id,
		InitialState:        s.machine.Initial,
		MaxEffectChainDepth: s.machine.MaxEffectChainDepth,
		TerminalStates:      s.actor.GetTerminalStates(),
		MachineYaml:         rawMachineYaml,
	}
}

func (s *OrderFulfillmentService) GetInFlight(ctx context.Context) (*InFlightResponse, error) {
	summary, err := s.actor.GetInFlightSummary(ctx)
	if err != nil {
		return nil, err
	}

	activeList, err := s.actor.ListActiveTransactions(ctx, 100)
	if err != nil {
		return nil, err
	}

	var orderSummaries []OrderSummaryPayload
	for _, a := range activeList {
		orderSummaries = append(orderSummaries, OrderSummaryPayload{
			OrderId:      a.TransactionId,
			CurrentState: a.CurrentState.String(),
			Status:       a.Status,
			UpdatedAt:    a.UpdatedAt,
		})
	}

	return &InFlightResponse{
		MachineId:        s.machine.Id,
		TotalInFlight:    summary.TotalInFlight,
		NonTerminalCount: summary.NonTerminalCount,
		TerminalStates:   summary.TerminalStates,
		Breakdown:        summary.Breakdown,
		InFlightOrders:   orderSummaries,
	}, nil
}

func (s *OrderFulfillmentService) GetTerminalStates() *TerminalStatesResponse {
	return &TerminalStatesResponse{
		MachineId:      s.machine.Id,
		TerminalStates: s.actor.GetTerminalStates(),
	}
}

func (s *OrderFulfillmentService) ForceCleanup(ctx context.Context, opts dfsm.ForceCleanUpOptions) (*dfsm.ForceCleanUpResult, error) {
	return s.actor.ForceCleanUp(ctx, opts)
}
