using System;
using System.Collections.Generic;

namespace EKLabDev.Dfsm;

public class DfsmException : Exception
{
    public DfsmException(string message) : base(message) { }
    public DfsmException(string message, Exception innerException) : base(message, innerException) { }
}

public class ValidationException : DfsmException
{
    public IReadOnlyList<string> Errors { get; }

    public ValidationException(string message, IEnumerable<string>? errors = null) 
        : base(message)
    {
        Errors = errors != null ? new List<string>(errors) : new List<string> { message };
    }
}

public class InvalidTransitionException : DfsmException
{
    public StateValue CurrentState { get; }
    public string EventName { get; }

    public InvalidTransitionException(StateValue currentState, string eventName, string message)
        : base(message)
    {
        CurrentState = currentState;
        EventName = eventName;
    }
}

public class CircuitOpenException : DfsmException
{
    public string HandlerName { get; }

    public CircuitOpenException(string handlerName, string message) : base(message)
    {
        HandlerName = handlerName;
    }
}

public class TransactionNotFoundException : DfsmException
{
    public string TransactionId { get; }

    public TransactionNotFoundException(string transactionId) 
        : base($"Transaction '{transactionId}' was not found in state store.")
    {
        TransactionId = transactionId;
    }
}

public class StaleTransactionVersionException : DfsmException
{
    public string TransactionId { get; }
    public long ExpectedVersion { get; }
    public long ActualVersion { get; }

    public StaleTransactionVersionException(string transactionId, long expectedVersion, long actualVersion)
        : base($"Optimistic concurrency conflict on transaction '{transactionId}'. Expected version {expectedVersion}, but found {actualVersion}.")
    {
        TransactionId = transactionId;
        ExpectedVersion = expectedVersion;
        ActualVersion = actualVersion;
    }
}

public class MaxEffectChainDepthException : DfsmException
{
    public int MaxDepth { get; }

    public MaxEffectChainDepthException(int maxDepth, string message) : base(message)
    {
        MaxDepth = maxDepth;
    }
}

