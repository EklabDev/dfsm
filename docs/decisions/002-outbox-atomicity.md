# ADR-002: Transactional transition + transactional outbox

## Status

Accepted

## Context

On each transition, the engine must both **advance durable state** (state, version, history) and **schedule side effects** (action slots). If these are written in separate non-transactional steps, failure modes include: state advanced but no work enqueued (lost effects), or work enqueued but state not advanced (duplicate or orphan processing relative to the chart). Classic **dual-write** hazards apply.

## Decision

Implement **`transitionWithOutbox`** using **`ClientSession.withTransaction`**: within one transaction, perform a conditional **`updateOne`** on **`workflow_state`** (including **`$push`** to `history` and **`$inc`** on `version` when the expected version matches) and **`insertMany`** into **`action_outbox`** for all dispatched slots. Each outbox row carries a **unique `idempotencyKey`** enforced by a MongoDB unique index.

Background **`ActionExecutor`** workers poll **`action_outbox`**, transition items through executing/done/failed, invoke handlers, and persist action results via **`mergeContext`**.

## Consequences

- **Pros**: Atomic coupling of “transition committed” and “work scheduled”; crash recovery replays from outbox, not from best-effort memory.
- **Pros**: Idempotency keys prevent duplicate inserts for the same logical dispatch at the storage layer.
- **Cons**: Requires replica set / deployment configuration that supports multi-document transactions.
- **Cons**: Handler implementations should remain **idempotent** where external systems do not deduplicate on their own; the outbox prevents duplicate *rows* but retries after partial external side effects remain an application concern.

## Alternatives Considered

- **Saga orchestration without outbox** — Rejected for core path: harder to guarantee alignment between chart movement and effect scheduling across failures.
- **Post-commit hook / message queue only** — Rejected as sole mechanism: introduces second system of record unless tightly coupled with DB commit; outbox colocates scheduling with workflow state.
- **Inline synchronous actions inside `sendEvent`** — Rejected: couples long I/O with lease hold time, obscures retries, and breaks the “pure transition planner + async effects” split.
