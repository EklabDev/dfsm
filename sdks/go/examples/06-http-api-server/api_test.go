package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHttpApiServerE2E(t *testing.T) {
	svc, err := NewOrderFulfillmentService(nil)
	require.NoError(t, err)

	handler := setupRoutes(svc)

	// 1. GET /api/machine
	req := httptest.NewRequest(http.MethodGet, "/api/machine", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var machineResp MachineResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &machineResp))
	assert.Equal(t, "express-order-fulfillment", machineResp.MachineId)
	assert.Equal(t, "created", machineResp.InitialState)
	assert.Contains(t, machineResp.MachineYaml, "id: express-order-fulfillment")

	// 2. POST /api/orders (create new order with autoAuthorize=true)
	createBody := CreateOrderRequest{
		OrderId:         "test-order-e2e-1",
		Customer:        "customer@example.com",
		Amount:          150.0,
		AutoAuthorize:   true,
		SimulateFailure: false,
	}
	createJson, _ := json.Marshal(createBody)
	req = httptest.NewRequest(http.MethodPost, "/api/orders", bytes.NewReader(createJson))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusCreated, w.Code)

	var createdOrder OrderResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &createdOrder))
	assert.Equal(t, "test-order-e2e-1", createdOrder.OrderId)
	assert.Equal(t, "created", createdOrder.CurrentState)

	// 3. POST /api/orders/{id}/transitions -> SUBMIT_ORDER
	// Since autoAuthorize=true, evaluatePostReserveRouting triggers autoAuthorizeWalletEffect -> AUTHORIZE_PAYMENT -> fulfilling parallel state!
	transBody := TransitionRequestPayload{Event: "SUBMIT_ORDER"}
	transJson, _ := json.Marshal(transBody)
	req = httptest.NewRequest(http.MethodPost, "/api/orders/test-order-e2e-1/transitions", bytes.NewReader(transJson))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var afterSubmit OrderResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &afterSubmit))
	assert.Contains(t, afterSubmit.CurrentState, "fulfilling")
	assert.True(t, afterSubmit.Context.ItemsReserved)
	assert.True(t, afterSubmit.Context.PaymentCharged)

	// 4. PACK_COMPLETE
	packJson, _ := json.Marshal(TransitionRequestPayload{Event: "PACK_COMPLETE"})
	req = httptest.NewRequest(http.MethodPost, "/api/orders/test-order-e2e-1/transitions", bytes.NewReader(packJson))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	// 5. BOOK_CARRIER -> onDone triggers delivered
	carrierJson, _ := json.Marshal(TransitionRequestPayload{Event: "BOOK_CARRIER"})
	req = httptest.NewRequest(http.MethodPost, "/api/orders/test-order-e2e-1/transitions", bytes.NewReader(carrierJson))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var afterDelivery OrderResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &afterDelivery))
	assert.Equal(t, "delivered", afterDelivery.CurrentState)

	// 6. Test Failure & Saga Rollback
	failBody := CreateOrderRequest{
		OrderId:         "test-order-fail-1",
		Customer:        "fail@example.com",
		Amount:          99.0,
		AutoAuthorize:   false,
		SimulateFailure: true,
	}
	failJson, _ := json.Marshal(failBody)
	req = httptest.NewRequest(http.MethodPost, "/api/orders", bytes.NewReader(failJson))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusCreated, w.Code)

	// Reserve stock
	req = httptest.NewRequest(http.MethodPost, "/api/orders/test-order-fail-1/transitions", bytes.NewReader(transJson))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	// Now attempt payment with simulateFailure -> fails and triggers Saga rollback!
	payJson, _ := json.Marshal(TransitionRequestPayload{Event: "AUTHORIZE_PAYMENT"})
	req = httptest.NewRequest(http.MethodPost, "/api/orders/test-order-fail-1/transitions", bytes.NewReader(payJson))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var failOrder OrderResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &failOrder))
	assert.Equal(t, "error", failOrder.CurrentState)
	assert.False(t, failOrder.Context.PaymentCharged)
	assert.False(t, failOrder.Context.ItemsReserved) // Released by Saga compensation!

	// 7. RESET_ORDER
	resetJson, _ := json.Marshal(TransitionRequestPayload{Event: "RESET_ORDER"})
	req = httptest.NewRequest(http.MethodPost, "/api/orders/test-order-fail-1/transitions", bytes.NewReader(resetJson))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var resetOrder OrderResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resetOrder))
	assert.Equal(t, "created", resetOrder.CurrentState)

	// 8. GET /api/terminals
	req = httptest.NewRequest(http.MethodGet, "/api/terminals", nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	var termResp TerminalStatesResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &termResp))
	assert.Contains(t, termResp.TerminalStates, "delivered")
	assert.Contains(t, termResp.TerminalStates, "cancelled")
}
