# Example 06: DFSM Spring Boot REST API Server

Full end-to-end Spring Boot 3 REST API sample demonstrating the **DFSM Java SDK (`io.github.eklabdev:dfsm-core`)** orchestrating an e-commerce order intake and parallel fulfillment Saga workflow.

---

## Capabilities Demonstrated

- **`dfsm: "1.0"` YAML Orchestration**: Loaded from `src/main/resources/order-fulfillment.dfsm.yaml` on application startup.
- **Service Handler Binding via Annotations**:
  - `@DfsmTransition`, `@Retry(3)`, `@CompensateWith`, `@OnFail(compensate = true, target = "error")`
  - `@DfsmCompensate` for LIFO Saga rollback
  - `@DfsmEffect` with conditional routing (`req.runEffect(...)` + `req.actor().transition(...)`)
  - All 6 `@DfsmHook` lifecycle hooks (`onOrderStarted`, `onBeforeOrderStep`, `onAfterOrderStep`, `onOrderCompensated`, `onOrderCompleted`, `onOrderTerminal`)
- **Structured Request & Response Logging Filter**:
  - Logs every incoming HTTP request (`--> METHOD /path | body={...}`)
  - Logs internal DFSM step and hook executions (`[DFSM-STEP]`, `[DFSM-HOOK]`)
  - Logs HTTP responses with elapsed time, `currentState`, `status`, `stepResult`, and `availableEvents` (`<-- 200 POST /path (6ms) | txId=... | currentState=... | status=IDLE | availableEvents=[...]`)
- **FSM State + YAML Response Envelope**: Every transaction response includes `currentState`, `status`, `availableEvents`, `context`, `lastBenchmark`, and the machine `yaml`.
- **Durable Persistence**: Defaults to in-memory H2, configurable to PostgreSQL (`DFSM_STORE=postgres`) or MongoDB (`DFSM_STORE=mongo`).
- **Postman v2.1 Collection**: [`dfsm-spring-api.postman_collection.json`](./dfsm-spring-api.postman_collection.json) with configurable `{{baseUrl}}` (default `http://localhost:8080`) and dynamic `{{orderId}}` synchronization.

---

## Running the Server

```bash
# Build and run with Spring Boot Maven plugin
cd sdks/java/examples/06-spring-boot-api-server
./mvnw spring-boot:run
```

The server listens on **`http://localhost:8080`**.

---

## Step-by-Step cURL Guide

### 1. Inspect Machine Definition & YAML
```bash
curl -s http://localhost:8080/api/machine | jq .
```

### 2. Create Order
```bash
curl -s -X POST http://localhost:8080/api/orders \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"order-101","customerEmail":"buyer@example.com"}' | jq .
```

### 3. Submit Order (Reserves Inventory)
```bash
curl -s -X POST http://localhost:8080/api/orders/order-101/transitions \
  -H "Content-Type: application/json" \
  -d '{
    "event": "SUBMIT_ORDER",
    "input": {
      "items": [{"sku":"KEYBOARD-01","quantity":1,"unitPriceCents":12900}],
      "autoApprovePayment": false
    }
  }' | jq .
```

### 4. Authorize Payment (Enters Concurrent Fulfillment)
```bash
curl -s -X POST http://localhost:8080/api/orders/order-101/transitions \
  -H "Content-Type: application/json" \
  -d '{
    "event": "AUTHORIZE_PAYMENT",
    "input": {
      "paymentMethod": "visa_credit",
      "simulateFailure": false
    }
  }' | jq .
```

### 5. Pack Order
```bash
curl -s -X POST http://localhost:8080/api/orders/order-101/transitions \
  -H "Content-Type: application/json" \
  -d '{
    "event": "PACK_COMPLETE",
    "input": {"boxWeightKg": 1.45}
  }' | jq .
```

### 6. Book Carrier (Triggers `onDone` -> `delivered` / `COMPLETED`)
```bash
curl -s -X POST http://localhost:8080/api/orders/order-101/transitions \
  -H "Content-Type: application/json" \
  -d '{
    "event": "BOOK_CARRIER",
    "input": {"carrier":"FEDEX","trackingNumber":"TRK-990011"}
  }' | jq .
```

---

## Running Automated Tests

```bash
cd sdks/java/examples/06-spring-boot-api-server
./mvnw test
```

