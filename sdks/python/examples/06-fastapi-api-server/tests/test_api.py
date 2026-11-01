from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

import sys
from pathlib import Path

# Add current example directory to sys.path so main and models can be imported
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import app, svc


@pytest.fixture(autouse=True)
def reset_service():
    # Re-initialize the service before each test for fresh state
    from order_service import OrderFulfillmentService
    import main
    main.svc = OrderFulfillmentService()


@pytest.mark.asyncio
async def test_get_machine():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/machine")
        assert resp.status_code == 200
        data = resp.json()
        assert data["machine_id"] == "fastapi-order-fulfillment"
        assert data["initial_state"] == "created"
        assert "delivered" in data["terminal_states"]
        assert "cancelled" in data["terminal_states"]
        assert "dfsm:" in data["machine_yaml"]


@pytest.mark.asyncio
async def test_happy_path_e2e():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. Create order
        create_resp = await client.post(
            "/api/orders",
            json={"orderId": "order-happy-1", "customer": "test@eklab.dev", "amount": 150.0},
        )
        assert create_resp.status_code == 200
        data = create_resp.json()
        assert data["order_id"] == "order-happy-1"
        assert data["current_state"] == "created"
        assert data["status"] == "IDLE"
        assert "SUBMIT_ORDER" in data["available_events"]

        # 2. Transition 1: SUBMIT_ORDER
        sub_resp = await client.post(
            "/api/orders/order-happy-1/transitions",
            json={"event": "SUBMIT_ORDER"},
        )
        assert sub_resp.status_code == 200
        sub_data = sub_resp.json()
        assert sub_data["current_state"] == "inventory_reserved"
        assert sub_data["context"]["items_reserved"] is True
        assert sub_data["saga_stack_depth"] == 1

        # 3. Transition 2: AUTHORIZE_PAYMENT (Parallel fulfillment)
        pay_resp = await client.post(
            "/api/orders/order-happy-1/transitions",
            json={"event": "AUTHORIZE_PAYMENT"},
        )
        assert pay_resp.status_code == 200
        pay_data = pay_resp.json()
        assert "fulfilling" in pay_data["current_state"]
        assert pay_data["context"]["payment_charged"] is True

        # 4. Transition 3: PACK_COMPLETE
        pack_resp = await client.post(
            "/api/orders/order-happy-1/transitions",
            json={"event": "PACK_COMPLETE"},
        )
        assert pack_resp.status_code == 200
        pack_data = pack_resp.json()
        assert "packed" in pack_data["current_state"]
        assert pack_data["context"]["pack_complete"] is True

        # 5. Transition 4: BOOK_CARRIER (triggers onDone -> delivered)
        ship_resp = await client.post(
            "/api/orders/order-happy-1/transitions",
            json={"event": "BOOK_CARRIER"},
        )
        assert ship_resp.status_code == 200
        ship_data = ship_resp.json()
        assert ship_data["current_state"] == "delivered"
        assert ship_data["status"] == "COMPLETED"


@pytest.mark.asyncio
async def test_saga_compensation_rollback_and_recovery():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # Create order configured to fail at payment
        create_resp = await client.post(
            "/api/orders",
            json={
                "orderId": "order-fail-1",
                "customer": "fail@eklab.dev",
                "amount": 250.0,
                "simulateFailure": True,
            },
        )
        assert create_resp.status_code == 200

        # Reserve inventory -> pushes compensation
        sub_resp = await client.post(
            "/api/orders/order-fail-1/transitions",
            json={"event": "SUBMIT_ORDER"},
        )
        assert sub_resp.status_code == 200
        assert sub_resp.json()["saga_stack_depth"] == 1

        # Authorize payment -> fails after 3 retry attempts, triggers LIFO Saga rollback
        pay_resp = await client.post(
            "/api/orders/order-fail-1/transitions",
            json={"event": "AUTHORIZE_PAYMENT"},
        )
        assert pay_resp.status_code == 200
        pay_data = pay_resp.json()
        assert pay_data["current_state"] == "error"
        assert pay_data["status"] == "COMPENSATED"
        assert pay_data["context"]["items_reserved"] is False  # Compensation ran!
        assert pay_data["step_result"]["compensated_steps"] == 1
        assert pay_data["step_result"]["rollback_occurred"] is True

        # Reset order back to created
        reset_resp = await client.post("/api/orders/order-fail-1/reset")
        assert reset_resp.status_code == 200
        reset_data = reset_resp.json()
        assert reset_data["current_state"] == "created"
        assert reset_data["status"] == "IDLE"


@pytest.mark.asyncio
async def test_in_flight_and_terminal_endpoints():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # Terminal states
        term_resp = await client.get("/api/terminals")
        assert term_resp.status_code == 200
        term_data = term_resp.json()
        assert "delivered" in term_data["terminal_states"]
        assert "cancelled" in term_data["terminal_states"]

        # In-flight
        in_flight_resp = await client.get("/api/in-flight")
        assert in_flight_resp.status_code == 200
        in_flight_data = in_flight_resp.json()
        assert "total_in_flight" in in_flight_data
        assert "non_terminal_count" in in_flight_data
        assert "breakdown" in in_flight_data

        # Scheduler
        sched_resp = await client.get("/api/scheduler")
        assert sched_resp.status_code == 200
        assert sched_resp.json()["scheduler_active"] is True


@pytest.mark.asyncio
async def test_validation_and_not_found():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 422: Invalid email
        bad_email_resp = await client.post(
            "/api/orders",
            json={"orderId": "bad-1", "customer": "not-an-email", "amount": 50.0},
        )
        assert bad_email_resp.status_code == 422

        # 422: Invalid amount (must be > 0)
        bad_amt_resp = await client.post(
            "/api/orders",
            json={"orderId": "bad-2", "customer": "test@eklab.dev", "amount": -10.0},
        )
        assert bad_amt_resp.status_code == 422

        # 404: Non-existent order
        nf_resp = await client.get("/api/orders/non-existent-order")
        assert nf_resp.status_code == 404

        # 409: Invalid transition
        await client.post(
            "/api/orders",
            json={"orderId": "order-invalid-step", "customer": "valid@eklab.dev", "amount": 20.0},
        )
        invalid_step_resp = await client.post(
            "/api/orders/order-invalid-step/transitions",
            json={"event": "NON_EXISTENT_EVENT"},
        )
        assert invalid_step_resp.status_code == 409

