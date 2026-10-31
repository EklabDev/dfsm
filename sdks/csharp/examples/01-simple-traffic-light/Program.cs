using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Runtime;

namespace EKLabDev.Dfsm.Examples;

public class Program
{
    public record TrafficContext(int Ticks, string LastColor);

    public static async Task Main(string[] args)
    {
        Console.WriteLine("=== DFSM C# Example 01: Simple Traffic Light ===");

        var machine = MachineBuilder<TrafficContext>.Create("traffic-light")
            .Initial("red")
            .State("red", s => s
                .Entry("turnOnRedBulb")
                .Exit("turnOffRedBulb")
                .On("NEXT", "green", "advanceToGreen")
                .On("SHUTDOWN", "off")
            )
            .State("green", s => s
                .On("NEXT", "yellow", "advanceToYellow")
            )
            .State("yellow", s => s
                .On("NEXT", "red", "advanceToRed")
            )
            .State("off", s => s.Type("final"))
            .Build();

        var registry = new FSMRegistry();
        registry.RegisterMachine(machine);

        registry.RegisterTransition("advanceToGreen", (TransitionRequest<TrafficContext, object> req) =>
        {
            var ctx = req.Data ?? new TrafficContext(0, "red");
            Console.WriteLine($"[Action] Advancing to green. Prev ticks: {ctx.Ticks}");
            return TransitionOutput<TrafficContext, string>.Of(new TrafficContext(ctx.Ticks + 1, "green"), "SWITCHED_TO_GREEN");
        });

        registry.RegisterTransition("advanceToYellow", (TransitionRequest<TrafficContext, object> req) =>
        {
            var ctx = req.Data ?? new TrafficContext(0, "green");
            return TransitionOutput<TrafficContext, string>.Of(new TrafficContext(ctx.Ticks + 1, "yellow"), "SWITCHED_TO_YELLOW");
        });

        registry.RegisterTransition("advanceToRed", (TransitionRequest<TrafficContext, object> req) =>
        {
            var ctx = req.Data ?? new TrafficContext(0, "yellow");
            return TransitionOutput<TrafficContext, string>.Of(new TrafficContext(ctx.Ticks + 1, "red"), "SWITCHED_TO_RED");
        });

        registry.RegisterEffect("turnOnRedBulb", (EffectRequest<TrafficContext> req) =>
        {
            Console.WriteLine("[Effect] Red bulb illuminated.");
        });

        registry.RegisterEffect("turnOffRedBulb", (EffectRequest<TrafficContext> req) =>
        {
            Console.WriteLine("[Effect] Red bulb extinguished.");
        });

        var actor = registry.CreateActor<TrafficContext>("traffic-light");
        string txId = "tx-traffic-001";

        Console.WriteLine("\n--> Sending NEXT event:");
        var res1 = await actor.TransitionAsync(txId, "NEXT");
        Console.WriteLine($"Result: state={res1.CurrentState}, status={res1.Status}, output={res1.OutputValue}");

        Console.WriteLine("\n--> Sending NEXT event:");
        var res2 = await actor.TransitionAsync(txId, "NEXT");
        Console.WriteLine($"Result: state={res2.CurrentState}, status={res2.Status}, output={res2.OutputValue}");

        Console.WriteLine("\n--> Sending NEXT event:");
        var res3 = await actor.TransitionAsync(txId, "NEXT");
        Console.WriteLine($"Result: state={res3.CurrentState}, status={res3.Status}, output={res3.OutputValue}");

        Console.WriteLine("\n--> Sending SHUTDOWN event:");
        var res4 = await actor.TransitionAsync(txId, "SHUTDOWN");
        Console.WriteLine($"Result: state={res4.CurrentState}, status={res4.Status} (COMPLETED)");

        Console.WriteLine("\nTraffic light cycle completed successfully!");
    }
}

