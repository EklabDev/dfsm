use eklabdev_dfsm::actor::DfsmActor;
use eklabdev_dfsm::circuit_breaker::{CircuitBreakerInstance, CircuitState};
use eklabdev_dfsm::clock::RealClock;
use eklabdev_dfsm::definition::parse_yaml_machine;
use eklabdev_dfsm::policy::{CircuitBreakerPolicy, PartialTransitionPolicy, PolicyMerger};
use eklabdev_dfsm::registry::FSMRegistry;
use eklabdev_dfsm::state_value::StateValue;
use eklabdev_dfsm::store::memory::MemoryStateStore;
use eklabdev_dfsm::types::{
    ForceCleanUpAction, ForceCleanUpOptions, HookType, TransactionStatus,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[test]
fn test_state_value_serialization_and_display() {
    let leaf = StateValue::leaf("idle");
    assert_eq!(leaf.to_string(), "idle");
    assert_eq!(leaf.is_leaf(), true);

    let mut map = BTreeMap::new();
    map.insert("child".to_string(), StateValue::leaf("sub_state"));
    let compound = StateValue::Compound(map);
    assert_eq!(compound.to_string(), "{\"child\":\"sub_state\"}");
    assert_eq!(compound.is_compound(), true);

    let json_str = serde_json::to_string(&compound).unwrap();
    let deserialized: StateValue = serde_json::from_str(&json_str).unwrap();
    assert_eq!(compound, deserialized);
}

#[tokio::test]
async fn test_circuit_breaker_transitions() {
    let clock = Arc::new(RealClock);
    let policy = CircuitBreakerPolicy {
        enabled: true,
        failure_threshold: 2,
        recovery_timeout_ms: 100,
        half_open_success_threshold: 1,
    };
    let cb = CircuitBreakerInstance::new(policy, clock);

    assert_eq!(cb.state(), CircuitState::Closed);
    assert!(cb.before_execution("testHandler").is_ok());

    // 1st failure
    cb.on_failure();
    assert_eq!(cb.state(), CircuitState::Closed);

    // 2nd failure -> Trips OPEN
    cb.on_failure();
    assert_eq!(cb.state(), CircuitState::Open);
    assert!(cb.before_execution("testHandler").is_err());

    // Wait 120ms for recovery duration
    tokio::time::sleep(tokio::time::Duration::from_millis(120)).await;

    // Transition to HalfOpen on request probe
    assert!(cb.before_execution("testHandler").is_ok());
    assert_eq!(cb.state(), CircuitState::HalfOpen);

    // Success in HalfOpen closes the circuit
    cb.on_success();
    assert_eq!(cb.state(), CircuitState::Closed);
}

#[test]
fn test_policy_merger_precedence() {
    let code_policy = PartialTransitionPolicy {
        retry_max_attempts: Some(4),
        retry_defined: true,
        ..Default::default()
    };

    let trans_policy = PartialTransitionPolicy {
        retry_max_attempts: Some(3),
        retry_defined: true,
        cb_enabled: Some(true),
        cb_failure_threshold: Some(3),
        cb_defined: true,
        ..Default::default()
    };

    let defaults_policy = PartialTransitionPolicy {
        retry_max_attempts: Some(2),
        retry_defined: true,
        on_fail_target: Some("error_queue".to_string()),
        on_fail_defined: true,
        ..Default::default()
    };

    let merged = PolicyMerger::merge(&[
        Some(&code_policy),
        Some(&trans_policy),
        Some(&defaults_policy),
        None,
    ]);

    // Code takes precedence for retry
    assert_eq!(merged.retry.max_attempts, 4);

    // Transition policy defines circuit breaker
    assert!(merged.circuit_breaker.is_some());
    assert_eq!(merged.circuit_breaker.as_ref().unwrap().failure_threshold, 3);

    // Machine defaults defines onFail target
    assert!(merged.on_fail.is_some());
    assert_eq!(
        merged.on_fail.as_ref().unwrap().target.as_deref(),
        Some("error_queue")
    );
}

#[tokio::test]
async fn test_lifecycle_hooks_and_actor_execution() {
    let yaml = r#"
dfsm: "1.0"
id: test-lifecycle
initial: start

states:
  start:
    on:
      SUBMIT:
        target: finished
        transition: doWork
  finished:
    type: final
"#;

    let machine = parse_yaml_machine(yaml).expect("Valid machine");
    let reg = FSMRegistry::new().with_store(Arc::new(MemoryStateStore::new()));

    let before_count = Arc::new(AtomicUsize::new(0));
    let after_count = Arc::new(AtomicUsize::new(0));
    let complete_count = Arc::new(AtomicUsize::new(0));
    let terminal_count = Arc::new(AtomicUsize::new(0));

    let bc = before_count.clone();
    reg.register_hook(
        HookType::BeforeTransition,
        Box::new(move |_ev| {
            bc.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {})
        }),
    );

    let ac = after_count.clone();
    reg.register_hook(
        HookType::AfterTransition,
        Box::new(move |_ev| {
            ac.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {})
        }),
    );

    let cc = complete_count.clone();
    reg.register_hook(
        HookType::OnComplete,
        Box::new(move |_ev| {
            cc.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {})
        }),
    );

    let tc = terminal_count.clone();
    reg.register_hook(
        HookType::OnTerminal,
        Box::new(move |_ev| {
            tc.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {})
        }),
    );

    reg.register_transition(
        "doWork",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                let mut data = ctx.as_object().cloned().unwrap_or_default();
                data.insert("done".to_string(), json!(true));
                Ok((Some(json!(data)), Some(json!({"result": "success"}))))
            })
        }),
        None,
    );

    let actor = DfsmActor::<serde_json::Value>::new(machine, Arc::new(reg));
    let tx_id = "tx-lifecycle-1";

    let res = actor
        .transition(tx_id, "SUBMIT", Some(json!({"param": 42})))
        .await
        .expect("Transition succeeded");

    assert_eq!(res.current_state, StateValue::leaf("finished"));
    assert_eq!(res.status, TransactionStatus::Completed);
    assert_eq!(before_count.load(Ordering::SeqCst), 1);
    assert_eq!(after_count.load(Ordering::SeqCst), 1);
    assert_eq!(complete_count.load(Ordering::SeqCst), 1);
    assert_eq!(terminal_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn test_ops_monitoring_and_cleanup() {
    let yaml = r#"
dfsm: "1.0"
id: test-ops
initial: pending

states:
  pending:
    on:
      ADVANCE: active
  active:
    on:
      DONE: completed
      FAIL: failed
  completed:
    type: final
  failed:
    type: final
"#;

    let machine = parse_yaml_machine(yaml).expect("Valid machine");
    let store = Arc::new(MemoryStateStore::new());
    let reg = FSMRegistry::new().with_store(store.clone());
    let actor = DfsmActor::<serde_json::Value>::new(machine, Arc::new(reg));

    // 1. Advance tx-1 to active
    let _ = actor
        .transition("tx-1", "ADVANCE", None::<serde_json::Value>)
        .await
        .unwrap();

    // 2. Complete tx-2
    let _ = actor
        .transition("tx-2", "ADVANCE", None::<serde_json::Value>)
        .await
        .unwrap();
    let _ = actor
        .transition("tx-2", "DONE", None::<serde_json::Value>)
        .await
        .unwrap();

    // Check summary
    let summary = actor.get_in_flight_summary().await.unwrap();
    assert_eq!(summary.non_terminal_count, 1); // tx-1 is active (IDLE non-terminal)
    assert!(summary.terminal_states.contains(&"completed".to_string()));
    assert!(summary.terminal_states.contains(&"failed".to_string()));

    // Force cleanup on tx-1 (stuck)
    let cleaned = actor
        .force_cleanup(ForceCleanUpOptions {
            transaction_ids: vec!["tx-1".to_string()],
            action: Some(ForceCleanUpAction::MarkFail),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(cleaned.processed_count, 1);

    let summary_after = actor.get_in_flight_summary().await.unwrap();
    assert_eq!(summary_after.non_terminal_count, 0);
}
