using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;
using NpgsqlTypes;

namespace EKLabDev.Dfsm.Store;

public class PostgresStateStore : IStateStore
{
    private readonly string _connectionString;

    public PostgresStateStore(string connectionString)
    {
        _connectionString = connectionString;
        InitializeSchema();
    }

    private void InitializeSchema()
    {
        using var conn = new NpgsqlConnection(_connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
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

            CREATE INDEX IF NOT EXISTS idx_dfsm_pg_status ON dfsm_transactions (status);
            CREATE INDEX IF NOT EXISTS idx_dfsm_pg_saga_tx_order ON dfsm_saga_steps (transaction_id, step_order);
        ";
        cmd.ExecuteNonQuery();
    }

    public async Task CreateTransactionAsync(TransactionRecord record, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            INSERT INTO dfsm_transactions 
            (transaction_id, machine_id, current_state, status, context_json, version, created_at, updated_at, lease_expires_at, lease_owner)
            VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8, $9, $10);
        ";
        cmd.Parameters.AddWithValue(record.TransactionId);
        cmd.Parameters.AddWithValue(record.MachineId);
        cmd.Parameters.AddWithValue(JsonSerializer.Serialize(record.CurrentState));
        cmd.Parameters.AddWithValue(record.Status.ToString());
        cmd.Parameters.AddWithValue(record.ContextJson ?? "{}");
        cmd.Parameters.AddWithValue(record.Version);
        cmd.Parameters.AddWithValue(record.CreatedAt);
        cmd.Parameters.AddWithValue(record.UpdatedAt);
        cmd.Parameters.AddWithValue((object?)record.LeaseExpiresAt ?? DBNull.Value);
        cmd.Parameters.AddWithValue((object?)record.LeaseOwner ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<TransactionRecord?> GetTransactionAsync(string transactionId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT transaction_id, machine_id, current_state::text, status, context_json::text, version, created_at, updated_at, lease_expires_at, lease_owner FROM dfsm_transactions WHERE transaction_id = $1;";
        cmd.Parameters.AddWithValue(transactionId);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;

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
        await reader.CloseAsync();

        record.SagaStack = await GetSagaStackInternalAsync(conn, transactionId, ct);
        return record;
    }

    private async Task<List<SagaStepRecord>> GetSagaStackInternalAsync(NpgsqlConnection conn, string transactionId, CancellationToken ct)
    {
        var list = new List<SagaStepRecord>();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT step_id, step_name, compensate_handler, from_state::text, target_state::text, input_snapshot_json, context_before_json, timestamp FROM dfsm_saga_steps WHERE transaction_id = $1 ORDER BY step_order ASC;";
        cmd.Parameters.AddWithValue(transactionId);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
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

    public async Task UpdateTransactionAsync(TransactionRecord record, long expectedVersion, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            UPDATE dfsm_transactions 
            SET current_state = $1::jsonb,
                status = $2,
                context_json = $3::jsonb,
                version = $4,
                updated_at = $5,
                lease_expires_at = $6,
                lease_owner = $7
            WHERE transaction_id = $8 AND version = $9;
        ";
        cmd.Parameters.AddWithValue(JsonSerializer.Serialize(record.CurrentState));
        cmd.Parameters.AddWithValue(record.Status.ToString());
        cmd.Parameters.AddWithValue(record.ContextJson ?? "{}");
        cmd.Parameters.AddWithValue(record.Version);
        cmd.Parameters.AddWithValue(record.UpdatedAt);
        cmd.Parameters.AddWithValue((object?)record.LeaseExpiresAt ?? DBNull.Value);
        cmd.Parameters.AddWithValue((object?)record.LeaseOwner ?? DBNull.Value);
        cmd.Parameters.AddWithValue(record.TransactionId);
        cmd.Parameters.AddWithValue(expectedVersion);

        int rows = await cmd.ExecuteNonQueryAsync(ct);
        if (rows == 0)
        {
            await using var checkCmd = conn.CreateCommand();
            checkCmd.CommandText = "SELECT version FROM dfsm_transactions WHERE transaction_id = $1;";
            checkCmd.Parameters.AddWithValue(record.TransactionId);
            var actualVersionObj = await checkCmd.ExecuteScalarAsync(ct);
            if (actualVersionObj == null)
            {
                throw new TransactionNotFoundException(record.TransactionId);
            }
            long actualVersion = Convert.ToInt64(actualVersionObj);
            throw new StaleTransactionVersionException(record.TransactionId, expectedVersion, actualVersion);
        }
    }

    public async Task PushSagaStepAsync(string transactionId, SagaStepRecord step, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);

        await using var countCmd = conn.CreateCommand();
        countCmd.CommandText = "SELECT COALESCE(MAX(step_order), 0) + 1 FROM dfsm_saga_steps WHERE transaction_id = $1;";
        countCmd.Parameters.AddWithValue(transactionId);
        long nextOrder = Convert.ToInt64(await countCmd.ExecuteScalarAsync(ct));

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            INSERT INTO dfsm_saga_steps 
            (step_id, transaction_id, step_name, compensate_handler, from_state, target_state, input_snapshot_json, context_before_json, timestamp, step_order)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10);
        ";
        cmd.Parameters.AddWithValue(step.StepId);
        cmd.Parameters.AddWithValue(transactionId);
        cmd.Parameters.AddWithValue(step.StepName);
        cmd.Parameters.AddWithValue(step.CompensateHandler);
        cmd.Parameters.AddWithValue(JsonSerializer.Serialize(step.FromState));
        cmd.Parameters.AddWithValue(JsonSerializer.Serialize(step.TargetState));
        cmd.Parameters.AddWithValue((object?)step.InputSnapshotJson ?? DBNull.Value);
        cmd.Parameters.AddWithValue((object?)step.ContextBeforeJson ?? DBNull.Value);
        cmd.Parameters.AddWithValue(step.Timestamp);
        cmd.Parameters.AddWithValue(nextOrder);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<List<SagaStepRecord>> GetSagaStackAsync(string transactionId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        return await GetSagaStackInternalAsync(conn, transactionId, ct);
    }

    public async Task<SagaStepRecord?> PopSagaStepAsync(string transactionId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            SELECT step_id, step_name, compensate_handler, from_state::text, target_state::text, input_snapshot_json, context_before_json, timestamp, step_order
            FROM dfsm_saga_steps 
            WHERE transaction_id = $1 
            ORDER BY step_order DESC 
            LIMIT 1;
        ";
        cmd.Parameters.AddWithValue(transactionId);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;

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
        await reader.CloseAsync();

        await using var delCmd = conn.CreateCommand();
        delCmd.CommandText = "DELETE FROM dfsm_saga_steps WHERE step_id = $1;";
        delCmd.Parameters.AddWithValue(stepId);
        await delCmd.ExecuteNonQueryAsync(ct);

        return step;
    }

    public async Task<List<TransactionRecord>> ListActiveTransactionsAsync(string? machineId = null, int limit = 100, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        var list = new List<TransactionRecord>();
        await using var cmd = conn.CreateCommand();
        var sql = "SELECT transaction_id, machine_id, current_state::text, status, context_json::text, version, created_at, updated_at, lease_expires_at, lease_owner FROM dfsm_transactions WHERE status IN ('IDLE', 'IN_FLIGHT', 'COMPENSATING')";
        if (!string.IsNullOrEmpty(machineId))
        {
            sql += " AND machine_id = $1";
            cmd.Parameters.AddWithValue(machineId);
        }
        sql += $" ORDER BY updated_at DESC LIMIT {limit};";
        cmd.CommandText = sql;

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
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
        return list;
    }

    public async Task<List<TransactionRecord>> ListAllTransactionsAsync(string? machineId = null, int limit = 100, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        var list = new List<TransactionRecord>();
        await using var cmd = conn.CreateCommand();
        var sql = "SELECT transaction_id, machine_id, current_state::text, status, context_json::text, version, created_at, updated_at, lease_expires_at, lease_owner FROM dfsm_transactions";
        if (!string.IsNullOrEmpty(machineId))
        {
            sql += " WHERE machine_id = $1";
            cmd.Parameters.AddWithValue(machineId);
        }
        sql += $" ORDER BY updated_at DESC LIMIT {limit};";
        cmd.CommandText = sql;

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
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
        return list;
    }

    public async Task DeleteTransactionAsync(string transactionId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM dfsm_saga_steps WHERE transaction_id = $1; DELETE FROM dfsm_transactions WHERE transaction_id = $1;";
        cmd.Parameters.AddWithValue(transactionId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<bool> AcquireLeaseAsync(string transactionId, string owner, long durationMs, long nowMs, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            UPDATE dfsm_transactions 
            SET lease_owner = $1,
                lease_expires_at = $2,
                updated_at = $3
            WHERE transaction_id = $4 
              AND (lease_expires_at IS NULL OR lease_expires_at < $3 OR lease_owner = $1);
        ";
        cmd.Parameters.AddWithValue(owner);
        cmd.Parameters.AddWithValue(nowMs + durationMs);
        cmd.Parameters.AddWithValue(nowMs);
        cmd.Parameters.AddWithValue(transactionId);

        int rows = await cmd.ExecuteNonQueryAsync(ct);
        return rows > 0;
    }
}

