using System;
using System.Threading;
using System.Threading.Tasks;
using EKLabDev.Dfsm.Attributes;

namespace EKLabDev.Dfsm.Policy;

public sealed record RetryPolicy(
    int MaxAttempts = 1,
    int BackoffMs = 100,
    double BackoffFactor = 2.0,
    int MaxBackoffMs = 10000,
    string Backoff = "EXPONENTIAL",
    bool Jitter = false
);

public sealed record CircuitBreakerPolicy(
    int FailureThreshold = 5,
    int RecoveryTimeoutMs = 30000,
    int HalfOpenSuccessThreshold = 2
);

public sealed record OnFailPolicy(
    string? Target = null,
    bool Compensate = false
);

public sealed record BenchmarkPolicy(
    bool Enabled = true,
    int WarnThresholdMs = 1000
);

public sealed record TransitionPolicy(
    RetryPolicy Retry,
    CircuitBreakerPolicy? CircuitBreaker,
    OnFailPolicy? OnFail,
    string? CompensateWith,
    BenchmarkPolicy Benchmark
)
{
    public static readonly TransitionPolicy Default = new(
        new RetryPolicy(1, 100, 2.0, 10000, "EXPONENTIAL", false),
        null,
        null,
        null,
        new BenchmarkPolicy(true, 1000)
    );
}

public sealed record PartialTransitionPolicy(
    int? RetryMaxAttempts = null,
    int? RetryBackoffMs = null,
    double? RetryBackoffFactor = null,
    int? RetryMaxBackoffMs = null,
    string? RetryBackoff = null,
    bool? RetryJitter = null,
    bool? RetryExplicitlyDefined = null,

    int? CbFailureThreshold = null,
    int? CbRecoveryTimeoutMs = null,
    int? CbHalfOpenSuccessThreshold = null,
    bool? CbExplicitlyDefined = null,

    string? OnFailTarget = null,
    bool? OnFailCompensate = null,
    bool? OnFailExplicitlyDefined = null,

    string? CompensateWith = null,

    bool? BenchmarkEnabled = null,
    int? BenchmarkWarnThresholdMs = null
)
{
    public static readonly PartialTransitionPolicy Empty = new();

    public static PartialTransitionPolicy FromAttributes(
        RetryAttribute? retry,
        BackoffAttribute? backoff,
        CircuitBreakerAttribute? cb,
        OnFailAttribute? onFail,
        CompensateWithAttribute? comp,
        BenchmarkAttribute? bench)
    {
        return new PartialTransitionPolicy(
            RetryMaxAttempts: retry?.MaxAttempts,
            RetryBackoffMs: backoff != null ? backoff.InitialDelayMs : retry?.BackoffMs,
            RetryBackoffFactor: backoff != null ? backoff.Factor : retry?.BackoffFactor,
            RetryMaxBackoffMs: backoff != null ? backoff.MaxDelayMs : retry?.MaxBackoffMs,
            RetryBackoff: backoff != null ? backoff.Type : retry?.Backoff,
            RetryJitter: backoff != null ? backoff.Jitter : retry?.Jitter,
            RetryExplicitlyDefined: retry != null || backoff != null,

            CbFailureThreshold: cb?.FailureThreshold,
            CbRecoveryTimeoutMs: cb?.RecoveryTimeoutMs,
            CbHalfOpenSuccessThreshold: cb?.HalfOpenSuccessThreshold,
            CbExplicitlyDefined: cb != null,

            OnFailTarget: onFail?.Target,
            OnFailCompensate: onFail?.Compensate,
            OnFailExplicitlyDefined: onFail != null,

            CompensateWith: comp?.CompensationHandler,

            BenchmarkEnabled: bench?.Enabled,
            BenchmarkWarnThresholdMs: bench?.WarnThresholdMs
        );
    }
}

public static class PolicyMerger
{
    public static TransitionPolicy Merge(
        PartialTransitionPolicy? codePolicy,
        PartialTransitionPolicy? transitionYaml,
        PartialTransitionPolicy? defaultsYaml,
        PartialTransitionPolicy? globalDefault)
    {
        var layers = new[] { codePolicy, transitionYaml, defaultsYaml, globalDefault };

        // 1. Retry: If a layer explicitly defined Retry, its settings take precedence
        int maxAttempts = 1;
        int backoffMs = 100;
        double backoffFactor = 2.0;
        int maxBackoffMs = 10000;
        string backoff = "EXPONENTIAL";
        bool jitter = false;

        foreach (var l in layers)
        {
            if (l == null) continue;
            if (l.RetryExplicitlyDefined == true || l.RetryMaxAttempts.HasValue)
            {
                maxAttempts = l.RetryMaxAttempts ?? maxAttempts;
                backoffMs = l.RetryBackoffMs ?? backoffMs;
                backoffFactor = l.RetryBackoffFactor ?? backoffFactor;
                maxBackoffMs = l.RetryMaxBackoffMs ?? maxBackoffMs;
                backoff = l.RetryBackoff ?? backoff;
                jitter = l.RetryJitter ?? jitter;
                break; // Do not multiply retry loops!
            }
        }

        // 2. Circuit Breaker
        CircuitBreakerPolicy? cbPolicy = null;
        foreach (var l in layers)
        {
            if (l == null) continue;
            if (l.CbExplicitlyDefined == true || l.CbFailureThreshold.HasValue)
            {
                cbPolicy = new CircuitBreakerPolicy(
                    FailureThreshold: l.CbFailureThreshold ?? 5,
                    RecoveryTimeoutMs: l.CbRecoveryTimeoutMs ?? 30000,
                    HalfOpenSuccessThreshold: l.CbHalfOpenSuccessThreshold ?? 2
                );
                break;
            }
        }

        // 3. OnFail
        OnFailPolicy? onFailPolicy = null;
        foreach (var l in layers)
        {
            if (l == null) continue;
            if (l.OnFailExplicitlyDefined == true || l.OnFailTarget != null || l.OnFailCompensate.HasValue)
            {
                onFailPolicy = new OnFailPolicy(
                    Target: l.OnFailTarget,
                    Compensate: l.OnFailCompensate ?? false
                );
                break;
            }
        }

        // 4. CompensateWith
        string? compWith = null;
        foreach (var l in layers)
        {
            if (l?.CompensateWith != null)
            {
                compWith = l.CompensateWith;
                break;
            }
        }

        // 5. Benchmark
        bool benchEnabled = true;
        int warnThreshold = 1000;
        foreach (var l in layers)
        {
            if (l == null) continue;
            if (l.BenchmarkEnabled.HasValue)
            {
                benchEnabled = l.BenchmarkEnabled.Value;
                warnThreshold = l.BenchmarkWarnThresholdMs ?? warnThreshold;
                break;
            }
        }

        return new TransitionPolicy(
            new RetryPolicy(maxAttempts, backoffMs, backoffFactor, maxBackoffMs, backoff, jitter),
            cbPolicy,
            onFailPolicy,
            compWith,
            new BenchmarkPolicy(benchEnabled, warnThreshold)
        );
    }
}

public sealed class CircuitBreakerInstance
{
    private enum State { Closed, Open, HalfOpen }

    private readonly CircuitBreakerPolicy _policy;
    private readonly ISystemClock _clock;
    private readonly object _lock = new();

    private State _state = State.Closed;
    private int _consecutiveFailures = 0;
    private int _consecutiveSuccesses = 0;
    private long _openedAtMs = 0;

    public CircuitBreakerInstance(CircuitBreakerPolicy policy, ISystemClock clock)
    {
        _policy = policy;
        _clock = clock;
    }

    public void BeforeExecution(string handlerName)
    {
        lock (_lock)
        {
            long now = _clock.NowMs();
            if (_state == State.Open)
            {
                if (now - _openedAtMs >= _policy.RecoveryTimeoutMs)
                {
                    _state = State.HalfOpen;
                    _consecutiveSuccesses = 0;
                }
                else
                {
                    throw new CircuitOpenException(
                        handlerName,
                        $"Circuit breaker is OPEN for handler '{handlerName}'. Wait {(_policy.RecoveryTimeoutMs - (now - _openedAtMs))}ms before retry."
                    );
                }
            }
        }
    }

    public void OnSuccess()
    {
        lock (_lock)
        {
            if (_state == State.HalfOpen)
            {
                _consecutiveSuccesses++;
                if (_consecutiveSuccesses >= _policy.HalfOpenSuccessThreshold)
                {
                    _state = State.Closed;
                    _consecutiveFailures = 0;
                    _consecutiveSuccesses = 0;
                }
            }
            else if (_state == State.Closed)
            {
                _consecutiveFailures = 0;
            }
        }
    }

    public void OnFailure()
    {
        lock (_lock)
        {
            long now = _clock.NowMs();
            if (_state == State.HalfOpen)
            {
                _state = State.Open;
                _openedAtMs = now;
                _consecutiveFailures++;
            }
            else if (_state == State.Closed)
            {
                _consecutiveFailures++;
                if (_consecutiveFailures >= _policy.FailureThreshold)
                {
                    _state = State.Open;
                    _openedAtMs = now;
                }
            }
        }
    }
}

