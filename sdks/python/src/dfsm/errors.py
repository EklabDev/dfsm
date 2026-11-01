from __future__ import annotations

from typing import Optional


class DfsmError(Exception):
    """Base exception for all DFSM errors."""
    pass


class ValidationError(DfsmError):
    """Raised when context or input validation fails."""
    pass


class SchemaValidationFailedError(DfsmError):
    """Raised when machine YAML definition fails JSON schema validation."""
    pass


class InvalidTransitionError(DfsmError):
    """Raised when an event cannot be processed from the current state."""
    def __init__(self, state: str, event: str, message: str) -> None:
        self.state = state
        self.event = event
        super().__init__(f"Invalid transition: event '{event}' from state '{state}': {message}")


class CircuitOpenError(DfsmError):
    """Raised when an execution is rejected because the circuit breaker is OPEN."""
    def __init__(self, handler: str, wait_ms: int) -> None:
        self.handler = handler
        self.wait_ms = wait_ms
        super().__init__(f"Circuit breaker OPEN for handler '{handler}'. Try again in {wait_ms}ms")


class TransactionNotFoundError(DfsmError):
    """Raised when a transaction ID does not exist."""
    def __init__(self, tx_id: str) -> None:
        self.tx_id = tx_id
        super().__init__(f"Transaction '{tx_id}' not found")


class StaleTransactionVersionError(DfsmError):
    """Raised when an optimistic concurrency version conflict occurs."""
    def __init__(self, tx_id: str, expected_version: int, actual_version: int) -> None:
        self.tx_id = tx_id
        self.expected_version = expected_version
        self.actual_version = actual_version
        super().__init__(
            f"Optimistic lock conflict on transaction '{tx_id}': expected version {expected_version}, found {actual_version}"
        )


class MaxEffectChainDepthExceededError(DfsmError):
    """Raised when routed effects exceed maxEffectChainDepth recursion limit."""
    def __init__(self, tx_id: str, max_depth: int) -> None:
        self.tx_id = tx_id
        self.max_depth = max_depth
        super().__init__(
            f"Max effect chain depth ({max_depth}) exceeded for transaction '{tx_id}'"
        )


class UnregisteredHandlerError(DfsmError):
    """Raised when a referenced transition, compensate, effect, or hook handler is not registered."""
    def __init__(self, handler_type: str, name: str) -> None:
        self.handler_type = handler_type
        self.name = name
        super().__init__(f"Unregistered {handler_type} handler '{name}'")


class ExecutionFailedError(DfsmError):
    """Raised when a transition execution fails."""
    pass


class StateNotFoundError(DfsmError):
    """Raised when a target or query state cannot be found."""
    pass
