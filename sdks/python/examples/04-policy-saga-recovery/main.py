from __future__ import annotations

import asyncio
from dataclasses import dataclass

from dfsm import (
    CompensationRequest,
    DfsmActor,
    FSMRegistry,
    PartialTransitionPolicy,
    TransitionRequest,
    parse_yaml_machine,
)


@dataclass
class BookingContext:
    flight_booked: bool = False
    hotel_booked: bool = False
    car_booked: bool = False


async def main() -> None:
    print("=== DFSM Python Example 04: Policy, LIFO Saga & Recovery ===")

    yaml_str = """
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
"""

    machine = parse_yaml_machine(yaml_str)
    reg = FSMRegistry()

    # Step 1: Flight succeeds
    async def book_flight(req: TransitionRequest) -> dict:
        print(">> [Step 1] Flight successfully booked")
        return {"flight_booked": True}

    async def cancel_flight(req: CompensationRequest) -> None:
        print("<< [Saga Rollback] Flight booking CANCELLED")

    reg.register_transition("bookFlight", book_flight)
    reg.register_compensate("cancelFlight", cancel_flight)

    # Step 2: Hotel succeeds
    async def book_hotel(req: TransitionRequest) -> dict:
        print(">> [Step 2] Hotel successfully booked")
        return {"flight_booked": True, "hotel_booked": True}

    async def cancel_hotel(req: CompensationRequest) -> None:
        print("<< [Saga Rollback] Hotel booking CANCELLED")

    reg.register_transition("bookHotel", book_hotel)
    reg.register_compensate("cancelHotel", cancel_hotel)

    # Step 3: Car fails with retry -> Triggers LIFO compensation
    attempts = 0

    async def book_car(req: TransitionRequest) -> dict:
        nonlocal attempts
        attempts += 1
        print(f">> [Step 3] Attempting Car Rental (Attempt {attempts})...")
        raise RuntimeError("Rental car inventory depleted")

    async def cancel_car(req: CompensationRequest) -> None:
        print("<< [Saga Rollback] Car rental CANCELLED")

    reg.register_transition(
        "bookCar",
        book_car,
        PartialTransitionPolicy(retry_max_attempts=2, retry_defined=True),
    )
    reg.register_compensate("cancelCar", cancel_car)

    actor = DfsmActor[BookingContext](machine, reg)
    tx_id = "vacation-booking-1"

    # Advance Flight
    r1 = await actor.transition(tx_id, "BOOK_FLIGHT")
    print(f"[1] -> {r1.current_state} (Status: {r1.status.value})")

    # Advance Hotel
    r2 = await actor.transition(tx_id, "BOOK_HOTEL")
    print(f"[2] -> {r2.current_state} (Status: {r2.status.value})")

    # Advance Car (fails after 2 attempts, triggers LIFO Saga rollback)
    r3 = await actor.transition(tx_id, "BOOK_CAR")
    print(
        f"[3] -> {r3.current_state} (Status: {r3.status.value}, "
        f"Compensated Steps: {r3.compensated_steps}, Rollback: {r3.rollback_occurred})"
    )

    # Error recovery
    r4 = await actor.transition(tx_id, "RECOVER")
    print(f"[4] -> {r4.current_state} (Status: {r4.status.value} - RECOVERED)")


if __name__ == "__main__":
    asyncio.run(main())

