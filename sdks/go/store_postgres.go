package dfsm

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStateStore struct {
	pool *pgxpool.Pool
}

func NewPostgresStateStore(connString string) (*PostgresStateStore, error) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, connString)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to postgres: %w", err)
	}

	store := &PostgresStateStore{pool: pool}
	if err := store.initSchema(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *PostgresStateStore) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

func (s *PostgresStateStore) initSchema(ctx context.Context) error {
	schema := `
	CREATE TABLE IF NOT EXISTS dfsm_transactions (
		transaction_id TEXT PRIMARY KEY,
		machine_id TEXT NOT NULL,
		current_state JSONB NOT NULL,
		status TEXT NOT NULL,
		context_json JSONB NOT NULL,
		version BIGINT NOT NULL,
		created_at BIGINT NOT NULL,
		updated_at BIGINT NOT NULL,
		lease_expires_at BIGINT,
		lease_owner TEXT
	);

	CREATE TABLE IF NOT EXISTS dfsm_saga_steps (
		step_id TEXT PRIMARY KEY,
		transaction_id TEXT NOT NULL,
		step_name TEXT NOT NULL,
		compensate_handler TEXT NOT NULL,
		from_state JSONB NOT NULL,
		target_state JSONB NOT NULL,
		input_snapshot_json TEXT,
		context_before_json TEXT,
		timestamp BIGINT NOT NULL,
		step_order BIGINT NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_dfsm_go_tx_status ON dfsm_transactions (status);
	CREATE INDEX IF NOT EXISTS idx_dfsm_go_saga_tx_order ON dfsm_saga_steps (transaction_id, step_order);
	`
	_, err := s.pool.Exec(ctx, schema)
	return err
}

func (s *PostgresStateStore) CreateTransaction(ctx context.Context, record *TransactionRecord) error {
	stateBytes, _ := json.Marshal(record.CurrentState)
	ctxJson := record.ContextJson
	if ctxJson == "" {
		ctxJson = "{}"
	}

	query := `
		INSERT INTO dfsm_transactions 
		(transaction_id, machine_id, current_state, status, context_json, version, created_at, updated_at, lease_expires_at, lease_owner)
		VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8, $9, $10);
	`
	_, err := s.pool.Exec(ctx, query,
		record.TransactionId,
		record.MachineId,
		string(stateBytes),
		string(record.Status),
		ctxJson,
		record.Version,
		record.CreatedAt,
		record.UpdatedAt,
		record.LeaseExpiresAt,
		record.LeaseOwner,
	)
	return err
}

func (s *PostgresStateStore) GetTransaction(ctx context.Context, txId string) (*TransactionRecord, error) {
	query := `
		SELECT transaction_id, machine_id, current_state::text, status, context_json::text, version, created_at, updated_at, lease_expires_at, lease_owner 
		FROM dfsm_transactions WHERE transaction_id = $1;
	`
	var (
		rec        TransactionRecord
		stateStr   string
		statusStr  string
		contextStr string
	)
	row := s.pool.QueryRow(ctx, query, txId)
	err := row.Scan(
		&rec.TransactionId,
		&rec.MachineId,
		&stateStr,
		&statusStr,
		&contextStr,
		&rec.Version,
		&rec.CreatedAt,
		&rec.UpdatedAt,
		&rec.LeaseExpiresAt,
		&rec.LeaseOwner,
	)
	if err != nil {
		return nil, nil
	}

	_ = json.Unmarshal([]byte(stateStr), &rec.CurrentState)
	rec.Status = TransactionStatus(statusStr)
	rec.ContextJson = contextStr

	stack, err := s.GetSagaStack(ctx, txId)
	if err != nil {
		return nil, err
	}
	rec.SagaStack = stack
	return &rec, nil
}

func (s *PostgresStateStore) UpdateTransaction(ctx context.Context, record *TransactionRecord, expectedVersion int64) error {
	stateBytes, _ := json.Marshal(record.CurrentState)
	ctxJson := record.ContextJson
	if ctxJson == "" {
		ctxJson = "{}"
	}

	query := `
		UPDATE dfsm_transactions 
		SET current_state = $1::jsonb,
		    status = $2,
		    context_json = $3::jsonb,
		    version = $4,
		    updated_at = $5,
		    lease_expires_at = $6,
		    lease_owner = $7
		WHERE transaction_id = $8 AND version = $9;
	`
	ct, err := s.pool.Exec(ctx, query,
		string(stateBytes),
		string(record.Status),
		ctxJson,
		record.Version,
		record.UpdatedAt,
		record.LeaseExpiresAt,
		record.LeaseOwner,
		record.TransactionId,
		expectedVersion,
	)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		var actualVersion int64
		checkErr := s.pool.QueryRow(ctx, "SELECT version FROM dfsm_transactions WHERE transaction_id = $1", record.TransactionId).Scan(&actualVersion)
		if checkErr != nil {
			return TransactionNotFoundError{TransactionId: record.TransactionId}
		}
		return StaleTransactionVersionError{
			TransactionId:   record.TransactionId,
			ExpectedVersion: expectedVersion,
			ActualVersion:   actualVersion,
		}
	}
	return nil
}

func (s *PostgresStateStore) PushSagaStep(ctx context.Context, txId string, step SagaStepRecord) error {
	var nextOrder int64
	_ = s.pool.QueryRow(ctx, "SELECT COALESCE(MAX(step_order), 0) + 1 FROM dfsm_saga_steps WHERE transaction_id = $1", txId).Scan(&nextOrder)

	fromBytes, _ := json.Marshal(step.FromState)
	toBytes, _ := json.Marshal(step.TargetState)

	query := `
		INSERT INTO dfsm_saga_steps 
		(step_id, transaction_id, step_name, compensate_handler, from_state, target_state, input_snapshot_json, context_before_json, timestamp, step_order)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10);
	`
	_, err := s.pool.Exec(ctx, query,
		step.StepId,
		txId,
		step.StepName,
		step.CompensateHandler,
		string(fromBytes),
		string(toBytes),
		step.InputSnapshotJson,
		step.ContextBeforeJson,
		step.Timestamp,
		nextOrder,
	)
	return err
}

func (s *PostgresStateStore) GetSagaStack(ctx context.Context, txId string) ([]SagaStepRecord, error) {
	query := `
		SELECT step_id, step_name, compensate_handler, from_state::text, target_state::text, input_snapshot_json, context_before_json, timestamp 
		FROM dfsm_saga_steps WHERE transaction_id = $1 ORDER BY step_order ASC;
	`
	rows, err := s.pool.Query(ctx, query, txId)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []SagaStepRecord
	for rows.Next() {
		var (
			step     SagaStepRecord
			fromStr  string
			toStr    string
			inSnap   *string
			ctxSnap  *string
		)
		if err := rows.Scan(
			&step.StepId,
			&step.StepName,
			&step.CompensateHandler,
			&fromStr,
			&toStr,
			&inSnap,
			&ctxSnap,
			&step.Timestamp,
		); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(fromStr), &step.FromState)
		_ = json.Unmarshal([]byte(toStr), &step.TargetState)
		if inSnap != nil {
			step.InputSnapshotJson = *inSnap
		}
		if ctxSnap != nil {
			step.ContextBeforeJson = *ctxSnap
		}
		list = append(list, step)
	}
	return list, nil
}

func (s *PostgresStateStore) PopSagaStep(ctx context.Context, txId string) (*SagaStepRecord, error) {
	query := `
		SELECT step_id, step_name, compensate_handler, from_state::text, target_state::text, input_snapshot_json, context_before_json, timestamp 
		FROM dfsm_saga_steps WHERE transaction_id = $1 ORDER BY step_order DESC LIMIT 1;
	`
	var (
		step    SagaStepRecord
		fromStr string
		toStr   string
		inSnap  *string
		ctxSnap *string
	)
	row := s.pool.QueryRow(ctx, query, txId)
	err := row.Scan(
		&step.StepId,
		&step.StepName,
		&step.CompensateHandler,
		&fromStr,
		&toStr,
		&inSnap,
		&ctxSnap,
		&step.Timestamp,
	)
	if err != nil {
		return nil, nil
	}

	_ = json.Unmarshal([]byte(fromStr), &step.FromState)
	_ = json.Unmarshal([]byte(toStr), &step.TargetState)
	if inSnap != nil {
		step.InputSnapshotJson = *inSnap
	}
	if ctxSnap != nil {
		step.ContextBeforeJson = *ctxSnap
	}

	_, _ = s.pool.Exec(ctx, "DELETE FROM dfsm_saga_steps WHERE step_id = $1", step.StepId)
	return &step, nil
}

func (s *PostgresStateStore) ListActiveTransactions(ctx context.Context, machineId string, limit int) ([]*TransactionRecord, error) {
	query := `
		SELECT transaction_id, machine_id, current_state::text, status, context_json::text, version, created_at, updated_at, lease_expires_at, lease_owner 
		FROM dfsm_transactions 
		WHERE status IN ('IDLE', 'IN_FLIGHT', 'COMPENSATING')
	`
	var rows pgx.Rows
	var err error
	if machineId != "" {
		query += " AND machine_id = $1 ORDER BY updated_at DESC LIMIT $2;"
		rows, err = s.pool.Query(ctx, query, machineId, limit)
	} else {
		query += " ORDER BY updated_at DESC LIMIT $1;"
		rows, err = s.pool.Query(ctx, query, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*TransactionRecord
	for rows.Next() {
		var (
			rec        TransactionRecord
			stateStr   string
			statusStr  string
			contextStr string
		)
		_ = rows.Scan(
			&rec.TransactionId,
			&rec.MachineId,
			&stateStr,
			&statusStr,
			&contextStr,
			&rec.Version,
			&rec.CreatedAt,
			&rec.UpdatedAt,
			&rec.LeaseExpiresAt,
			&rec.LeaseOwner,
		)
		_ = json.Unmarshal([]byte(stateStr), &rec.CurrentState)
		rec.Status = TransactionStatus(statusStr)
		rec.ContextJson = contextStr
		list = append(list, &rec)
	}
	return list, nil
}

func (s *PostgresStateStore) ListAllTransactions(ctx context.Context, machineId string, limit int) ([]*TransactionRecord, error) {
	query := "SELECT transaction_id, machine_id, current_state::text, status, context_json::text, version, created_at, updated_at, lease_expires_at, lease_owner FROM dfsm_transactions"
	var rows pgx.Rows
	var err error
	if machineId != "" {
		query += " WHERE machine_id = $1 ORDER BY updated_at DESC LIMIT $2;"
		rows, err = s.pool.Query(ctx, query, machineId, limit)
	} else {
		query += " ORDER BY updated_at DESC LIMIT $1;"
		rows, err = s.pool.Query(ctx, query, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*TransactionRecord
	for rows.Next() {
		var (
			rec        TransactionRecord
			stateStr   string
			statusStr  string
			contextStr string
		)
		_ = rows.Scan(
			&rec.TransactionId,
			&rec.MachineId,
			&stateStr,
			&statusStr,
			&contextStr,
			&rec.Version,
			&rec.CreatedAt,
			&rec.UpdatedAt,
			&rec.LeaseExpiresAt,
			&rec.LeaseOwner,
		)
		_ = json.Unmarshal([]byte(stateStr), &rec.CurrentState)
		rec.Status = TransactionStatus(statusStr)
		rec.ContextJson = contextStr
		list = append(list, &rec)
	}
	return list, nil
}

func (s *PostgresStateStore) DeleteTransaction(ctx context.Context, txId string) error {
	if _, err := s.pool.Exec(ctx, "DELETE FROM dfsm_saga_steps WHERE transaction_id = $1", txId); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, "DELETE FROM dfsm_transactions WHERE transaction_id = $1", txId)
	return err
}

func (s *PostgresStateStore) AcquireLease(ctx context.Context, txId string, owner string, durationMs int64, nowMs int64) (bool, error) {
	query := `
		UPDATE dfsm_transactions 
		SET lease_owner = $1,
		    lease_expires_at = $2,
		    updated_at = $3
		WHERE transaction_id = $4 
		  AND (lease_expires_at IS NULL OR lease_expires_at < $3 OR lease_owner = $1);
	`
	ct, err := s.pool.Exec(ctx, query, owner, nowMs+durationMs, nowMs, txId)
	if err != nil {
		return false, err
	}
	return ct.RowsAffected() > 0, nil
}
