# ADR-005: TypeScript compile gate and version-pinned migrations

## Status

Accepted

## Context

Registering a new **`machine_registry`** version changes runtime behaviour for **new** workflows. Implementations must implement **every** slot the compiled machine exposes; drift between config and code causes production failures after deploy. Migrations should also avoid stranding in-flight instances on semantics they were never started with.

## Decision

1. **`dfsm migrate up`** runs **`npx tsc --noEmit`** in the target project **`cwd`** **before** opening a MongoDB connection for registry writes. If TypeScript fails, the CLI exits without persisting a new version—**implementations must satisfy generated `I*Actions` / `I*Guards` interfaces** first.

2. **Version pinning** — **`startWorkflow`** records **`machineVersion`** from **`getActiveMachine`** on the **`workflow_state`** document. Transition execution uses **`machineId` + `machineVersion`** to select compiled semantics (see engine **`getCompiled`**). **`saveMachineVersion`** marks older registry rows **`deprecated`** and inserts the new **`active`** row without rewriting existing workflow documents.

3. **CLI preconditions** — **`migrate up`** requires **`.dfsm/{machineId}.json`** and **`generated/I{Name}Actions.ts`** to exist (i.e. **`dfsm compile`** has been run).

## Consequences

- **Pros**: Catches contract drift at migrate time; reduces “green CI locally but broken handlers in prod” scenarios.
- **Pros**: In-flight workflows continue on the **pinned** table until completion, isolating them from incompatible graph changes.
- **Cons**: **`tsc --noEmit`** adds latency to migrate; acceptable trade-off versus unsafe registry promotion.
- **Cons**: Long-lived workflows may run **old** versions indefinitely unless a separate data-migration story is introduced (explicitly out of scope for automatic cross-version rewriting).

## Alternatives Considered

- **Migrate without compile gate** — Rejected: allows promoting machines that TypeScript proves are inconsistent with slots.
- **Runtime-only reflection / dynamic dispatch** — Rejected: loses static guarantees the project is built around.
- **Forced upgrade of in-flight workflows on migrate** — Rejected for v1: high risk without automated state mapping; version pinning is the safe default.
