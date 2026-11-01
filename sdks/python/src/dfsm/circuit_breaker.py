from __future__ import annotations

import asyncio
from enum import Enum
from typing import Optional

from dfsm.clock import Clock
from dfsm.errors import CircuitOpenError
from dfsm.policy import CircuitBreakerPolicy


class CircuitState(str, Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitBreakerInstance:
    def __init__(self, policy: CircuitBreakerPolicy, clock: Clock) -> None:
        self.policy = policy
        self.clock = clock
        self._state = CircuitState.CLOSED
        self._consecutive_failures = 0
        self._consecutive_successes = 0
        self._opened_at_ms = 0
        self._lock = asyncio.Lock()

    @property
    def state(self) -> CircuitState:
        return self._state

    def before_execution(self, handler_name: str) -> None:
        now = self.clock.now_ms()
        if self._state == CircuitState.OPEN:
            elapsed = now - self._opened_at_ms
            if elapsed >= self.policy.recovery_timeout_ms:
                self._state = CircuitState.HALF_OPEN
                self._consecutive_successes = 0
            else:
                wait_ms = self.policy.recovery_timeout_ms - elapsed
                raise CircuitOpenError(handler_name, wait_ms)

    def on_success(self) -> None:
        if self._state == CircuitState.HALF_OPEN:
            self._consecutive_successes += 1
            if self._consecutive_successes >= self.policy.half_open_success_threshold:
                self._state = CircuitState.CLOSED
                self._consecutive_failures = 0
                self._consecutive_successes = 0
        elif self._state == CircuitState.CLOSED:
            self._consecutive_failures = 0

    def on_failure(self) -> None:
        now = self.clock.now_ms()
        if self._state == CircuitState.HALF_OPEN:
            self._state = CircuitState.OPEN
            self._opened_at_ms = now
            self._consecutive_failures += 1
        elif self._state == CircuitState.CLOSED:
            self._consecutive_failures += 1
            if self._consecutive_failures >= self.policy.failure_threshold:
                self._state = CircuitState.OPEN
                self._opened_at_ms = now

