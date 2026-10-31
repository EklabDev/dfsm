using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Runtime;

namespace EKLabDev.Dfsm.Examples;

public class Program
{
    public record OrderFulfillmentContext(string OrderId, bool Billed, bool Packed);

    public static async Task Main(string[] args)
    {
        Console.WriteLine("=== DFSM C# Example 03: Hierarchical & Parallel Workflows with onDone ===");

        string yaml = @"
dfsm: '1.0'
id: order-fulfillment-workflow
version: '1.0.0'
description: Parallel fulfillment regions with onDone cascade into shipped state
initial: created

states:
  created:
    on:
      START_FULFILLMENT: fulfilling

  fulfilling:
    type: parallel
    states:
      billing:
        initial: pending_charge
        states:
          pending_charge:
            on:
              CHARGE_SUCCESS: charged
          charged:
            type: final
      warehouse:
        initial: picking
        states:
          picking:
            on:
              ITEM_PICKED: packed
          packed:
            type: final
    onDone: shipped

  shipped:
    type: final
";

        var machine = YamlMachineParser.Parse(yaml);
        var registry = new FSMRegistry();
        registry.RegisterMachine(machine);

        var actor = registry.CreateActor<OrderFulfillmentContext>("order-fulfillment-workflow");
        string txId = "tx-fulfill-003";

        Console.WriteLine("\n[Step 1] Initializing fulfillment -> enters parallel regions:");
        var res1 = await actor.TransitionAsync(txId, "START_FULFILLMENT");
        Console.WriteLine($"State: {res1.CurrentState}, Status: {res1.Status}");

        Console.WriteLine("\n[Step 2] Charging credit card in billing region:");
        var res2 = await actor.TransitionAsync(txId, "CHARGE_SUCCESS");
        Console.WriteLine($"State: {res2.CurrentState}, Status: {res2.Status}");

        Console.WriteLine("\n[Step 3] Picking & packing items in warehouse region -> triggers onDone:");
        var res3 = await actor.TransitionAsync(txId, "ITEM_PICKED");
        Console.WriteLine($"State: {res3.CurrentState}, Status: {res3.Status}");

        Console.WriteLine("\nNotice: Both parallel regions finished, automatically triggering onDone -> 'shipped'!");
        Console.WriteLine("Example 03 completed successfully!");
    }
}

