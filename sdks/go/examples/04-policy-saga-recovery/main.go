package main

import (
	"context"
	"fmt"

	"github.com/eklabdev/dfsm/sdks/go"
)

type BookingContext struct {
	FlightBooked bool `json:"flightBooked"`
	HotelBooked  bool `json:"hotelBooked"`
	CarBooked    bool `json:"carBooked"`
}

func main() {
	yamlDef := `
dfsm: "1.0"
id: "trip-booking-saga"
version: "1.0.0"
initial: "booking_flight"
defaults:
  onFail:
    compensate: true
    target: "error"
states:
  booking_flight:
    on:
      BOOK_FLIGHT:
        target: "booking_hotel"
        transition: "bookFlight"
        compensate: "cancelFlight"
  booking_hotel:
    on:
      BOOK_HOTEL:
        target: "booking_car"
        transition: "bookHotel"
        compensate: "cancelHotel"
  booking_car:
    on:
      BOOK_CAR:
        target: "confirmed"
        transition: "bookCar"
        compensate: "cancelCar"
  confirmed:
    type: "final"
  error:
    on:
      RECOVER: "booking_flight"
`

	machine, err := dfsm.ParseYamlMachine(yamlDef)
	if err != nil {
		panic(err)
	}

	reg := dfsm.NewFSMRegistry()

	// Step 1: Flight succeeds
	reg.RegisterTransition("bookFlight", func(ctx context.Context, req dfsm.TransitionRequest[BookingContext, any]) (dfsm.TransitionOutput[BookingContext, any], error) {
		req.Data.FlightBooked = true
		fmt.Println(">> [Step 1] Flight successfully booked")
		return dfsm.OutputWithContext[BookingContext, any](req.Data), nil
	}, nil)

	reg.RegisterCompensate("cancelFlight", func(ctx context.Context, req dfsm.CompensationRequest[BookingContext]) {
		fmt.Println("<< [Saga Rollback] Flight booking CANCELLED")
	})

	// Step 2: Hotel succeeds
	reg.RegisterTransition("bookHotel", func(ctx context.Context, req dfsm.TransitionRequest[BookingContext, any]) (dfsm.TransitionOutput[BookingContext, any], error) {
		req.Data.HotelBooked = true
		fmt.Println(">> [Step 2] Hotel successfully booked")
		return dfsm.OutputWithContext[BookingContext, any](req.Data), nil
	}, nil)

	reg.RegisterCompensate("cancelHotel", func(ctx context.Context, req dfsm.CompensationRequest[BookingContext]) {
		fmt.Println("<< [Saga Rollback] Hotel booking CANCELLED")
	})

	// Step 3: Car fails -> Triggers LIFO compensation
	attempts := 0
	reg.RegisterTransition("bookCar", func(ctx context.Context, req dfsm.TransitionRequest[BookingContext, any]) (dfsm.TransitionOutput[BookingContext, any], error) {
		attempts++
		fmt.Printf(">> [Step 3] Attempting Car Rental (Attempt %d)...\n", attempts)
		return dfsm.OutputEmpty[BookingContext, any](), fmt.Errorf("rental car inventory depleted")
	}, &dfsm.PartialTransitionPolicy{
		RetryMaxAttempts: func(i int) *int { return &i }(2),
		RetryDefined:     true,
	})

	reg.RegisterCompensate("cancelCar", func(ctx context.Context, req dfsm.CompensationRequest[BookingContext]) {
		fmt.Println("<< [Saga Rollback] Car rental CANCELLED")
	})

	actor := dfsm.NewDfsmActor[BookingContext](machine, reg)
	ctx := context.Background()
	txId := "vacation-booking-1"

	fmt.Println("=== DFSM Go Example 04: Policy, LIFO Saga & Recovery ===")

	// Advance flight & hotel
	_, _ = actor.Transition(ctx, txId, "BOOK_FLIGHT", nil)
	_, _ = actor.Transition(ctx, txId, "BOOK_HOTEL", nil)

	// Car fails -> Unwinds Hotel then Flight (LIFO order!)
	_, err = actor.Transition(ctx, txId, "BOOK_CAR", nil)
	fmt.Printf("[Outcome]: %v\n", err)

	stateAfterError, _ := actor.GetState(ctx, txId)
	fmt.Printf("State after failure: %s | Status: %s | Saga Stack Depth: %d\n",
		stateAfterError.CurrentState, stateAfterError.Status, stateAfterError.SagaStackDepth)

	// Recover back to booking_flight
	resRecover, err := actor.Transition(ctx, txId, "RECOVER", nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("[Recovery]: Transitioned back to %s (Status: %s)\n", resRecover.CurrentState, resRecover.Status)
}
