use eklabdev_dfsm::*;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Deserialize)]
struct ConformanceSuite {
    scenarios: Vec<Scenario>,
}

#[derive(Debug, Deserialize)]
struct Scenario {
    id: String,
    file: String,
    #[serde(rename = "machineId")]
    _machine_id: String,
    description: String,
    #[serde(rename = "expectedInitialState")]
    _expected_initial_state: serde_json::Value,
    steps: Option<Vec<Step>>,
    #[serde(rename = "decoratorOverrides")]
    decorator_overrides: Option<serde_json::Value>,
    #[serde(rename = "expectedEffectiveMaxAttempts")]
    expected_effective_max_attempts: Option<usize>,
    #[serde(rename = "expectedEffectiveCircuitBreakerEnabled")]
    expected_effective_circuit_breaker_enabled: Option<bool>,
    #[serde(rename = "expectedCompensationOrder")]
    expected_compensation_order: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct Step {
    event: String,
    input: Option<serde_json::Value>,
    #[serde(rename = "expectedState")]
    expected_state: serde_json::Value,
    #[serde(rename = "expectedStatus")]
    expected_status: Option<String>,
}

#[tokio::test]
async fn test_canonical_conformance_suite() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let suite_path = manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("spec")
        .join("conformance")
        .join("conformance-suite.json");

    let suite_json = fs::read_to_string(&suite_path).expect("Read conformance-suite.json");
    let suite: ConformanceSuite = serde_json::from_str(&suite_json).expect("Parse conformance suite");

    let conf_dir = suite_path.parent().unwrap();

    for scenario in suite.scenarios {
        println!("=== Running Scenario: {} - {} ===", scenario.id, scenario.description);

        let yaml_path = conf_dir.join(&scenario.file);
        let yaml_str = fs::read_to_string(&yaml_path).expect("Read scenario YAML");
        let machine = parse_yaml_machine(&yaml_str).expect("Parse machine YAML");

        let reg = Arc::new(FSMRegistry::new());
        let compensation_log = Arc::new(Mutex::new(Vec::<String>::new()));

        // Standard transitions
        for tx_name in [
            "conformance.traffic.recordStep",
            "conformance.hierarchy.beginAuth",
            "conformance.hierarchy.captureFunds",
            "conformance.hierarchy.markCancelled",
            "conformance.parallel.initFulfillment",
            "conformance.parallel.recordPaid",
            "conformance.parallel.recordPacked",
            "conformance.saga.bookFlight",
            "conformance.saga.bookHotel",
        ] {
            reg.register_transition(
                tx_name,
                Box::new(|_tx, ctx, in_val, _st, _ev| {
                    Box::pin(async move {
                        let mut merged = ctx.as_object().cloned().unwrap_or_default();
                        if let Some(in_obj) = in_val.and_then(|v| v.as_object().cloned()) {
                            for (k, v) in in_obj {
                                merged.insert(k, v);
                            }
                        }
                        Ok((Some(serde_json::Value::Object(merged)), None))
                    })
                }),
                None,
            );
        }

        // Failure transitions
        for fail_name in [
            "conformance.traffic.brokenBulb",
            "conformance.resilience.callPrimary",
            "conformance.resilience.alwaysFail",
            "conformance.saga.bookCar",
        ] {
            let fn_name = fail_name.to_string();
            let mut policy_override = None;

            if let Some(overrides) = &scenario.decorator_overrides {
                if let Some(ov) = overrides.get(fail_name) {
                    if let Some(ret) = ov.get("retry") {
                        if let Some(ma) = ret.get("maxAttempts").and_then(|v| v.as_u64()) {
                            policy_override = Some(PartialTransitionPolicy {
                                retry_max_attempts: Some(ma as usize),
                                retry_defined: true,
                                ..Default::default()
                            });
                        }
                    }
                }
            }

            reg.register_transition(
                fail_name,
                Box::new(move |_tx, _ctx, in_val, _st, _ev| {
                    let fname = fn_name.clone();
                    Box::pin(async move {
                        let mut should_fail = true;
                        if let Some(in_obj) = in_val.and_then(|v| v.as_object().cloned()) {
                            if let Some(f) = in_obj.get("fail") {
                                if let Some(b) = f.as_bool() {
                                    if !b {
                                        should_fail = false;
                                    }
                                }
                            }
                        }
                        if should_fail {
                            Err(DfsmError::ExecutionFailed(format!("Simulated failure in {}", fname)))
                        } else {
                            Ok((None, None))
                        }
                    })
                }),
                policy_override,
            );
        }

        // Compensations
        for comp_name in [
            "conformance.saga.cancelFlight",
            "conformance.saga.cancelHotel",
            "conformance.saga.cancelCar",
        ] {
            let cn = comp_name.to_string();
            let log_clone = compensation_log.clone();
            reg.register_compensate(
                comp_name,
                Box::new(move |_req| {
                    let c = cn.clone();
                    let l = log_clone.clone();
                    Box::pin(async move {
                        l.lock().unwrap().push(c);
                    })
                }),
            );
        }

        // Test policy merge check for scenario 04
        if scenario.id == "policy-merge-decorator-precedence-and-fallback" {
            let mut decorator_retry = None;
            if let Some(dec) = &scenario.decorator_overrides {
                if let Some(cp) = dec.get("conformance.resilience.callPrimary") {
                    if let Some(ret) = cp.get("retry") {
                        if let Some(ma) = ret.get("maxAttempts").and_then(|v| v.as_u64()) {
                            decorator_retry = Some(ma as usize);
                        }
                    }
                }
            }

            let trans_pol = machine
                .states
                .get("ready")
                .and_then(|s| s.on.get("CALL_PRIMARY"))
                .and_then(|tv| match tv {
                    eklabdev_dfsm::definition::TransitionValue::Detailed(d) => d.to_partial_policy(),
                    eklabdev_dfsm::definition::TransitionValue::Multiple(v) => {
                        v.first().and_then(|d| d.to_partial_policy())
                    }
                    _ => None,
                });

            let merged = PolicyMerger::merge(&[
                Some(&PartialTransitionPolicy {
                    retry_max_attempts: decorator_retry,
                    retry_defined: decorator_retry.is_some(),
                    ..Default::default()
                }),
                trans_pol.as_ref(),
                machine.defaults.as_ref(),
                None,
            ]);

            if let Some(expected_ma) = scenario.expected_effective_max_attempts {
                assert_eq!(expected_ma, merged.retry.max_attempts);
            }
            if let Some(expected_cb) = scenario.expected_effective_circuit_breaker_enabled {
                assert_eq!(
                    expected_cb,
                    merged.circuit_breaker.map(|cb| cb.enabled).unwrap_or(false)
                );
            }
        }

        let actor = DfsmActor::<serde_json::Value>::new(machine, reg);
        let tx_id = format!("tx-{}", scenario.id);

        if let Some(steps) = scenario.steps {
            for step in steps {
                let res = actor.transition(&tx_id, &step.event, step.input).await;
                assert!(res.is_ok(), "Step '{}' failed: {:?}", step.event, res.err());
                let result = res.unwrap();

                let expected_sv: StateValue =
                    serde_json::from_value(step.expected_state.clone()).expect("Deser expected StateValue");
                assert_eq!(
                    expected_sv, result.current_state,
                    "State mismatch for event '{}'",
                    step.event
                );

                if let Some(exp_status) = step.expected_status {
                    assert_eq!(exp_status, result.status.to_string());
                }
            }
        }

        // Verify compensation order if specified
        if let Some(expected_order) = scenario.expected_compensation_order {
            let actual_order = compensation_log.lock().unwrap().clone();
            assert_eq!(expected_order, actual_order);
        }
    }
}
