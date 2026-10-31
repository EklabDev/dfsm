using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Attributes;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Runtime;

namespace EKLabDev.Dfsm.Examples;

public class Program
{
    public class BookingContext
    {
        public string? FlightRef { get; set; }
        public string? HotelRef { get; set; }
    }

    public class TravelBookingService
    {
        [DfsmTransition("bookFlight")]
        [CompensateWith("cancelFlight")]
        public TransitionOutput<BookingContext, string> BookFlight(TransitionRequest<BookingContext, object> req)
        {
            var ctx = req.Data ?? new BookingContext();
            ctx.FlightRef = "FL-9911";
            Console.WriteLine("[Step 1] Flight booked: FL-9911. Compensation 'cancelFlight' pushed to Saga stack.");
            return TransitionOutput<BookingContext, string>.Of(ctx, "FLIGHT_BOOKED");
        }

        [DfsmCompensate("cancelFlight")]
        public void CancelFlight(CompensationRequest<BookingContext> req)
        {
            Console.WriteLine($"[SAGA-ROLLBACK] Cancelled flight for tx: {req.TransactionId}");
        }

        [DfsmTransition("bookHotel")]
        [CompensateWith("cancelHotel")]
        public TransitionOutput<BookingContext, string> BookHotel(TransitionRequest<BookingContext, object> req)
        {
            var ctx = req.Data ?? new BookingContext();
            ctx.HotelRef = "HOTEL-PARIS-204";
            Console.WriteLine("[Step 2] Hotel booked: HOTEL-PARIS-204. Compensation 'cancelHotel' pushed to Saga stack.");
            return TransitionOutput<BookingContext, string>.Of(ctx, "HOTEL_BOOKED");
        }

        [DfsmCompensate("cancelHotel")]
        public void CancelHotel(CompensationRequest<BookingContext> req)
        {
            Console.WriteLine($"[SAGA-ROLLBACK] Cancelled hotel for tx: {req.TransactionId}");
        }

        // Code attribute @Retry(4) overrides YAML retry: 2, but does NOT multiply!
        [DfsmTransition("bookCar")]
        [Retry(4, BackoffMs = 20)]
        [OnFail(compensate: true, target: "error")]
        public TransitionOutput<BookingContext, string> BookCar(TransitionRequest<BookingContext, object> req)
        {
            Console.WriteLine("[Step 3] Attempting car rental API (simulating out-of-cars outage)...");
            throw new Exception("Rental fleet unavailable! Out of stock.");
        }
    }

    public static async Task Main(string[] args)
    {
        Console.WriteLine("=== DFSM C# Example 04: Policy Precedence & LIFO Saga Compensation ===");

        string yaml = @"
dfsm: '1.0'
id: travel-saga-machine
version: '1.0.0'
description: Multi-step travel booking with automatic LIFO Saga rollback
initial: flight_step

registry:
  namespace: 'travel'
  strict: true

defaults:
  retry:
    maxAttempts: 2

states:
  flight_step:
    on:
      BOOK_FLIGHT:
        target: hotel_step
        transition: bookFlight
        compensate: cancelFlight

  hotel_step:
    on:
      BOOK_HOTEL:
        target: car_step
        transition: bookHotel
        compensate: cancelHotel

  car_step:
    on:
      BOOK_CAR:
        target: confirmed
        transition: bookCar
        onFail:
          compensate: true
          target: error

  confirmed:
    type: final

  error:
    type: final
";

        var machine = YamlMachineParser.Parse(yaml);
        var registry = new FSMRegistry();
        registry.RegisterMachine(machine);
        registry.RegisterAnnotatedHandlers(new TravelBookingService());

        var actor = registry.CreateActor<BookingContext>("travel-saga-machine");
        string txId = "tx-saga-004";

        Console.WriteLine("\n--> 1. Booking Flight:");
        await actor.TransitionAsync(txId, "BOOK_FLIGHT");

        Console.WriteLine("\n--> 2. Booking Hotel:");
        await actor.TransitionAsync(txId, "BOOK_HOTEL");

        Console.WriteLine("\n--> 3. Booking Car (will retry 4 times and trigger LIFO Saga unwind):");
        var res3 = await actor.TransitionAsync(txId, "BOOK_CAR");

        Console.WriteLine($"\nFinal state: {res3.CurrentState}, Status: {res3.Status}");
        Console.WriteLine($"Compensated steps unwound: {res3.CompensatedSteps}, Rollback triggered: {res3.RollbackTriggered}");
        Console.WriteLine("\nNotice: Saga unwound in reverse LIFO order: 'cancelHotel' first, then 'cancelFlight'!");
        Console.WriteLine("Example 04 completed successfully!");
    }
}
