use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use eklabdev_dfsm::actor::DfsmActor;
use eklabdev_dfsm::clock::{Clock, RealClock};
use eklabdev_dfsm::definition::parse_yaml_machine;
use eklabdev_dfsm::error::DfsmError;
use eklabdev_dfsm::registry::FSMRegistry;
use eklabdev_dfsm::state_value::StateValue;
use eklabdev_dfsm::store::memory::MemoryStateStore;
use eklabdev_dfsm::types::{
    ForceCleanUpAction, ForceCleanUpOptions, HookType, TransactionStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

pub const MACHINE_YAML: &str = include_str!("../order-fulfillment.dfsm.yaml");

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderContext {
    pub order_id: String,
    pub customer: String,
    pub amount: f64,
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default)]
    pub inventory_reserved: bool,
    #[serde(default)]
    pub payment_authorized: bool,
    #[serde(default)]
    pub packing_completed: bool,
    #[serde(default)]
    pub shipping_booked: bool,
    #[serde(default)]
    pub fail_step: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOrderRequest {
    pub order_id: String,
    pub customer: String,
    pub amount: f64,
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default)]
    pub fail_step: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionRequestPayload {
    pub event: String,
    #[serde(default)]
    pub input: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStatusResponse {
    pub order_id: String,
    pub current_state: StateValue,
    pub status: TransactionStatus,
    pub version: i64,
    pub context: OrderContext,
    pub available_events: Vec<String>,
    pub yaml: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepExecutionResponse {
    pub order_id: String,
    pub event_name: String,
    pub previous_state: StateValue,
    pub current_state: StateValue,
    pub status: TransactionStatus,
    pub version: i64,
    pub output_value: Option<serde_json::Value>,
    pub compensated_steps: usize,
    pub rollback_occurred: bool,
    pub available_events: Vec<String>,
    pub yaml: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InFlightOrdersResponse {
    pub total_in_flight: usize,
    pub non_terminal_count: usize,
    pub terminal_states: Vec<String>,
    pub in_flight_orders: Vec<OrderStatusResponse>,
}

pub struct AppState {
    pub actor: Arc<DfsmActor<OrderContext>>,
    pub order_ids: tokio::sync::RwLock<Vec<String>>,
}

async fn logging_middleware(req: Request<axum::body::Body>, next: Next) -> Response {
    let start = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    println!("[HTTP-IN] {} {}", method, path);

    let res = next.run(req).await;

    let duration_ms = start.elapsed().as_millis();
    println!(
        "[HTTP-OUT] {} {} -> {} ({}ms)",
        method,
        path,
        res.status().as_u16(),
        duration_ms
    );

    res
}

pub fn build_app() -> (Router, Arc<AppState>) {
    let machine = parse_yaml_machine(MACHINE_YAML).expect("Valid embedded order-fulfillment machine");
    let reg = FSMRegistry::new().with_store(Arc::new(MemoryStateStore::new()));

    // 1. Register Lifecycle Hooks with Structured Logs
    reg.register_hook(
        HookType::OnStart,
        Box::new(|ev| {
            Box::pin(async move {
                let tx = ev.get("transactionId").and_then(|v| v.as_str()).unwrap_or("?");
                let st = ev.get("initialState").map(|v| v.to_string()).unwrap_or_default();
                println!("[DFSM-HOOK] onStart | tx={} | initialState={}", tx, st);
            })
        }),
    );

    reg.register_hook(
        HookType::BeforeTransition,
        Box::new(|ev| {
            Box::pin(async move {
                let tx = ev.get("transactionId").and_then(|v| v.as_str()).unwrap_or("?");
                let st = ev.get("currentState").map(|v| v.to_string()).unwrap_or_default();
                let evt = ev.get("eventName").and_then(|v| v.as_str()).unwrap_or("?");
                println!("[DFSM-HOOK] beforeTransition | tx={} | event={} | state={}", tx, evt, st);
            })
        }),
    );

    reg.register_hook(
        HookType::AfterTransition,
        Box::new(|ev| {
            Box::pin(async move {
                let tx = ev.get("transactionId").and_then(|v| v.as_str()).unwrap_or("?");
                let st = ev.get("currentState").map(|v| v.to_string()).unwrap_or_default();
                let evt = ev.get("eventName").and_then(|v| v.as_str()).unwrap_or("?");
                let stat = ev.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                println!(
                    "[DFSM-HOOK] afterTransition | tx={} | event={} | currentState={} | status={}",
                    tx, evt, st, stat
                );
            })
        }),
    );

    reg.register_hook(
        HookType::OnCompensate,
        Box::new(|ev| {
            Box::pin(async move {
                let tx = ev.get("transactionId").and_then(|v| v.as_str()).unwrap_or("?");
                let step = ev.get("stepName").and_then(|v| v.as_str()).unwrap_or("?");
                let rem = ev.get("stepsRemaining").and_then(|v| v.as_u64()).unwrap_or(0);
                println!(
                    "[DFSM-HOOK] onCompensate | tx={} | step={} | remaining={}",
                    tx, step, rem
                );
            })
        }),
    );

    reg.register_hook(
        HookType::OnComplete,
        Box::new(|ev| {
            Box::pin(async move {
                let tx = ev.get("transactionId").and_then(|v| v.as_str()).unwrap_or("?");
                println!("[DFSM-HOOK] onComplete | tx={} | Order fulfilled successfully!", tx);
            })
        }),
    );

    reg.register_hook(
        HookType::OnTerminal,
        Box::new(|ev| {
            Box::pin(async move {
                let tx = ev.get("transactionId").and_then(|v| v.as_str()).unwrap_or("?");
                let st = ev.get("finalState").map(|v| v.to_string()).unwrap_or_default();
                let stat = ev.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                println!("[DFSM-HOOK] onTerminal | tx={} | finalState={} | status={}", tx, st, stat);
            })
        }),
    );

    // 2. Register Business Transitions & Saga Compensations
    reg.register_transition(
        "api.orders.reserveInventory",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                let mut order: OrderContext = serde_json::from_value(ctx).unwrap_or_default();
                if order.fail_step.as_deref() == Some("reserveInventory") {
                    return Err(DfsmError::ExecutionFailed("Simulated inventory shortage".to_string()));
                }
                order.inventory_reserved = true;
                println!(">> [Step] Stock reserved for order: {}", order.order_id);
                Ok((Some(serde_json::to_value(&order).unwrap()), None))
            })
        }),
        None,
    );

    reg.register_compensate(
        "api.orders.releaseInventory",
        Box::new(|_req| {
            Box::pin(async move {
                println!("<< [Compensate] Stock released back to warehouse");
            })
        }),
    );

    reg.register_transition(
        "api.orders.authorizePayment",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                let mut order: OrderContext = serde_json::from_value(ctx).unwrap_or_default();
                if order.fail_step.as_deref() == Some("authorizePayment") {
                    return Err(DfsmError::ExecutionFailed("Payment card declined".to_string()));
                }
                order.payment_authorized = true;
                println!(">> [Step] Payment authorized: ${:.2}", order.amount);
                Ok((Some(serde_json::to_value(&order).unwrap()), None))
            })
        }),
        None,
    );

    reg.register_compensate(
        "api.orders.refundPayment",
        Box::new(|_req| {
            Box::pin(async move {
                println!("<< [Compensate] Payment refund issued to customer");
            })
        }),
    );

    reg.register_transition(
        "api.orders.completePacking",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                let mut order: OrderContext = serde_json::from_value(ctx).unwrap_or_default();
                order.packing_completed = true;
                println!(">> [Step] Order packing completed: {}", order.order_id);
                Ok((Some(serde_json::to_value(&order).unwrap()), None))
            })
        }),
        None,
    );

    reg.register_transition(
        "api.orders.bookShippingCarrier",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                let mut order: OrderContext = serde_json::from_value(ctx).unwrap_or_default();
                order.shipping_booked = true;
                println!(">> [Step] Shipping carrier booked: {}", order.order_id);
                Ok((Some(serde_json::to_value(&order).unwrap()), None))
            })
        }),
        None,
    );

    reg.register_transition(
        "api.orders.cancelDraftOrder",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                println!(">> [Step] Order draft cancelled cleanly");
                Ok((Some(ctx), None))
            })
        }),
        None,
    );

    reg.register_transition(
        "api.orders.cancelReservedOrder",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                println!(">> [Step] Reserved order cancelled");
                Ok((Some(ctx), None))
            })
        }),
        None,
    );

    reg.register_transition(
        "api.orders.resetAfterError",
        Box::new(|_tx, ctx, _in, _st, _ev| {
            Box::pin(async move {
                let mut order: OrderContext = serde_json::from_value(ctx).unwrap_or_default();
                order.fail_step = None;
                order.inventory_reserved = false;
                order.payment_authorized = false;
                println!(">> [Step] Order reset to fresh draft state");
                Ok((Some(serde_json::to_value(&order).unwrap()), None))
            })
        }),
        None,
    );

    let actor = DfsmActor::<OrderContext>::new(machine, Arc::new(reg));
    let state = Arc::new(AppState {
        actor,
        order_ids: tokio::sync::RwLock::new(Vec::new()),
    });

    let app = Router::new()
        .route("/api/machine", get(get_machine))
        .route("/api/orders", post(create_order).get(list_orders))
        .route("/api/orders/:id", get(get_order))
        .route("/api/orders/:id/transitions", post(transition_order))
        .route("/api/orders/:id/cancel", post(cancel_order))
        .route("/api/orders/:id/reset", post(reset_order))
        .route("/api/in-flight", get(get_in_flight))
        .route("/api/terminals", get(get_terminals))
        .route("/api/scheduler", get(get_scheduler))
        .route("/api/scheduler/sweep", post(trigger_sweep))
        .route("/api/cleanup", post(force_cleanup_endpoint))
        .layer(middleware::from_fn(logging_middleware))
        .with_state(state.clone());

    (app, state)
}

// Endpoints

async fn get_machine(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let m = state.actor.machine();
    Json(json!({
        "id": m.id,
        "description": m.description,
        "initial": m.initial,
        "yaml": MACHINE_YAML,
    }))
}

async fn create_order(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateOrderRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    if payload.order_id.is_empty() || payload.customer.is_empty() || payload.amount <= 0.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "orderId, customer, and amount > 0 are required"})),
        ));
    }

    let initial_context = OrderContext {
        order_id: payload.order_id.clone(),
        customer: payload.customer,
        amount: payload.amount,
        items: payload.items,
        inventory_reserved: false,
        payment_authorized: false,
        packing_completed: false,
        shipping_booked: false,
        fail_step: payload.fail_step,
    };

    let order_state = state
        .actor
        .start(&payload.order_id, Some(initial_context.clone()))
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e.to_string()})),
            )
        })?;

    state.order_ids.write().await.push(payload.order_id.clone());

    let available = state.actor.get_available_events(&order_state.current_state);

    Ok((
        StatusCode::CREATED,
        Json(OrderStatusResponse {
            order_id: payload.order_id,
            current_state: order_state.current_state,
            status: order_state.status,
            version: order_state.version,
            context: order_state.context,
            available_events: available,
            yaml: MACHINE_YAML.to_string(),
        }),
    ))
}

async fn get_order(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let order_state = state.actor.get_state(&id).await.map_err(|e| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("Order '{}' not found: {}", id, e)})),
        )
    })?;

    let available = state.actor.get_available_events(&order_state.current_state);

    Ok(Json(OrderStatusResponse {
        order_id: id,
        current_state: order_state.current_state,
        status: order_state.status,
        version: order_state.version,
        context: order_state.context,
        available_events: available,
        yaml: MACHINE_YAML.to_string(),
    }))
}

async fn transition_order(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<TransitionRequestPayload>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let step_res = state
        .actor
        .transition(&id, &payload.event, payload.input)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": e.to_string()})),
            )
        })?;

    let available = state.actor.get_available_events(&step_res.current_state);

    println!(
        "[DFSM-STEP-RESULT] tx={} | event={} | {} -> {} | status={:?} | available={:?}",
        step_res.transaction_id,
        step_res.event_name,
        step_res.previous_state,
        step_res.current_state,
        step_res.status,
        available
    );

    Ok(Json(StepExecutionResponse {
        order_id: id,
        event_name: step_res.event_name,
        previous_state: step_res.previous_state,
        current_state: step_res.current_state,
        status: step_res.status,
        version: step_res.version,
        output_value: step_res.output_value,
        compensated_steps: step_res.compensated_steps,
        rollback_occurred: step_res.rollback_occurred,
        available_events: available,
        yaml: MACHINE_YAML.to_string(),
    }))
}

async fn cancel_order(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let step_res = state
        .actor
        .transition(&id, "CANCEL_ORDER", None::<serde_json::Value>)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": e.to_string()})),
            )
        })?;

    let available = state.actor.get_available_events(&step_res.current_state);

    Ok(Json(StepExecutionResponse {
        order_id: id,
        event_name: step_res.event_name,
        previous_state: step_res.previous_state,
        current_state: step_res.current_state,
        status: step_res.status,
        version: step_res.version,
        output_value: step_res.output_value,
        compensated_steps: step_res.compensated_steps,
        rollback_occurred: step_res.rollback_occurred,
        available_events: available,
        yaml: MACHINE_YAML.to_string(),
    }))
}

async fn reset_order(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let step_res = state
        .actor
        .transition(&id, "RESET_ORDER", None::<serde_json::Value>)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": e.to_string()})),
            )
        })?;

    let available = state.actor.get_available_events(&step_res.current_state);

    Ok(Json(StepExecutionResponse {
        order_id: id,
        event_name: step_res.event_name,
        previous_state: step_res.previous_state,
        current_state: step_res.current_state,
        status: step_res.status,
        version: step_res.version,
        output_value: step_res.output_value,
        compensated_steps: step_res.compensated_steps,
        rollback_occurred: step_res.rollback_occurred,
        available_events: available,
        yaml: MACHINE_YAML.to_string(),
    }))
}

async fn list_orders(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let ids = state.order_ids.read().await.clone();
    let mut list = Vec::new();

    for id in ids {
        if let Ok(order_state) = state.actor.get_state(&id).await {
            let available = state.actor.get_available_events(&order_state.current_state);
            list.push(OrderStatusResponse {
                order_id: id,
                current_state: order_state.current_state,
                status: order_state.status,
                version: order_state.version,
                context: order_state.context,
                available_events: available,
                yaml: MACHINE_YAML.to_string(),
            });
        }
    }

    Json(list)
}

async fn get_in_flight(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let summary = state.actor.get_in_flight_summary().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
    })?;

    let ids = state.order_ids.read().await.clone();
    let mut in_flight_list = Vec::new();

    for id in ids {
        if let Ok(order_state) = state.actor.get_state(&id).await {
            let is_terminal = summary.terminal_states.iter().any(|t| order_state.current_state.matches_string(t));
            if !is_terminal && order_state.status != TransactionStatus::Completed && order_state.status != TransactionStatus::Failed {
                let available = state.actor.get_available_events(&order_state.current_state);
                in_flight_list.push(OrderStatusResponse {
                    order_id: id,
                    current_state: order_state.current_state,
                    status: order_state.status,
                    version: order_state.version,
                    context: order_state.context,
                    available_events: available,
                    yaml: MACHINE_YAML.to_string(),
                });
            }
        }
    }

    Ok(Json(InFlightOrdersResponse {
        total_in_flight: in_flight_list.len(),
        non_terminal_count: summary.non_terminal_count,
        terminal_states: summary.terminal_states,
        in_flight_orders: in_flight_list,
    }))
}

async fn get_terminals(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let terminals = state.actor.get_terminal_states();
    Json(json!({
        "terminalStates": terminals,
        "count": terminals.len()
    }))
}

async fn get_scheduler() -> impl IntoResponse {
    Json(json!({
        "status": "RUNNING",
        "sweepIntervalMs": 60000,
        "stuckThresholdMs": 300000,
        "clock": "RealClock"
    }))
}

async fn trigger_sweep(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let res = state
        .actor
        .force_cleanup(ForceCleanUpOptions {
            older_than_ms: Some(300000),
            stuck_only: true,
            action: Some(ForceCleanUpAction::MarkFail),
            ..Default::default()
        })
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e.to_string()})),
            )
        })?;

    Ok(Json(json!({
        "sweptCount": res.processed_count,
        "affectedTransactionIds": res.affected_transaction_ids,
        "timestamp": RealClock.now_ms(),
    })))
}

async fn force_cleanup_endpoint(
    State(state): State<Arc<AppState>>,
    Json(opts): Json<ForceCleanUpOptions>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let res = state
        .actor
        .force_cleanup(opts)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e.to_string()})),
            )
        })?;

    Ok(Json(res))
}

