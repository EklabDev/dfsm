## ADDED Requirements

### Requirement: dfsm lint validates configured machines

The CLI SHALL expose `dfsm lint` with optional `--machine <id>`, load `dfsm.config.ts` via `tsx`, and run `lint` on each selected machine configuration, printing errors in red and warnings in yellow. The process SHALL exit with code `1` when any errors exist.

#### Scenario: Lint failure exits non-zero

- **WHEN** at least one machine fails lint with an error
- **THEN** the CLI SHALL terminate with exit status `1` after printing all collected issues.

### Requirement: dfsm compile generates interfaces and local artifacts

The CLI SHALL expose `dfsm compile` that runs lint (failing fast on errors), determines the next machine version from MongoDB (`current active + 1` or `1` if none), calls `compile`, writes generated TypeScript to `{generatedDir}/I{Name}Actions.ts` (and guards), writes `.dfsm/{machineId}.json` containing serialisable `transitionTable` and `vizGraph`, and prints a summary including slot and graph counts.

#### Scenario: Compile refuses invalid graphs

- **WHEN** lint reports errors for a machine
- **THEN** `dfsm compile` SHALL exit before writing generated sources or `.dfsm` artifacts.

### Requirement: dfsm migrate up gates on TypeScript correctness

The CLI SHALL expose `dfsm migrate up` that reads `.dfsm/{machineId}.json`, verifies the generated interface file exists, runs `tsc --noEmit` for the project, and only if that succeeds connects to MongoDB and calls `saveMachineVersion`. If `tsc` fails, the CLI SHALL print TypeScript diagnostics, emit the message `Implementation does not satisfy generated interface. Fix errors before migrating.`, exit `1`, and MUST NOT write `machine_registry` documents for that attempt.

#### Scenario: Type errors block database migration

- **WHEN** `tsc --noEmit` returns a non-zero exit code
- **THEN** `dfsm migrate up` SHALL make no changes to `machine_registry` for the targeted machine.

### Requirement: dfsm migrate down enforces safe rollback

The CLI SHALL expose `dfsm migrate down` that refuses to proceed when active workflows still reference the current active machine version, printing how many must drain. When safe, it SHALL reactivate the previous registry version, deprecate the current row, delete superseded generated interface files, and regenerate interfaces for the restored version.

#### Scenario: In-flight workflows block rollback

- **WHEN** one or more `workflow_state` documents remain active on the version being rolled back from
- **THEN** `dfsm migrate down` SHALL exit `1` with a message including the count of blocking workflows.

### Requirement: dfsm migrate status reports version posture

The CLI SHALL expose `dfsm migrate status` printing a table of `machineId`, `activeVersion`, `inFlightCount`, and deprecated versions per machine.

#### Scenario: Status is human-readable

- **WHEN** a user runs `dfsm migrate status` against a configured database
- **THEN** the output SHALL include one row per configured machine with the required columns populated from store queries.

### Requirement: dfsm viz launches the visualiser

The CLI SHALL expose `dfsm viz` with optional `--port` (default `4242`) and optional `--machine <id>` to start the visualization server package entrypoint.

#### Scenario: Default port is 4242

- **WHEN** `dfsm viz` runs without `--port`
- **THEN** the server SHALL bind to TCP port `4242` unless the host environment prevents it, and the CLI SHALL document the URL.
