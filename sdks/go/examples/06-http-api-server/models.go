package main

import (
	"github.com/eklabdev/dfsm/sdks/go"
)

type OrderContext struct {
	OrderId         string   `json:"orderId"`
	Customer        string   `json:"customer"`
	Amount          float64  `json:"amount"`
	AutoAuthorize   bool     `json:"autoAuthorize"`
	SimulateFailure bool     `json:"simulateFailure"`
	ItemsReserved   bool     `json:"itemsReserved"`
	PaymentCharged  bool     `json:"paymentCharged"`
	PackComplete    bool     `json:"packComplete"`
	CarrierBooked   bool     `json:"carrierBooked"`
	TraceLog        []string `json:"traceLog"`
}

type CreateOrderRequest struct {
	OrderId         string  `json:"orderId" validate:"required"`
	Customer        string  `json:"customer" validate:"required,email"`
	Amount          float64 `json:"amount" validate:"required,min=1"`
	AutoAuthorize   bool    `json:"autoAuthorize"`
	SimulateFailure bool    `json:"simulateFailure"`
}

type TransitionRequestPayload struct {
	Event   string `json:"event" validate:"required"`
	Payload any    `json:"payload,omitempty"`
}

type OrderResponse struct {
	OrderId         string                 `json:"orderId"`
	MachineId       string                 `json:"machineId"`
	CurrentState    string                 `json:"currentState"`
	Status          dfsm.TransactionStatus `json:"status"`
	AvailableEvents []string               `json:"availableEvents"`
	SagaStackDepth  int                    `json:"sagaStackDepth"`
	Version         int64                  `json:"version"`
	CreatedAt       int64                  `json:"createdAt"`
	UpdatedAt       int64                  `json:"updatedAt"`
	Context         OrderContext           `json:"context"`
	MachineYaml     string                 `json:"machineYaml"`
}

type InFlightResponse struct {
	MachineId        string                `json:"machineId"`
	TotalInFlight    int                   `json:"totalInFlight"`
	NonTerminalCount int                   `json:"nonTerminalCount"`
	TerminalStates   []string              `json:"terminalStates"`
	Breakdown        dfsm.StatusBreakdown  `json:"breakdown"`
	InFlightOrders   []OrderSummaryPayload `json:"inFlightOrders"`
}

type OrderSummaryPayload struct {
	OrderId      string                 `json:"orderId"`
	CurrentState string                 `json:"currentState"`
	Status       dfsm.TransactionStatus `json:"status"`
	UpdatedAt    int64                  `json:"updatedAt"`
}

type TerminalStatesResponse struct {
	MachineId      string   `json:"machineId"`
	TerminalStates []string `json:"terminalStates"`
}

type MachineResponse struct {
	MachineId           string   `json:"machineId"`
	InitialState        string   `json:"initialState"`
	MaxEffectChainDepth int      `json:"maxEffectChainDepth"`
	TerminalStates      []string `json:"terminalStates"`
	MachineYaml         string   `json:"machineYaml"`
}

type CleanupRequestPayload struct {
	TransactionIds []string                `json:"transactionIds,omitempty"`
	OlderThanMs    *int64                  `json:"olderThanMs,omitempty"`
	StuckOnly      bool                    `json:"stuckOnly,omitempty"`
	Action         dfsm.ForceCleanUpAction `json:"action,omitempty"`
	DryRun         bool                    `json:"dryRun,omitempty"`
}

