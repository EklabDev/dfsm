using System;
using System.Threading;
using System.Threading.Tasks;

namespace EKLabDev.Dfsm;

public interface ISystemClock
{
    long NowMs();
    Task SleepAsync(long durationMs, CancellationToken cancellationToken = default);
}

public sealed class RealSystemClock : ISystemClock
{
    public static readonly RealSystemClock Instance = new();

    public long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public Task SleepAsync(long durationMs, CancellationToken cancellationToken = default)
    {
        if (durationMs <= 0) return Task.CompletedTask;
        return Task.Delay((int)durationMs, cancellationToken);
    }
}

public sealed class VirtualClock : ISystemClock
{
    private long _currentTimeMs;

    public VirtualClock(long initialTimeMs = 1000)
    {
        _currentTimeMs = initialTimeMs;
    }

    public long NowMs() => Interlocked.Read(ref _currentTimeMs);

    public void Advance(long deltaMs)
    {
        Interlocked.Add(ref _currentTimeMs, deltaMs);
    }

    public void SetTime(long timeMs)
    {
        Interlocked.Exchange(ref _currentTimeMs, timeMs);
    }

    public Task SleepAsync(long durationMs, CancellationToken cancellationToken = default)
    {
        Advance(durationMs);
        return Task.CompletedTask;
    }
}

