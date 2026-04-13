## Context

The @eklabdev/dfsm (`dfsm`) initiative greenfields a TypeScript monorepo that couples **declarative machine configs** (Zod-described action/guard slots, no embedded functions in persisted data) with **MongoDB-native durability** (optimistic concurrency, leases, transactional transition + outbox writes) and **compile-time bridges** (generated `I*Actions` / `I*Guards` interfaces). Project guidance lives in `claudeInstruction.md` (phased prompts through core, CLI, viz, examples, docs, CI). There is no pre-existing `openspec/specs` baseline; this change defines the initial capability set.

## Goals / Non-Goals

**Goals:**

- Ship `packages/core`, `packages/cli`, `packages/viz`, runnable `examples/order-fulfilment` and `examples/traffic-light`, and documentation sufficient for onboarding.
- Enforce non-negotiable invariants: transactional `transitionWithOutbox`, append-only `history`, unique outbox idempotency keys, pure `executeTransition`, `tsc --noEmit` gate before `migrate up` DB writes, version pinning for in-flight workflows.
- Provide observability via the viz package (graph, live counts, history diff).

**Non-Goals:**

- Hosted SaaS control plane, multi-region replication design, or non-Mongo persistence adapters in v1.
- Automatic data migration of in-flight workflows across machine versions beyond version pinning semantics described in the plan.
- Distributed sagas beyond the optional in-process `createSaga` helper.

## Decisions

| Decision | Rationale | Alternatives considered |
| --- | --- | --- |
| MongoDB as sole system of record | Matches instruction, leverages transactions + unique indexes for outbox idempotency and document-oriented context | PostgreSQL with SKIP LOCKED (rejected for v1 scope alignment) |
| Zod + `zod-to-ts` for interface generation | Keeps machine config as source of truth; compiler derives TS contracts | Hand-written interfaces (rejects contract sync), stringly slot maps (rejects type safety) |
| Synthetic `__AFTER_{ms}` events | Normalises TTL transitions through the same `sendEvent` path as user events | Separate supervisor-written rows bypassing transition table (rejected—duplicates logic) |
| `tsx` loads `dfsm.config.ts` | Matches Node developer ergonomics for TS config without a separate build step for config | JSON-only config (rejected—loses live `defineMachine` references) |
| Vitest + mongodb-memory-server | Fast unit + integration feedback in CI per toolchain section | Jest (acceptable but instruction specifies Vitest) |
| Express + Vite React for viz | Straightforward local dashboard behind `dfsm viz` | Next.js (heavier than needed for local tooling) |

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Lease TTL misconfiguration causes thrashing or stuck workflows | Document defaults (`30s` lease, `500ms` outbox poll, `30s` supervisor cadence) and surface lease acquisition failures in engine logs/metrics hooks (future). |
| Long-running actions block outbox worker throughput | Keep default batch small (`limit: 10`), document horizontal scaling story as multiple workers with lease + outbox contention model. |
| `tsc --noEmit` gate increases migrate latency | Accept trade-off for safety; provide `dfsm compile` dry feedback earlier in dev loop. |
| `mergeContext` races with concurrent transitions | Engine design only mutates context via outbox path while lease held; document that handlers must remain idempotent. |

## Migration Plan

1. Land packages and examples with passing CI.
2. Developers adopt workflow: edit machine → `dfsm compile` → fix TS until clean → `dfsm migrate up`.
3. Rollback uses `dfsm migrate down` after draining in-flight workflows; regenerated interfaces must match restored registry version.
4. Library versioning (if published) follows semver independently of machine schema semver (future packaging decision).

## Open Questions

- Whether `GET .../diff/:index` should return `400` for `index < 1` vs empty structural diff—finalize during viz implementation to match UI needs.
- Exact export surface of the public `@eklabdev/dfsm` package entry (barrel vs subpath exports) pending API review before first publish.
- Telemetry/metrics hooks for production deployments (outbox backlog depth, lease contention) are deferred beyond initial OSS drop.
