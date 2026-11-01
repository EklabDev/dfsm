from __future__ import annotations

from typing import List, Optional, Protocol

from dfsm.types import SagaStepRecord, TransactionRecord


class StateStore(Protocol):
    async def get_transaction(self, tx_id: str) -> Optional[TransactionRecord]:
        ...

    async def create_transaction(self, record: TransactionRecord) -> None:
        ...

    async def update_transaction(self, record: TransactionRecord, expected_version: int) -> None:
        ...

    async def push_saga_step(self, tx_id: str, step: SagaStepRecord) -> None:
        ...

    async def pop_saga_step(self, tx_id: str) -> Optional[SagaStepRecord]:
        ...

    async def get_saga_stack(self, tx_id: str) -> List[SagaStepRecord]:
        ...

    async def list_all_transactions(self, machine_id: str, limit: int = 500) -> List[TransactionRecord]:
        ...

    async def list_active_transactions(self, machine_id: str, limit: int = 500) -> List[TransactionRecord]:
        ...

    async def list_in_flight(self, older_than_ms: Optional[int] = None) -> List[TransactionRecord]:
        ...
