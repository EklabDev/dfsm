## ADDED Requirements

### Requirement: Graph API serves active machine topology

The visualization server SHALL expose `GET /api/graph/:machineId` returning JSON `{ nodes, edges, machineId, version }` sourced from the active `machine_registry` entry's `vizGraph` and metadata.

#### Scenario: Unknown machine yields client error

- **WHEN** no registry document exists for the requested `machineId`
- **THEN** the server SHALL respond with an HTTP `4xx` error and a JSON body explaining the missing machine.

### Requirement: Live API aggregates workflow counts by state

The server SHALL expose `GET /api/live/:machineId` returning `{ counts: Record<stateName, number>, total: number }` derived from `workflow_state` documents filtered to active statuses for that machine.

#### Scenario: Totals match sum of per-state counts

- **WHEN** live data is requested for a machine with workflows spread across states
- **THEN** `total` SHALL equal the sum of all `counts` values for that response payload.

### Requirement: Workflow detail and diff endpoints support debugging

The server SHALL expose `GET /api/workflow/:workflowId` returning the full `workflow_state` document, and `GET /api/workflow/:workflowId/diff/:index` returning structural differences between `history[index-1].contextSnapshot` and `history[index].contextSnapshot` with `added`, `changed` (from/to pairs), and `removed` keys.

#### Scenario: Diff endpoint handles first history index

- **WHEN** `index` is `0` or otherwise indicates no prior snapshot exists per documented rules
- **THEN** the server SHALL return a deterministic representation (for example treating all current keys as added) consistent with the UI contract documented in project guides.

### Requirement: SPA integrates graph, live overlay, and history views

The React client SHALL render `VizGraph` using elkjs automatic layout, distinguish node visuals for initial, normal, and terminal states, annotate edges with event labels, optional guard names in brackets, and action names, poll `/api/live` on a three-second cadence to refresh badges without full page reload, and provide `HistoryPanel` rows that expand to fetch and render diff tables with color cues for added, changed, and removed fields.

#### Scenario: Live counts refresh independently of graph layout

- **WHEN** the live polling interval elapses
- **THEN** the UI SHALL update per-node count badges using the latest `/api/live` response without recomputing elkjs layout unless the graph structure changes.
