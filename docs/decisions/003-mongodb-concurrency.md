# ADR-003: Lease-based workflow locking with optimistic versioning

## Status

Accepted

## Context

Multiple workers or overlapping requests may call **`sendEvent`** for the same **`workflowId`**. Without coordination, two transitions could read the same **`version`**, both attempt updates, or interleave reads and writes in ways that corrupt chart semantics. Database-level row locking APIs vary by engine; we standardise on MongoDB primitives available in the reference store.

## Decision

Combine:

1. **Short-lived lease** — **`acquireLease`** uses **`findOneAndUpdate`** with a filter that matches the document only when **`lockedUntil`** is **`null`** or **less than `new Date()`**, and sets **`lockedUntil`** to **`Date.now() + ttlMs`**. **`releaseLease`** clears **`lockedUntil`** after the critical section. **`ConcurrencyManager.withLease`** wraps **`sendEvent`**’s transition work so only one lease holder runs the planner + **`transitionWithOutbox`** path at a time (for a given workflow).

2. **Optimistic locking** — **`transitionWithOutbox`** updates **`workflow_state`** only when **`version === expectedVersion`**, then atomically **`$inc`**’s **`version`**. A matched count of zero surfaces **`ConcurrentModificationError`**.

## Consequences

- **Pros**: Lease acquisition is a **single atomic conditional update**, analogous in intent to claiming a row for update until **`lockedUntil`** expires.
- **Pros**: **`version`** catches races that leases alone might not serialise (e.g. logical conflicts if lease TTL misconfigured or bypassing APIs).
- **Cons**: **`acquireLease` failure** makes **`withLease`** resolve **`null`** without running the callback; today **`WorkflowEngine.sendEvent`** does not inspect that return value, so a failed lease is effectively a **no-op** unless callers add logging or retries around **`sendEvent`**.
- **Cons**: Mis-tuned **`leaseTtlMs`** can cause starvation or excess contention; operators must align TTL with worst-case transition latency.

## Alternatives Considered

- **Version only, no lease** — Rejected as primary UX: relies entirely on retry on **`ConcurrentModificationError`**; higher churn under load for long-running handlers.
- **Distributed lock service (Redis, etc.)** — Rejected for v1: extra infrastructure and split-brain story; MongoDB remains the single coordination surface.
- **PostgreSQL `SELECT … FOR UPDATE SKIP LOCKED`** — Valid pattern but out of scope for the MongoDB-first v1 store.
