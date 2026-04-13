## Why

Teams need durable, MongoDB-backed finite state machines where the **machine definition is the contract**: action and guard slots are declared with Zod schemas, `dfsm compile` generates TypeScript interfaces, and implementations stay in ordinary classes—no serialised functions in the database. This change establishes **@eklabdev/dfsm (dfsm)** as a monorepo product (core, CLI, viz, examples) so workflows survive crashes, support optimistic concurrency and outbox-style side effects, and remain type-safe from config through migrate.

## What Changes

- Introduce **`packages/core`**: serialisable `MachineConfig`, `defineMachine` / `createSaga`, compiler (`lint`, `compile`, `generateInterface`), MongoDB `IStateStore` / `MongoStateStore`, and runtime (`WorkflowEngine`, pure `executeTransition`, `ActionExecutor`, `TimeoutSupervisor`, `ConcurrencyManager`).
- Introduce **`packages/cli`**: `dfsm lint`, `dfsm compile`, `dfsm migrate` (up/down/status), `dfsm viz` launcher; config loaded from project `dfsm.config.ts`; **`migrate up` MUST run `tsc --noEmit` before any DB write** (no partial migrate on type failure).
- Introduce **`packages/viz`**: Express API for graph/live/workflow/diff plus React UI (elkjs layout, live counts, history timeline).
- Add **examples** (`order-fulfilment`, `traffic-light`), **docs** (architecture, ADRs, guides), and **root toolchain** (pnpm workspaces, turbo, Vitest, CI with MongoDB for integration tests).
- **BREAKING**: N/A for a greenfield repo; future published package APIs may semver independently.

## Capabilities

### New Capabilities

- `machine-configuration`: `MachineConfig`, slot declarations (Zod-only), `ActionInput` / `HistoryEntry`, `defineMachine` validation/registry, optional `createSaga` helper.
- `compiler`: Graph lint, `compile` → `TransitionTable` / `CompiledMachine`, `VizGraph`, `generateInterface` output for `generated/I*Actions.ts` / `I*Guards.ts`.
- `mongodb-persistence`: Collections (`workflow_state`, `action_outbox`, `machine_registry`), indexes, leases, transactional `transitionWithOutbox`, outbox lifecycle APIs, machine version persistence.
- `workflow-runtime`: `WorkflowEngine` (`startWorkflow`, `sendEvent`), guard/action handler registration, outbox relay merging context, TTL supervisor, version-pinned transitions for in-flight workflows.
- `dfsm-cli`: Commander-based commands, `.dfsm` compile artifacts, migrate gates and rollback rules, viz port defaults.
- `statechart-visualization`: HTTP APIs and SPA behaviour for graph, live aggregates, workflow detail, and history diff.
- `developer-experience`: Examples, documentation set, workspace scripts, and CI pipeline aligned with integration/unit test expectations.

### Modified Capabilities

- _(none — `openspec/specs/` has no baseline specs yet.)_

## Impact

- New **pnpm** workspace layout under `packages/*` and `examples/*`.
- **Runtime dependency** on MongoDB 6+ driver and server for integration tests and examples.
- **Developer workflow**: edit machine → `dfsm compile` → fix implementations until `tsc` passes → `dfsm migrate up`.
- **Operational**: workers rely on lease TTL, outbox polling interval, and supervisor scan intervals as configured.
