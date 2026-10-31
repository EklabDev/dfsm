using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;

namespace EKLabDev.Dfsm.Store;

public class SqliteStateStore : IStateStore, IDisposable
{
    private readonly SqliteConnection _keepAliveConnection;
    private readonly string _connectionString;
    private readonly object _lock = new();

    public SqliteStateStore(string connectionString = "Data Source=dfsm_inmemory;Mode=Memory;Cache=Shared")
    {
        _connectionString = connectionString;
        _keepAliveConnection = new SqliteConnection(_connectionString);
        _keepAliveConnection.Open();
        InitializeSchema();
    }

    private void InitializeSchema()
    {
        using var cmd = _keepAliveConnection.CreateCommand();
        cmd.CommandText = @"
            CREATE TABLE IF NOT EXISTS dfsm_transactions (
                transaction_id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                current_state TEXT NOT NULL,
                status TEXT NOT NULL,
                context_json TEXT NOT NULL,
                version INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                lease_expires_at INTEGER,
                lease_owner TEXT
            );

            CREATE TABLE IF NOT EXISTS dfsm_saga_steps (
                step_id TEXT PRIMARY KEY,
                transaction_id TEXT NOT NULL,
                step_name TEXT NOT NULL,
                compensate_handler TEXT NOT NULL,
                from_state TEXT NOT NULL,
                target_state TEXT NOT NULL,
                input_snapshot_json TEXT,
                context_before_json TEXT,
                timestamp INTEGER NOT NULL,
                step_order INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_dfsm_tx_status ON dfsm_transactions (status);
            CREATE INDEX IF NOT EXISTS idx_dfsm_saga_tx_order ON dfsm_saga_steps (transaction_id, step_order);
        ";
        cmd.ExecuteNonQuery();
    }

    public Task CreateTransactionAsync(TransactionRecord record, CancellationToken ct = default)
    {
        lock (_lock)
        {
            using var cmd = _keepAliveConnection.CreateCommand();
            cmd.CommandText = @"
                INSERT INTO dfsm_transactions 
                (transaction_id, machine_id, current_state, status, context_json, version, created_at, updated_at, lease_expires_at, lease_owner)
                VALUES ($id, $machine, $state, $status, $context, $version, $created, $updated, $lease_exp, $lease_owner);
            ";
            cmd.Parameters.AddWithValue("$id", record.TransactionId);
            cmd.Parameters.AddWithValue("$machine", record.MachineId);
            cmd.Parameters.AddWithValue("$state", JsonSerializer.Serialize(record.CurrentState));
            cmd.Parameters.AddWithValue("$status", record.Status.ToString());
            cmd.Parameters.AddWithValue("$context", record.ContextJson ?? "{}");
            cmd.Parameters.AddWithValue("$version", record.Version);
            cmd.Parameters.AddWithValue("$created", record.CreatedAt);
            cmd.Parameters.AddWithValue("$updated", record.UpdatedAt);
            cmd.Parameters.AddWithValue("$lease_exp", (object?)record.LeaseExpiresAt ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$lease_owner", (object?)record.LeaseOwner ?? DBNull.Value);
            cmd.ExecuteNonQuery();
            return Task.CompletedTask;
        }
    }

    public Task<TransactionRecord?> GetTransactionAsync(string transactionId, CancellationToken ct = default)
    {
        lock (_lock)
        {
            using var cmd = _keepAliveConnection.CreateCommand();
            cmd.CommandText = "SELECT transaction_id, machine_id, current_state, status, context_json, version, created_at, updated_at, lease_expires_at, lease_owner FROM dfsm_transactions WHERE transaction_id = $id;";
            cmd.Parameters.AddWithValue("$id", transactionId);

            using var reader = cmd.ExecuteReader();
            if (!reader.Read()) return Task.FromResult<TransactionRecord?>(null);

            var record = new TransactionRecord
            {
                TransactionId = reader.GetString(0),
                MachineId = reader.GetString(1),
                CurrentState = StateValue.FromJsonElement(JsonDocument.Parse(reader.GetString(2)).RootElement),
                Status = Enum.Parse<TransactionStatus>(reader.GetString(3)),
                ContextJson = reader.GetString(4),
                Version = reader.GetInt64(5),
                CreatedAt = reader.GetInt64(6),
                UpdatedAt = reader.GetInt64(7),
                LeaseExpiresAt = reader.IsDBNull(8) ? null : reader.GetInt64(8),
                LeaseOwner = reader.IsDBNull(9) ? null : reader.GetString(9)
            };

            record.SagaStack = GetSagaStackInternal(transactionId);
            return Task.FromResult<TransactionRecord?>(record);
        }
    }

    private List<SagaStepRecord> GetSagaStackInternal(string transactionId)
    {
        var list = new List<SagaStepRecord>();
        using var cmd = _keepAliveConnection.CreateCommand();
        cmd.CommandText = "SELECT step_id, step_name, compensate_handler, from_state, target_state, input_snapshot_json, context_before_json, timestamp FROM dfsm_saga_steps WHERE transaction_id = $id ORDER BY step_order ASC;";
        cmd.Parameters.AddWithValue("$id", transactionId);

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            list.Add(new SagaStepRecord(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                StateValue.FromJsonElement(JsonDocument.Parse(reader.GetString(3)).RootElement),
                StateValue.FromJsonElement(JsonDocument.Parse(reader.GetString(4)).RootElement),
                reader.IsDBNull(5) ? null : reader.GetString(5),
                reader.IsDBNull(6) ? null : reader.GetString(6),
                reader.GetInt64(7)
            ));
        }
        return list;
    }

    public Task UpdateTransactionAsync(TransactionRecord record, long expectedVersion, CancellationToken ct = default)
    {
        lock (_lock)
        {
            using var cmd = _keepAliveConnection.CreateCommand();
            cmd.CommandText = @"
                UPDATE dfsm_transactions 
                SET current_state = $state,
                    status = $status,
                    context_json = $context,
                    version = $new_version,
                    updated_at = $updated,
                    lease_expires_at = $lease_exp,
                    lease_owner = $lease_owner
                WHERE transaction_id = $id AND version = $expected_version;
            ";
            cmd.Parameters.AddWithValue("$state", JsonSerializer.Serialize(record.CurrentState));
            cmd.Parameters.AddWithValue("$status", record.Status.ToString());
            cmd.Parameters.AddWithValue("$context", record.ContextJson ?? "{}");
            cmd.Parameters.AddWithValue("$new_version", record.Version);
            cmd.Parameters.AddWithValue("$updated", record.UpdatedAt);
            cmd.Parameters.AddWithValue("$lease_exp", (object?)record.LeaseExpiresAt ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$lease_owner", (object?)record.LeaseOwner ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$id", record.TransactionId);
            cmd.Parameters.AddWithValue("$expected_version", expectedVersion);

            int rows = cmd.ExecuteNonQuery();
            if (rows == 0)
            {
                using var checkCmd = _keepAliveConnection.CreateCommand();
                checkCmd.CommandText = "SELECT version FROM dfsm_transactions WHERE transaction_id = $id;";
                checkCmd.Parameters.AddWithValue("$id", record.TransactionId);
                var actualVersionObj = checkCmd.ExecuteScalar();
                if (actualVersionObj == null)
                {
                    throw new TransactionNotFoundException(record.TransactionId);
                }
                long actualVersion = Convert.ToInt64(actualVersionObj);
                throw new StaleTransactionVersionException(record.TransactionId, expectedVersion, actualVersion);
            }
            return Task.CompletedTask;
        }
    }

    public Task PushSagaStepAsync(string transactionId, SagaStepRecord step, CancellationToken ct = default)
    {
        lock (_lock)
        {
            using var countCmd = _keepAliveConnection.CreateCommand();
            countCmd.CommandText = "SELECT COALESCE(MAX(step_order), 0) + 1 FROM dfsm_saga_steps WHERE transaction_id = $id;";
            countCmd.Parameters.AddWithValue("$id", transactionId);
            long nextOrder = Convert.ToInt64(countCmd.ExecuteScalar());

            using var cmd = _keepAliveConnection.CreateCommand();
            cmd.CommandText = @"
                INSERT INTO dfsm_saga_steps 
                (step_id, transaction_id, step_name, compensate_handler, from_state, target_state, input_snapshot_json, context_before_json, timestamp, step_order)
                VALUES ($step_id, $tx_id, $name, $handler, $from, $to, $input, $ctx, $ts, $order);
            ";
            cmd.Parameters.AddWithValue("$step_id", step.StepId);
            cmd.Parameters.AddWithValue("$tx_id", transactionId);
            cmd.Parameters.AddWithValue("$name", step.StepName);
            cmd.Parameters.AddWithValue("$handler", step.CompensateHandler);
            cmd.Parameters.AddWithValue("$from", JsonSerializer.Serialize(step.FromState));
            cmd.Parameters.AddWithValue("$to", JsonSerializer.Serialize(step.TargetState));
            cmd.Parameters.AddWithValue("$input", (object?)step.InputSnapshotJson ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$ctx", (object?)step.ContextBeforeJson ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$ts", step.Timestamp);
            cmd.Parameters.AddWithValue("$order", nextOrder);
            cmd.ExecuteNonQuery();
            return Task.CompletedTask;
        }
    }

    public Task<List<SagaStepRecord>> GetSagaStackAsync(string transactionId, CancellationToken ct = default)
    {
        lock (_lock)
        {
            return Task.FromResult(GetSagaStackInternal(transactionId));
        }
    }

    public Task<SagaStepRecord?> PopSagaStepAsync(string transactionId, CancellationToken ct = default)
    {
        lock (_lock)
        {
            using var cmd = _keepAliveConnection.CreateCommand();
            cmd.CommandText = @"
                SELECT step_id, step_name, compensate_handler, from_state, target_state, input_snapshot_json, context_before_json, timestamp, step_order
                FROM dfsm_saga_steps 
                WHERE transaction_id = $id 
                ORDER BY step_order DESC 
                LIMIT 1;
            ";
            cmd.Parameters.AddWithValue("$id", transactionId);

            using var reader = cmd.ExecuteReader();
            if (!reader.Read()) return Task.FromResult<SagaStepRecord?>(null);

            var step = new SagaStepRecord(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                StateValue.FromJsonElement(JsonDocument.Parse(reader.GetString(3)).RootElement),
                StateValue.FromJsonElement(JsonDocument.Parse(reader.GetString(4)).RootElement),
                reader.IsDBNull(5) ? null : reader.GetString(5),
                reader.IsDBNull(6) ? null : reader.GetString(6),
                reader.GetInt64(7)
            );
            string stepId = step.StepId;
            reader.Close();

            using var delCmd = _keepAliveConnection.CreateCommand();
            delCmd.CommandText = "DELETE FROM dfsm_saga_steps WHERE step_id = $stepId;";
            delCmd.Parameters.AddWithValue("$stepId", stepId);
            delCmd.ExecuteNonQuery();

            return Task.FromResult<SagaStepRecord?>(step);
        }
    }

    public Task<List<TransactionRecord>> ListActiveTransactionsAsync(string? machineId = null, int limit = 100, CancellationToken ct = default)
    {
        lock (_lock)
        {
            var list = new List<TransactionRecord>();
            using var cmd = _keepAliveConnection.CreateCommand();
            var sql = "SELECT transaction_id, machine_id, current_state, status, context_json, version, created_at, updated_at, lease_expires_at, lease_owner FROM dfsm_transactions WHERE status IN ('IDLE', 'IN_FLIGHT', 'COMPENSATING')";
            if (!string.IsNullOrEmpty(machineId))
            {
                sql += " AND machine_id = $machine";
                cmd.Parameters.AddWithValue("$machine", machineId);
            }
            sql += " ORDER BY updated_at DESC LIMIT $limit;";
            cmd.Parameters.AddWithValue("$limit", limit);
            cmd.CommandText = sql;

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                list.Add(new TransactionRecord
                {
                    TransactionId = reader.GetString(0),
                    MachineId = reader.GetString(1),
                    CurrentState = StateValue.FromJsonElement(JsonDocument.Parse(reader.GetString(2)).RootElement),
                    Status = Enum.Parse<TransactionStatus>(reader.GetString(3)),
                    ContextJson = reader.GetString(4),
                    Version = reader.GetInt64(5),
                    CreatedAt = reader.GetInt64(6),
                    UpdatedAt = reader.GetInt64(7),
                    LeaseExpiresAt = reader.IsDBNull(8) ? null : reader.GetInt64(8),
                    LeaseOwner = reader.IsDBNull(9) ? null : reader.GetString(9)
                });
            }
            return Task.FromResult(list);
        }
    }

    public Task<List<TransactionRecord>> ListAllTransactionsAsync(string? machineId = null, int limit = 100, CancellationToken ct = default)
    {
        lock (_lock)
        {
            var list = new List<TransactionRecord>();
            using var cmd = _keepAliveConnection.CreateCommand();
            var sql = "SELECT transaction_id, machine_id, current_state, status, context_json, version, created_at, updated_at, lease_expires_at, lease_owner FROM dfsm_transactions";
            if (!string.IsNullOrEmpty(machineId))
            {
                sql += " WHERE machine_id = $machine";
                cmd.Parameters.AddWithValue("$machine", machineId);
            }
            sql += " ORDER BY updated_at DESC LIMIT $limit;";
            cmd.Parameters.AddWithValue("$limit", limit);
            cmd.CommandText = sql;

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                list.Add(new TransactionRecord
                {
                    TransactionId = reader.GetString(0),
                    MachineId = reader.GetString(1),
                    CurrentState = StateValue.FromJsonElement(JsonDocument.Parse(reader.GetString(2)).RootElement),
                    Status = Enum.Parse<TransactionStatus>(reader.GetString(3)),
                    ContextJson = reader.GetString(4),
                    Version = reader.GetInt64(5),
                    CreatedAt = reader.GetInt64(6),
                    UpdatedAt = reader.GetInt64(7),
                    LeaseExpiresAt = reader.IsDBNull(8) ? null : reader.GetInt64(8),
                    LeaseOwner = reader.IsDBNull(9) ? null : reader.GetString(9)
                });
            }
            return Task.FromResult(list);
        }
    }

    public Task DeleteTransactionAsync(string transactionId, CancellationToken ct = default)
    {
        lock (_lock)
        {
            using var cmd = _keepAliveConnection.CreateCommand();
            cmd.CommandText = "DELETE FROM dfsm_saga_steps WHERE transaction_id = $id; DELETE FROM dfsm_transactions WHERE transaction_id = $id;";
            cmd.Parameters.AddWithValue("$id", transactionId);
            cmd.ExecuteNonQuery();
            return Task.CompletedTask;
        }
    }

    public Task<bool> AcquireLeaseAsync(string transactionId, string owner, long durationMs, long nowMs, CancellationToken ct = default)
    {
        lock (_lock)
        {
            using var cmd = _keepAliveConnection.CreateCommand();
            cmd.CommandText = @"
                UPDATE dfsm_transactions 
                SET lease_owner = $owner,
                    lease_expires_at = $new_exp,
                    updated_at = $now
                WHERE transaction_id = $id 
                  AND (lease_expires_at IS NULL OR lease_expires_at < $now OR lease_owner = $owner);
            ";
            cmd.Parameters.AddWithValue("$owner", owner);
            cmd.Parameters.AddWithValue("$new_exp", nowMs + durationMs);
            cmd.Parameters.AddWithValue("$now", nowMs);
            cmd.Parameters.AddWithValue("$id", transactionId);

            int rows = cmd.ExecuteNonQuery();
            return Task.FromResult(rows > 0);
        }
    }

    public void Dispose()
    {
        _keepAliveConnection.Dispose();
    }
}

