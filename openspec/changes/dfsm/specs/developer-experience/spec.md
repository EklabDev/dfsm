## ADDED Requirements

### Requirement: Monorepo scripts orchestrate build and tests

The repository root SHALL define `pnpm` workspace configuration with `packages/*` and `examples/*`, `turbo` pipelines, and npm scripts for `build`, `test`, `test:unit`, `test:integration`, `lint`, and typedoc generation targeting `packages/core/src/index.ts`.

#### Scenario: CI runs the quality stages in order

- **WHEN** GitHub Actions executes on push or pull request to `main`
- **THEN** the workflow SHALL run lint, build, unit tests, then integration tests using a MongoDB service container mirroring production driver semantics.

### Requirement: Order fulfilment example is runnable end-to-end

The repository SHALL include `examples/order-fulfilment` with `machines/order.machine.ts`, `actions/order.actions.ts`, `dfsm.config.ts`, `docker-compose.yml` provisioning MongoDB 7, `run.ts` exercising a scripted happy path (`SUBMIT` → `PAYMENT_CAPTURED` → `SHIPPED` → `DELIVERED`), and `README.md` documenting prerequisites and commands (`docker-compose up`, `pnpm install`, `dfsm lint`, `dfsm compile`, `dfsm migrate up`, `pnpm run example`).

#### Scenario: Example README lists expected console milestones

- **WHEN** a developer follows the README commands successfully
- **THEN** the documented sequence SHALL match the states and accumulated context fields (`chargeId`, `reservationId`, `trackingNumber`) emitted by `run.ts`.

### Requirement: Traffic-light example demonstrates minimal setup

The repository SHALL include `examples/traffic-light` with a three-state cyclic machine, a single logging action slot, generated interface committed for first-run ergonomics, `run.ts` that auto-cycles transitions, and README positioning it as the smallest teaching sample.

#### Scenario: Example runs without external services beyond documented needs

- **WHEN** a developer executes the traffic-light README instructions
- **THEN** the sample SHALL start, transition, and log colour changes without requiring the order example's docker stack unless explicitly documented otherwise.

### Requirement: Documentation explains architecture and operations

The `docs/` tree SHALL include `architecture.md` covering contract separation, DB-native durability, outbox atomicity, concurrency, migrations, and a Mermaid sequence diagram for the transition lifecycle, ADR-style decision records (`docs/decisions/*.md`) including machine contract generation, and guides for defining machines, implementing actions, sagas, migrations, and visualization usage.

#### Scenario: Migration guide documents breaking-change categories

- **WHEN** a reader opens `docs/guides/migration.md`
- **THEN** the document SHALL enumerate representative breaking vs non-breaking machine edits and tie each category to how `dfsm compile`, `tsc`, and version pinning surface risk.

### Requirement: Core integration tests cover durability scenarios

The `packages/core` test suite SHALL provide `mongodb-memory-server`-backed integration tests for happy path order processing, crash recovery with lease expiry, concurrent workflow starts, TTL supervision, outbox retries, saga compensation failures, and multi-version migrations with pinned workflows.

#### Scenario: Happy path asserts durable artefacts

- **WHEN** the happy-path integration test completes the scripted order events
- **THEN** assertions SHALL verify terminal state, ordered `history` transitions, accumulated context fields, and `action_outbox` rows all reach `done` without data loss.
