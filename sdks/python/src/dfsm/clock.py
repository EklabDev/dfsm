from __future__ import annotations

import time
from typing import Protocol


class Clock(Protocol):
    """Protocol for monotonic/system wall-clock operations."""
    def now_ms(self) -> int:
        ...


class RealClock:
    """Default system clock returning epoch milliseconds."""
    def now_ms(self) -> int:
        return int(time.time() * 1000)


class VirtualClock:
    """Controllable clock for deterministic time-based testing."""
    def __init__(self, initial_ms: int = 0) -> None:
        self._current_ms = initial_ms

    def now_ms(self) -> int:
        return self._current_ms

    def advance(self, delta_ms: int) -> None:
        self._current_ms += delta_ms

    def set_time(self, ms: int) -> None:
        self._current_ms = ms

