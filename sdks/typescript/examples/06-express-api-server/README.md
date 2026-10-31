# Example 06 — Full End-to-End Express REST API Server

This example boots a complete **Express** REST API server backed by **DFSM (`@eklabdev/dfsm`)** and [`order-fulfillment.dfsm.yaml`](./order-fulfillment.dfsm.yaml), letting you step through transitions **1-by-1** over HTTP and inspect the live FSM state, `availableEvents`, typed `context`, Saga `compensationStack`, YAML-defined lifecycle `hooks` (`@DfsmHook`) & conditional sub-`effects` (`@DfsmEffect`), benchmark telemetry, and the underlying `yaml` definition on every call.

> **Tip**: Open [`order-fulfillment.dfsm.yaml`](./order-fulfillment.dfsm.yaml) in VS Code and click **Open Statechart Visualizer** (`eklabdev.vscode-dfsm`) to view the statechart side-by-side while calling the endpoints below!

---

## 1. Start the Express Server

```bash
cd sdks/typescript

# Default embedded SQLite (:memory:) store on port 3000:
npm run start:api

# Or connect to live PostgreSQL / MongoDB (after `docker compose -f ../../infra/docker-compose.yml up -d`):
DFSM_STORE=postgres npm run start:api
DFSM_STORE=mongodb  npm run start:api
```

Every incoming request, DFSM step benchmark, and outgoing response prints structured terminal logs showing `txId`, `currentState`, `status`, `result`, and `availableEvents`:

```text
[2026-10-30T11:42:01.102Z] --> POST /api/orders/order-101/transitions | body={"event":"SUBMIT_ORDER","input":{"items":[{"sku":"MECH-KEY-01","quantity":2,"unitPriceCents":8500}]}}
[2026-10-30T11:42:01.104Z] [DFSM-STEP] tx=order-101 | event=SUBMIT_ORDER | handler=api.orders.reserveInventory | attempts=1 | outcome=SUCCESS (1ms) | "created" -> "inventory_reserved"
[2026-10-30T11:42:01.105Z] <-- 200 POST /api/orders/order-101/transitions (3ms) | txId=order-101 | currentState="inventory_reserved" | status=IDLE | result={"event":"SUBMIT_ORDER","previousState":"created","outputValue":{"reservedSkus":1,"totalCents":17000},"compensatedSteps":0} | availableEvents=["AUTHORIZE_PAYMENT","CANCEL_ORDER"]
```

---

## 1.5 Import the Postman Collection (`dfsm-express-api.postman_collection.json`)

Import [`dfsm-express-api.postman_collection.json`](./dfsm-express-api.postman_collection.json) directly into **Postman**:

- **Collection Variables**:
  - `baseUrl`: `http://localhost:3000`
  - `orderId`: `order-101` *(change this anytime in the **Variables** tab, edit `"transactionId"` in `01a. Create Order`, or run `01b. Create Order (Auto-Generate Fresh {{orderId}})` to auto-generate a new `order-<timestamp>` into `{{orderId}}`!)*
  - `customerEmail`: `buyer@eklab.dev`
- Includes 5 ready-to-run folders:
  1. **1. Happy Path — Step-by-Step Transitions (1-by-1)**
  2. **2. Saga Compensation Rollback & Error Recovery**
  3. **3. Validation & Guardrail Responses (400 / 409 / 404)**
  4. **4. Machine YAML & Admin Control Plane** (including **List Non-Terminal (Active) & In-Flight Orders + Terminal States**)
  5. **5. Conditional Effect Router & Automatic Next Transition** (`autoApprovePayment: true`)

---

## 2. Step-by-Step `curl` Walkthrough (1 Transition at a Time)

### Step A — Create a New Order Transaction (`initial: "created"`)
```bash
curl -s -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"transactionId": "order-101", "customerEmail": "buyer@eklab.dev"}' | jq .
```
- Persists `currentState: "created"`, `status: "IDLE"`, `availableEvents: ["SUBMIT_ORDER", "CANCEL_ORDER"]`, and returns the full `yaml` definition.

### Step B — Transition 1: `SUBMIT_ORDER` (`"created"` → `"inventory_reserved"`)
```bash
curl -s -X POST http://localhost:3000/api/orders/order-101/transitions \
  -H "Content-Type: application/json" \
  -d '{
    "event": "SUBMIT_ORDER",
    "input": {
      "items": [
        { "sku": "MECH-KEY-01", "quantity": 2, "unitPriceCents": 8500 }
      ]
    }
  }' | jq '{currentState, status, availableEvents, stepResult, compensationStack}'
```
- Validates input with **Zod**, reserves inventory (`totalCents: 17000`), and pushes `api.orders.releaseInventory` onto the persistent `compensationStack`.

### Step C — Transition 2: `AUTHORIZE_PAYMENT` (`"inventory_reserved"` → parallel `"fulfilling"`)
```bash
curl -s -X POST http://localhost:3000/api/orders/order-101/transitions \
  -H "Content-Type: application/json" \
  -d '{
    "event": "AUTHORIZE_PAYMENT",
    "input": { "paymentMethod": "visa_4242" }
  }' | jq '{currentState, status, availableEvents}'
```
- Enters XState `parallel` state:
  ```json
  {
    "currentState": {
      "fulfilling": {
        "packaging": "packing",
        "shipping": "booking_carrier"
      }
    },
    "status": "IDLE",
    "availableEvents": ["PACK_COMPLETE", "BOOK_CARRIER"]
  }
  ```

### Step D — Transition 3: `PACK_COMPLETE` (Advances `packaging` Region Only)
```bash
curl -s -X POST http://localhost:3000/api/orders/order-101/transitions \
  -H "Content-Type: application/json" \
  -d '{
    "event": "PACK_COMPLETE",
    "input": { "boxWeightKg": 1.8 }
  }' | jq '{currentState, status, availableEvents}'
```
- `packaging` becomes `"packed"` (`final`), while `shipping` remains `"booking_carrier"`!

### Step E — Transition 4: `BOOK_CARRIER` (Completes Both Parallel Regions → Automatic `onDone` → `"delivered"`)
```bash
curl -s -X POST http://localhost:3000/api/orders/order-101/transitions \
  -H "Content-Type: application/json" \
  -d '{
    "event": "BOOK_CARRIER",
    "input": { "carrier": "FedEx", "trackingNumber": "FDX-778899" }
  }' | jq '{currentState, status, availableEvents, notifications}'
```
- Both parallel regions reach `final`, automatically firing `fulfilling.onDone` → `currentState: "delivered"`, `status: "COMPLETED"`!

---

## 3. Try Failure + Retry + LIFO Saga Rollback + Error Recovery

```bash
# 1. Start order-202 and reserve inventory
curl -s -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"transactionId": "order-202", "customerEmail": "ops@eklab.dev"}' > /dev/null

curl -s -X POST http://localhost:3000/api/orders/order-202/transitions \
  -H "Content-Type: application/json" \
  -d '{"event": "SUBMIT_ORDER", "input": {"items": [{"sku": "GPU-90", "quantity": 1, "unitPriceCents": 99900}]}}' > /dev/null

# 2. Simulate payment failure -> retries 3 times (@Retry(3) overrides YAML retry: 2),
#    unwinds releaseInventory in LIFO order, and lands in custom 'error' state!
curl -s -X POST http://localhost:3000/api/orders/order-202/transitions \
  -H "Content-Type: application/json" \
  -d '{"event": "AUTHORIZE_PAYMENT", "input": {"paymentMethod": "declined_card", "simulateFailure": true}}' \
  | jq '{currentState, status, availableEvents, stepResult, inventoryReserved: .context.inventoryReserved, auditLog: .context.auditLog, lastBenchmark}'

# 3. Recover out of custom overridden 'error' state back to 'created'!
curl -s -X POST http://localhost:3000/api/orders/order-202/transitions \
  -H "Content-Type: application/json" \
  -d '{"event": "RESET_ORDER"}' | jq '{currentState, status, availableEvents}'
```

---

## 4. Conditional Effect Branching & Automatic Next Transition (`req.actor` + `req.runEffect`)

Because `EffectRequest<TContext>` exposes both `req.runEffect(effectName, payload)` and `req.actor`, `@DfsmEffect` functions can act as `if / else` routers and immediately trigger the next transition on the same actor without needing `always:` in YAML:

```bash
curl -s -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"transactionId": "order-vip-1", "customerEmail": "vip@eklab.dev"}' > /dev/null

# Sending autoApprovePayment: true enters 'inventory_reserved', triggers 'evaluatePostReserveRouting',
# delegates to 'autoAuthorizeWalletEffect', and calls req.actor.transition(..., "AUTHORIZE_PAYMENT")
# advancing straight into parallel 'fulfilling'!
curl -s -X POST http://localhost:3000/api/orders/order-vip-1/transitions \
  -H "Content-Type: application/json" \
  -d '{"event": "SUBMIT_ORDER", "input": {"autoApprovePayment": true, "items": [{"sku": "VIP-01", "quantity": 1, "unitPriceCents": 25000}]}}' \
  | jq '{currentState, status, availableEvents, paymentAuthId: .context.paymentAuthId, routingEvents}'
```

---

## 5. List Non-Terminal Orders, Terminal States, Machine Config & Admin Control Plane

```bash
# List all non-terminal ("active / open") orders (IDLE, IN_FLIGHT, COMPENSATING) + statusBreakdown + terminalStates
curl -s http://localhost:3000/api/orders | jq '{nonTerminalCount, terminalCount, statusBreakdown, topLevelTerminalStates: .terminalStates.topLevelTerminalStates, activeOrders}'

# Machine definition, terminalStates, normalized Decorator + YAML policies, & YAML source
curl -s http://localhost:3000/api/machine | jq .

# Registry config, loaded machines, active actors, scheduler status, lifecycle hooks, & benchmark logs
curl -s http://localhost:3000/api/admin/status | jq .

# Dry-run force cleanup of completed/compensated orders
curl -s -X POST http://localhost:3000/api/admin/cleanup \
  -H "Content-Type: application/json" \
  -d '{"statuses": ["COMPLETED", "COMPENSATED"], "dryRun": true}' | jq .
```

