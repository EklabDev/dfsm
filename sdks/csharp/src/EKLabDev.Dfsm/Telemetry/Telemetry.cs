using System;

namespace EKLabDev.Dfsm.Telemetry;

public sealed record BenchmarkEvent(
    string TransactionId,
    string MachineId,
    string EventName,
    string HandlerName,
    int Attempts,
    string Outcome,
    long DurationMs,
    StateValue PreviousState,
    StateValue CurrentState,
    string? ErrorMessage = null
);

public interface IBenchmarkLogEngine
{
    void Record(BenchmarkEvent evt);
    void Log(string message);
}

public class ConsoleBenchmarkLogEngine : IBenchmarkLogEngine
{
    public static readonly ConsoleBenchmarkLogEngine Instance = new();

    public void Record(BenchmarkEvent evt)
    {
        var line = $"[DFSM-STEP] tx={evt.TransactionId} | event={evt.EventName} | handler={evt.HandlerName} | attempts={evt.Attempts} | outcome={evt.Outcome} ({evt.DurationMs}ms) | {evt.PreviousState} -> {evt.CurrentState}";
        if (!string.IsNullOrEmpty(evt.ErrorMessage))
        {
            line += $" | error=\"{evt.ErrorMessage}\"";
        }
        Console.WriteLine(line);
    }

    public void Log(string message)
    {
        Console.WriteLine(message);
    }
}

public class NoOpBenchmarkLogEngine : IBenchmarkLogEngine
{
    public static readonly NoOpBenchmarkLogEngine Instance = new();

    public void Record(BenchmarkEvent evt) { }
    public void Log(string message) { }
}

