# ADR-001: MongoDB documents as canonical workflow state

## Status

Accepted

## Context

@eklabdev/dfsm targets long-running workflows where correctness under restarts, crashes, and concurrent workers matters. We need a single **system of record** for each workflow instance: current state, version for concurrency, accumulated context, and an audit trail. Alternatives include keeping FSM state only in application memory, maintaining a separate event log with materialised views, or treating the database as a dump of snapshots disconnected from execution.

## Decision

Treat each **`workflow_state`** document as the **authoritative** representation of a running workflow. The document holds `currentState`, `machineId`, **`machineVersion`** (pinned at creation), `context`, append-only `history`, optimistic **`version`**, lease **`lockedUntil`**, and lifecycle **`status`**. Runtime code reads and updates this row (via `IStateStore` / `MongoStateStore`); there is no parallel “primary” copy of the same facts.

## Consequences

- **Pros**: Simple mental model; one read loads everything needed for a transition; MongoDB transactions can atomically update state and enqueue outbox work.
- **Pros**: **`machineVersion`** on the document isolates in-flight instances from newly registered machine definitions.
- **Cons**: Large `history` arrays grow without bound unless archived or trimmed by a separate policy (out of scope for the core invariant).
- **Cons**: Query patterns and indexes must be designed explicitly (e.g. supervisor scans, viz aggregates).

## Alternatives Considered

- **In-memory state with periodic snapshots** — Rejected: loses durability on process loss and complicates multi-worker setups.
- **Event-sourced store with on-the-fly fold** — Rejected for v1: higher operational and read-path complexity; can be revisited if replay-first semantics become a requirement.
- **Relational normalised tables per concern** — Deferred: MongoDB was chosen for document-shaped context, flexible schema, and transactional multi-collection updates aligned with the outbox pattern.
