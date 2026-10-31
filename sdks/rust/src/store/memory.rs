use super::StateStore;
use crate::error::DfsmError;
use crate::types::{SagaStepRecord, TransactionRecord, TransactionStatus};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone, Default)]
pub struct MemoryStateStore {
    transactions: Arc<RwLock<HashMap<String, TransactionRecord>>>,
    saga_stacks: Arc<RwLock<HashMap<String, Vec<SagaStepRecord>>>>,
}

impl MemoryStateStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl StateStore for MemoryStateStore {
    async fn create_transaction(&self, record: &TransactionRecord) -> Result<(), DfsmError> {
        let mut txs = self.transactions.write().await;
        if txs.contains_key(&record.transaction_id) {
            return Err(DfsmError::StoreError(format!(
                "Transaction '{}' already exists",
                record.transaction_id
            )));
        }
        txs.insert(record.transaction_id.clone(), record.clone());
        Ok(())
    }

    async fn get_transaction(&self, tx_id: &str) -> Result<Option<TransactionRecord>, DfsmError> {
        let txs = self.transactions.read().await;
        Ok(txs.get(tx_id).cloned())
    }

    async fn update_transaction(
        &self,
        record: &TransactionRecord,
        expected_version: i64,
    ) -> Result<(), DfsmError> {
        let mut txs = self.transactions.write().await;
        if let Some(existing) = txs.get_mut(&record.transaction_id) {
            if existing.version != expected_version {
                return Err(DfsmError::StoreError(format!(
                    "Optimistic concurrency violation: expected version {}, found {}",
                    expected_version, existing.version
                )));
            }
            *existing = record.clone();
            Ok(())
        } else {
            Err(DfsmError::TransactionNotFound {
                tx_id: record.transaction_id.clone(),
            })
        }
    }

    async fn push_saga_step(&self, tx_id: &str, step: SagaStepRecord) -> Result<(), DfsmError> {
        let mut sagas = self.saga_stacks.write().await;
        sagas.entry(tx_id.to_string()).or_default().push(step);
        Ok(())
    }

    async fn get_saga_stack(&self, tx_id: &str) -> Result<Vec<SagaStepRecord>, DfsmError> {
        let sagas = self.saga_stacks.read().await;
        Ok(sagas.get(tx_id).cloned().unwrap_or_default())
    }

    async fn pop_saga_step(&self, tx_id: &str) -> Result<Option<SagaStepRecord>, DfsmError> {
        let mut sagas = self.saga_stacks.write().await;
        if let Some(stack) = sagas.get_mut(tx_id) {
            Ok(stack.pop())
        } else {
            Ok(None)
        }
    }

    async fn list_active_transactions(
        &self,
        machine_id: &str,
        limit: usize,
    ) -> Result<Vec<TransactionRecord>, DfsmError> {
        let txs = self.transactions.read().await;
        let mut active = Vec::new();
        for rec in txs.values() {
            if rec.machine_id == machine_id
                && (rec.status == TransactionStatus::Idle
                    || rec.status == TransactionStatus::InFlight
                    || rec.status == TransactionStatus::Compensating)
            {
                active.push(rec.clone());
                if active.len() >= limit {
                    break;
                }
            }
        }
        Ok(active)
    }

    async fn list_all_transactions(
        &self,
        machine_id: &str,
        limit: usize,
    ) -> Result<Vec<TransactionRecord>, DfsmError> {
        let txs = self.transactions.read().await;
        let mut list = Vec::new();
        for rec in txs.values() {
            if rec.machine_id == machine_id {
                list.push(rec.clone());
                if list.len() >= limit {
                    break;
                }
            }
        }
        Ok(list)
    }

    async fn delete_transaction(&self, tx_id: &str) -> Result<(), DfsmError> {
        let mut txs = self.transactions.write().await;
        txs.remove(tx_id);
        let mut sagas = self.saga_stacks.write().await;
        sagas.remove(tx_id);
        Ok(())
    }

    async fn acquire_lease(
        &self,
        tx_id: &str,
        owner: &str,
        duration_ms: i64,
        now_ms: i64,
    ) -> Result<bool, DfsmError> {
        let mut txs = self.transactions.write().await;
        if let Some(existing) = txs.get_mut(tx_id) {
            let can_acquire = match existing.lease_expires_at {
                None => true,
                Some(exp) => exp < now_ms || existing.lease_owner.as_deref() == Some(owner),
            };
            if can_acquire {
                existing.lease_owner = Some(owner.to_string());
                existing.lease_expires_at = Some(now_ms + duration_ms);
                existing.updated_at = now_ms;
                return Ok(true);
            }
        }
        Ok(false)
    }
}

