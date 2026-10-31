using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace EKLabDev.Dfsm;

public interface IDfsmActor
{
    string MachineId { get; }
    Task<TransitionExecutionResult> TransitionAsync(
        string transactionId, 
        string eventName, 
        object? input = null, 
        CancellationToken cancellationToken = default);
    Task<ActorStateRecord> GetStateAsync(string transactionId, CancellationToken cancellationToken = default);
    IReadOnlyList<string> GetAvailableEvents(StateValue state);
    IReadOnlyList<string> GetTerminalStates();
}

public sealed record TransitionRequest<TContext, TInput>(
    string TransactionId,
    TContext Data,
    TInput Input,
    StateValue CurrentState,
    string EventName,
    IReadOnlyDictionary<string, object>? Meta = null
);

public sealed class TransitionOutput<TContext, TOutput>
{
    public TContext? Context { get; }
    public TOutput? Output { get; }
    public bool ContextUpdated { get; }

    public TransitionOutput(TContext? context, TOutput? output, bool contextUpdated)
    {
        Context = context;
        Output = output;
        ContextUpdated = contextUpdated;
    }

    public static TransitionOutput<TContext, TOutput> Of(TContext context, TOutput output) =>
        new(context, output, true);

    public static TransitionOutput<TContext, TOutput> OfContext(TContext context) =>
        new(context, default, true);

    public static TransitionOutput<TContext, TOutput> OfOutput(TOutput output) =>
        new(default, output, false);

    public static TransitionOutput<TContext, TOutput> Empty() =>
        new(default, default, false);
}

public sealed record CompensationRequest<TContext>(
    string TransactionId,
    TContext Context,
    string StepName,
    object? InputSnapshot,
    StateValue FromState,
    StateValue TargetState
);

public sealed class EffectRequest<TContext>
{
    public string TransactionId { get; }
    public TContext Context { get; }
    public string EventName { get; }
    public StateValue State { get; }
    public IDfsmActor Actor { get; }
    private readonly Func<string, object?, CancellationToken, Task> _runEffectFunc;

    public EffectRequest(
        string transactionId,
        TContext context,
        string eventName,
        StateValue state,
        IDfsmActor actor,
        Func<string, object?, CancellationToken, Task> runEffectFunc)
    {
        TransactionId = transactionId;
        Context = context;
        EventName = eventName;
        State = state;
        Actor = actor;
        _runEffectFunc = runEffectFunc;
    }

    public Task RunEffectAsync(string effectName, object? payload = null, CancellationToken cancellationToken = default) =>
        _runEffectFunc(effectName, payload, cancellationToken);
}

public static class ActorLifecycleEvents
{
    public sealed record OnStartEvent(string TransactionId, StateValue InitialState, object? InitialContext);
    public sealed record BeforeTransitionEvent(string TransactionId, StateValue CurrentState, string EventName, object? Input);
    public sealed record AfterTransitionEvent(string TransactionId, string EventName, StateValue PreviousState, StateValue CurrentState, TransactionStatus Status, int CompensatedSteps);
    public sealed record OnCompensateEvent(string TransactionId, string StepName, StateValue FromState, StateValue TargetState, int StepsRemaining);
    public sealed record OnCompleteEvent(string TransactionId, StateValue FinalState, object? FinalContext);
    public sealed record OnTerminalEvent(string TransactionId, StateValue FinalState, TransactionStatus Status, object? FinalContext);
}

public sealed record SagaStepRecord(
    string StepId,
    string StepName,
    string CompensateHandler,
    StateValue FromState,
    StateValue TargetState,
    string? InputSnapshotJson,
    string? ContextBeforeJson,
    long Timestamp
);

public sealed class TransactionRecord
{
    public string TransactionId { get; set; } = string.Empty;
    public string MachineId { get; set; } = string.Empty;
    public StateValue CurrentState { get; set; } = StateValue.Of("idle");
    public TransactionStatus Status { get; set; } = TransactionStatus.IDLE;
    public string ContextJson { get; set; } = "{}";
    public long Version { get; set; } = 1;
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
    public long? LeaseExpiresAt { get; set; }
    public string? LeaseOwner { get; set; }
    public List<SagaStepRecord> SagaStack { get; set; } = new();
}

public sealed record ActorStateRecord(
    string TransactionId,
    string MachineId,
    StateValue CurrentState,
    TransactionStatus Status,
    object? Context,
    long Version,
    long CreatedAt,
    long UpdatedAt,
    IReadOnlyList<string> AvailableEvents,
    int SagaStackDepth
);

public sealed record TransitionExecutionResult(
    string TransactionId,
    string EventName,
    StateValue PreviousState,
    StateValue CurrentState,
    TransactionStatus Status,
    object? OutputValue,
    int CompensatedSteps,
    bool RollbackTriggered
);

public sealed record ActiveTransactionSummary(
    string TransactionId,
    string MachineId,
    StateValue CurrentState,
    TransactionStatus Status,
    long Version,
    long CreatedAt,
    long UpdatedAt
);

public sealed record StatusBreakdown(
    int Idle,
    int InFlight,
    int Compensating,
    int Compensated,
    int Completed,
    int Failed
);

public sealed record InFlightSummary(
    int TotalInFlight,
    int NonTerminalCount,
    IReadOnlyList<string> TerminalStates,
    StatusBreakdown Breakdown
);

public sealed record ForceCleanUpOptions(
    ForceCleanUpAction Action = ForceCleanUpAction.COMPENSATE,
    IReadOnlyList<string>? TransactionIds = null,
    bool IncludeInFlight = true,
    bool StuckOnly = false,
    long? OlderThanMs = null,
    bool DryRun = false,
    int Limit = 100
);

public sealed record ForceCleanUpResult(
    int MatchedCount,
    int ProcessedCount,
    bool DryRun,
    ForceCleanUpAction Action,
    IReadOnlyList<string> AffectedTransactionIds
);
