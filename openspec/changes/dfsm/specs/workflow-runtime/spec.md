## ADDED Requirements

### Requirement: Transition execution is side-effect free at the pure layer

The system SHALL provide `executeTransition` as a pure asynchronous function that, given current state, event, `TransitionTable`, live guard functions map, `context`, and `history`, resolves the next state and ordered action slot names. It SHALL throw `NoTransitionError` when no mapping exists and `GuardRejectedError` when a configured guard returns falsy. It MUST NOT access MongoDB or module-level mutable stores.

#### Scenario: Missing guard registration is a hard error

- **WHEN** a transition requires `guardName` `g` but `guards` does not contain `g`
- **THEN** `executeTransition` SHALL throw an error identifying the missing guard before mutating any caller-owned structures.

### Requirement: WorkflowEngine orchestrates lease, transition, and outbox enqueue

The system SHALL provide `WorkflowEngine` with `start` / `stop`, `startWorkflow`, `sendEvent`, `getWorkflow`, and `getHistory`. `sendEvent` SHALL acquire a lease (or skip work if not acquired), load workflow and pinned machine version, call `executeTransition`, build a `HistoryEntry` including `actionsDispatched`, construct deterministic `idempotencyKey` values per enqueued action from workflow id, source state, action name, and current document version, and invoke `transitionWithOutbox` with empty immediate context merge unless specified by separate APIs.

#### Scenario: Successful transition appends a single history entry

- **WHEN** `sendEvent` completes without error for a valid transition
- **THEN** the store SHALL contain exactly one new `history` element describing the prior state, next state, event, payload snapshot, and dispatched action names.

### Requirement: ActionExecutor processes outbox with retries and context merge

The system SHALL run a background loop on a configurable interval that fetches pending outbox items, marks them executing, resolves the action implementation by slot name, builds `ActionInput` with live workflow `context` and `history`, awaits the handler, shallow-merges the returned partial context into persisted workflow context on success, and marks the item done. On failure it SHALL increment attempts, mark failed beyond a max retry threshold, otherwise reset to pending for retry.

#### Scenario: Missing action handler marks outbox failed

- **WHEN** an outbox item references an action name not registered on the engine
- **THEN** the executor SHALL mark that item failed with a clear error message without throwing an unhandled rejection from the loop.

### Requirement: TimeoutSupervisor emits synthetic TTL events

The system SHALL periodically scan active workflows, determine whether the current state's compiled transition table defines synthetic `__AFTER_{ms}` entries, compare elapsed time since `updatedAt` against `ttlMs`, and call `sendEvent` with the corresponding synthetic event type when breached.

#### Scenario: TTL breach triggers timeout transition path

- **WHEN** a workflow remains in a state with `after: { 200: 'cancelled' }` and `updatedAt` is older than 200ms beyond the threshold used by tests
- **THEN** the supervisor SHALL emit event `__AFTER_200` such that the engine applies the configured transition.

### Requirement: In-flight workflows remain pinned to their machine version

The system SHALL load the `CompiledMachine` matching each workflow document's `machineId` and `machineVersion`, falling back to stored registry data when not present in memory maps, so older transitions continue to resolve against the table active at workflow start.

#### Scenario: Old version table used for legacy workflow

- **WHEN** a workflow document references machine version `v1` after `v2` is saved as active
- **THEN** `sendEvent` for that workflow SHALL still evaluate transitions using the `v1` transition table until the workflow completes or is migrated by explicit future features.
