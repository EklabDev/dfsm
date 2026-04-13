## ADDED Requirements

### Requirement: Machine configuration uses Zod-only slots

The system SHALL represent transitions using `TransitionConfig` with optional `GuardSlot` and ordered `ActionSlot` arrays where each slot exposes a `name` and Zod `input` / `output` schemas for actions, and `name` and Zod `input` for guards. The configuration SHALL NOT embed executable functions for guards or actions in the serialisable machine definition.

#### Scenario: Action and guard slots are schema-only

- **WHEN** a developer defines a transition with `guard` and `actions` entries
- **THEN** each slot SHALL include only `name` and Zod schema objects suitable for compile-time interface generation, and SHALL NOT require function references on the config object for persistence or compilation.

### Requirement: defineMachine validates structure and registers machines

The system SHALL provide `defineMachine` that validates `MachineConfig`: the `initial` state exists in `states`, every `terminal` state exists in `states`, and every transition `target` (including `after` TTL targets) references an existing state. On validation failure the system SHALL throw a descriptive `Error`. On success the system SHALL register the config in an in-process registry keyed by `config.id` and return the config.

#### Scenario: Invalid initial state is rejected

- **WHEN** `defineMachine` is called with `initial` set to a state name not present in `states`
- **THEN** the function SHALL throw an error whose message identifies the missing initial state.

#### Scenario: Invalid transition target is rejected

- **WHEN** any `on` transition references a `target` not in `states`
- **THEN** `defineMachine` SHALL throw an error identifying the offending state, event, and target.

#### Scenario: Valid machine is registered

- **WHEN** `defineMachine` is called with a fully valid configuration
- **THEN** the configuration SHALL be retrievable from `getMachineRegistry()` under `config.id` and the same object reference SHALL be returned to the caller.

### Requirement: History and action input shapes are stable contracts

The system SHALL define `HistoryEntry` with transition metadata (`transitionedAt`, `fromState`, `toState`, `event`, `eventPayload`, `contextSnapshot`, `actionsDispatched`) and `ActionInput` with `workflowId`, mutable `context`, read-only `history`, and triggering `event`. Action handlers SHALL be expressible as `ActionHandler` and guards as `GuardHandler` types parameterized by context and Zod-derived input/output shapes.

#### Scenario: History is described for audit use

- **WHEN** documentation or types refer to `HistoryEntry`
- **THEN** each entry SHALL be defined as append-only semantic content suitable for persisting per transition without post-hoc mutation of prior entries.

### Requirement: createSaga provides optional multi-step compensation

The system SHALL provide `createSaga` accepting ordered `SagaStep` objects with `execute` and `compensate` functions. On the first failing `execute`, the system SHALL invoke `compensate` for each previously succeeded step in reverse order, then rethrow the original failure. The helper SHALL NOT be required for engine operation.

#### Scenario: Mid-sequence failure triggers reverse compensation

- **WHEN** step index `k` throws during `createSaga`
- **THEN** compensations SHALL run for indices `k-1` down through `0` in that order before the error propagates to the caller.
