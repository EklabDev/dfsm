# DFSM ASP.NET Core REST API Server Sample

A production-grade ASP.NET Core Minimal API server demonstrating the complete **DFSM (`EKLabDev.Dfsm`)** orchestration lifecycle for an e-commerce order and parallel fulfillment workflow.

## Features Demonstrated

- **Canonical YAML Workflow (`order-fulfillment.dfsm.yaml`)**:
  - `created` -> `SUBMIT_ORDER` -> `inventory_reserved`
  - Conditional `@DfsmEffect` (`evaluatePostReserveRouting`) auto-routing priority orders into `AUTHORIZE_PAYMENT`
  - Parallel fulfillment (`packaging.packing` + `shipping.booking_carrier`)
  - Automatic `onDone` -> `delivered` (`COMPLETED`)
  - Distributed LIFO Saga rollback on carrier failure (`refundPayment` then `releaseInventory`)
  - Overridden `error` state with `RESET_ORDER` recovery back to `created`
- **Machine Definition in Responses**: `GET /api/machine` and all order transition responses return current state, status, availableEvents, and the full YAML definition.
- **Structured Real-Time Logs**:
  - Request/Response envelope: `--> POST /api/orders/{id}/transitions` and `<-- 200 POST` with elapsed ms
  - Execution pipeline: `[DFSM-STEP] tx={id} | event={event} | handler={handler} | attempts={n} | outcome=SUCCESS`
  - Lifecycle hooks: `[DFSM-HOOK] hook=beforeTransition | tx={id} | ...`
- **Operations & Introspection APIs**:
  - `GET /api/in-flight`: List active orders, total non-terminal count, and list of terminal states.
  - `GET /api/terminals`: Terminal states (`delivered`, `cancelled`, `error`) and statuses (`COMPLETED`, `COMPENSATED`, `FAILED`).
  - `POST /api/cleanup`: Administrative clean-up supporting safe `dryRun: true`.
- **Postman v2.1 Collection**: Pre-configured in `dfsm-aspnet-api.postman_collection.json` with editable `{{orderId}}` variable.

## Running the Server

```bash
cd examples/06-aspnet-api-server
dotnet run
```

The server starts on `http://localhost:5000` (or configured port).

## Running Tests

```bash
dotnet test ../../tests/EKLabDev.Dfsm.Tests
```

