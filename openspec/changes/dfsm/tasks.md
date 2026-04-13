## 1. Workspace and toolchain

- [x] 1.1 Initialize pnpm workspace (`pnpm-workspace.yaml`, root `package.json`, `turbo.json`) with `packages/core`, `packages/cli`, `packages/viz`, and `examples/*` members per plan.
- [x] 1.2 Add shared `tsconfig.base.json` (`ES2022`, `NodeNext`, `strict`, `exactOptionalPropertyTypes`) and per-package `tsconfig` references.
- [x] 1.3 Configure Vitest, ESLint (if used), and root scripts: `build`, `test`, `test:unit`, `test:integration`, `lint`, `docs:api`.
- [x] 1.4 Add `.gitignore` entries for `node_modules/`, `dist/`, `.dfsm/`, `docs/api/`, and generated example dirs per instruction.
- [x] 1.5 Create GitHub Actions workflow running lint → build → unit → integration tests with MongoDB service container.

## 2. Core types (`packages/core`)

- [x] 2.1 Implement `types/machine.ts` (`ActionSlot`, `GuardSlot`, `TransitionConfig`, `StateConfig`, `MachineConfig`).
- [x] 2.2 Implement `types/context.ts` (`HistoryEntry`, `ActionInput`, `ActionHandler`, `GuardHandler`).
- [x] 2.3 Implement `types/engine.ts` (`VizNode`, `VizEdge`, `VizGraph`, `TransitionTable`, `TransitionTableEntry`, `CompiledMachine`).

## 3. defineMachine and saga helper

- [x] 3.1 Implement `define/defineMachine.ts` with structural validations and registry APIs.
- [x] 3.2 Implement `define/createSaga.ts` with compensation ordering semantics.
- [x] 3.3 Add unit tests in `packages/core/test/unit/define/` covering validation failures, registry behavior, and saga success/failure/compensation paths.

## 4. Compiler pipeline

- [x] 4.1 Implement `compiler/lint.ts` with error/warning codes enumerated in the plan.
- [x] 4.2 Implement `compiler/vizGraph.ts` (or equivalent) to build `VizGraph` from config.
- [x] 4.3 Implement `compiler/compile.ts` to assemble `TransitionTable`, dedupe slots, invoke lint, and return `CompiledMachine`.
- [x] 4.4 Implement `compiler/generateInterface.ts` using `zod-to-ts` with dedupe and context typing rules.
- [x] 4.5 Add unit tests for lint, compile, and interface generation (`packages/core/test/unit/compiler/`).

## 5. MongoDB persistence

- [x] 5.1 Define `IStateStore` covering workflow lifecycle, leasing, transactional transition + outbox insert, outbox processing helpers, machine registry access, and `mergeContext`.
- [x] 5.2 Implement `MongoStateStore` with collections, indexes in `setup()`, and Mongo session transactions for `transitionWithOutbox`.
- [x] 5.3 Add focused unit tests where feasible plus integration coverage via later engine tests.

## 6. Runtime engine

- [x] 6.1 Implement `ConcurrencyManager` wrapping lease acquire/release/`withLease`.
- [x] 6.2 Implement pure `executeTransition` with `GuardRejectedError` / `NoTransitionError`.
- [x] 6.3 Implement `WorkflowEngine` (`start`/`stop`, `startWorkflow`, `sendEvent`, `getWorkflow`, `getHistory`) coordinating store, compiled machines, guards/actions, and leases.
- [x] 6.4 Implement `ActionExecutor` background loop with retry + failure semantics.
- [x] 6.5 Implement `TimeoutSupervisor` scanning TTL transitions via synthetic events.
- [x] 6.6 Add targeted unit tests for executor pieces and transition executor (`packages/core/test/unit/engine/`).

## 7. Integration tests and fixtures

- [x] 7.1 Create `packages/core/test/fixtures/orderMachine.ts` and stub `orderActions.ts` implementing generated interfaces.
- [x] 7.2 Implement integration tests (`happy-path`, `crash-recovery`, `concurrent-workflows`, `timeout-stuck`, `outbox-retry`, `saga-compensation`, `migration`) using `mongodb-memory-server`, following assertions in the plan.

## 8. CLI (`packages/cli`)

- [x] 8.1 Implement `config/loadConfig.ts` to load `dfsm.config.ts` via `tsx`.
- [x] 8.2 Implement `dfsm lint`, `dfsm compile`, `dfsm migrate up/down/status`, and `dfsm viz` commands with chalk formatting and exit codes.
- [x] 8.3 Enforce `tsc --noEmit` gate in `migrate up` before DB writes; manage `.dfsm` JSON artifacts and generated interface output paths.
- [x] 8.4 Add CLI unit/integration tests under `packages/cli/test/`.

## 9. Visualization package

- [x] 9.1 Implement Express `server.ts` routes: `/api/graph/:machineId`, `/api/live/:machineId`, `/api/workflow/:workflowId`, `/api/workflow/:workflowId/diff/:index`, and static SPA hosting.
- [x] 9.2 Build React UI (`App`, `StatechartCanvas`, `LiveOverlay`, `HistoryPanel`) with elkjs layout, polling, and diff presentation.
- [x] 9.3 Wire `dfsm viz` to launch the server with configurable port/machine filters.

## 10. Examples

- [x] 10.1 Scaffold `examples/order-fulfilment` with machine, actions, `dfsm.config.ts`, `docker-compose.yml`, `run.ts`, README, and initial committed generated artifacts per instruction.
- [x] 10.2 Scaffold `examples/traffic-light` minimal sample with README and runnable `run.ts`.

## 11. Documentation

- [x] 11.1 Author `docs/architecture.md` plus ADRs (`docs/decisions/001`–`006` topics) mirroring plan themes.
- [x] 11.2 Author guides (`getting-started`, `defining-machines`, `implementing-actions`, `saga-helper`, `migration`, `visualization`) with breaking-change tables and operational guidance.

## 12. Final verification

- [x] 12.1 Run full `pnpm` test matrix locally and confirm CI parity.
- [x] 12.2 Run `openspec verify change dfsm` (or project equivalent) once implementation exists to ensure artifacts remain coherent.
