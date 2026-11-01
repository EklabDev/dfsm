from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol

from dfsm.state_value import StateValue


@dataclass
class BenchmarkEvent:
    transaction_id: str
    machine_id: str
    event_name: str
    handler_name: str
    attempts: int
    outcome: str
    duration_ms: int
    previous_state: StateValue
    current_state: StateValue
    error_message: Optional[str] = None


class BenchmarkEngine(Protocol):
    def record(self, event: BenchmarkEvent) -> None:
        ...


class ConsoleBenchmarkEngine:
    def record(self, event: BenchmarkEvent) -> None:
        err_part = f' | error="{event.error_message}"' if event.error_message else ""
        print(
            f"[DFSM-STEP] tx={event.transaction_id} | event={event.event_name} | "
            f"handler={event.handler_name} | attempts={event.attempts} | "
            f"outcome={event.outcome} ({event.duration_ms}ms) | "
            f"{event.previous_state} -> {event.current_state}{err_part}"
        )

