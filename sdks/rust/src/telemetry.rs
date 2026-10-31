use crate::state_value::StateValue;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkEvent {
    pub transaction_id: String,
    pub machine_id: String,
    pub event_name: String,
    pub handler_name: String,
    pub attempts: usize,
    pub outcome: String,
    pub duration_ms: i64,
    pub previous_state: StateValue,
    pub current_state: StateValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

pub trait BenchmarkEngine: Send + Sync {
    fn record(&self, event: BenchmarkEvent);
}

#[derive(Debug, Clone, Default)]
pub struct ConsoleBenchmarkEngine;

impl BenchmarkEngine for ConsoleBenchmarkEngine {
    fn record(&self, event: BenchmarkEvent) {
        if let Some(err) = &event.error_message {
            println!(
                "[DFSM-STEP] tx={} | event={} | handler={} | attempts={} | outcome={} ({}ms) | {} -> {} | error=\"{}\"",
                event.transaction_id,
                event.event_name,
                event.handler_name,
                event.attempts,
                event.outcome,
                event.duration_ms,
                event.previous_state,
                event.current_state,
                err
            );
        } else {
            println!(
                "[DFSM-STEP] tx={} | event={} | handler={} | attempts={} | outcome={} ({}ms) | {} -> {}",
                event.transaction_id,
                event.event_name,
                event.handler_name,
                event.attempts,
                event.outcome,
                event.duration_ms,
                event.previous_state,
                event.current_state
            );
        }
    }
}

