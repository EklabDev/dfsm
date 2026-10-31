use crate::state_value::StateValue;
use thiserror::Error;

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum DfsmError {
    #[error("Validation failed for {target}: {details}")]
    ValidationError { target: String, details: String },

    #[error("Invalid transition: event '{event}' from state '{state}': {message}")]
    InvalidTransition {
        state: StateValue,
        event: String,
        message: String,
    },

    #[error("Circuit breaker is OPEN for handler '{handler}'. Wait {wait_ms}ms before retry")]
    CircuitOpen { handler: String, wait_ms: i64 },

    #[error("Max effect chain depth of {max_depth} exceeded in transaction '{tx_id}'")]
    MaxEffectChainDepthExceeded { max_depth: usize, tx_id: String },

    #[error("Transaction not found: '{tx_id}'")]
    TransactionNotFound { tx_id: String },

    #[error("Storage error: {0}")]
    StoreError(String),

    #[error("Execution failed: {0}")]
    ExecutionFailed(String),

    #[error("Schema validation failed: {0}")]
    SchemaValidationFailed(String),

    #[error("YAML parse error: {0}")]
    YamlParseError(String),
}

