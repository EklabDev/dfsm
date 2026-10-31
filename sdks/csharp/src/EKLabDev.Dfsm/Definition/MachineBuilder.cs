using System;
using System.Collections.Generic;
using EKLabDev.Dfsm.Policy;

namespace EKLabDev.Dfsm.Definition;

public class MachineBuilder<TContext>
{
    private readonly MachineDefinition _machine = new();

    public static MachineBuilder<TContext> Create(string id)
    {
        var builder = new MachineBuilder<TContext>();
        builder._machine.Id = id;
        return builder;
    }

    public MachineBuilder<TContext> Initial(string initial)
    {
        _machine.Initial = initial;
        return this;
    }

    public MachineBuilder<TContext> Description(string desc)
    {
        _machine.Description = desc;
        return this;
    }

    public MachineBuilder<TContext> MaxEffectChainDepth(int depth)
    {
        _machine.MaxEffectChainDepth = depth;
        return this;
    }

    public MachineBuilder<TContext> State(string name, Action<StateBuilder<TContext>> configure)
    {
        var stateBuilder = new StateBuilder<TContext>(name);
        configure(stateBuilder);
        _machine.States[name] = stateBuilder.Build();
        return this;
    }

    public MachineDefinition Build()
    {
        if (string.IsNullOrEmpty(_machine.Initial))
        {
            throw new ValidationException($"Machine '{_machine.Id}' must define an initial state.");
        }
        if (!_machine.States.ContainsKey("error"))
        {
            _machine.States["error"] = new StateDefinition { Id = "error", Type = "final" };
        }
        return _machine;
    }
}

public class StateBuilder<TContext>
{
    private readonly StateDefinition _state = new();

    public StateBuilder(string id)
    {
        _state.Id = id;
    }

    public StateBuilder<TContext> Type(string type)
    {
        _state.Type = type;
        return this;
    }

    public StateBuilder<TContext> Initial(string initial)
    {
        _state.Initial = initial;
        return this;
    }

    public StateBuilder<TContext> Entry(params string[] actions)
    {
        _state.Entry.AddRange(actions);
        return this;
    }

    public StateBuilder<TContext> Exit(params string[] actions)
    {
        _state.Exit.AddRange(actions);
        return this;
    }

    public StateBuilder<TContext> On(string eventName, string target, string? handler = null, Action<TransitionPolicyBuilder>? policyConfig = null)
    {
        if (!_state.On.TryGetValue(eventName, out var list))
        {
            list = new List<TransitionDefinition>();
            _state.On[eventName] = list;
        }

        PartialTransitionPolicy? policy = null;
        if (policyConfig != null)
        {
            var pBuilder = new TransitionPolicyBuilder();
            policyConfig(pBuilder);
            policy = pBuilder.Build();
        }

        list.Add(new TransitionDefinition
        {
            Target = target,
            Handler = handler,
            Policy = policy
        });
        return this;
    }

    public StateBuilder<TContext> OnDone(string target, string? handler = null)
    {
        _state.OnDone ??= new List<TransitionDefinition>();
        _state.OnDone.Add(new TransitionDefinition { Target = target, Handler = handler });
        return this;
    }

    public StateBuilder<TContext> State(string name, Action<StateBuilder<TContext>> configure)
    {
        var child = new StateBuilder<TContext>(name);
        configure(child);
        _state.States[name] = child.Build();
        return this;
    }

    public StateDefinition Build() => _state;
}

public class TransitionPolicyBuilder
{
    private int? _retryAttempts;
    private int? _backoffMs;
    private double? _backoffFactor;
    private int? _maxBackoffMs;
    private string? _backoff;
    private bool? _jitter;
    private bool? _retryDefined;

    private int? _cbFailure;
    private int? _cbRecovery;
    private int? _cbSuccess;
    private bool? _cbDefined;

    private string? _onFailTarget;
    private bool? _onFailCompensate;
    private bool? _onFailDefined;

    private string? _compensateWith;
    private bool? _benchmarkEnabled;
    private int? _warnThreshold;

    public TransitionPolicyBuilder Retry(int maxAttempts = 3, int backoffMs = 100, double factor = 2.0, int maxBackoffMs = 10000, string backoff = "EXPONENTIAL", bool jitter = false)
    {
        _retryAttempts = maxAttempts;
        _backoffMs = backoffMs;
        _backoffFactor = factor;
        _maxBackoffMs = maxBackoffMs;
        _backoff = backoff;
        _jitter = jitter;
        _retryDefined = true;
        return this;
    }

    public TransitionPolicyBuilder CircuitBreaker(int failureThreshold = 5, int recoveryTimeoutMs = 30000, int successThreshold = 2)
    {
        _cbFailure = failureThreshold;
        _cbRecovery = recoveryTimeoutMs;
        _cbSuccess = successThreshold;
        _cbDefined = true;
        return this;
    }

    public TransitionPolicyBuilder OnFail(string? target = null, bool compensate = false)
    {
        _onFailTarget = target;
        _onFailCompensate = compensate;
        _onFailDefined = true;
        return this;
    }

    public TransitionPolicyBuilder CompensateWith(string handler)
    {
        _compensateWith = handler;
        return this;
    }

    public TransitionPolicyBuilder Benchmark(bool enabled = true, int warnThresholdMs = 1000)
    {
        _benchmarkEnabled = enabled;
        _warnThreshold = warnThresholdMs;
        return this;
    }

    public PartialTransitionPolicy Build()
    {
        return new PartialTransitionPolicy(
            RetryMaxAttempts: _retryAttempts,
            RetryBackoffMs: _backoffMs,
            RetryBackoffFactor: _backoffFactor,
            RetryMaxBackoffMs: _maxBackoffMs,
            RetryBackoff: _backoff,
            RetryJitter: _jitter,
            RetryExplicitlyDefined: _retryDefined,
            CbFailureThreshold: _cbFailure,
            CbRecoveryTimeoutMs: _cbRecovery,
            CbHalfOpenSuccessThreshold: _cbSuccess,
            CbExplicitlyDefined: _cbDefined,
            OnFailTarget: _onFailTarget,
            OnFailCompensate: _onFailCompensate,
            OnFailExplicitlyDefined: _onFailDefined,
            CompensateWith: _compensateWith,
            BenchmarkEnabled: _benchmarkEnabled,
            BenchmarkWarnThresholdMs: _warnThreshold
        );
    }
}

