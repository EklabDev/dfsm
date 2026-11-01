from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Generic, List, Optional, TypeVar

from dfsm.state_value import StateValue

TContext = TypeVar("TContext")
TInput = TypeVar("TInput")
TOutput = TypeVar("TOutput")


class TransactionStatus(str, Enum):
    IDLE = "IDLE"
    IN_FLIGHT = "IN_FLIGHT"
    COMPENSATING = "COMPENSATING"
    COMPENSATED = "COMPENSATED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class HookType(str, Enum):
    ON_START = "onStart"
    BEFORE_TRANSITION = "beforeTransition"
    AFTER_TRANSITION = "afterTransition"
    ON_COMPENSATE = "onCompensate"
    ON_COMPLETE = "onComplete"
    ON_TERMINAL = "onTerminal"


class ForceCleanUpAction(str, Enum):
    MARK_FAIL = "MARK_FAIL"
    COMPENSATE = "COMPENSATE"
    DELETE = "DELETE"
    STOP = "STOP"
    CONTINUE = "CONTINUE"


@dataclass
class SagaStepRecord:
    step_id: str
    step_name: str
    compensate_handler: str
    from_state: StateValue
    target_state: StateValue
    input_snapshot_json: Optional[str] = None
    context_before_json: Optional[str] = None
    timestamp: int = 0


@dataclass
class TransactionRecord:
    transaction_id: str
    machine_id: str
    current_state: StateValue
    status: TransactionStatus
    context_json: str
    version: int
    created_at: int
    updated_at: int
    lease_expires_at: Optional[int] = None
    lease_owner: Optional[str] = None
    saga_stack: List[SagaStepRecord] = field(default_factory=list)


@dataclass
class ActorStateRecord(Generic[TContext]):
    transaction_id: str
    machine_id: str
    current_state: StateValue
    status: TransactionStatus
    version: int
    context: TContext
    created_at: int
    updated_at: int


@dataclass
class TransitionExecutionResult:
    transaction_id: str
    event_name: str
    previous_state: StateValue
    current_state: StateValue
    status: TransactionStatus
    version: int
    output_value: Optional[Any] = None
    compensated_steps: int = 0
    rollback_occurred: bool = false if False else False


@dataclass
class ForceCleanUpOptions:
    transaction_ids: List[str] = field(default_factory=list)
    older_than_ms: Optional[int] = None
    stuck_only: bool = False
    action: Optional[ForceCleanUpAction] = None
    dry_run: bool = False
    limit: Optional[int] = None


@dataclass
class ForceCleanUpResult:
    matched_count: int
    processed_count: int
    dry_run: bool
    action: Optional[ForceCleanUpAction]
    affected_transaction_ids: List[str]


@dataclass
class StatusBreakdown:
    idle: int = 0
    in_flight: int = 0
    compensating: int = 0
    compensated: int = 0
    completed: int = 0
    failed: int = 0


@dataclass
class InFlightSummary:
    total_in_flight: int
    non_terminal_count: int
    terminal_states: List[str]
    breakdown: StatusBreakdown


# Lifecycle hook payloads
@dataclass
class OnStartEvent:
    transaction_id: str
    initial_state: StateValue


@dataclass
class BeforeTransitionEvent:
    transaction_id: str
    current_state: StateValue
    event_name: str


@dataclass
class AfterTransitionEvent:
    transaction_id: str
    event_name: str
    previous_state: StateValue
    current_state: StateValue
    status: TransactionStatus
    compensated_steps: int = 0


@dataclass
class OnCompensateEvent:
    transaction_id: str
    step_name: str
    from_state: StateValue
    target_state: StateValue
    steps_remaining: int


@dataclass
class OnCompleteEvent:
    transaction_id: str
    final_state: StateValue
    version: int


@dataclass
class OnTerminalEvent:
    transaction_id: str
    final_state: StateValue
    status: TransactionStatus


# Request / Response wrappers
@dataclass
class TransitionRequest(Generic[TContext, TInput]):
    transaction_id: str
    context: TContext
    input: TInput
    current_state: StateValue
    event_name: str


@dataclass
class TransitionOutput(Generic[TContext, TOutput]):
    context: Optional[TContext] = None
    output: Optional[TOutput] = None


@dataclass
class CompensationRequest(Generic[TContext]):
    transaction_id: str
    context: TContext
    step_name: str
    input_snapshot: Optional[Any] = None
    from_state: Optional[StateValue] = None
    target_state: Optional[StateValue] = None


@dataclass
class EffectRequest(Generic[TContext]):
    transaction_id: str
    context: TContext
    event_name: str
    state: StateValue
    actor: Any = None

