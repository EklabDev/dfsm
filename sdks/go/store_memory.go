package dfsm

import (
	"context"
	"sort"
	"sync"
)

type MemoryStateStore struct {
	mu           sync.RWMutex
	transactions map[string]*TransactionRecord
	sagaStacks   map[string][]SagaStepRecord
}

func NewMemoryStateStore() *MemoryStateStore {
	return &MemoryStateStore{
		transactions: make(map[string]*TransactionRecord),
		sagaStacks:   make(map[string][]SagaStepRecord),
	}
}

func (s *MemoryStateStore) CreateTransaction(ctx context.Context, record *TransactionRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cp := *record
	cp.SagaStack = append([]SagaStepRecord{}, record.SagaStack...)
	s.transactions[record.TransactionId] = &cp
	s.sagaStacks[record.TransactionId] = append([]SagaStepRecord{}, record.SagaStack...)
	return nil
}

func (s *MemoryStateStore) GetTransaction(ctx context.Context, txId string) (*TransactionRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rec, ok := s.transactions[txId]
	if !ok {
		return nil, nil
	}
	cp := *rec
	cp.SagaStack = append([]SagaStepRecord{}, s.sagaStacks[txId]...)
	return &cp, nil
}

func (s *MemoryStateStore) UpdateTransaction(ctx context.Context, record *TransactionRecord, expectedVersion int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.transactions[record.TransactionId]
	if !ok {
		return TransactionNotFoundError{TransactionId: record.TransactionId}
	}
	if existing.Version != expectedVersion {
		return StaleTransactionVersionError{
			TransactionId:   record.TransactionId,
			ExpectedVersion: expectedVersion,
			ActualVersion:   existing.Version,
		}
	}

	cp := *record
	s.transactions[record.TransactionId] = &cp
	return nil
}

func (s *MemoryStateStore) PushSagaStep(ctx context.Context, txId string, step SagaStepRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sagaStacks[txId] = append(s.sagaStacks[txId], step)
	return nil
}

func (s *MemoryStateStore) GetSagaStack(ctx context.Context, txId string) ([]SagaStepRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	stack := s.sagaStacks[txId]
	cp := make([]SagaStepRecord, len(stack))
	copy(cp, stack)
	return cp, nil
}

func (s *MemoryStateStore) PopSagaStep(ctx context.Context, txId string) (*SagaStepRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	stack := s.sagaStacks[txId]
	if len(stack) == 0 {
		return nil, nil
	}

	last := stack[len(stack)-1]
	s.sagaStacks[txId] = stack[:len(stack)-1]
	return &last, nil
}

func (s *MemoryStateStore) ListActiveTransactions(ctx context.Context, machineId string, limit int) ([]*TransactionRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var list []*TransactionRecord
	for _, rec := range s.transactions {
		if rec.Status == StatusIdle || rec.Status == StatusInFlight || rec.Status == StatusCompensating {
			if machineId == "" || rec.MachineId == machineId {
				cp := *rec
				list = append(list, &cp)
			}
		}
	}

	sort.Slice(list, func(i, j int) bool {
		return list[i].UpdatedAt > list[j].UpdatedAt
	})

	if limit > 0 && len(list) > limit {
		list = list[:limit]
	}
	return list, nil
}

func (s *MemoryStateStore) ListAllTransactions(ctx context.Context, machineId string, limit int) ([]*TransactionRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var list []*TransactionRecord
	for _, rec := range s.transactions {
		if machineId == "" || rec.MachineId == machineId {
			cp := *rec
			list = append(list, &cp)
		}
	}

	sort.Slice(list, func(i, j int) bool {
		return list[i].UpdatedAt > list[j].UpdatedAt
	})

	if limit > 0 && len(list) > limit {
		list = list[:limit]
	}
	return list, nil
}

func (s *MemoryStateStore) DeleteTransaction(ctx context.Context, txId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.transactions, txId)
	delete(s.sagaStacks, txId)
	return nil
}

func (s *MemoryStateStore) AcquireLease(ctx context.Context, txId string, owner string, durationMs int64, nowMs int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec, ok := s.transactions[txId]
	if !ok {
		return false, nil
	}

	if rec.LeaseExpiresAt == nil || *rec.LeaseExpiresAt < nowMs || (rec.LeaseOwner != nil && *rec.LeaseOwner == owner) {
		newExp := nowMs + durationMs
		rec.LeaseExpiresAt = &newExp
		rec.LeaseOwner = &owner
		rec.UpdatedAt = nowMs
		return true, nil
	}
	return false, nil
}

