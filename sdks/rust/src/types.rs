use crate::error::DfsmError;
use crate::state_value::StateValue;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TransactionStatus {
    Idle,
    InFlight,
    Compensating,
    Compensated,
    Completed,
    Failed,
}

impl fmt::Display for TransactionStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransactionStatus::Idle => write!(f, "IDLE"),
            TransactionStatus::InFlight => write!(f, "IN_FLIGHT"),
            TransactionStatus::Compensating => write!(f, "COMPENSATING"),
            TransactionStatus::Compensated => write!(f, "COMPENSATED"),
            TransactionStatus::Completed => write!(f, "COMPLETED"),
            TransactionStatus::Failed => write!(f, "FAILED"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookType {
    OnStart,
    BeforeTransition,
    AfterTransition,
    OnCompensate,
    OnComplete,
    OnTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ForceCleanUpAction {
    Compensate,
    MarkFail,
    Delete,
    Continue,
}

#[async_trait]
pub trait IDfsmActor: Send + Sync {
    fn machine_id(&self) -> &str;
    async fn transition_raw(
        &self,
        tx_id: &str,
        event: &str,
        input: Option<serde_json::Value>,
    ) -> Result<TransitionExecutionResult, DfsmError>;
    fn get_available_events(&self, state: &StateValue) -> Vec<String>;
    fn get_terminal_states(&self) -> Vec<String>;
}

#[derive(Debug, Clone)]
pub struct TransitionRequest<TContext, TInput> {
    pub transaction_id: String,
    pub data: TContext,
    pub input: TInput,
    pub current_state: StateValue,
    pub event_name: String,
}

#[derive(Debug, Clone)]
pub struct TransitionOutput<TContext, TOutput> {
    pub context: Option<TContext>,
    pub output: Option<TOutput>,
    pub context_updated: bool,
}

impl<TContext, TOutput> TransitionOutput<TContext, TOutput> {
    pub fn with_context(context: TContext) -> Self {
        Self {
            context: Some(context),
            output: None,
            context_updated: true,
        }
    }

    pub fn with_result(context: TContext, output: TOutput) -> Self {
        Self {
            context: Some(context),
            output: Some(output),
            context_updated: true,
        }
    }

    pub fn empty() -> Self {
        Self {
            context: None,
            output: None,
            context_updated: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompensationRequest<TContext> {
    pub transaction_id: String,
    pub context: TContext,
    pub step_name: String,
    pub input_snapshot: Option<serde_json::Value>,
    pub from_state: StateValue,
    pub target_state: StateValue,
}

#[derive(Clone)]
pub struct EffectRequest<TContext> {
    pub transaction_id: String,
    pub context: TContext,
    pub event_name: String,
    pub state: StateValue,
    pub actor: Arc<dyn IDfsmActor>,
    pub runner: Arc<dyn Fn(String, Option<serde_json::Value>) -> Result<(), DfsmError> + Send + Sync>,
}

impl<TContext> EffectRequest<TContext> {
    pub fn run_effect(&self, effect_name: &str, payload: Option<serde_json::Value>) -> Result<(), DfsmError> {
        (self.runner)(effect_name.to_string(), payload)
    }
}

// Lifecycle events
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnStartEvent {
    pub transaction_id: String,
    pub initial_state: StateValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeforeTransitionEvent {
    pub transaction_id: String,
    pub current_state: StateValue,
    pub event_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AfterTransitionEvent {
    pub transaction_id: String,
    pub event_name: String,
    pub previous_state: StateValue,
    pub current_state: StateValue,
    pub status: TransactionStatus,
    pub compensated_steps: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnCompensateEvent {
    pub transaction_id: String,
    pub step_name: String,
    pub from_state: StateValue,
    pub target_state: StateValue,
    pub steps_remaining: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnCompleteEvent {
    pub transaction_id: String,
    pub final_state: StateValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnTerminalEvent {
    pub transaction_id: String,
    pub final_state: StateValue,
    pub status: TransactionStatus,
}

// Persistence records
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SagaStepRecord {
    pub step_id: String,
    pub step_name: String,
    pub compensate_handler: String,
    pub from_state: StateValue,
    pub target_state: StateValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_snapshot_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_before_json: Option<String>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionRecord {
    pub transaction_id: String,
    pub machine_id: String,
    pub current_state: StateValue,
    pub status: TransactionStatus,
    pub context_json: String,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_owner: Option<String>,
    #[serde(default)]
    pub saga_stack: Vec<SagaStepRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorStateRecord<TContext> {
    pub transaction_id: String,
    pub machine_id: String,
    pub current_state: StateValue,
    pub status: TransactionStatus,
    pub context: TContext,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub available_events: Vec<String>,
    pub saga_stack_depth: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionExecutionResult {
    pub transaction_id: String,
    pub event_name: String,
    pub previous_state: StateValue,
    pub current_state: StateValue,
    pub status: TransactionStatus,
    pub version: i64,
    pub output_value: Option<serde_json::Value>,
    pub compensated_steps: usize,
    pub rollback_occurred: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBreakdown {
    pub idle: usize,
    pub in_flight: usize,
    pub compensating: usize,
    pub compensated: usize,
    pub completed: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InFlightSummary {
    pub total_in_flight: usize,
    pub non_terminal_count: usize,
    pub terminal_states: Vec<String>,
    pub breakdown: StatusBreakdown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceCleanUpOptions {
    pub transaction_ids: Vec<String>,
    pub older_than_ms: Option<i64>,
    pub stuck_only: bool,
    pub action: Option<ForceCleanUpAction>,
    pub dry_run: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceCleanUpResult {
    pub matched_count: usize,
    pub processed_count: usize,
    pub dry_run: bool,
    pub action: Option<ForceCleanUpAction>,
    pub affected_transaction_ids: Vec<String>,
}

