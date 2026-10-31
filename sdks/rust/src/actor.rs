use crate::circuit_breaker::CircuitBreakerInstance;
use crate::definition::MachineDefinition;
use crate::error::DfsmError;
use crate::policy::PolicyMerger;
use crate::registry::FSMRegistry;
use crate::state_value::StateValue;
use crate::statechart::StatechartEngine;
use crate::telemetry::BenchmarkEvent;
use crate::types::*;
use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::HashMap;
use std::marker::PhantomData;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

pub struct DfsmActor<TContext> {
    machine: Arc<MachineDefinition>,
    registry: Arc<FSMRegistry>,
    circuit_breakers: Arc<RwLock<HashMap<String, Arc<CircuitBreakerInstance>>>>,
    _phantom: PhantomData<TContext>,
}

impl<TContext> DfsmActor<TContext>
where
    TContext: Serialize + DeserializeOwned + Default + Clone + Send + Sync + 'static,
{
    pub fn new(machine: MachineDefinition, registry: Arc<FSMRegistry>) -> Arc<Self> {
        Arc::new(Self {
            machine: Arc::new(machine),
            registry,
            circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
            _phantom: PhantomData,
        })
    }

    pub fn machine_id(&self) -> &str {
        &self.machine.id
    }

    pub fn machine(&self) -> &MachineDefinition {
        &self.machine
    }

    pub fn get_terminal_states(&self) -> Vec<String> {
        StatechartEngine::get_terminal_states(&self.machine)
    }

    pub fn get_available_events(&self, state: &StateValue) -> Vec<String> {
        StatechartEngine::get_available_events(&self.machine, state)
    }

    pub async fn start(
        &self,
        tx_id: &str,
        initial_context: Option<TContext>,
    ) -> Result<ActorStateRecord<TContext>, DfsmError> {
        if let Some(_existing) = self.registry.store.get_transaction(tx_id).await? {
            return self.get_state(tx_id).await;
        }

        let init_res = StatechartEngine::resolve_initial_state(&self.machine);
        let now = self.registry.clock.now_ms();
        let ctx = initial_context.unwrap_or_default();
        let ctx_json = serde_json::to_string(&ctx).unwrap_or_else(|_| "{}".to_string());

        let rec = TransactionRecord {
            transaction_id: tx_id.to_string(),
            machine_id: self.machine.id.clone(),
            current_state: init_res.state_value.clone(),
            status: TransactionStatus::Idle,
            context_json: ctx_json,
            version: 1,
            created_at: now,
            updated_at: now,
            lease_expires_at: None,
            lease_owner: None,
            saga_stack: Vec::new(),
        };

        self.registry.store.create_transaction(&rec).await?;

        self.fire_hook(
            HookType::OnStart,
            serde_json::to_value(OnStartEvent {
                transaction_id: tx_id.to_string(),
                initial_state: init_res.state_value.clone(),
            })
            .unwrap_or_default(),
        )
        .await;

        self.get_state(tx_id).await
    }

    pub async fn get_state(&self, tx_id: &str) -> Result<ActorStateRecord<TContext>, DfsmError> {
        let rec = self
            .registry
            .store
            .get_transaction(tx_id)
            .await?
            .ok_or_else(|| DfsmError::TransactionNotFound {
                tx_id: tx_id.to_string(),
            })?;

        let user_ctx: TContext = if rec.context_json.is_empty() || rec.context_json == "{}" {
            TContext::default()
        } else {
            serde_json::from_str(&rec.context_json).unwrap_or_default()
        };

        let available = StatechartEngine::get_available_events(&self.machine, &rec.current_state);

        Ok(ActorStateRecord {
            transaction_id: rec.transaction_id,
            machine_id: rec.machine_id,
            current_state: rec.current_state,
            status: rec.status,
            context: user_ctx,
            version: rec.version,
            created_at: rec.created_at,
            updated_at: rec.updated_at,
            available_events: available,
            saga_stack_depth: rec.saga_stack.len(),
        })
    }

    pub async fn transition<TInput>(
        self: &Arc<Self>,
        tx_id: &str,
        event: &str,
        input: Option<TInput>,
    ) -> Result<TransitionExecutionResult, DfsmError>
    where
        TInput: Serialize + Send + 'static,
    {
        let input_val = input.map(|i| serde_json::to_value(i).unwrap_or(serde_json::Value::Null));
        self.transition_internal(tx_id, event, input_val, 0).await
    }

    async fn transition_internal(
        self: &Arc<Self>,
        tx_id: &str,
        event: &str,
        input_val: Option<serde_json::Value>,
        depth: usize,
    ) -> Result<TransitionExecutionResult, DfsmError> {
        // 1. Guard recursion depth
        if depth >= self.machine.max_effect_chain_depth {
            return Err(DfsmError::MaxEffectChainDepthExceeded {
                max_depth: self.machine.max_effect_chain_depth,
                tx_id: tx_id.to_string(),
            });
        }

        // 2. Load or initialize transaction
        let mut rec = match self.registry.store.get_transaction(tx_id).await? {
            Some(r) => r,
            None => {
                let init_res = StatechartEngine::resolve_initial_state(&self.machine);
                let now = self.registry.clock.now_ms();
                let initial_rec = TransactionRecord {
                    transaction_id: tx_id.to_string(),
                    machine_id: self.machine.id.clone(),
                    current_state: init_res.state_value.clone(),
                    status: TransactionStatus::Idle,
                    context_json: serde_json::to_string(&TContext::default()).unwrap_or_else(|_| "{}".to_string()),
                    version: 1,
                    created_at: now,
                    updated_at: now,
                    lease_expires_at: None,
                    lease_owner: None,
                    saga_stack: Vec::new(),
                };
                self.registry.store.create_transaction(&initial_rec).await?;

                // Fire OnStart hook
                self.fire_hook(
                    HookType::OnStart,
                    serde_json::to_value(OnStartEvent {
                        transaction_id: tx_id.to_string(),
                        initial_state: initial_rec.current_state.clone(),
                    })
                    .unwrap_or_default(),
                )
                .await;

                // Run initial entry effects
                for eff in init_res.entry_effects {
                    let _ = self
                        .run_effect_internal(tx_id, &TContext::default(), event, &initial_rec.current_state, &eff, None, depth)
                        .await;
                }

                initial_rec
            }
        };

        // 3. Terminal status check
        if rec.status == TransactionStatus::Completed || rec.status == TransactionStatus::Failed {
            return Err(DfsmError::InvalidTransition {
                state: rec.current_state.clone(),
                event: event.to_string(),
                message: format!(
                    "Cannot process event '{}' because transaction '{}' is in terminal status '{}' (state: {})",
                    event, tx_id, rec.status, rec.current_state
                ),
            });
        }

        // 4. Resolve transition for event
        let matched_list =
            StatechartEngine::resolve_transitions_for_event(&self.machine, &rec.current_state, event);
        if matched_list.is_empty() {
            return Err(DfsmError::InvalidTransition {
                state: rec.current_state.clone(),
                event: event.to_string(),
                message: format!(
                    "No transition found for event '{}' from state '{}' in machine '{}'",
                    event, rec.current_state, self.machine.id
                ),
            });
        }

        let matched = matched_list[0].clone();
        let handler_name = matched
            .edge
            .transition
            .clone()
            .unwrap_or_else(|| event.to_string());

        // 5. Merge policies
        let reg_tx = self.registry.find_transition(&handler_name);
        let code_pol = reg_tx.as_ref().and_then(|r| r.policy.as_ref());
        let trans_pol = matched.policy.as_ref();
        let def_pol = self.machine.defaults.as_ref();
        let global_pol = self.registry.global_policy.as_ref();

        let policy = PolicyMerger::merge(&[code_pol, trans_pol, def_pol, global_pol]);

        // 6. Fire BeforeTransition hook
        self.fire_hook(
            HookType::BeforeTransition,
            serde_json::to_value(BeforeTransitionEvent {
                transaction_id: tx_id.to_string(),
                current_state: rec.current_state.clone(),
                event_name: event.to_string(),
            })
            .unwrap_or_default(),
        )
        .await;

        // Mark IN_FLIGHT
        let original_version = rec.version;
        rec.status = TransactionStatus::InFlight;
        rec.updated_at = self.registry.clock.now_ms();
        rec.version = original_version + 1;
        self.registry
            .store
            .update_transaction(&rec, original_version)
            .await?;
        let in_flight_version = rec.version;

        // 7. Execute Handler with Retry & Circuit Breaker
        let cb_instance = if let Some(cb_pol) = &policy.circuit_breaker {
            if cb_pol.enabled {
                let mut cbs = self.circuit_breakers.write().unwrap();
                let inst = cbs
                    .entry(handler_name.clone())
                    .or_insert_with(|| {
                        Arc::new(CircuitBreakerInstance::new(
                            cb_pol.clone(),
                            self.registry.clock.clone(),
                        ))
                    })
                    .clone();
                Some(inst)
            } else {
                None
            }
        } else {
            None
        };

        let start_time = Instant::now();
        let mut attempts = 0;
        let mut last_err: Option<DfsmError> = None;
        let mut handler_output: Option<serde_json::Value> = None;
        let original_ctx_json = rec.context_json.clone();

        let user_ctx: TContext = if rec.context_json.is_empty() || rec.context_json == "{}" {
            TContext::default()
        } else {
            serde_json::from_str(&rec.context_json).unwrap_or_default()
        };
        let mut current_ctx = user_ctx.clone();

        if let Some(reg) = reg_tx {
            if let Some(cb) = &cb_instance {
                if let Err(e) = cb.before_execution(&handler_name) {
                    return Err(e);
                }
            }

            let max_attempts = policy.retry.max_attempts;
            for attempt in 1..=max_attempts {
                attempts = attempt;
                let ctx_val = serde_json::to_value(&current_ctx).unwrap_or_default();
                let res = (reg.handler)(
                    tx_id.to_string(),
                    ctx_val,
                    input_val.clone(),
                    rec.current_state.clone(),
                    event.to_string(),
                )
                .await;

                match res {
                    Ok((updated_ctx_opt, out_opt)) => {
                        last_err = None;
                        handler_output = out_opt;
                        if let Some(new_ctx_val) = updated_ctx_opt {
                            if let Ok(deser) = serde_json::from_value(new_ctx_val.clone()) {
                                current_ctx = deser;
                                rec.context_json = new_ctx_val.to_string();
                            }
                        }
                        if let Some(cb) = &cb_instance {
                            cb.on_success();
                        }
                        break;
                    }
                    Err(e) => {
                        last_err = Some(e);
                        if let Some(cb) = &cb_instance {
                            cb.on_failure();
                        }
                        if attempt < max_attempts {
                            let delay = self.calculate_backoff_delay(attempt, &policy.retry);
                            self.registry.clock.sleep(Duration::from_millis(delay));
                        }
                    }
                }
            }
        } else {
            attempts = 1;
        }

        let duration_ms = start_time.elapsed().as_millis() as i64;

        // 8. Handle Success
        if last_err.is_none() {
            let prev_state = rec.current_state.clone();
            let target_name = matched
                .edge
                .target
                .as_deref()
                .unwrap_or(matched.source_path.last().map(|s| s.as_str()).unwrap_or(""));

            let applied = StatechartEngine::apply_target_transition(
                &self.machine,
                &rec.current_state,
                &matched.source_path,
                target_name,
            );
            rec.current_state = applied.next_state_value;

            // Push Saga step if compensation configured
            if let Some(comp_name) = &matched.edge.compensate {
                let in_snap_str = input_val.as_ref().map(|v| v.to_string());
                let step = SagaStepRecord {
                    step_id: format!("{}-{}", tx_id, self.registry.clock.now_ms()),
                    step_name: handler_name.clone(),
                    compensate_handler: comp_name.clone(),
                    from_state: prev_state.clone(),
                    target_state: rec.current_state.clone(),
                    input_snapshot_json: in_snap_str,
                    context_before_json: Some(original_ctx_json),
                    timestamp: self.registry.clock.now_ms(),
                };
                self.registry.store.push_saga_step(tx_id, step).await?;
            }

            // Cascade onDone
            while let Some(pending) = StatechartEngine::find_pending_on_done(&self.machine, &rec.current_state) {
                if let Some(target) = &pending.edge.target {
                    let on_done_applied = StatechartEngine::apply_target_transition(
                        &self.machine,
                        &rec.current_state,
                        &pending.source_path,
                        target,
                    );
                    rec.current_state = on_done_applied.next_state_value;
                } else {
                    break;
                }
            }

            // Check if final
            let is_final = match &rec.current_state {
                StateValue::Leaf(leaf) => self
                    .machine
                    .states
                    .get(leaf)
                    .map(|s| s.is_final())
                    .unwrap_or(false),
                _ => false,
            };

            rec.status = if is_final {
                TransactionStatus::Completed
            } else {
                TransactionStatus::Idle
            };
            rec.updated_at = self.registry.clock.now_ms();
            rec.version = in_flight_version + 1;

            self.registry
                .store
                .update_transaction(&rec, in_flight_version)
                .await?;

            // Record benchmark
            self.registry.benchmark.record(BenchmarkEvent {
                transaction_id: tx_id.to_string(),
                machine_id: self.machine.id.clone(),
                event_name: event.to_string(),
                handler_name: handler_name.clone(),
                attempts,
                outcome: "SUCCESS".to_string(),
                duration_ms,
                previous_state: prev_state.clone(),
                current_state: rec.current_state.clone(),
                error_message: None,
            });

            // Fire AfterTransition hook
            self.fire_hook(
                HookType::AfterTransition,
                serde_json::to_value(AfterTransitionEvent {
                    transaction_id: tx_id.to_string(),
                    event_name: event.to_string(),
                    previous_state: prev_state.clone(),
                    current_state: rec.current_state.clone(),
                    status: rec.status,
                    compensated_steps: 0,
                })
                .unwrap_or_default(),
            )
            .await;

            if rec.status == TransactionStatus::Completed {
                self.fire_hook(
                    HookType::OnComplete,
                    serde_json::to_value(OnCompleteEvent {
                        transaction_id: tx_id.to_string(),
                        final_state: rec.current_state.clone(),
                    })
                    .unwrap_or_default(),
                )
                .await;

                self.fire_hook(
                    HookType::OnTerminal,
                    serde_json::to_value(OnTerminalEvent {
                        transaction_id: tx_id.to_string(),
                        final_state: rec.current_state.clone(),
                        status: rec.status,
                    })
                    .unwrap_or_default(),
                )
                .await;
            }

            // Run exit & entry effects
            for eff in applied.exit_effects {
                let _ = self
                    .run_effect_internal(tx_id, &current_ctx, event, &rec.current_state, &eff, None, depth)
                    .await;
            }
            for eff in applied.entry_effects {
                let _ = self
                    .run_effect_internal(tx_id, &current_ctx, event, &rec.current_state, &eff, None, depth)
                    .await;
            }

            return Ok(TransitionExecutionResult {
                transaction_id: tx_id.to_string(),
                event_name: event.to_string(),
                previous_state: prev_state,
                current_state: rec.current_state,
                status: rec.status,
                version: rec.version,
                output_value: handler_output,
                compensated_steps: 0,
                rollback_occurred: false,
            });
        }

        // 9. Handle Failure & Saga Compensation Rollback
        let err_msg = last_err.as_ref().map(|e| e.to_string()).unwrap_or_default();
        self.registry.benchmark.record(BenchmarkEvent {
            transaction_id: tx_id.to_string(),
            machine_id: self.machine.id.clone(),
            event_name: event.to_string(),
            handler_name: handler_name.clone(),
            attempts,
            outcome: "FAILED".to_string(),
            duration_ms,
            previous_state: rec.current_state.clone(),
            current_state: rec.current_state.clone(),
            error_message: Some(err_msg),
        });

        let mut compensated_steps = 0;
        let rollback_triggered = policy
            .on_fail
            .as_ref()
            .map(|of| of.compensate)
            .unwrap_or(false);

        if rollback_triggered {
            rec.status = TransactionStatus::Compensating;
            let stack = self.registry.store.get_saga_stack(tx_id).await?;
            let mut remaining = stack.len();

            while remaining > 0 {
                let step = match self.registry.store.pop_saga_step(tx_id).await? {
                    Some(s) => s,
                    None => break,
                };

                if let Some(comp_fn) = self.registry.find_compensate(&step.compensate_handler) {
                    let in_snap: Option<serde_json::Value> = step
                        .input_snapshot_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok());

                    let comp_req = CompensationRequest {
                        transaction_id: tx_id.to_string(),
                        context: serde_json::to_value(&current_ctx).unwrap_or_default(),
                        step_name: step.step_name.clone(),
                        input_snapshot: in_snap,
                        from_state: step.from_state.clone(),
                        target_state: step.target_state.clone(),
                    };

                    comp_fn(comp_req).await;

                    if let Some(ctx_before) = &step.context_before_json {
                        if let Ok(restored) = serde_json::from_str(ctx_before) {
                            current_ctx = restored;
                            rec.context_json = ctx_before.clone();
                        }
                    }
                }

                compensated_steps += 1;
                remaining -= 1;

                self.fire_hook(
                    HookType::OnCompensate,
                    serde_json::to_value(OnCompensateEvent {
                        transaction_id: tx_id.to_string(),
                        step_name: step.step_name,
                        from_state: step.from_state,
                        target_state: step.target_state,
                        steps_remaining: remaining,
                    })
                    .unwrap_or_default(),
                )
                .await;
            }
        }

        let fail_target = policy
            .on_fail
            .as_ref()
            .and_then(|of| of.target.clone())
            .unwrap_or_else(|| "error".to_string());

        let fail_applied = StatechartEngine::apply_target_transition(
            &self.machine,
            &rec.current_state,
            &matched.source_path,
            &fail_target,
        );
        rec.current_state = fail_applied.next_state_value;

        // If target is error or final
        rec.status = if rollback_triggered {
            TransactionStatus::Compensated
        } else {
            TransactionStatus::Failed
        };
        rec.updated_at = self.registry.clock.now_ms();
        rec.version = in_flight_version + 1;

        self.registry
            .store
            .update_transaction(&rec, in_flight_version)
            .await?;

        self.fire_hook(
            HookType::OnTerminal,
            serde_json::to_value(OnTerminalEvent {
                transaction_id: tx_id.to_string(),
                final_state: rec.current_state.clone(),
                status: rec.status,
            })
            .unwrap_or_default(),
        )
        .await;

        Ok(TransitionExecutionResult {
            transaction_id: tx_id.to_string(),
            event_name: event.to_string(),
            previous_state: rec.current_state.clone(),
            current_state: rec.current_state,
            status: rec.status,
            version: rec.version,
            output_value: None,
            compensated_steps,
            rollback_occurred: rollback_triggered,
        })
    }

    async fn run_effect_internal(
        self: &Arc<Self>,
        tx_id: &str,
        user_ctx: &TContext,
        event: &str,
        state: &StateValue,
        effect_name: &str,
        _payload: Option<serde_json::Value>,
        depth: usize,
    ) -> Result<(), DfsmError> {
        if let Some(eff_fn) = self.registry.find_effect(effect_name) {
            let self_clone = self.clone();
            let tx_clone = tx_id.to_string();
            let event_clone = event.to_string();
            let state_clone = state.clone();

            let runner = Arc::new(move |sub_eff: String, sub_payload: Option<serde_json::Value>| {
                let s = self_clone.clone();
                let tid = tx_clone.clone();
                let ev = event_clone.clone();
                let st = state_clone.clone();
                tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(async move {
                        s.run_effect_internal(&tid, &TContext::default(), &ev, &st, &sub_eff, sub_payload, depth + 1).await
                    })
                })
            });

            let eff_req = EffectRequest {
                transaction_id: tx_id.to_string(),
                context: serde_json::to_value(user_ctx).unwrap_or_default(),
                event_name: event.to_string(),
                state: state.clone(),
                actor: self.clone(),
                runner,
            };

            eff_fn(eff_req).await
        } else {
            Ok(())
        }
    }

    async fn fire_hook(&self, hook_type: HookType, payload: serde_json::Value) {
        let hooks = self.registry.get_hooks(hook_type);
        for h in hooks {
            h(payload.clone()).await;
        }
    }

    fn calculate_backoff_delay(&self, attempt: usize, retry: &crate::policy::RetryPolicy) -> u64 {
        let delay = if retry.backoff.eq_ignore_ascii_case("LINEAR") {
            retry.backoff_ms * attempt as u64
        } else if retry.backoff.eq_ignore_ascii_case("FIXED") {
            retry.backoff_ms
        } else {
            (retry.backoff_ms as f64 * retry.backoff_factor.powi((attempt as i32) - 1)) as u64
        };
        std::cmp::min(delay, retry.max_backoff_ms)
    }

    // --- Ops APIs ---

    pub async fn get_status_breakdown(&self) -> Result<StatusBreakdown, DfsmError> {
        let all = self
            .registry
            .store
            .list_all_transactions(&self.machine.id, 5000)
            .await?;
        let mut b = StatusBreakdown::default();
        for r in all {
            match r.status {
                TransactionStatus::Idle => b.idle += 1,
                TransactionStatus::InFlight => b.in_flight += 1,
                TransactionStatus::Compensating => b.compensating += 1,
                TransactionStatus::Compensated => b.compensated += 1,
                TransactionStatus::Completed => b.completed += 1,
                TransactionStatus::Failed => b.failed += 1,
            }
        }
        Ok(b)
    }

    pub async fn get_in_flight_summary(&self) -> Result<InFlightSummary, DfsmError> {
        let b = self.get_status_breakdown().await?;
        let non_terminal = b.idle + b.in_flight + b.compensating;
        let terminals = self.get_terminal_states();
        Ok(InFlightSummary {
            total_in_flight: b.in_flight,
            non_terminal_count: non_terminal,
            terminal_states: terminals,
            breakdown: b,
        })
    }

    pub async fn list_active_transactions(
        &self,
        limit: usize,
    ) -> Result<Vec<TransactionRecord>, DfsmError> {
        self.registry
            .store
            .list_active_transactions(&self.machine.id, limit)
            .await
    }

    pub async fn force_cleanup(
        &self,
        opts: ForceCleanUpOptions,
    ) -> Result<ForceCleanUpResult, DfsmError> {
        let candidates = if !opts.transaction_ids.is_empty() {
            let mut list = Vec::new();
            for id in &opts.transaction_ids {
                if let Some(rec) = self.registry.store.get_transaction(id).await? {
                    list.push(rec);
                }
            }
            list
        } else {
            self.registry
                .store
                .list_active_transactions(&self.machine.id, opts.limit.unwrap_or(500))
                .await?
        };

        let now = self.registry.clock.now_ms();
        let mut matched = Vec::new();
        for rec in candidates {
            if let Some(older_than) = opts.older_than_ms {
                if (now - rec.updated_at) < older_than {
                    continue;
                }
            }
            if opts.stuck_only
                && rec.status != TransactionStatus::InFlight
                && rec.status != TransactionStatus::Compensating
            {
                continue;
            }
            matched.push(rec);
        }

        let affected_ids: Vec<String> = matched.iter().map(|m| m.transaction_id.clone()).collect();
        if opts.dry_run {
            return Ok(ForceCleanUpResult {
                matched_count: matched.len(),
                processed_count: 0,
                dry_run: true,
                action: opts.action,
                affected_transaction_ids: affected_ids,
            });
        }

        let mut processed = 0;
        let action = opts.action.unwrap_or(ForceCleanUpAction::MarkFail);
        for mut rec in matched {
            match action {
                ForceCleanUpAction::Delete => {
                    self.registry.store.delete_transaction(&rec.transaction_id).await?;
                    processed += 1;
                }
                ForceCleanUpAction::MarkFail => {
                    let old_ver = rec.version;
                    rec.status = TransactionStatus::Failed;
                    rec.current_state = StateValue::leaf("error");
                    rec.updated_at = now;
                    rec.version = old_ver + 1;
                    self.registry.store.update_transaction(&rec, old_ver).await?;
                    processed += 1;
                }
                ForceCleanUpAction::Compensate => {
                    while let Some(step) = self.registry.store.pop_saga_step(&rec.transaction_id).await? {
                        if let Some(comp_fn) = self.registry.find_compensate(&step.compensate_handler) {
                            let in_snap: Option<serde_json::Value> = step
                                .input_snapshot_json
                                .as_deref()
                                .and_then(|s| serde_json::from_str(s).ok());
                            let comp_req = CompensationRequest {
                                transaction_id: rec.transaction_id.clone(),
                                context: serde_json::from_str(&rec.context_json).unwrap_or_default(),
                                step_name: step.step_name,
                                input_snapshot: in_snap,
                                from_state: step.from_state,
                                target_state: step.target_state,
                            };
                            comp_fn(comp_req).await;
                        }
                    }
                    let old_ver = rec.version;
                    rec.status = TransactionStatus::Failed;
                    rec.current_state = StateValue::leaf("error");
                    rec.updated_at = now;
                    rec.version = old_ver + 1;
                    self.registry.store.update_transaction(&rec, old_ver).await?;
                    processed += 1;
                }
                ForceCleanUpAction::Continue => {
                    let old_ver = rec.version;
                    rec.status = TransactionStatus::Idle;
                    rec.updated_at = now;
                    rec.version = old_ver + 1;
                    self.registry.store.update_transaction(&rec, old_ver).await?;
                    processed += 1;
                }
            }
        }

        Ok(ForceCleanUpResult {
            matched_count: processed,
            processed_count: processed,
            dry_run: false,
            action: Some(action),
            affected_transaction_ids: affected_ids,
        })
    }
}

#[async_trait]
impl<TContext> IDfsmActor for DfsmActor<TContext>
where
    TContext: Serialize + DeserializeOwned + Default + Clone + Send + Sync + 'static,
{
    fn machine_id(&self) -> &str {
        &self.machine.id
    }

    async fn transition_raw(
        &self,
        tx_id: &str,
        event: &str,
        input: Option<serde_json::Value>,
    ) -> Result<TransitionExecutionResult, DfsmError> {
        let actor_arc = Arc::new(Self {
            machine: self.machine.clone(),
            registry: self.registry.clone(),
            circuit_breakers: self.circuit_breakers.clone(),
            _phantom: PhantomData,
        });
        actor_arc.transition_internal(tx_id, event, input, 0).await
    }

    fn get_available_events(&self, state: &StateValue) -> Vec<String> {
        StatechartEngine::get_available_events(&self.machine, state)
    }

    fn get_terminal_states(&self) -> Vec<String> {
        StatechartEngine::get_terminal_states(&self.machine)
    }
}
