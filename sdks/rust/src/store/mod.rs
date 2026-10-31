pub mod memory;

use crate::error::DfsmError;
use crate::types::{SagaStepRecord, TransactionRecord};
use async_trait::async_trait;

#[async_trait]
pub trait StateStore: Send + Sync {
    async fn create_transaction(&self, record: &TransactionRecord) -> Result<(), DfsmError>;
    async fn get_transaction(&self, tx_id: &str) -> Result<Option<TransactionRecord>, DfsmError>;
    async fn update_transaction(
        &self,
        record: &TransactionRecord,
        expected_version: i64,
    ) -> Result<(), DfsmError>;
    async fn push_saga_step(&self, tx_id: &str, step: SagaStepRecord) -> Result<(), DfsmError>;
    async fn get_saga_stack(&self, tx_id: &str) -> Result<Vec<SagaStepRecord>, DfsmError>;
    async fn pop_saga_step(&self, tx_id: &str) -> Result<Option<SagaStepRecord>, DfsmError>;
    async fn list_active_transactions(
        &self,
        machine_id: &str,
        limit: usize,
    ) -> Result<Vec<TransactionRecord>, DfsmError>;
    async fn list_all_transactions(
        &self,
        machine_id: &str,
        limit: usize,
    ) -> Result<Vec<TransactionRecord>, DfsmError>;
    async fn delete_transaction(&self, tx_id: &str) -> Result<(), DfsmError>;
    async fn acquire_lease(
        &self,
        tx_id: &str,
        owner: &str,
        duration_ms: i64,
        now_ms: i64,
    ) -> Result<bool, DfsmError>;
}

