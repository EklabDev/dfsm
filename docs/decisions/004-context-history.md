# ADR-004: Append-only history and accumulating context

## Status

Accepted

## Context

Workflows need **durable business data** that carries across many states (identifiers, amounts, correlation IDs) and a **trace** of what happened for support, compliance, and debugging. Mixing these concerns in one mutable structure invites accidental rewrite of audit data or using audit data as live state.

## Decision

- **`context`**: A **document-shaped accumulator** on **`workflow_state`**. Transitions may apply shallow field updates (`contextUpdate` / **`mergeContext`**). Action handlers return **partial** objects merged into **`context`** after outbox execution. This is the **authoritative working state** for guards, actions, and integrations.

- **`history`**: An **append-only** array. Each transition **`$push`**es an entry capturing from/to state, event type and payload, **snapshot of context at transition time**, and dispatched action slot names. **No in-place mutation** of prior history elements is supported by the engine API.

## Consequences

- **Pros**: Clear separation: **`context`** answers “what do we know now?”; **`history`** answers “how did we get here?”
- **Pros**: Snapshots in history support diffing and incident reconstruction without guessing past field values.
- **Cons**: Snapshot duplication increases document size; retention/compaction policies may be needed for long-lived workflows.
- **Cons**: **`context`** shape is not rigidly enforced at the database layer (BSON); type discipline is enforced in TypeScript at the machine and generated-interface level.

## Alternatives Considered

- **History-only / derived context from replay** — Rejected for v1: higher read cost and replay complexity for every operation.
- **Mutable history entries** — Rejected: violates audit expectations and complicates concurrent writers.
- **Separate audit table/collection** — Possible future optimisation; core design keeps a single workflow document for simplicity.
