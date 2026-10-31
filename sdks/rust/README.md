# DFSM Rust SDK (`eklabdev-dfsm`)

Official Rust SDK for **DFSM** (Deterministic Finite State Machine) — high-performance, strictly schema-validated statecharts with Saga transactions, circuit breaker resilience, and multi-store durability.

## Features

- **XState-Compliant Statechart**: Compound parent bubbling, orthogonal parallel regions, and automatic `onDone` transitions.
- **Embedded JSON Schema Validation**: Draft 2020-12 schema validation baked into YAML parsing via `jsonschema`.
- **Precedence Policy Pipeline**: Multi-layer policy merging (`Code > YAML Transition > Machine Defaults > Global Default`) with non-multiplying exponential retry, circuit breaker, and timeout handling.
- **LIFO Saga Rollback**: Automatic unwinding of recorded compensation steps upon failure, with full state recovery.
- **Lifecycle Hooks**: Complete 6-hook lifecycle (`onStart`, `beforeTransition`, `afterTransition`, `onCompensate`, `onComplete`, `onTerminal`).
- **Conditional Effect Routing**: Dynamic sub-effect dispatch with guard depth limits (`maxEffectChainDepth`).
- **Pluggable State Stores**:
  - `MemoryStateStore`: High-speed thread-safe in-memory store.
  - Implement the `StateStore` trait for custom stores (PostgreSQL, MongoDB, Redis, etc.).
- **Comprehensive Ops APIs**: `get_status_breakdown()`, `get_in_flight_summary()`, `list_active_transactions()`, and `force_cleanup()`.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
eklabdev-dfsm = "1.0.0"
tokio = { version = "1", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
```

## Quick Start

```rust
use eklabdev_dfsm::actor::DfsmActor;
use eklabdev_dfsm::definition::parse_yaml_machine;
use eklabdev_dfsm::registry::FSMRegistry;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct OrderContext {
    order_id: String,
    amount: f64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let yaml = r#"
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
"#;

    let machine = parse_yaml_machine(yaml)?;
    let reg = FSMRegistry::new();
    let actor = DfsmActor::<OrderContext>::new(machine, Arc::new(reg));

    let res = actor
        .transition("order-001", "SUBMIT", None::<serde_json::Value>)
        .await?;

    println!("State: {} (Status: {:?})", res.current_state, res.status);
    Ok(())
}
```

## Progressive Examples

| Directory | Topic | Description |
|---|---|---|
| [`examples/01-simple-traffic-light`](./examples/01-simple-traffic-light) | Basics | Atomic states, timer transitions, final state completion |
| [`examples/02-yaml-validation`](./examples/02-yaml-validation) | Validation | Input payload validation and JSON Schema Draft 2020-12 |
| [`examples/03-hierarchical-parallel`](./examples/03-hierarchical-parallel) | Hierarchy & Parallel | Orthogonal parallel regions and automatic parent `onDone` cascades |
| [`examples/04-policy-saga-recovery`](./examples/04-policy-saga-recovery) | Saga & Policy | Retries, circuit breaker, LIFO Saga compensation rollback, and error recovery |
| [`examples/05-multi-actor-ops`](./examples/05-multi-actor-ops) | Operations | Multi-actor monitoring, status breakdowns, and orphan cleanup sweeps |
| [`examples/06-axum-api-server`](./examples/06-axum-api-server) | End-to-End API Server | Axum REST API server with Postman collection, structured logs, and step-by-step transitions |

## Running Examples & Tests

```bash
# Run canonical conformance suite (6/6 scenarios)
cargo test --test conformance_test

# Run core unit tests
cargo test --test dfsm_test

# Run progressive examples
cargo run --example 01-simple-traffic-light
cargo run --example 02-yaml-validation
cargo run --example 03-hierarchical-parallel
cargo run --example 04-policy-saga-recovery
cargo run --example 05-multi-actor-ops

# Run Example 06 Axum API server tests
cargo test --manifest-path examples/06-axum-api-server/Cargo.toml
```

