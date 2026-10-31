# Changelog

## 1.0.0 - 2026-10-30

### Added
- Automatic DFSM machine document recognition for `*.dfsm.yaml`, `*.dfsm.yml`, and generic `*.yaml` / `*.yml` files declaring `dfsm: "1.0"`.
- Bundled canonical `dfsm-v1.schema.json` with automatic `redhat.vscode-yaml` schema validation.
- YAML CST/AST parser with exact 1-based and 0-based line/column source-map ranges.
- Semantic DFSM v1.0 diagnostics engine:
  - Untyped `context:` rejection with host-code `TContext` guidance.
  - Compound state missing `initial` or referencing non-existent child state.
  - `parallel` state defining `initial` error.
  - `final` state defining `states`, `initial`, or outgoing `on` transitions.
  - XState-aligned transition `target` and `onFail.target` path resolution (`#machineId.path`, `#path`, relative dot-paths, sibling keys, and implicit root `error` state).
  - Unreachable state detection across `initial`, `parallel` entry, `on`, `onDone`, and `onFail.target`.
  - Informational hint & badge distinguishing built-in implicit `error` state vs. custom `states.error` override.
- Interactive Statechart Studio Webview (`DFSM: Open Statechart Visualizer`):
  - Hierarchical nested `compound` containers (with initial child markers) and `parallel` containers (with dashed orthogonal region dividers).
  - Resilience & Saga transition badges (`retry: N`, `CB`, `compensate: <fn>`, `effects`).
  - State Inspector sidebar with leaf-by-leaf effective merged policy preview (`SDK Default <- Machine defaults <- Transition YAML`).
  - Live two-way editor sync (YAML edits -> live graph update, click node/edge -> jump to YAML line, cursor inside YAML state -> highlight active node).
- Rich YAML code snippets and `DFSM: New Machine Template` scaffolding command.
