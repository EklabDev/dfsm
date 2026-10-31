package dfsm

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPostgresStoreIntegration(t *testing.T) {
	connStr := "postgres://dfsm:dfsm_password@localhost:55432/dfsm_test?sslmode=disable"

	store, err := NewPostgresStateStore(connStr)
	if err != nil {
		t.Skipf("Postgres container not available: %v", err)
		return
	}
	defer store.Close()

	actorID := "pg-test-" + time.Now().Format("20060102150405.000")
	now := time.Now().UnixMilli()
	rec := &TransactionRecord{
		TransactionId: actorID,
		MachineId:     "pg-machine",
		CurrentState:  Leaf("active.idle"),
		Status:        StatusInFlight,
		ContextJson:   `{"orderId":"123","amount":42.0}`,
		Version:       1,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	err = store.CreateTransaction(context.Background(), rec)
	require.NoError(t, err)

	loaded, err := store.GetTransaction(context.Background(), actorID)
	require.NoError(t, err)
	require.NotNil(t, loaded)
	assert.Equal(t, actorID, loaded.TransactionId)
	assert.Equal(t, "active.idle", loaded.CurrentState.String())

	// Saga compensation push
	comp := SagaStepRecord{
		StepId:            actorID + "-step-1",
		StepName:          "reserveInventory",
		CompensateHandler: "cancelInventory",
		FromState:         Leaf("idle"),
		TargetState:       Leaf("reserved"),
		InputSnapshotJson: `{"sku":"A1"}`,
		Timestamp:         now,
	}
	err = store.PushSagaStep(context.Background(), actorID, comp)
	require.NoError(t, err)

	comps, err := store.GetSagaStack(context.Background(), actorID)
	require.NoError(t, err)
	assert.Len(t, comps, 1)
	assert.Equal(t, "reserveInventory", comps[0].StepName)

	// List active transactions
	inFlight, err := store.ListActiveTransactions(context.Background(), "pg-machine", 10)
	require.NoError(t, err)
	assert.NotEmpty(t, inFlight)

	// Cleanup
	err = store.DeleteTransaction(context.Background(), actorID)
	require.NoError(t, err)
}

func TestMongoStoreIntegration(t *testing.T) {
	uri := "mongodb://localhost:27018"

	store, err := NewMongoStateStore(uri, "dfsm_test_db")
	if err != nil {
		t.Skipf("MongoDB container not available: %v", err)
		return
	}
	defer store.Close(context.Background())

	actorID := "mongo-test-" + time.Now().Format("20060102150405.000")
	now := time.Now().UnixMilli()
	rec := &TransactionRecord{
		TransactionId: actorID,
		MachineId:     "mongo-machine",
		CurrentState:  Leaf("processing"),
		Status:        StatusInFlight,
		ContextJson:   `{"orderId":"999","amount":100.0}`,
		Version:       1,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	err = store.CreateTransaction(context.Background(), rec)
	require.NoError(t, err)

	loaded, err := store.GetTransaction(context.Background(), actorID)
	require.NoError(t, err)
	require.NotNil(t, loaded)
	assert.Equal(t, actorID, loaded.TransactionId)
	assert.Equal(t, "processing", loaded.CurrentState.String())

	// Saga compensation push
	comp := SagaStepRecord{
		StepId:            "step-1",
		StepName:          "chargeCard",
		CompensateHandler: "refundCard",
		FromState:         Leaf("idle"),
		TargetState:       Leaf("charged"),
		InputSnapshotJson: `{"chargeId":"ch_1"}`,
		Timestamp:         now,
	}
	err = store.PushSagaStep(context.Background(), actorID, comp)
	require.NoError(t, err)

	comps, err := store.GetSagaStack(context.Background(), actorID)
	require.NoError(t, err)
	assert.Len(t, comps, 1)
	assert.Equal(t, "chargeCard", comps[0].StepName)

	// Cleanup
	err = store.DeleteTransaction(context.Background(), actorID)
	require.NoError(t, err)
}
