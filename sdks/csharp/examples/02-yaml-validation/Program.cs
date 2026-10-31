using System;
using System.ComponentModel.DataAnnotations;
using System.Threading.Tasks;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Attributes;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Runtime;

namespace EKLabDev.Dfsm.Examples;

public class Program
{
    public class OrderContext
    {
        public string OrderId { get; set; } = string.Empty;
        public string Email { get; set; } = string.Empty;
        public decimal Total { get; set; }
    }

    public class PlaceOrderInput
    {
        [Required(ErrorMessage = "Customer email is required.")]
        [EmailAddress(ErrorMessage = "A valid email address is required.")]
        public string Email { get; set; } = string.Empty;

        [Range(10, 5000, ErrorMessage = "Total amount must be between $10 and $5000.")]
        public decimal Amount { get; set; }
    }

    public class CheckoutService
    {
        [DfsmTransition("placeOrder")]
        public TransitionOutput<OrderContext, string> PlaceOrder(TransitionRequest<OrderContext, PlaceOrderInput> req)
        {
            var ctx = new OrderContext
            {
                OrderId = req.TransactionId,
                Email = req.Input.Email,
                Total = req.Input.Amount
            };
            Console.WriteLine($"[Service] Order placed successfully for {ctx.Email} (${ctx.Total}).");
            return TransitionOutput<OrderContext, string>.Of(ctx, "ORDER_CREATED");
        }
    }

    public static async Task Main(string[] args)
    {
        Console.WriteLine("=== DFSM C# Example 02: YAML Definition & DataAnnotations Validation ===");

        string yaml = @"
dfsm: '1.0'
id: order-validation-machine
version: '1.0.0'
description: YAML-driven order placement with DataAnnotations pre-flight validation
initial: awaiting_order

registry:
  namespace: 'orders'
  strict: true

states:
  awaiting_order:
    on:
      SUBMIT_ORDER:
        target: processing
        transition: placeOrder

  processing:
    type: final
";

        var machine = YamlMachineParser.Parse(yaml);
        var registry = new FSMRegistry();
        registry.RegisterMachine(machine);
        registry.RegisterAnnotatedHandlers(new CheckoutService());

        var actor = registry.CreateActor<OrderContext>("order-validation-machine");
        string txId = "tx-order-002";

        Console.WriteLine("\n[Test 1] Attempting invalid submission (invalid email, amount = -5):");
        try
        {
            await actor.TransitionAsync(txId, "SUBMIT_ORDER", new PlaceOrderInput
            {
                Email = "not-an-email",
                Amount = -5
            });
        }
        catch (ValidationException ex)
        {
            Console.WriteLine($"[Caught ValidationException as expected]: {ex.Message}");
        }

        Console.WriteLine("\n[Test 2] Submitting valid order input (jane@example.com, $150):");
        var res = await actor.TransitionAsync(txId, "SUBMIT_ORDER", new PlaceOrderInput
        {
            Email = "jane@example.com",
            Amount = 150
        });

        Console.WriteLine($"Result: state={res.CurrentState}, status={res.Status}, output={res.OutputValue}");
        var state = await actor.GetStateAsync(txId);
        Console.WriteLine($"Persisted Context: Email={(state.Context as OrderContext)?.Email}, Total={(state.Context as OrderContext)?.Total}");
        Console.WriteLine("\nExample 02 completed successfully!");
    }
}

