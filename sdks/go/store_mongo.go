package dfsm

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

type MongoStateStore struct {
	coll *mongo.Collection
}

func NewMongoStateStore(connString string, dbName string) (*MongoStateStore, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(connString))
	if err != nil {
		return nil, fmt.Errorf("failed to connect to mongodb: %w", err)
	}

	coll := client.Database(dbName).Collection("dfsm_transactions")
	indexModel := mongo.IndexModel{
		Keys: bson.D{{Key: "status", Value: 1}, {Key: "machine_id", Value: 1}},
	}
	_, _ = coll.Indexes().CreateOne(context.Background(), indexModel)

	return &MongoStateStore{coll: coll}, nil
}

func (s *MongoStateStore) Close(ctx context.Context) error {
	if s.coll != nil {
		return s.coll.Database().Client().Disconnect(ctx)
	}
	return nil
}

type mongoTxDoc struct {
	ID             string            `bson:"_id"`
	MachineId      string            `bson:"machine_id"`
	CurrentState   string            `bson:"current_state"`
	Status         string            `bson:"status"`
	ContextJson    string            `bson:"context_json"`
	Version        int64             `bson:"version"`
	CreatedAt      int64             `bson:"created_at"`
	UpdatedAt      int64             `bson:"updated_at"`
	LeaseExpiresAt *int64            `bson:"lease_expires_at,omitempty"`
	LeaseOwner     *string           `bson:"lease_owner,omitempty"`
	SagaStack      []mongoSagaDoc    `bson:"saga_stack,omitempty"`
}

type mongoSagaDoc struct {
	StepId            string `bson:"step_id"`
	StepName          string `bson:"step_name"`
	CompensateHandler string `bson:"compensate_handler"`
	FromState         string `bson:"from_state"`
	TargetState       string `bson:"target_state"`
	InputSnapshotJson string `bson:"input_snapshot_json,omitempty"`
	ContextBeforeJson string `bson:"context_before_json,omitempty"`
	Timestamp         int64  `bson:"timestamp"`
}

func (s *MongoStateStore) CreateTransaction(ctx context.Context, record *TransactionRecord) error {
	stateBytes, _ := json.Marshal(record.CurrentState)
	doc := mongoTxDoc{
		ID:             record.TransactionId,
		MachineId:      record.MachineId,
		CurrentState:   string(stateBytes),
		Status:         string(record.Status),
		ContextJson:    record.ContextJson,
		Version:        record.Version,
		CreatedAt:      record.CreatedAt,
		UpdatedAt:      record.UpdatedAt,
		LeaseExpiresAt: record.LeaseExpiresAt,
		LeaseOwner:     record.LeaseOwner,
		SagaStack:      []mongoSagaDoc{},
	}
	_, err := s.coll.InsertOne(ctx, doc)
	return err
}

func (s *MongoStateStore) GetTransaction(ctx context.Context, txId string) (*TransactionRecord, error) {
	var doc mongoTxDoc
	err := s.coll.FindOne(ctx, bson.M{"_id": txId}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}

	var sv StateValue
	_ = json.Unmarshal([]byte(doc.CurrentState), &sv)

	var sagaStack []SagaStepRecord
	for _, sd := range doc.SagaStack {
		var fState, tState StateValue
		_ = json.Unmarshal([]byte(sd.FromState), &fState)
		_ = json.Unmarshal([]byte(sd.TargetState), &tState)
		sagaStack = append(sagaStack, SagaStepRecord{
			StepId:            sd.StepId,
			StepName:          sd.StepName,
			CompensateHandler: sd.CompensateHandler,
			FromState:         fState,
			TargetState:       tState,
			InputSnapshotJson: sd.InputSnapshotJson,
			ContextBeforeJson: sd.ContextBeforeJson,
			Timestamp:         sd.Timestamp,
		})
	}

	return &TransactionRecord{
		TransactionId:  doc.ID,
		MachineId:      doc.MachineId,
		CurrentState:   sv,
		Status:         TransactionStatus(doc.Status),
		ContextJson:    doc.ContextJson,
		Version:        doc.Version,
		CreatedAt:      doc.CreatedAt,
		UpdatedAt:      doc.UpdatedAt,
		LeaseExpiresAt: doc.LeaseExpiresAt,
		LeaseOwner:     doc.LeaseOwner,
		SagaStack:      sagaStack,
	}, nil
}

func (s *MongoStateStore) UpdateTransaction(ctx context.Context, record *TransactionRecord, expectedVersion int64) error {
	stateBytes, _ := json.Marshal(record.CurrentState)
	filter := bson.M{
		"_id":     record.TransactionId,
		"version": expectedVersion,
	}
	update := bson.M{
		"$set": bson.M{
			"current_state":    string(stateBytes),
			"status":           string(record.Status),
			"context_json":     record.ContextJson,
			"version":          record.Version,
			"updated_at":       record.UpdatedAt,
			"lease_expires_at": record.LeaseExpiresAt,
			"lease_owner":      record.LeaseOwner,
		},
	}

	res, err := s.coll.UpdateOne(ctx, filter, update)
	if err != nil {
		return err
	}
	if res.MatchedCount == 0 {
		var existing mongoTxDoc
		findErr := s.coll.FindOne(ctx, bson.M{"_id": record.TransactionId}).Decode(&existing)
		if findErr != nil {
			return TransactionNotFoundError{TransactionId: record.TransactionId}
		}
		return StaleTransactionVersionError{
			TransactionId:   record.TransactionId,
			ExpectedVersion: expectedVersion,
			ActualVersion:   existing.Version,
		}
	}
	return nil
}

func (s *MongoStateStore) PushSagaStep(ctx context.Context, txId string, step SagaStepRecord) error {
	fromBytes, _ := json.Marshal(step.FromState)
	toBytes, _ := json.Marshal(step.TargetState)
	sDoc := mongoSagaDoc{
		StepId:            step.StepId,
		StepName:          step.StepName,
		CompensateHandler: step.CompensateHandler,
		FromState:         string(fromBytes),
		TargetState:       string(toBytes),
		InputSnapshotJson: step.InputSnapshotJson,
		ContextBeforeJson: step.ContextBeforeJson,
		Timestamp:         step.Timestamp,
	}

	filter := bson.M{"_id": txId}
	update := bson.M{"$push": bson.M{"saga_stack": sDoc}}
	_, err := s.coll.UpdateOne(ctx, filter, update)
	return err
}

func (s *MongoStateStore) GetSagaStack(ctx context.Context, txId string) ([]SagaStepRecord, error) {
	rec, err := s.GetTransaction(ctx, txId)
	if err != nil || rec == nil {
		return nil, err
	}
	return rec.SagaStack, nil
}

func (s *MongoStateStore) PopSagaStep(ctx context.Context, txId string) (*SagaStepRecord, error) {
	rec, err := s.GetTransaction(ctx, txId)
	if err != nil || rec == nil || len(rec.SagaStack) == 0 {
		return nil, err
	}

	last := rec.SagaStack[len(rec.SagaStack)-1]
	filter := bson.M{"_id": txId}
	update := bson.M{"$pop": bson.M{"saga_stack": 1}}
	_, err = s.coll.UpdateOne(ctx, filter, update)
	if err != nil {
		return nil, err
	}
	return &last, nil
}

func (s *MongoStateStore) ListActiveTransactions(ctx context.Context, machineId string, limit int) ([]*TransactionRecord, error) {
	filter := bson.M{"status": bson.M{"$in": []string{"IDLE", "IN_FLIGHT", "COMPENSATING"}}}
	if machineId != "" {
		filter["machine_id"] = machineId
	}

	opts := options.Find().SetSort(bson.M{"updated_at": -1}).SetLimit(int64(limit))
	cur, err := s.coll.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)

	var list []*TransactionRecord
	for cur.Next(ctx) {
		var doc mongoTxDoc
		if err := cur.Decode(&doc); err == nil {
			var sv StateValue
			_ = json.Unmarshal([]byte(doc.CurrentState), &sv)
			list = append(list, &TransactionRecord{
				TransactionId:  doc.ID,
				MachineId:      doc.MachineId,
				CurrentState:   sv,
				Status:         TransactionStatus(doc.Status),
				ContextJson:    doc.ContextJson,
				Version:        doc.Version,
				CreatedAt:      doc.CreatedAt,
				UpdatedAt:      doc.UpdatedAt,
				LeaseExpiresAt: doc.LeaseExpiresAt,
				LeaseOwner:     doc.LeaseOwner,
			})
		}
	}
	return list, nil
}

func (s *MongoStateStore) ListAllTransactions(ctx context.Context, machineId string, limit int) ([]*TransactionRecord, error) {
	filter := bson.M{}
	if machineId != "" {
		filter["machine_id"] = machineId
	}

	opts := options.Find().SetSort(bson.M{"updated_at": -1}).SetLimit(int64(limit))
	cur, err := s.coll.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)

	var list []*TransactionRecord
	for cur.Next(ctx) {
		var doc mongoTxDoc
		if err := cur.Decode(&doc); err == nil {
			var sv StateValue
			_ = json.Unmarshal([]byte(doc.CurrentState), &sv)
			list = append(list, &TransactionRecord{
				TransactionId:  doc.ID,
				MachineId:      doc.MachineId,
				CurrentState:   sv,
				Status:         TransactionStatus(doc.Status),
				ContextJson:    doc.ContextJson,
				Version:        doc.Version,
				CreatedAt:      doc.CreatedAt,
				UpdatedAt:      doc.UpdatedAt,
				LeaseExpiresAt: doc.LeaseExpiresAt,
				LeaseOwner:     doc.LeaseOwner,
			})
		}
	}
	return list, nil
}

func (s *MongoStateStore) DeleteTransaction(ctx context.Context, txId string) error {
	_, err := s.coll.DeleteOne(ctx, bson.M{"_id": txId})
	return err
}

func (s *MongoStateStore) AcquireLease(ctx context.Context, txId string, owner string, durationMs int64, nowMs int64) (bool, error) {
	filter := bson.M{
		"_id": txId,
		"$or": []bson.M{
			{"lease_expires_at": nil},
			{"lease_expires_at": bson.M{"$lt": nowMs}},
			{"lease_owner": owner},
		},
	}
	update := bson.M{
		"$set": bson.M{
			"lease_owner":      owner,
			"lease_expires_at": nowMs + durationMs,
			"updated_at":       nowMs,
		},
	}
	res, err := s.coll.UpdateOne(ctx, filter, update)
	if err != nil {
		return false, err
	}
	return res.MatchedCount > 0, nil
}
