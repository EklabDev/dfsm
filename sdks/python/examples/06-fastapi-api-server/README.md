# Example 06 — Full End-to-End FastAPI REST API Server

This example boots a complete **FastAPI** REST API server backed by **DFSM Python (`eklabdev-dfsm`)** and [`order-fulfillment.dfsm.yaml`](./order-fulfillment.dfsm.yaml), letting you step through transitions **1-by-1** over HTTP and inspect the live FSM state, `available_events`, typed Pydantic `context`, Saga `compensation_stack`, YAML-defined lifecycle hooks (`@dfsm_hook`), conditional sub-effects (`@dfsm_effect`), benchmark telemetry, and the underlying YAML definition on every call.

---

## 1. Start the FastAPI Server

```bash
cd sdks/python/examples/06-fastapi-api-server

# Run with uvicorn on port 8000:
../../.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Every incoming request, DFSM step benchmark, and outgoing response prints structured terminal logs showing `txId`, `currentState`, `status`, `result`, and `availableEvents`:

```text
[2026-11-01T15:32:22.677Z] --> POST /api/orders | body={"orderId":"order-py-101","customer":"buyer@eklab.dev","amount":150.0}
[DFSM-HOOK:onStart] tx=order-py-101 | initial=created
[2026-11-01T15:32:22.679Z] <-- 200 POST /api/orders (1ms) | txId=order-py-101 | currentState="created" | status=IDLE | availableEvents=["CANCEL_ORDER", "SUBMIT_ORDER"]
[2026-11-01T15:32:22.679Z] --> POST /api/orders/order-py-101/transitions | body={"event":"SUBMIT_ORDER"}
[DFSM-HOOK:beforeTransition] tx=order-py-101 | event=SUBMIT_ORDER | current=created
[DFSM-STEP] tx=order-py-101 | Items reserved in warehouse
[DFSM-STEP] tx=order-py-101 | event=SUBMIT_ORDER | handler=api.orders.reserveInventory | attempts=1 | outcome=SUCCESS (0ms) | created -> inventory_reserved
[DFSM-HOOK:afterTransition] tx=order-py-101 | event=SUBMIT_ORDER -> inventory_reserved (status=IDLE)
[2026-11-01T15:32:22.680Z] <-- 200 POST /api/orders/order-py-101/transitions (0ms) | txId=order-py-101 | currentState="inventory_reserved" | status=IDLE | result={"event": "SUBMIT_ORDER", "previous_state": "created", "current_state": "inventory_reserved", "status": "IDLE", "output": {"reservedSkus": 1, "totalCents": 15000}, "compensated_steps": 0, "rollback_occurred": false} | availableEvents=["AUTHORIZE_PAYMENT", "CANCEL_ORDER"]
```

---

## 1.5 Import the Postman Collection (`dfsm-python-api.postman_collection.json`)

Import [`dfsm-python-api.postman_collection.json`](./dfsm-python-api.postman_collection.json) directly into **Postman**:

- **Collection Variables**:
  - `baseUrl`: `http://localhost:8000`
  - `orderId`: `order-py-101` *(change anytime in the **Variables** tab, edit `"orderId"` in `01a. Create Order`, or run `01b. Create Order (Auto-New orderId)` to auto-generate a fresh ID!)*
  - `customerEmail`: `buyer@eklab.dev`
- Includes 5 ready-to-run folders:
  1. **1. Happy Path — Step-by-Step Transitions (1-by-1)**
  2. **2. Saga Compensation Rollback & Error Recovery**
  3. **3. Validation & Guardrail Responses (422 / 404 / 409)**
  4. **4. Machine YAML & Admin Control Plane**
  5. **5. Cancel Order**

---

## 2. Step-by-Step `curl` Walkthrough

### Step A — Create Order
```bash
curl -s -X POST http://localhost:8000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"orderId": "order-py-101", "customer": "buyer@eklab.dev", "amount": 150.0}'
```

### Step B — Reserve Inventory (`SUBMIT_ORDER`)
```bash
curl -s -X POST http://localhost:8000/api/orders/order-py-101/transitions \
  -H "Content-Type: application/json" \
  -d '{"event": "SUBMIT_ORDER"}'
```

### Step C — Authorize Payment (`AUTHORIZE_PAYMENT`)
```bash
curl -s -X POST http://localhost:8000/api/orders/order-py-101/transitions \
  -H "Content-Type: application/json" \
  -d '{"event": "AUTHORIZE_PAYMENT"}'
```

### Step D — Complete Packing (`PACK_COMPLETE`)
```bash
curl -s -X POST http://localhost:8000/api/orders/order-py-101/transitions \
  -H "Content-Type: application/json" \
  -d '{"event": "PACK_COMPLETE"}'
```

### Step E — Book Carrier (`BOOK_CARRIER`)
```bash
curl -s -X POST http://localhost:8000/api/orders/order-py-101/transitions \
  -H "Content-Type: application/json" \
  -d '{"event": "BOOK_CARRIER"}'
```
- Triggers automatic `onDone` cascade directly to `delivered` (`COMPLETED`)!

---

## 3. Automated Test Suite

```bash
cd sdks/python
.venv/bin/pytest examples/06-fastapi-api-server/tests
```

