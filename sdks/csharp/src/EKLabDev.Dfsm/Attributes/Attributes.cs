using System;

namespace EKLabDev.Dfsm.Attributes;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true, Inherited = true)]
public class DfsmTransitionAttribute : Attribute
{
    public string EventName { get; }

    public DfsmTransitionAttribute(string eventName)
    {
        EventName = eventName ?? throw new ArgumentNullException(nameof(eventName));
    }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public class DfsmCompensateAttribute : Attribute
{
    public string Name { get; }

    public DfsmCompensateAttribute(string name)
    {
        Name = name ?? throw new ArgumentNullException(nameof(name));
    }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public class DfsmEffectAttribute : Attribute
{
    public string Name { get; }

    public DfsmEffectAttribute(string name)
    {
        Name = name ?? throw new ArgumentNullException(nameof(name));
    }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true, Inherited = true)]
public class DfsmHookAttribute : Attribute
{
    public HookType HookType { get; }

    public DfsmHookAttribute(HookType hookType)
    {
        HookType = hookType;
    }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public class RetryAttribute : Attribute
{
    public int MaxAttempts { get; set; } = 3;
    public int BackoffMs { get; set; } = 100;
    public double BackoffFactor { get; set; } = 2.0;
    public int MaxBackoffMs { get; set; } = 10000;
    public string Backoff { get; set; } = "EXPONENTIAL";
    public bool Jitter { get; set; } = false;

    public RetryAttribute(int maxAttempts = 3)
    {
        MaxAttempts = maxAttempts;
    }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public class BackoffAttribute : Attribute
{
    public string Type { get; set; } = "EXPONENTIAL";
    public int InitialDelayMs { get; set; } = 100;
    public double Factor { get; set; } = 2.0;
    public int MaxDelayMs { get; set; } = 10000;
    public bool Jitter { get; set; } = false;

    public BackoffAttribute(string type = "EXPONENTIAL")
    {
        Type = type;
    }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public class CircuitBreakerAttribute : Attribute
{
    public int FailureThreshold { get; set; } = 5;
    public int RecoveryTimeoutMs { get; set; } = 30000;
    public int HalfOpenSuccessThreshold { get; set; } = 2;

    public CircuitBreakerAttribute(int failureThreshold = 5)
    {
        FailureThreshold = failureThreshold;
    }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public class OnFailAttribute : Attribute
{
    public string? Target { get; set; }
    public bool Compensate { get; set; }

    public OnFailAttribute(string? target = null, bool compensate = false)
    {
        Target = target;
        Compensate = compensate;
    }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public class CompensateWithAttribute : Attribute
{
    public string CompensationHandler { get; }

    public CompensateWithAttribute(string compensationHandler)
    {
        CompensationHandler = compensationHandler ?? throw new ArgumentNullException(nameof(compensationHandler));
    }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public class BenchmarkAttribute : Attribute
{
    public bool Enabled { get; set; } = true;
    public int WarnThresholdMs { get; set; } = 1000;

    public BenchmarkAttribute(bool enabled = true, int warnThresholdMs = 1000)
    {
        Enabled = enabled;
        WarnThresholdMs = warnThresholdMs;
    }
}

