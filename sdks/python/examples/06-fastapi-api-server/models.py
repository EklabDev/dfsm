from __future__ import annotations

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class OrderContext(BaseModel):
    order_id: str = ""
    customer: str = ""
    amount: float = 0.0
    auto_authorize: bool = False
    simulate_failure: bool = False
    items_reserved: bool = False
    payment_charged: bool = False
    pack_complete: bool = False
    carrier_booked: bool = False
    trace_log: List[str] = Field(default_factory=list)


class CreateOrderRequest(BaseModel):
    order_id: str = Field(..., alias="orderId", min_length=1)
    customer: str = Field(..., pattern=r"^[\w\.-]+@[\w\.-]+\.\w+$")
    amount: float = Field(..., gt=0)
    auto_authorize: bool = Field(False, alias="autoAuthorize")
    simulate_failure: bool = Field(False, alias="simulateFailure")

    model_config = {"populate_by_name": True}


class TransitionRequestPayload(BaseModel):
    event: str = Field(..., min_length=1)
    payload: Optional[Any] = None


class OrderSummaryPayload(BaseModel):
    order_id: str
    current_state: str
    status: str
    updated_at: int


class OrderResponse(BaseModel):
    order_id: str
    machine_id: str
    current_state: str
    status: str
    available_events: List[str]
    saga_stack_depth: int
    version: int
    created_at: int
    updated_at: int
    context: OrderContext
    machine_yaml: str


class InFlightResponse(BaseModel):
    machine_id: str
    total_in_flight: int
    non_terminal_count: int
    terminal_states: List[str]
    breakdown: Dict[str, int]
    in_flight_orders: List[OrderSummaryPayload]


class TerminalStatesResponse(BaseModel):
    machine_id: str
    terminal_states: List[str]


class MachineResponse(BaseModel):
    machine_id: str
    initial_state: str
    max_effect_chain_depth: int
    terminal_states: List[str]
    machine_yaml: str


class CleanupRequestPayload(BaseModel):
    transaction_ids: Optional[List[str]] = Field(None, alias="transactionIds")
    older_than_ms: Optional[int] = Field(None, alias="olderThanMs")
    stuck_only: bool = Field(True, alias="stuckOnly")
    action: str = "fail"

    model_config = {"populate_by_name": True}

