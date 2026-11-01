from __future__ import annotations

import asyncio
from copy import deepcopy
from typing import Dict, List, Optional

from dfsm.errors import StaleTransactionVersionError
from dfsm.types import SagaStepRecord, TransactionRecord, TransactionStatus


class MemoryStateStore:
    def __init__(self) -> None:
        self._txs: Dict[str, TransactionRecord] = {}
        self._sagas: Dict[str, List[SagaStepRecord]] = {}
        self._lock = asyncio.Lock()

    async def get_transaction(self, tx_id: str) -> Optional[TransactionRecord]:
        async with self._lock:
            rec = self._txs.get(tx_id)
            return deepcopy(rec) if rec else None

    async def create_transaction(self, record: TransactionRecord) -> None:
        async with self._lock:
            self._txs[record.transaction_id] = deepcopy(record)
            if record.transaction_id not in self._sagas:
                self._sagas[record.transaction_id] = []

    async def update_transaction(self, record: TransactionRecord, expected_version: int) -> None:
        async with self._lock:
            current = self._txs.get(record.transaction_id)
            if not current:
                self._txs[record.transaction_id] = deepcopy(record)
                return

            if current.version != expected_version:
                raise StaleTransactionVersionError(
                    record.transaction_id, expected_version, current.version
                )

            self._txs[record.transaction_id] = deepcopy(record)

    async def push_saga_step(self, tx_id: str, step: SagaStepRecord) -> None:
        async with self._lock:
            if tx_id not in self._sagas:
                self._sagas[tx_id] = []
            self._sagas[tx_id].append(deepcopy(step))

    async def pop_saga_step(self, tx_id: str) -> Optional[SagaStepRecord]:
        async with self._lock:
            stack = self._sagas.get(tx_id)
            if stack and len(stack) > 0:
                return stack.pop()
            return None

    async def get_saga_stack(self, tx_id: str) -> List[SagaStepRecord]:
        async with self._lock:
            stack = self._sagas.get(tx_id, [])
            return deepcopy(stack)

    async def list_all_transactions(self, machine_id: str, limit: int = 500) -> List[TransactionRecord]:
        async with self._lock:
            res = [
                deepcopy(r)
                for r in self._txs.values()
                if r.machine_id == machine_id
            ]
            return res[:limit]

    async def list_active_transactions(self, machine_id: str, limit: int = 500) -> List[TransactionRecord]:
        async with self._lock:
            res = [
                deepcopy(r)
                for r in self._txs.values()
                if r.machine_id == machine_id
                and r.status not in (TransactionStatus.COMPLETED, TransactionStatus.FAILED)
            ]
            return res[:limit]

    async def list_in_flight(self, older_than_ms: Optional[int] = None) -> List[TransactionRecord]:
        async with self._lock:
            res = [
                deepcopy(r)
                for r in self._txs.values()
                if r.status in (TransactionStatus.IN_FLIGHT, TransactionStatus.COMPENSATING, TransactionStatus.IDLE)
            ]
            return res
