using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Policy;
using EKLabDev.Dfsm.Statechart;
using EKLabDev.Dfsm.Telemetry;

namespace EKLabDev.Dfsm.Runtime;

public class DfsmActor<TContext> : IDfsmActor
{
    private readonly MachineDefinition _machine;
    private readonly FSMRegistry _registry;
    private readonly ConcurrentDictionary<string, CircuitBreakerInstance> _circuitBreakers = new(StringComparer.Ordinal);
    private static readonly AsyncLocal<int> EffectChainDepth = new();

    public string MachineId => _machine.Id;

    public DfsmActor(MachineDefinition machine, FSMRegistry registry)
    {
        _machine = machine ?? throw new ArgumentNullException(nameof(machine));
        _registry = registry ?? throw new ArgumentNullException(nameof(registry));
    }

    public async Task<ActorStateRecord> GetStateAsync(string transactionId, CancellationToken ct = default)
    {
        var record = await _registry.Store.GetTransactionAsync(transactionId, ct);
        if (record == null)
        {
            throw new TransactionNotFoundException(transactionId);
        }

        var ctx = DeserializeContext(record.ContextJson);
        var availableEvents = StatechartEngine.GetAvailableEvents(_machine, record.CurrentState);

        return new ActorStateRecord(
            record.TransactionId,
            record.MachineId,
            record.CurrentState,
            record.Status,
            ctx,
            record.Version,
            record.CreatedAt,
            record.UpdatedAt,
            availableEvents,
            record.SagaStack.Count
        );
    }

    public IReadOnlyList<string> GetAvailableEvents(StateValue state)
    {
        return StatechartEngine.GetAvailableEvents(_machine, state);
    }

    public IReadOnlyList<string> GetTerminalStates()
    {
        return StatechartEngine.GetTerminalStates(_machine);
    }

    public async Task<TransitionExecutionResult> TransitionAsync(
        string transactionId,
        string eventName,
        object? input = null,
        CancellationToken ct = default)
    {
        // 1. Guard effect chain depth
        int currentDepth = EffectChainDepth.Value;
        if (currentDepth >= _machine.MaxEffectChainDepth)
        {
            throw new MaxEffectChainDepthException(
                _machine.MaxEffectChainDepth,
                $"Maximum effect chain depth of {_machine.MaxEffectChainDepth} exceeded in transaction '{transactionId}' during event '{eventName}'."
            );
        }

        // 2. Load or initialize transaction
        var record = await _registry.Store.GetTransactionAsync(transactionId, ct);
        long now = _registry.Clock.NowMs();

        if (record == null)
        {
            var initRes = StatechartEngine.ResolveInitialState(_machine);
            record = new TransactionRecord
            {
                TransactionId = transactionId,
                MachineId = _machine.Id,
                CurrentState = initRes.StateValue,
                Status = TransactionStatus.IDLE,
                ContextJson = SerializeContext(default(TContext)),
                Version = 1,
                CreatedAt = now,
                UpdatedAt = now
            };
            await _registry.Store.CreateTransactionAsync(record, ct);

            // Fire OnStart hook
            await FireHookAsync(HookType.OnStart, new ActorLifecycleEvents.OnStartEvent(transactionId, record.CurrentState, default(TContext)), ct);

            // Execute initial entry effects
            foreach (var effectName in initRes.EntryEffects)
            {
                await RunEffectInternalAsync(transactionId, default(TContext)!, eventName, record.CurrentState, effectName, null, ct);
            }
        }

        // 3. Terminal state check
        if (record.Status == TransactionStatus.COMPLETED || record.Status == TransactionStatus.FAILED)
        {
            throw new InvalidTransitionException(
                record.CurrentState,
                eventName,
                $"Cannot process event '{eventName}' because transaction '{transactionId}' is already in terminal status '{record.Status}' (state: {record.CurrentState})."
            );
        }

        // 5. Resolve transition
        var matchedList = StatechartEngine.ResolveTransitionsForEvent(_machine, record.CurrentState, eventName);
        if (matchedList.Count == 0)
        {
            throw new InvalidTransitionException(
                record.CurrentState,
                eventName,
                $"No transition found for event '{eventName}' from state '{record.CurrentState}' in machine '{_machine.Id}'."
            );
        }

        var matched = matchedList[0];
        string handlerName = matched.Edge.Handler ?? eventName;
        var regTx = _registry.GetTransition(handlerName);

        // Pre-flight input coercion & DataAnnotations validation
        object? coercedInput = input;
        if (regTx != null && input != null)
        {
            var parameters = regTx.Value.Handler.Method.GetParameters();
            if (parameters.Length > 0)
            {
                var paramType = parameters[0].ParameterType;
                if (paramType.IsGenericType && paramType.GetGenericTypeDefinition() == typeof(TransitionRequest<,>))
                {
                    var expectedInputType = paramType.GetGenericArguments()[1];
                    if (!expectedInputType.IsAssignableFrom(input.GetType()))
                    {
                        var json = JsonSerializer.Serialize(input);
                        coercedInput = JsonSerializer.Deserialize(json, expectedInputType, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                    }
                }
            }
        }

        if (coercedInput != null)
        {
            _registry.Validator.Validate(coercedInput, $"input for event '{eventName}'");
        }

        // 6. Merge policies
        var codePolicy = regTx?.Policy;
        var edgePolicy = matched.Edge.Policy;
        var policy = PolicyMerger.Merge(codePolicy, edgePolicy, _machine.Defaults, _registry.GlobalPolicy);

        // 7. Fire BeforeTransition hook
        await FireHookAsync(HookType.BeforeTransition, new ActorLifecycleEvents.BeforeTransitionEvent(transactionId, record.CurrentState, eventName, input), ct);

        // Mark IN_FLIGHT
        long originalVersion = record.Version;
        record.Status = TransactionStatus.IN_FLIGHT;
        record.UpdatedAt = _registry.Clock.NowMs();
        record.Version = originalVersion + 1;
        await _registry.Store.UpdateTransactionAsync(record, originalVersion, ct);
        long inFlightVersion = record.Version;

        // 8. Execute Handler with Retry & Circuit Breaker
        var sw = Stopwatch.StartNew();
        int attempts = 0;
        Exception? lastError = null;
        object? handlerOutput = null;
        TContext currentCtx = DeserializeContext(record.ContextJson);
        TContext updatedCtx = currentCtx;
        bool contextUpdated = false;

        CircuitBreakerInstance? cbInstance = null;
        if (policy.CircuitBreaker != null)
        {
            cbInstance = _circuitBreakers.GetOrAdd(handlerName, _ => new CircuitBreakerInstance(policy.CircuitBreaker, _registry.Clock));
        }

        if (regTx != null)
        {
            cbInstance?.BeforeExecution(handlerName);

            int maxAttempts = policy.Retry.MaxAttempts;
            for (int attempt = 1; attempt <= maxAttempts; attempt++)
            {
                attempts = attempt;
                try
                {
                    var (outVal, newCtx, ctxUpdated) = await InvokeHandlerAsync(regTx.Value.Handler, transactionId, currentCtx, coercedInput, record.CurrentState, eventName, ct);
                    handlerOutput = outVal;
                    if (ctxUpdated)
                    {
                        updatedCtx = newCtx;
                        contextUpdated = true;
                    }
                    cbInstance?.OnSuccess();
                    lastError = null;
                    break;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    cbInstance?.OnFailure();

                    if (attempt < maxAttempts)
                    {
                        long delay = CalculateBackoffDelay(attempt, policy.Retry);
                        await _registry.Clock.SleepAsync(delay, ct);
                    }
                }
            }
        }
        else
        {
            // Direct state transition without custom handler
            attempts = 1;
        }

        sw.Stop();
        long durationMs = sw.ElapsedMilliseconds;

        // 9. Handle Success
        if (lastError == null)
        {
            var prevState = record.CurrentState;
            var applied = StatechartEngine.ApplyTargetTransition(_machine, record.CurrentState, matched.SourcePath, matched.Edge.Target);
            record.CurrentState = applied.NextStateValue;

            if (contextUpdated)
            {
                record.ContextJson = SerializeContext(updatedCtx);
            }

            // Push Saga compensation if configured
            string? compHandler = policy.CompensateWith;
            if (!string.IsNullOrEmpty(compHandler))
            {
                var step = new SagaStepRecord(
                    Guid.NewGuid().ToString(),
                    handlerName,
                    compHandler,
                    prevState,
                    record.CurrentState,
                    input != null ? JsonSerializer.Serialize(input) : null,
                    SerializeContext(currentCtx),
                    _registry.Clock.NowMs()
                );
                await _registry.Store.PushSagaStepAsync(transactionId, step, ct);
            }

            // Check OnDone cascades
            var pendingOnDone = StatechartEngine.FindPendingOnDone(_machine, record.CurrentState);
            while (pendingOnDone != null)
            {
                var onDoneApplied = StatechartEngine.ApplyTargetTransition(_machine, record.CurrentState, pendingOnDone.SourcePath, pendingOnDone.Edge.Target);
                record.CurrentState = onDoneApplied.NextStateValue;
                pendingOnDone = StatechartEngine.FindPendingOnDone(_machine, record.CurrentState);
            }

            // Resolve settled status
            record.Status = StatechartEngine.ResolveSettledTransactionStatus(_machine, record.CurrentState, wasCompensated: false);
            record.UpdatedAt = _registry.Clock.NowMs();
            record.Version = inFlightVersion + 1;

            await _registry.Store.UpdateTransactionAsync(record, inFlightVersion, ct);

            // Record benchmark
            _registry.BenchmarkEngine.Record(new BenchmarkEvent(
                transactionId, _machine.Id, eventName, handlerName, attempts, "SUCCESS", durationMs, prevState, record.CurrentState
            ));

            // Run AfterTransition hook
            await FireHookAsync(HookType.AfterTransition, new ActorLifecycleEvents.AfterTransitionEvent(
                transactionId, eventName, prevState, record.CurrentState, record.Status, 0
            ), ct);

            // If completed / terminal
            if (record.Status == TransactionStatus.COMPLETED)
            {
                await FireHookAsync(HookType.OnComplete, new ActorLifecycleEvents.OnCompleteEvent(transactionId, record.CurrentState, updatedCtx), ct);
                await FireHookAsync(HookType.OnTerminal, new ActorLifecycleEvents.OnTerminalEvent(transactionId, record.CurrentState, record.Status, updatedCtx), ct);
            }

            // Run exit & entry effects
            foreach (var eff in applied.ExitEffects)
            {
                await RunEffectInternalAsync(transactionId, updatedCtx, eventName, record.CurrentState, eff, null, ct);
            }
            foreach (var eff in applied.EntryEffects)
            {
                await RunEffectInternalAsync(transactionId, updatedCtx, eventName, record.CurrentState, eff, null, ct);
            }

            return new TransitionExecutionResult(
                transactionId, eventName, prevState, record.CurrentState, record.Status, handlerOutput, 0, false
            );
        }

        // 10. Handle Failure & Saga Compensation
        _registry.BenchmarkEngine.Record(new BenchmarkEvent(
            transactionId, _machine.Id, eventName, handlerName, attempts, "FAILED", durationMs, record.CurrentState, record.CurrentState, lastError.Message
        ));

        int compensatedSteps = 0;
        bool rollbackTriggered = policy.OnFail?.Compensate == true;

        if (rollbackTriggered)
        {
            record.Status = TransactionStatus.COMPENSATING;
            var sagaStack = await _registry.Store.GetSagaStackAsync(transactionId, ct);
            int remaining = sagaStack.Count;

            while (remaining > 0)
            {
                var step = await _registry.Store.PopSagaStepAsync(transactionId, ct);
                if (step == null) break;

                var compDelegate = _registry.GetCompensate(step.CompensateHandler);
                if (compDelegate != null)
                {
                    try
                    {
                        var compReq = new CompensationRequest<TContext>(
                            transactionId,
                            currentCtx,
                            step.StepName,
                            step.InputSnapshotJson != null ? JsonDocument.Parse(step.InputSnapshotJson).RootElement : null,
                            step.FromState,
                            step.TargetState
                        );
                        await InvokeCompensationAsync(compDelegate, compReq, ct);
                    }
                    catch (Exception cex)
                    {
                        _registry.BenchmarkEngine.Log($"[DFSM-COMPENSATE-ERROR] tx={transactionId} | step={step.StepName} | error={cex.Message}");
                    }
                }

                compensatedSteps++;
                remaining--;
                await FireHookAsync(HookType.OnCompensate, new ActorLifecycleEvents.OnCompensateEvent(
                    transactionId, step.StepName, step.FromState, step.TargetState, remaining
                ), ct);
            }
        }

        string failTarget = policy.OnFail?.Target ?? "error";
        var failApplied = StatechartEngine.ApplyTargetTransition(_machine, record.CurrentState, matched.SourcePath, failTarget);
        record.CurrentState = failApplied.NextStateValue;
        record.Status = StatechartEngine.ResolveSettledTransactionStatus(_machine, record.CurrentState, wasCompensated: rollbackTriggered);
        record.UpdatedAt = _registry.Clock.NowMs();
        record.Version = inFlightVersion + 1;

        await _registry.Store.UpdateTransactionAsync(record, inFlightVersion, ct);

        await FireHookAsync(HookType.OnTerminal, new ActorLifecycleEvents.OnTerminalEvent(
            transactionId, record.CurrentState, record.Status, currentCtx
        ), ct);

        return new TransitionExecutionResult(
            transactionId, eventName, record.CurrentState, record.CurrentState, record.Status, null, compensatedSteps, rollbackTriggered
        );
    }

    private async Task<(object? Output, TContext Context, bool ContextUpdated)> InvokeHandlerAsync(
        Delegate handler,
        string transactionId,
        TContext context,
        object? input,
        StateValue currentState,
        string eventName,
        CancellationToken ct)
    {
        var parameters = handler.Method.GetParameters();
        if (parameters.Length == 0)
        {
            var res = handler.DynamicInvoke();
            return (res, context, false);
        }

        var paramType = parameters[0].ParameterType;
        Type expectedInputType = typeof(object);
        if (paramType.IsGenericType && paramType.GetGenericTypeDefinition() == typeof(TransitionRequest<,>))
        {
            expectedInputType = paramType.GetGenericArguments()[1];
        }

        object? coercedInput = input;
        if (input != null && !expectedInputType.IsAssignableFrom(input.GetType()))
        {
            var json = JsonSerializer.Serialize(input);
            coercedInput = JsonSerializer.Deserialize(json, expectedInputType, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }

        var reqType = typeof(TransitionRequest<,>).MakeGenericType(typeof(TContext), expectedInputType);
        var reqInstance = Activator.CreateInstance(reqType, transactionId, context, coercedInput!, currentState, eventName, null);

        object? result = handler.DynamicInvoke(reqInstance);

        if (result is Task task)
        {
            await task;
            var taskType = task.GetType();
            if (taskType.IsGenericType)
            {
                result = taskType.GetProperty("Result")?.GetValue(task);
            }
            else
            {
                result = null;
            }
        }

        if (result == null)
        {
            return (null, context, false);
        }

        // Check if result is TransitionOutput<TContext, TOutput>
        var resType = result.GetType();
        if (resType.IsGenericType && resType.GetGenericTypeDefinition() == typeof(TransitionOutput<,>))
        {
            var ctxUpdated = (bool)resType.GetProperty("ContextUpdated")!.GetValue(result)!;
            var outCtx = ctxUpdated ? (TContext)resType.GetProperty("Context")!.GetValue(result)! : context;
            var outputVal = resType.GetProperty("Output")!.GetValue(result);
            return (outputVal, outCtx, ctxUpdated);
        }

        return (result, context, false);
    }

    private async Task InvokeCompensationAsync(Delegate handler, CompensationRequest<TContext> req, CancellationToken ct)
    {
        object? result;
        if (handler.Method.GetParameters().Length == 0)
        {
            result = handler.DynamicInvoke();
        }
        else
        {
            result = handler.DynamicInvoke(req);
        }

        if (result is Task task)
        {
            await task;
        }
    }

    public async Task RunEffectAsync(string transactionId, string effectName, object? payload = null, CancellationToken ct = default)
    {
        var record = await _registry.Store.GetTransactionAsync(transactionId, ct);
        if (record == null) throw new TransactionNotFoundException(transactionId);
        var ctx = DeserializeContext(record.ContextJson);
        await RunEffectInternalAsync(transactionId, ctx, "EFFECT", record.CurrentState, effectName, payload, ct);
    }

    private async Task RunEffectInternalAsync(
        string transactionId,
        TContext context,
        string eventName,
        StateValue state,
        string effectName,
        object? payload,
        CancellationToken ct)
    {
        var effectHandler = _registry.GetEffect(effectName);
        if (effectHandler == null) return;

        var prevDepth = EffectChainDepth.Value;
        EffectChainDepth.Value = prevDepth + 1;
        try
        {
            var effectReq = new EffectRequest<TContext>(
                transactionId,
                context,
                eventName,
                state,
                this,
                (eff, pl, token) => RunEffectInternalAsync(transactionId, context, eventName, state, eff, pl, token)
            );

            object? result;
            var parameters = effectHandler.Method.GetParameters();
            if (parameters.Length == 0)
            {
                result = effectHandler.DynamicInvoke();
            }
            else if (parameters.Length == 1 && parameters[0].ParameterType.IsAssignableFrom(typeof(EffectRequest<TContext>)))
            {
                result = effectHandler.DynamicInvoke(effectReq);
            }
            else
            {
                result = effectHandler.DynamicInvoke(effectReq, payload);
            }

            if (result is Task task)
            {
                await task;
            }
        }
        finally
        {
            EffectChainDepth.Value = prevDepth;
        }
    }

    private async Task FireHookAsync(HookType hookType, object eventPayload, CancellationToken ct)
    {
        var hooks = _registry.GetHooks(hookType);
        foreach (var h in hooks)
        {
            try
            {
                object? result = h.Method.GetParameters().Length == 0 ? h.DynamicInvoke() : h.DynamicInvoke(eventPayload);
                if (result is Task t) await t;
            }
            catch (Exception ex)
            {
                _registry.BenchmarkEngine.Log($"[DFSM-HOOK-ERROR] hook={hookType} | error={ex.Message}");
            }
        }
    }

    private long CalculateBackoffDelay(int attempt, RetryPolicy retry)
    {
        long delay;
        if (string.Equals(retry.Backoff, "LINEAR", StringComparison.OrdinalIgnoreCase))
        {
            delay = (long)retry.BackoffMs * attempt;
        }
        else if (string.Equals(retry.Backoff, "FIXED", StringComparison.OrdinalIgnoreCase))
        {
            delay = retry.BackoffMs;
        }
        else
        {
            // EXPONENTIAL
            delay = (long)(retry.BackoffMs * Math.Pow(retry.BackoffFactor, attempt - 1));
        }

        delay = Math.Min(delay, retry.MaxBackoffMs);
        if (retry.Jitter)
        {
            var rnd = new Random();
            delay = (long)(delay * (0.5 + rnd.NextDouble() * 0.5));
        }
        return Math.Max(0, delay);
    }

    private string SerializeContext(TContext? context)
    {
        if (context == null) return "{}";
        return JsonSerializer.Serialize(context);
    }

    private TContext DeserializeContext(string json)
    {
        if (string.IsNullOrWhiteSpace(json) || json == "{}")
        {
            return default!;
        }
        return JsonSerializer.Deserialize<TContext>(json)!;
    }

    // --- Ops & Management APIs ---

    public async Task<int> GetActiveCountAsync(CancellationToken ct = default)
    {
        var list = await _registry.Store.ListActiveTransactionsAsync(_machine.Id, 1000, ct);
        return list.Count;
    }

    public async Task<List<ActiveTransactionSummary>> ListActiveTransactionsAsync(int limit = 100, CancellationToken ct = default)
    {
        var list = await _registry.Store.ListActiveTransactionsAsync(_machine.Id, limit, ct);
        return list.Select(r => new ActiveTransactionSummary(
            r.TransactionId, r.MachineId, r.CurrentState, r.Status, r.Version, r.CreatedAt, r.UpdatedAt
        )).ToList();
    }

    public async Task<StatusBreakdown> GetStatusBreakdownAsync(CancellationToken ct = default)
    {
        var all = await _registry.Store.ListAllTransactionsAsync(_machine.Id, 5000, ct);
        int idle = 0, inFlight = 0, comp = 0, compensated = 0, done = 0, fail = 0;
        foreach (var r in all)
        {
            switch (r.Status)
            {
                case TransactionStatus.IDLE: idle++; break;
                case TransactionStatus.IN_FLIGHT: inFlight++; break;
                case TransactionStatus.COMPENSATING: comp++; break;
                case TransactionStatus.COMPENSATED: compensated++; break;
                case TransactionStatus.COMPLETED: done++; break;
                case TransactionStatus.FAILED: fail++; break;
            }
        }
        return new StatusBreakdown(idle, inFlight, comp, compensated, done, fail);
    }

    public async Task<InFlightSummary> GetInFlightSummaryAsync(CancellationToken ct = default)
    {
        var breakdown = await GetStatusBreakdownAsync(ct);
        int nonTerminal = breakdown.Idle + breakdown.InFlight + breakdown.Compensating;
        var terminals = GetTerminalStates();
        return new InFlightSummary(breakdown.InFlight, nonTerminal, terminals, breakdown);
    }

    public async Task<ForceCleanUpResult> ForceCleanUpAsync(ForceCleanUpOptions options, CancellationToken ct = default)
    {
        var candidateList = options.TransactionIds != null && options.TransactionIds.Count > 0
            ? new List<TransactionRecord>()
            : await _registry.Store.ListActiveTransactionsAsync(_machine.Id, options.Limit, ct);

        if (options.TransactionIds != null && options.TransactionIds.Count > 0)
        {
            foreach (var id in options.TransactionIds)
            {
                var rec = await _registry.Store.GetTransactionAsync(id, ct);
                if (rec != null) candidateList.Add(rec);
            }
        }

        long now = _registry.Clock.NowMs();
        var matched = new List<TransactionRecord>();

        foreach (var rec in candidateList)
        {
            if (options.OlderThanMs.HasValue && (now - rec.UpdatedAt) < options.OlderThanMs.Value)
            {
                continue;
            }
            if (options.StuckOnly && rec.Status != TransactionStatus.IN_FLIGHT && rec.Status != TransactionStatus.COMPENSATING)
            {
                continue;
            }
            matched.Add(rec);
        }

        var affectedIds = matched.Select(m => m.TransactionId).ToList();
        if (options.DryRun)
        {
            return new ForceCleanUpResult(matched.Count, 0, true, options.Action, affectedIds);
        }

        int processed = 0;
        foreach (var rec in matched)
        {
            switch (options.Action)
            {
                case ForceCleanUpAction.DELETE:
                    await _registry.Store.DeleteTransactionAsync(rec.TransactionId, ct);
                    processed++;
                    break;

                case ForceCleanUpAction.MARK_FAIL:
                    rec.Status = TransactionStatus.FAILED;
                    rec.CurrentState = StateValue.Of("error");
                    rec.UpdatedAt = now;
                    rec.Version++;
                    await _registry.Store.UpdateTransactionAsync(rec, rec.Version - 1, ct);
                    processed++;
                    break;

                case ForceCleanUpAction.COMPENSATE:
                    // Unwind saga stack
                    while (true)
                    {
                        var step = await _registry.Store.PopSagaStepAsync(rec.TransactionId, ct);
                        if (step == null) break;
                        var compDel = _registry.GetCompensate(step.CompensateHandler);
                        if (compDel != null)
                        {
                            try
                            {
                                var compReq = new CompensationRequest<TContext>(
                                    rec.TransactionId,
                                    DeserializeContext(rec.ContextJson),
                                    step.StepName,
                                    step.InputSnapshotJson != null ? JsonDocument.Parse(step.InputSnapshotJson).RootElement : null,
                                    step.FromState,
                                    step.TargetState
                                );
                                await InvokeCompensationAsync(compDel, compReq, ct);
                            }
                            catch { }
                        }
                    }
                    rec.Status = TransactionStatus.FAILED;
                    rec.CurrentState = StateValue.Of("error");
                    rec.UpdatedAt = now;
                    rec.Version++;
                    await _registry.Store.UpdateTransactionAsync(rec, rec.Version - 1, ct);
                    processed++;
                    break;

                case ForceCleanUpAction.CONTINUE:
                    rec.Status = TransactionStatus.IDLE;
                    rec.UpdatedAt = now;
                    rec.Version++;
                    await _registry.Store.UpdateTransactionAsync(rec, rec.Version - 1, ct);
                    processed++;
                    break;
            }
        }

        return new ForceCleanUpResult(matched.Count, processed, false, options.Action, affectedIds);
    }
}
