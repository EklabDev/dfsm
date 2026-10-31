package dfsm

import (
	"context"
)

type StateStore interface {
	CreateTransaction(ctx context.Context, record *TransactionRecord) error
	GetTransaction(ctx context.Context, txId string) (*TransactionRecord, error)
	UpdateTransaction(ctx context.Context, record *TransactionRecord, expectedVersion int64) error
	PushSagaStep(ctx context.Context, txId string, step SagaStepRecord) error
	GetSagaStack(ctx context.Context, txId string) ([]SagaStepRecord, error)
	PopSagaStep(ctx context.Context, txId string) (*SagaStepRecord, error)
	ListActiveTransactions(ctx context.Context, machineId string, limit int) ([]*TransactionRecord, error)
	ListAllTransactions(ctx context.Context, machineId string, limit int) ([]*TransactionRecord, error)
	DeleteTransaction(ctx context.Context, txId string) error
	AcquireLease(ctx context.Context, txId string, owner string, durationMs int64, nowMs int64) (bool, error)
}

