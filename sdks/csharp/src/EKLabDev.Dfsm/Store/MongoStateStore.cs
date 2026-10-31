using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MongoDB.Bson;
using MongoDB.Driver;

namespace EKLabDev.Dfsm.Store;

public class MongoStateStore : IStateStore
{
    private readonly IMongoCollection<BsonDocument> _transactions;

    public MongoStateStore(string connectionString, string databaseName = "dfsm_test")
    {
        var client = new MongoClient(connectionString);
        var db = client.GetDatabase(databaseName);
        _transactions = db.GetCollection<BsonDocument>("dfsm_transactions");
        InitializeIndexes();
    }

    private void InitializeIndexes()
    {
        var indexKeys = Builders<BsonDocument>.IndexKeys.Ascending("status").Ascending("machine_id");
        _transactions.Indexes.CreateOne(new CreateIndexModel<BsonDocument>(indexKeys));
    }

    public async Task CreateTransactionAsync(TransactionRecord record, CancellationToken ct = default)
    {
        var doc = new BsonDocument
        {
            { "_id", record.TransactionId },
            { "machine_id", record.MachineId },
            { "current_state", JsonSerializer.Serialize(record.CurrentState) },
            { "status", record.Status.ToString() },
            { "context_json", record.ContextJson ?? "{}" },
            { "version", record.Version },
            { "created_at", record.CreatedAt },
            { "updated_at", record.UpdatedAt },
            { "lease_expires_at", record.LeaseExpiresAt.HasValue ? (BsonValue)record.LeaseExpiresAt.Value : BsonNull.Value },
            { "lease_owner", record.LeaseOwner != null ? (BsonValue)record.LeaseOwner : BsonNull.Value },
            { "saga_stack", new BsonArray() }
        };
        await _transactions.InsertOneAsync(doc, cancellationToken: ct);
    }

    public async Task<TransactionRecord?> GetTransactionAsync(string transactionId, CancellationToken ct = default)
    {
        var filter = Builders<BsonDocument>.Filter.Eq("_id", transactionId);
        var doc = await _transactions.Find(filter).FirstOrDefaultAsync(ct);
        if (doc == null) return null;

        return DocumentToRecord(doc);
    }

    private TransactionRecord DocumentToRecord(BsonDocument doc)
    {
        var record = new TransactionRecord
        {
            TransactionId = doc["_id"].AsString,
            MachineId = doc["machine_id"].AsString,
            CurrentState = StateValue.FromJsonElement(JsonDocument.Parse(doc["current_state"].AsString).RootElement),
            Status = Enum.Parse<TransactionStatus>(doc["status"].AsString),
            ContextJson = doc["context_json"].AsString,
            Version = doc["version"].AsInt64,
            CreatedAt = doc["created_at"].AsInt64,
            UpdatedAt = doc["updated_at"].AsInt64,
            LeaseExpiresAt = doc["lease_expires_at"].IsBsonNull ? null : doc["lease_expires_at"].AsInt64,
            LeaseOwner = doc["lease_owner"].IsBsonNull ? null : doc["lease_owner"].AsString
        };

        if (doc.Contains("saga_stack") && doc["saga_stack"].IsBsonArray)
        {
            foreach (var item in doc["saga_stack"].AsBsonArray)
            {
                var sDoc = item.AsBsonDocument;
                record.SagaStack.Add(new SagaStepRecord(
                    sDoc["step_id"].AsString,
                    sDoc["step_name"].AsString,
                    sDoc["compensate_handler"].AsString,
                    StateValue.FromJsonElement(JsonDocument.Parse(sDoc["from_state"].AsString).RootElement),
                    StateValue.FromJsonElement(JsonDocument.Parse(sDoc["target_state"].AsString).RootElement),
                    sDoc["input_snapshot_json"].IsBsonNull ? null : sDoc["input_snapshot_json"].AsString,
                    sDoc["context_before_json"].IsBsonNull ? null : sDoc["context_before_json"].AsString,
                    sDoc["timestamp"].AsInt64
                ));
            }
        }

        return record;
    }

    public async Task UpdateTransactionAsync(TransactionRecord record, long expectedVersion, CancellationToken ct = default)
    {
        var filter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", record.TransactionId),
            Builders<BsonDocument>.Filter.Eq("version", expectedVersion)
        );

        var update = Builders<BsonDocument>.Update
            .Set("current_state", JsonSerializer.Serialize(record.CurrentState))
            .Set("status", record.Status.ToString())
            .Set("context_json", record.ContextJson ?? "{}")
            .Set("version", record.Version)
            .Set("updated_at", record.UpdatedAt)
            .Set("lease_expires_at", record.LeaseExpiresAt.HasValue ? (BsonValue)record.LeaseExpiresAt.Value : BsonNull.Value)
            .Set("lease_owner", record.LeaseOwner != null ? (BsonValue)record.LeaseOwner : BsonNull.Value);

        var result = await _transactions.UpdateOneAsync(filter, update, cancellationToken: ct);
        if (result.MatchedCount == 0)
        {
            var checkFilter = Builders<BsonDocument>.Filter.Eq("_id", record.TransactionId);
            var existing = await _transactions.Find(checkFilter).FirstOrDefaultAsync(ct);
            if (existing == null)
            {
                throw new TransactionNotFoundException(record.TransactionId);
            }
            long actualVersion = existing["version"].AsInt64;
            throw new StaleTransactionVersionException(record.TransactionId, expectedVersion, actualVersion);
        }
    }

    public async Task PushSagaStepAsync(string transactionId, SagaStepRecord step, CancellationToken ct = default)
    {
        var stepDoc = new BsonDocument
        {
            { "step_id", step.StepId },
            { "step_name", step.StepName },
            { "compensate_handler", step.CompensateHandler },
            { "from_state", JsonSerializer.Serialize(step.FromState) },
            { "target_state", JsonSerializer.Serialize(step.TargetState) },
            { "input_snapshot_json", step.InputSnapshotJson != null ? (BsonValue)step.InputSnapshotJson : BsonNull.Value },
            { "context_before_json", step.ContextBeforeJson != null ? (BsonValue)step.ContextBeforeJson : BsonNull.Value },
            { "timestamp", step.Timestamp }
        };

        var filter = Builders<BsonDocument>.Filter.Eq("_id", transactionId);
        var update = Builders<BsonDocument>.Update.Push("saga_stack", stepDoc);
        await _transactions.UpdateOneAsync(filter, update, cancellationToken: ct);
    }

    public async Task<List<SagaStepRecord>> GetSagaStackAsync(string transactionId, CancellationToken ct = default)
    {
        var record = await GetTransactionAsync(transactionId, ct);
        return record?.SagaStack ?? new List<SagaStepRecord>();
    }

    public async Task<SagaStepRecord?> PopSagaStepAsync(string transactionId, CancellationToken ct = default)
    {
        var filter = Builders<BsonDocument>.Filter.Eq("_id", transactionId);
        var doc = await _transactions.Find(filter).FirstOrDefaultAsync(ct);
        if (doc == null || !doc.Contains("saga_stack") || !doc["saga_stack"].IsBsonArray || doc["saga_stack"].AsBsonArray.Count == 0)
        {
            return null;
        }

        var array = doc["saga_stack"].AsBsonArray;
        var lastElement = array[array.Count - 1].AsBsonDocument;
        var step = new SagaStepRecord(
            lastElement["step_id"].AsString,
            lastElement["step_name"].AsString,
            lastElement["compensate_handler"].AsString,
            StateValue.FromJsonElement(JsonDocument.Parse(lastElement["from_state"].AsString).RootElement),
            StateValue.FromJsonElement(JsonDocument.Parse(lastElement["target_state"].AsString).RootElement),
            lastElement["input_snapshot_json"].IsBsonNull ? null : lastElement["input_snapshot_json"].AsString,
            lastElement["context_before_json"].IsBsonNull ? null : lastElement["context_before_json"].AsString,
            lastElement["timestamp"].AsInt64
        );

        // Pop last element
        var popUpdate = Builders<BsonDocument>.Update.PopLast("saga_stack");
        await _transactions.UpdateOneAsync(filter, popUpdate, cancellationToken: ct);

        return step;
    }

    public async Task<List<TransactionRecord>> ListActiveTransactionsAsync(string? machineId = null, int limit = 100, CancellationToken ct = default)
    {
        var statusFilter = Builders<BsonDocument>.Filter.In("status", new[] { "IDLE", "IN_FLIGHT", "COMPENSATING" });
        var filter = string.IsNullOrEmpty(machineId)
            ? statusFilter
            : Builders<BsonDocument>.Filter.And(statusFilter, Builders<BsonDocument>.Filter.Eq("machine_id", machineId));

        var docs = await _transactions.Find(filter)
            .Sort(Builders<BsonDocument>.Sort.Descending("updated_at"))
            .Limit(limit)
            .ToListAsync(ct);

        return docs.Select(DocumentToRecord).ToList();
    }

    public async Task<List<TransactionRecord>> ListAllTransactionsAsync(string? machineId = null, int limit = 100, CancellationToken ct = default)
    {
        var filter = string.IsNullOrEmpty(machineId)
            ? Builders<BsonDocument>.Filter.Empty
            : Builders<BsonDocument>.Filter.Eq("machine_id", machineId);

        var docs = await _transactions.Find(filter)
            .Sort(Builders<BsonDocument>.Sort.Descending("updated_at"))
            .Limit(limit)
            .ToListAsync(ct);

        return docs.Select(DocumentToRecord).ToList();
    }

    public async Task DeleteTransactionAsync(string transactionId, CancellationToken ct = default)
    {
        var filter = Builders<BsonDocument>.Filter.Eq("_id", transactionId);
        await _transactions.DeleteOneAsync(filter, ct);
    }

    public async Task<bool> AcquireLeaseAsync(string transactionId, string owner, long durationMs, long nowMs, CancellationToken ct = default)
    {
        var filter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", transactionId),
            Builders<BsonDocument>.Filter.Or(
                Builders<BsonDocument>.Filter.Eq("lease_expires_at", BsonNull.Value),
                Builders<BsonDocument>.Filter.Lt("lease_expires_at", nowMs),
                Builders<BsonDocument>.Filter.Eq("lease_owner", owner)
            )
        );

        var update = Builders<BsonDocument>.Update
            .Set("lease_owner", owner)
            .Set("lease_expires_at", nowMs + durationMs)
            .Set("updated_at", nowMs);

        var result = await _transactions.UpdateOneAsync(filter, update, cancellationToken: ct);
        return result.MatchedCount > 0;
    }
}

