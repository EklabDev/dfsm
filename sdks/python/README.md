# DFSM Python SDK (`eklabdev-dfsm`)

Official Python SDK for **DFSM** (Deterministic Finite State Machine) — enterprise-grade statecharts with distributed Saga orchestration, 4-layer policy merging, circuit breaker resilience, and multi-store durability.

---

## Features

- **XState-Compliant Statechart**: Compound parent bubbling, orthogonal parallel regions, and automatic `onDone` transitions.
- **Embedded JSON Schema Validation**: Draft 2020-12 schema validation baked into YAML parsing via `jsonschema`.
- **Precedence Policy Pipeline**: 4-layer policy merging (`Code Decorator > Transition YAML > Machine Defaults > Global Default`) with non-multiplying exponential retries & jitter, sliding-window circuit breaker, and timeout handling.
- **LIFO Saga Rollback**: Automatic unwinding of recorded compensation steps upon failure, with full state recovery.
- **Complete Lifecycle Hooks**: 6 lifecycle hooks (`on_start`, `before_transition`, `after_transition`, `on_compensate`, `on_complete`, `on_terminal`).
- **Conditional Effect Routing**: Dynamic sub-effect dispatch (`run_effect`) with guard depth limits (`maxEffectChainDepth`).
- **Pluggable State Stores**:
  - `MemoryStateStore`: High-speed thread-safe in-memory store.
  - Implement the `StateStore` protocol for custom stores (PostgreSQL, Redis, DynamoDB, MongoDB, etc.).
- **Comprehensive Ops & Admin APIs**: `get_in_flight_summary()`, `get_terminal_states()`, and `force_cleanup()`.

---

## Installation

```bash
pip install eklabdev-dfsm
```

Or install with optional API extras (FastAPI & Uvicorn):

```bash
pip install eklabdev-dfsm[api]
```

---

## Quick Start

```python
import asyncio
from dataclasses import dataclass
from dfsm import DfsmActor, FSMRegistry, parse_yaml_machine

@dataclass
class OrderContext:
    order_id: str = ""
    amount: float = 0.0

async def main():
    yaml_def = """
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
"""

    machine = parse_yaml_machine(yaml_def)
    actor = DfsmActor[OrderContext](machine)

    tx_id = "order-001"
    await actor.start(tx_id, OrderContext(order_id=tx_id, amount=99.50))

    # Advance state: draft -> processing
    res = await actor.transition(tx_id, "SUBMIT")
    print(f"Current state: {res.current_state} (Status: {res.status.value})")

    # Complete order: processing -> fulfilled
    res = await actor.transition(tx_id, "COMPLETE")
    print(f"Final state: {res.current_state} (Status: {res.status.value})")

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Examples Catalog

| Example | Directory | Highlights |
|---|---|---|
| **01 Simple Traffic Light** | `examples/01-simple-traffic-light` | Minimal 3-state cycle with timer transitions and terminal state |
| **02 YAML Validation** | `examples/02-yaml-validation` | Pydantic payload validation and Draft 2020-12 schema verification |
| **03 Hierarchical & Parallel** | `examples/03-hierarchical-parallel` | Parallel regions with concurrent progression and automatic `onDone` |
| **04 Policy & Saga Recovery** | `examples/04-policy-saga-recovery` | Exponential retries, circuit breaker, and LIFO Saga compensation unwind |
| **05 Multi-Actor Ops** | `examples/05-multi-actor-ops` | Non-terminal counts, stuck transaction sweeper, and `force_cleanup` |
| **06 FastAPI REST API Server** | `examples/06-fastapi-api-server` | Full REST API server with request/response logging middleware, step logs, Postman collection, and E2E tests |

---

## Conformance Verification

The Python SDK passes 100% of the canonical cross-SDK conformance scenarios:

```bash
cd sdks/python
pytest tests/test_conformance.py
```

- Scenario 1: Atomic state cycle
- Scenario 2: Hierarchical bubbling cancellation
- Scenario 3: Hierarchical child `onDone` cascade
- Scenario 4: Orthogonal parallel regions joint `onDone` cascade
- Scenario 5: 4-layer policy precedence pipeline
- Scenario 6: LIFO Saga compensation rollback and state recovery

---

## Publishing to PyPI

```bash
# 1. Build distribution archives
python -m build

# 2. Upload to PyPI (or TestPyPI)
twine upload dist/*
```

