# DFSM Go HTTP API Server Example (06-http-api-server)

End-to-end REST API Server demonstrating deterministic finite state machine (DFSM) orchestration using the Go SDK (`github.com/eklabdev/dfsm/sdks/go`).

## Features
- **Standard Go `net/http`**: Clean, production-ready REST API with zero heavyweight framework overhead.
- **Embedded Statechart YAML**: Validated at startup using JSON Schema Draft 2020-12.
- **LIFO Saga Rollback**: Automatic unwinding of compensation handlers on unhandled failure.
- **Parallel Regions**: Concurrent fulfillment (`packaging` + `shipping`) with automatic `onDone` bubbling to `delivered`.
- **Conditional Effect Routing**: Sub-effect chain evaluation based on context flags (`autoAuthorize`).
- **Comprehensive Logging**: Detailed `[HTTP-IN]`, `[HTTP-OUT]`, `[DFSM-STEP]`, `[DFSM-HOOK]`, `[DFSM-SAGA]`, and `[DFSM-EFFECT]` logs.
- **Durable Store Support**: Defaults to in-memory, with pluggable PostgreSQL and MongoDB backends via environment variables.
- **Postman v2.1 Collection**: Included `dfsm-go-api.postman_collection.json` with editable `{{orderId}}` and automated sync scripts.

## Running the Server

```bash
# In-Memory Store (default)
go run .

# Or with PostgreSQL
DFSM_STORE=postgres DFSM_POSTGRES_URL="postgres://dfsm:dfsm_password@localhost:55432/dfsm_test?sslmode=disable" go run .

# Or with MongoDB
DFSM_STORE=mongo DFSM_MONGO_URL="mongodb://localhost:27018" go run .
```

The server starts on port `8080` (or `$PORT`).

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/machine` | Returns machine metadata and raw YAML definition |
| `POST` | `/api/orders` | Creates a new order transaction |
| `GET` | `/api/orders/{id}` | Fetches current order state, context, status, and raw YAML |
| `POST` | `/api/orders/{id}/transitions` | Step-by-step transition execution (`{"event": "..."}`) |
| `POST` | `/api/orders/{id}/cancel` | Convenience shortcut for `CANCEL_ORDER` |
| `POST` | `/api/orders/{id}/reset` | Recovers order from `error` back to `created` |
| `GET` | `/api/orders` | Lists active in-flight orders |
| `GET` | `/api/in-flight` | Breakdown of in-flight and non-terminal orders |
| `GET` | `/api/terminals` | Returns list of terminal states (`[delivered, cancelled]`) |
| `GET` | `/api/scheduler` | Returns background sweep configuration |
| `POST` | `/api/scheduler/sweep` | Sweeps orphan transactions older than threshold |
| `POST` | `/api/cleanup` | Administrative forced cleanup with options |

## Testing

Run the full end-to-end integration suite:

```bash
go test -v ./...
```

