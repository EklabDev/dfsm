use eklabdev_dfsm::actor::DfsmActor;
use eklabdev_dfsm::definition::parse_yaml_machine;
use eklabdev_dfsm::error::DfsmError;
use eklabdev_dfsm::policy::PartialTransitionPolicy;
use eklabdev_dfsm::registry::FSMRegistry;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct BookingContext {
    flight_booked: bool,
    hotel_booked: bool,
    car_booked: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== DFSM Rust Example 04: Policy, LIFO Saga & Recovery ===");

    let yaml = r#"
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
"#;

    let machine = parse_yaml_machine(yaml)?;
    let reg = FSMRegistry::new();

    // Step 1: Flight succeeds
    reg.register_transition(
        "bookFlight",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                let mut data: BookingContext = serde_json::from_value(ctx).unwrap_or_default();
                data.flight_booked = true;
                println!(">> [Step 1] Flight successfully booked");
                Ok((Some(serde_json::to_value(&data).unwrap()), None))
            })
        }),
        None,
    );

    reg.register_compensate(
        "cancelFlight",
        Box::new(|_req| {
            Box::pin(async move {
                println!("<< [Saga Rollback] Flight booking CANCELLED");
            })
        }),
    );

    // Step 2: Hotel succeeds
    reg.register_transition(
        "bookHotel",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                let mut data: BookingContext = serde_json::from_value(ctx).unwrap_or_default();
                data.hotel_booked = true;
                println!(">> [Step 2] Hotel successfully booked");
                Ok((Some(serde_json::to_value(&data).unwrap()), None))
            })
        }),
        None,
    );

    reg.register_compensate(
        "cancelHotel",
        Box::new(|_req| {
            Box::pin(async move {
                println!("<< [Saga Rollback] Hotel booking CANCELLED");
            })
        }),
    );

    // Step 3: Car fails with retry -> Triggers LIFO compensation
    let attempts = Arc::new(AtomicUsize::new(0));
    let att_clone = attempts.clone();
    reg.register_transition(
        "bookCar",
        Box::new(move |_tx, _ctx, _in, _st, _ev| {
            let count = att_clone.fetch_add(1, Ordering::SeqCst) + 1;
            Box::pin(async move {
                println!(">> [Step 3] Attempting Car Rental (Attempt {})...", count);
                Err(DfsmError::ExecutionFailed(
                    "Rental car inventory depleted".to_string(),
                ))
            })
        }),
        Some(PartialTransitionPolicy {
            retry_max_attempts: Some(2),
            retry_defined: true,
            ..Default::default()
        }),
    );

    reg.register_compensate(
        "cancelCar",
        Box::new(|_req| {
            Box::pin(async move {
                println!("<< [Saga Rollback] Car rental CANCELLED");
            })
        }),
    );

    let actor = DfsmActor::<BookingContext>::new(machine, Arc::new(reg));
    let tx_id = "vacation-booking-1";

    // Advance Flight
    let r1 = actor
        .transition(tx_id, "BOOK_FLIGHT", None::<serde_json::Value>)
        .await?;
    println!("[1] -> {} (Status: {:?})", r1.current_state, r1.status);

    // Advance Hotel
    let r2 = actor
        .transition(tx_id, "BOOK_HOTEL", None::<serde_json::Value>)
        .await?;
    println!("[2] -> {} (Status: {:?})", r2.current_state, r2.status);

    // Advance Car (fails, retried twice, triggers LIFO Saga rollback)
    let r3 = actor
        .transition(tx_id, "BOOK_CAR", None::<serde_json::Value>)
        .await?;
    println!(
        "[3] -> {} (Status: {:?}, Compensated Steps: {}, Rollback: {})",
        r3.current_state, r3.status, r3.compensated_steps, r3.rollback_occurred
    );

    // Error recovery back to initial state
    let r4 = actor
        .transition(tx_id, "RECOVER", None::<serde_json::Value>)
        .await?;
    println!(
        "[4] -> {} (Status: {:?} - RECOVERED)",
        r4.current_state, r4.status
    );

    Ok(())
}
