## ADDED Requirements

### Requirement: Collections and fields match the durability model

The system SHALL persist workflows in `workflow_state` with `_id` as `workflowId`, `machineId`, `machineVersion`, `currentState`, document `context`, append-only `history`, numeric optimistic `version`, optional `lockedUntil`, `status` in `{ active, completed, failed }`, and timestamps. The system SHALL persist asynchronous work in `action_outbox` with unique business `idempotencyKey`, slot `actionName`, serialised `payload`, attempt counters, and lifecycle `status`. The system SHALL persist compiled machine snapshots in `machine_registry` keyed by `machineId` and `version` with serialised `transitionTable`, `vizGraph`, slot name lists, and lifecycle `status`.

#### Scenario: Outbox idempotency is enforceable at the database

- **WHEN** the store creates indexes during setup
- **THEN** a unique index SHALL exist on `action_outbox.idempotencyKey` so duplicate enqueue attempts for the same logical operation cannot commit twice.

### Requirement: Leasing uses atomic compare-and-set semantics

The system SHALL implement `acquireLease(workflowId, ttlMs)` using a single conditional update that matches documents where `lockedUntil` is null or less than now, and sets `lockedUntil` to `now + ttlMs`. The call SHALL return a boolean indicating whether the lease was acquired. `releaseLease` SHALL clear `lockedUntil`.

#### Scenario: Concurrent lease acquisition has single winner

- **WHEN** two workers concurrently call `acquireLease` for the same `workflowId`
- **THEN** at most one call SHALL return true for the same lease epoch while the other observes the lock held or fails acquisition according to the filter.

### Requirement: transitionWithOutbox is transactional

The system SHALL implement `transitionWithOutbox` using a MongoDB client session `withTransaction` that (1) updates `workflow_state` matching `expectedVersion`, applying state transition, merged context updates, appended `history` entry, incremented `version`, optional terminal `status`, and `updatedAt`, and (2) inserts all provided outbox rows in the same transaction. If the matched document count for the workflow update is zero, the system SHALL throw a `ConcurrentModificationError` (or equivalent) and MUST NOT insert outbox documents.

#### Scenario: Version mismatch aborts without outbox writes

- **WHEN** `transitionWithOutbox` runs with an `expectedVersion` not equal to the current stored `version`
- **THEN** the method SHALL fail without inserting new `action_outbox` documents for that attempt.

### Requirement: Context merge supports outbox completion

The system SHALL expose `mergeContext(workflowId, partial)` (or equivalent) that shallow-merges `partial` into the persisted `workflow_state.context` document without rewriting `history` entries, suitable for `ActionExecutor` after successful handler execution.

#### Scenario: Merge preserves unrelated context keys

- **WHEN** `mergeContext` is called with `{ chargeId: 'ch_123' }` for a workflow whose context already contains unrelated keys
- **THEN** the stored document SHALL retain prior keys while updating or inserting merged fields only.

### Requirement: Machine registry supports active versioning

The system SHALL support `saveMachineVersion(compiled)` to insert a new registry document and mark prior active versions as deprecated, and `getActiveMachine(machineId)` to return the active row. Stored documents MUST omit Zod schemas—only serialisable structural data and slot names.

#### Scenario: New machine version does not mutate in-flight workflow documents

- **WHEN** `saveMachineVersion` inserts version `n+1` for a machine
- **THEN** existing `workflow_state` documents SHALL retain their prior `machineVersion` until explicitly migrated by application logic, and the store API SHALL allow reading the correct compiled snapshot per pinned version.
