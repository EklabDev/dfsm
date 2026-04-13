## ADDED Requirements

### Requirement: Lint performs graph-level static analysis

The system SHALL expose `lint(config: MachineConfig)` returning categorized `errors` and `warnings`. The linter MUST emit errors for invalid `initial`, invalid `terminal` membership, invalid `on` targets, and invalid `after` targets. The linter SHALL emit warnings such as non-terminal states with no outgoing transitions (`DEAD_STATE`).

#### Scenario: Invalid initial produces structured error

- **WHEN** `initial` names a state absent from `states`
- **THEN** `lint` SHALL return an error with code `INVALID_INITIAL` and a message naming the missing state.

#### Scenario: Dead non-terminal state is warned

- **WHEN** a state is not terminal and has neither `on` nor `after`
- **THEN** `lint` SHALL include a `DEAD_STATE` warning for that state.

### Requirement: compile builds transition table and collects slots

The system SHALL expose `compile(config, version)` that runs `lint` and aborts with an aggregate error if any lint errors exist. On success it SHALL build a `TransitionTable` mapping state → event → `{ nextState, guardName?, actionNames }`, represent `after` TTLs as synthetic `__AFTER_{ttlMs}` events, deduplicate all `ActionSlot` and `GuardSlot` instances by slot `name`, and attach a `VizGraph` describing nodes and edges for visualisation.

#### Scenario: Lint errors block compilation

- **WHEN** `lint` reports one or more errors
- **THEN** `compile` SHALL throw before mutating or returning a `CompiledMachine`.

#### Scenario: TTL maps to synthetic timeout event

- **WHEN** a state defines `after: { 300000: 'cancelled' }`
- **THEN** the compiled transition table for that state SHALL include an entry keyed `__AFTER_300000` pointing to the declared target with the configured action name list (possibly empty).

### Requirement: generateInterface emits TypeScript contracts

The system SHALL generate a TypeScript module string containing a banner stating the machine id and version, importing `ActionInput` from the public package entry, exporting a context type derived from the machine's Zod context object, and declaring `I{Name}Actions` / `I{Name}Guards` interfaces with one method per unique slot using Zod-to-TypeScript translation for parameter augmentation and action return types.

#### Scenario: Duplicate slot names dedupe to one method

- **WHEN** the same action slot name appears on multiple transitions with identical slot metadata
- **THEN** `generateInterface` SHALL emit exactly one method for that name on the actions interface.

#### Scenario: Generated file is non-hand-edited contract

- **WHEN** `generateInterface` completes successfully
- **THEN** the output string SHALL include an explicit auto-generated banner referencing `dfsm compile` and the machine identifier.
