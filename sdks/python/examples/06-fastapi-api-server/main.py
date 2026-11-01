from __future__ import annotations

import datetime
import json
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse

from dfsm import (
    ForceCleanUpAction,
    ForceCleanUpOptions,
    InvalidTransitionError,
    StateNotFoundError,
    TransactionNotFoundError,
)
from models import (
    CleanupRequestPayload,
    CreateOrderRequest,
    InFlightResponse,
    MachineResponse,
    OrderContext,
    OrderResponse,
    OrderSummaryPayload,
    TerminalStatesResponse,
    TransitionRequestPayload,
)
from order_service import OrderFulfillmentService

app = FastAPI(
    title="DFSM Order Fulfillment REST API",
    description="Full FastAPI REST API server backed by DFSM Python SDK and order-fulfillment.dfsm.yaml",
    version="1.0.0",
)

svc = OrderFulfillmentService()


@app.middleware("http")
async def logging_middleware(request: Request, call_next):
    start_time = time.time()
    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    # Read body for logging
    req_body_str = ""
    if request.method in ["POST", "PUT", "PATCH"]:
        body_bytes = await request.body()
        if body_bytes:
            req_body_str = body_bytes.decode("utf-8", errors="replace")

    print(f"[{now_iso}] --> {request.method} {request.url.path} | body={req_body_str}")

    response = await call_next(request)

    duration_ms = int((time.time() - start_time) * 1000)
    end_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    meta_log = response.headers.get("X-DFSM-Log", "")
    suffix = f" | {meta_log}" if meta_log else ""

    print(f"[{end_iso}] <-- {response.status_code} {request.method} {request.url.path} ({duration_ms}ms){suffix}")
    return response


def _build_order_response(record: Any, saga_depth: int = 0) -> Dict[str, Any]:
    avail = svc.actor.get_available_events(record.current_state)
    ctx_data = record.context
    if hasattr(ctx_data, "model_dump"):
        ctx_dict = ctx_data.model_dump()
    elif isinstance(ctx_data, dict):
        ctx_dict = ctx_data
    else:
        ctx_dict = vars(ctx_data)

    return {
        "order_id": record.transaction_id,
        "machine_id": record.machine_id,
        "current_state": str(record.current_state),
        "status": record.status.value,
        "available_events": avail,
        "saga_stack_depth": saga_depth,
        "version": record.version,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "context": ctx_dict,
        "machine_yaml": svc.yaml_content,
    }


@app.get("/api/machine", response_model=MachineResponse)
async def get_machine() -> MachineResponse:
    terminals = svc.actor.get_terminal_states()
    return MachineResponse(
        machine_id=svc.machine.id,
        initial_state=svc.machine.initial,
        max_effect_chain_depth=svc.machine.max_effect_chain_depth,
        terminal_states=terminals,
        machine_yaml=svc.yaml_content,
    )


@app.post("/api/orders", response_model=OrderResponse)
async def create_order(req: CreateOrderRequest, response: Response) -> Dict[str, Any]:
    ctx = OrderContext(
        order_id=req.order_id,
        customer=req.customer,
        amount=req.amount,
        auto_authorize=req.auto_authorize,
        simulate_failure=req.simulate_failure,
    )

    try:
        rec = await svc.actor.start(req.order_id, ctx)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    avail = svc.actor.get_available_events(rec.current_state)
    response.headers["X-DFSM-Log"] = (
        f"txId={rec.transaction_id} | currentState=\"{rec.current_state}\" | status={rec.status.value} | availableEvents={json.dumps(avail)}"
    )

    return _build_order_response(rec, saga_depth=0)


@app.get("/api/orders/{order_id}", response_model=OrderResponse)
async def get_order(order_id: str, response: Response) -> Dict[str, Any]:
    try:
        rec = await svc.actor.get_state(order_id)
        saga_stack = await svc.registry.store.get_saga_stack(order_id)
        saga_depth = len(saga_stack)
    except TransactionNotFoundError:
        raise HTTPException(status_code=404, detail=f"Order '{order_id}' not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    avail = svc.actor.get_available_events(rec.current_state)
    response.headers["X-DFSM-Log"] = (
        f"txId={rec.transaction_id} | currentState=\"{rec.current_state}\" | status={rec.status.value} | availableEvents={json.dumps(avail)}"
    )

    return _build_order_response(rec, saga_depth=saga_depth)


@app.post("/api/orders/{order_id}/transitions")
async def process_transition(order_id: str, payload: TransitionRequestPayload, response: Response) -> Dict[str, Any]:
    try:
        result = await svc.actor.transition(order_id, payload.event, payload.payload)
    except TransactionNotFoundError:
        raise HTTPException(status_code=404, detail=f"Order '{order_id}' not found")
    except InvalidTransitionError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    rec = await svc.actor.get_state(order_id)
    saga_stack = await svc.registry.store.get_saga_stack(order_id)
    saga_depth = len(saga_stack)
    avail = svc.actor.get_available_events(rec.current_state)

    result_summary = {
        "event": result.event_name,
        "previous_state": str(result.previous_state),
        "current_state": str(result.current_state),
        "status": result.status.value,
        "output": result.output_value,
        "compensated_steps": result.compensated_steps,
        "rollback_occurred": result.rollback_occurred,
    }

    response.headers["X-DFSM-Log"] = (
        f"txId={order_id} | currentState=\"{rec.current_state}\" | status={rec.status.value} | result={json.dumps(result_summary)} | availableEvents={json.dumps(avail)}"
    )

    resp_dict = _build_order_response(rec, saga_depth=saga_depth)
    resp_dict["step_result"] = result_summary
    return resp_dict


@app.post("/api/orders/{order_id}/cancel")
async def cancel_order(order_id: str, response: Response) -> Dict[str, Any]:
    return await process_transition(order_id, TransitionRequestPayload(event="CANCEL_ORDER"), response)


@app.post("/api/orders/{order_id}/reset")
async def reset_order(order_id: str, response: Response) -> Dict[str, Any]:
    return await process_transition(order_id, TransitionRequestPayload(event="RESET_ORDER"), response)


@app.get("/api/in-flight", response_model=InFlightResponse)
async def get_in_flight() -> InFlightResponse:
    summary = await svc.actor.get_in_flight_summary()
    all_txs = await svc.registry.store.list_in_flight(older_than_ms=None)

    in_flight_list = [
        OrderSummaryPayload(
            order_id=tx.transaction_id,
            current_state=str(tx.current_state),
            status=tx.status.value,
            updated_at=tx.updated_at,
        )
        for tx in all_txs
    ]

    breakdown_dict = {
        "idle": summary.breakdown.idle,
        "in_flight": summary.breakdown.in_flight,
        "compensating": summary.breakdown.compensating,
        "compensated": summary.breakdown.compensated,
        "completed": summary.breakdown.completed,
        "failed": summary.breakdown.failed,
    }

    return InFlightResponse(
        machine_id=svc.machine.id,
        total_in_flight=summary.total_in_flight,
        non_terminal_count=summary.non_terminal_count,
        terminal_states=summary.terminal_states,
        breakdown=breakdown_dict,
        in_flight_orders=in_flight_list,
    )


@app.get("/api/terminals", response_model=TerminalStatesResponse)
async def get_terminals() -> TerminalStatesResponse:
    return TerminalStatesResponse(
        machine_id=svc.machine.id,
        terminal_states=svc.actor.get_terminal_states(),
    )


@app.get("/api/scheduler")
async def get_scheduler_status() -> Dict[str, Any]:
    summary = await svc.actor.get_in_flight_summary()
    return {
        "scheduler_active": True,
        "interval_seconds": 30,
        "total_active_orders": summary.non_terminal_count,
        "in_flight_orders": summary.total_in_flight,
    }


@app.post("/api/scheduler/sweep")
async def sweep_scheduler() -> Dict[str, Any]:
    opts = ForceCleanUpOptions(stuck_only=True, action=ForceCleanUpAction.FAIL)
    result = await svc.actor.force_cleanup(opts)
    return {
        "message": f"Swept {result.processed_count} stuck order(s)",
        "processed_count": result.processed_count,
        "affected_order_ids": result.affected_transaction_ids,
    }


@app.post("/api/cleanup")
async def force_cleanup(payload: CleanupRequestPayload) -> Dict[str, Any]:
    action_enum = ForceCleanUpAction.FAIL
    if payload.action.lower() == "compensate":
        action_enum = ForceCleanUpAction.COMPENSATE
    elif payload.action.lower() == "reset":
        action_enum = ForceCleanUpAction.RESET

    opts = ForceCleanUpOptions(
        transaction_ids=payload.transaction_ids or [],
        older_than_ms=payload.older_than_ms,
        stuck_only=payload.stuck_only,
        action=action_enum,
    )
    result = await svc.actor.force_cleanup(opts)
    return {
        "matched_count": result.matched_count,
        "processed_count": result.processed_count,
        "action": result.action.value if result.action else None,
        "affected_order_ids": result.affected_transaction_ids,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3000, reload=True)
