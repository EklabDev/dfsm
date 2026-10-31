using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace EKLabDev.Dfsm.Store;

public interface IStateStore
{
    Task CreateTransactionAsync(TransactionRecord record, CancellationToken ct = default);
    Task<TransactionRecord?> GetTransactionAsync(string transactionId, CancellationToken ct = default);
    Task UpdateTransactionAsync(TransactionRecord record, long expectedVersion, CancellationToken ct = default);
    Task PushSagaStepAsync(string transactionId, SagaStepRecord step, CancellationToken ct = default);
    Task<List<SagaStepRecord>> GetSagaStackAsync(string transactionId, CancellationToken ct = default);
    Task<SagaStepRecord?> PopSagaStepAsync(string transactionId, CancellationToken ct = default);
    Task<List<TransactionRecord>> ListActiveTransactionsAsync(string? machineId = null, int limit = 100, CancellationToken ct = default);
    Task<List<TransactionRecord>> ListAllTransactionsAsync(string? machineId = null, int limit = 100, CancellationToken ct = default);
    Task DeleteTransactionAsync(string transactionId, CancellationToken ct = default);
    Task<bool> AcquireLeaseAsync(string transactionId, string owner, long durationMs, long nowMs, CancellationToken ct = default);
}

