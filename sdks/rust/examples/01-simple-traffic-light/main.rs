use eklabdev_dfsm::actor::DfsmActor;
use eklabdev_dfsm::definition::parse_yaml_machine;
use eklabdev_dfsm::registry::FSMRegistry;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TrafficContext {
    cycle_count: usize,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== DFSM Rust Example 01: Simple Traffic Light ===");

    let yaml = r#"
dfsm: "1.0"
id: "traffic-light"
version: "1.0.0"
description: "Simple traffic light state machine in Rust"
initial: "red"
states:
  red:
    on:
      TIMER: "green"
  green:
    on:
      TIMER: "yellow"
  yellow:
    on:
      TIMER: "red"
      OFF: "off"
  off:
    type: "final"
"#;

    let machine = parse_yaml_machine(yaml)?;
    let reg = FSMRegistry::new();
    let actor = DfsmActor::<TrafficContext>::new(machine, Arc::new(reg));

    let tx_id = "traffic-light-1";

    // 1. red -> green
    let res1 = actor
        .transition(tx_id, "TIMER", None::<serde_json::Value>)
        .await?;
    println!("[1] red -> {} (Event: {})", res1.current_state, res1.event_name);

    // 2. green -> yellow
    let res2 = actor
        .transition(tx_id, "TIMER", None::<serde_json::Value>)
        .await?;
    println!("[2] green -> {} (Event: {})", res2.current_state, res2.event_name);

    // 3. yellow -> off (Final state)
    let res3 = actor
        .transition(tx_id, "OFF", None::<serde_json::Value>)
        .await?;
    println!(
        "[3] yellow -> {} (Final State! Status: {:?})",
        res3.current_state, res3.status
    );

    let state = actor.get_state(tx_id).await?;
    println!("Final Status: {:?} | State: {}", state.status, state.current_state);

    Ok(())
}

