use eklabdev_dfsm::actor::DfsmActor;
use eklabdev_dfsm::clock::{Clock, RealClock};
use eklabdev_dfsm::definition::parse_yaml_machine;
use eklabdev_dfsm::registry::FSMRegistry;
use eklabdev_dfsm::state_value::StateValue;
use eklabdev_dfsm::store::memory::MemoryStateStore;
use eklabdev_dfsm::store::StateStore;
use eklabdev_dfsm::types::{
    ForceCleanUpAction, ForceCleanUpOptions, TransactionRecord, TransactionStatus,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WorkerContext {
    task_id: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== DFSM Rust Example 05: Multi-Actor Ops & Sweep ===");

    let yaml = r#"
dfsm: "1.0"
id: "worker-job"
version: "1.0.0"
initial: "queued"
states:
  queued:
    on:
      DISPATCH: "processing"
  processing:
    on:
      COMPLETE: "done"
      FAIL: "failed"
  done:
    type: "final"
  failed:
    type: "final"
"#;

    let machine = parse_yaml_machine(yaml)?;
    let store = Arc::new(MemoryStateStore::new());
    let reg = FSMRegistry::new().with_store(store.clone());
    let actor = DfsmActor::<WorkerContext>::new(machine, Arc::new(reg));

    // 1. Create a set of transactions
    let _ = actor
        .transition("job-1", "DISPATCH", None::<serde_json::Value>)
        .await?;
    let _ = actor
        .transition("job-1", "COMPLETE", None::<serde_json::Value>)
        .await?; // completed

    let _ = actor
        .transition("job-2", "DISPATCH", None::<serde_json::Value>)
        .await?; // in processing (in-flight)

    let _ = actor
        .transition("job-3", "DISPATCH", None::<serde_json::Value>)
        .await?;
    let _ = actor
        .transition("job-3", "FAIL", None::<serde_json::Value>)
        .await?; // failed

    // Simulate an older stuck job created 1 hour ago
    let now = RealClock.now_ms();
    let orphan = TransactionRecord {
        transaction_id: "job-stuck-orphan".to_string(),
        machine_id: "worker-job".to_string(),
        current_state: StateValue::leaf("processing"),
        status: TransactionStatus::InFlight,
        context_json: "{}".to_string(),
        version: 1,
        created_at: now - 3600000,
        updated_at: now - 3600000,
        lease_expires_at: None,
        lease_owner: None,
        saga_stack: Vec::new(),
    };
    store.create_transaction(&orphan).await?;

    // 2. Query Status Breakdown
    let breakdown = actor.get_status_breakdown().await?;
    println!(
        "[Status Breakdown]: Idle={}, InFlight={}, Completed={}, Failed={}",
        breakdown.idle, breakdown.in_flight, breakdown.completed, breakdown.failed
    );

    // 3. Query InFlightSummary
    let summary = actor.get_in_flight_summary().await?;
    println!(
        "[InFlight Summary]: Total In-Flight={} | Non-Terminal Count={} | Terminal States={:?}",
        summary.total_in_flight, summary.non_terminal_count, summary.terminal_states
    );

    // 4. Force Cleanup of stuck jobs (> 30 mins old)
    let clean_res = actor
        .force_cleanup(ForceCleanUpOptions {
            older_than_ms: Some(1800000),
            stuck_only: true,
            action: Some(ForceCleanUpAction::MarkFail),
            ..Default::default()
        })
        .await?;
    println!(
        "[Ops Cleanup]: Processed {} stuck job(s): {:?} marked as FAILED",
        clean_res.processed_count, clean_res.affected_transaction_ids
    );

    // 5. Query updated breakdown
    let updated = actor.get_status_breakdown().await?;
    println!(
        "[Updated Breakdown]: InFlight={}, Completed={}, Failed={}",
        updated.in_flight, updated.completed, updated.failed
    );

    Ok(())
}
