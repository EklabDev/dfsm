# DFSM Go SDK (`github.com/eklabdev/dfsm/sdks/go`)

Official Go SDK for **DFSM** (Deterministic Finite State Machine) — high-performance, strictly schema-validated statecharts with Saga transactions, circuit breaker resilience, and multi-store durability.

## Features

- **XState-Compliant Statechart**: Compound parent bubbling, orthogonal parallel regions, and automatic `onDone` transitions.
- **Embedded JSON Schema Validation**: Draft 2020-12 schema validation baked into YAML parsing via `santhosh-tekuri/jsonschema/v5`.
- **Precedence Policy Pipeline**: Multi-layer policy merging (`Code > YAML Transition > Machine Defaults > Global Default`) with non-multiplying exponential retry, circuit breaker, and timeout handling.
- **LIFO Saga Rollback**: Automatic unwinding of recorded compensation steps upon failure, with full state recovery.
- **Lifecycle Hooks**: Complete 6-hook lifecycle (`onStart`, `beforeTransition`, `afterTransition`, `onCompensate`, `onComplete`, `onTerminal`).
- **Conditional Effect Routing**: Dynamic sub-effect dispatch with guard depth limits (`maxEffectChainDepth`).
- **Pluggable State Stores**:
  - `MemoryStateStore`: High-speed thread-safe in-memory store.
  - `PostgresStateStore`: PostgreSQL storage with transactional Saga steps and optimistic concurrency control (`pgx/v5`).
  - `MongoStateStore`: MongoDB document storage with embedded atomic compensation arrays.
- **Comprehensive Ops APIs**: `GetStatusBreakdown`, `GetInFlightSummary`, `ListActiveTransactions`, and `ForceCleanUp`.

## Installation

```bash
go get github.com/eklabdev/dfsm/sdks/go
```

## Quick Start

```go
package main

import (
    "context"
    "fmt"
    "github.com/eklabdev/dfsm/sdks/go"
)

type MyContext struct {
    OrderId string `json:"orderId"`
    Amount  float64 `json:"amount"`
}

func main() {
    yamlDef := `
dfsm: "1.0"
id: "order-lifecycle"
version: "1.0.0"
initial: "draft"
states:
  draft:
    on:
      SUBMIT: "processing"
  processing:
    on:
      COMPLETE: "fulfilled"
  fulfilled:
    type: "final"
`

    machine, err := dfsm.ParseYamlMachine(yamlDef)
    if err != nil {
        panic(err)
    }

    reg := dfsm.NewFSMRegistry()
    actor := dfsm.NewDfsmActor[MyContext](machine, reg)
    ctx := context.Background()

    res, err := actor.Transition(ctx, "order-001", "SUBMIT", nil)
    if err != nil {
        panic(err)
    }
    fmt.Printf("State: %s (Status: %s)\n", res.CurrentState, res.Status)
}
```

## Progressive Examples

| Directory | Topic | Description |
|---|---|---|
| [`examples/01-simple-traffic-light`](./examples/01-simple-traffic-light) | Basics | Atomic states, timer transitions, final state completion |
| [`examples/02-yaml-validation`](./examples/02-yaml-validation) | Validation | Struct tags (`required`, `email`, `min`) and JSON Schema Draft 2020-12 |
| [`examples/03-hierarchical-parallel`](./examples/03-hierarchical-parallel) | Hierarchy & Parallel | Orthogonal parallel regions and automatic parent `onDone` cascades |
| [`examples/04-policy-saga-recovery`](./examples/04-policy-saga-recovery) | Saga & Policy | Retries, circuit breaker, LIFO Saga compensation rollback, and error recovery |
| [`examples/05-multi-actor-ops`](./examples/05-multi-actor-ops) | Operations | Multi-actor monitoring, status breakdowns, and orphan cleanup sweeps |
| [`examples/06-http-api-server`](./examples/06-http-api-server) | End-to-End API Server | REST API server with Postman collection, structured logs, and step-by-step transitions |

## Running Tests

```bash
# Run unit tests and canonical conformance suite
go test -v ./...

# Run Example 06 HTTP API tests
cd examples/06-http-api-server && go test -v ./...
```

