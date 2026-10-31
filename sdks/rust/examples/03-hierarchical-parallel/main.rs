use eklabdev_dfsm::actor::DfsmActor;
use eklabdev_dfsm::definition::parse_yaml_machine;
use eklabdev_dfsm::registry::FSMRegistry;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct FulfillmentContext {
    tracking_number: String,
    invoice_id: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== DFSM Rust Example 03: Parallel Regions & onDone ===");

    let yaml = r#"
dfsm: "1.0"
id: "fulfillment-process"
version: "1.0.0"
initial: "fulfilling"
states:
  fulfilling:
    type: "parallel"
    onDone: "completed"
    states:
      shipping:
        initial: "pending"
        states:
          pending:
            on:
              SHIP: "dispatched"
          dispatched:
            type: "final"
      billing:
        initial: "unpaid"
        states:
          unpaid:
            on:
              PAY: "settled"
          settled:
            type: "final"
  completed:
    type: "final"
"#;

    let machine = parse_yaml_machine(yaml)?;
    let reg = FSMRegistry::new();
    let actor = DfsmActor::<FulfillmentContext>::new(machine, Arc::new(reg));

    let tx_id = "order-fulfillment-1";

    // 1. Initial parallel state
    let state0 = actor.start(tx_id, None).await?;
    println!("Initial State: {}", state0.current_state);

    // 2. Dispatch shipping region
    let res1 = actor
        .transition(tx_id, "SHIP", None::<serde_json::Value>)
        .await?;
    println!(
        "[1] SHIP -> {} (Status: {:?})",
        res1.current_state, res1.status
    );

    // 3. Settle billing region -> triggers onDone -> completed!
    let res2 = actor
        .transition(tx_id, "PAY", None::<serde_json::Value>)
        .await?;
    println!(
        "[2] PAY -> {} (Status: {:?} - onDone triggered!)",
        res2.current_state, res2.status
    );

    let final_state = actor.get_state(tx_id).await?;
    println!(
        "Final Transaction State: {} | Status: {:?}",
        final_state.current_state, final_state.status
    );

    Ok(())
}
