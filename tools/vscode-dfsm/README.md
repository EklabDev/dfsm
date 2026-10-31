# DFSM Statechart Studio (`eklabdev.vscode-dfsm`)

Official Visual Studio Code extension for **DFSM (`eklabdev/dfsm`) v1.0** — providing automatic YAML schema & semantic statechart validation, interactive hierarchical/parallel Statechart Studio visualization, Saga compensation & resilience policy inspection, and live two-way editor synchronization.

---

## Features

### 1. Automatic Machine Recognition
DFSM Statechart Studio automatically activates whenever you open:
- Any `*.dfsm.yaml` or `*.dfsm.yml` file, **or**
- Any standard `*.yaml` / `*.yml` file whose root map declares `dfsm: "1.0"` alongside `id` and `states`.

When a DFSM document is active:
- Sets the `dfsm.isMachineDocument` context key so the **Open Statechart Visualizer** icon button appears automatically in the editor title bar.
- Displays a live Status Bar item (`$(type-hierarchy-sub) DFSM: <machineId> (<stateCount> states)`) that opens the Statechart Visualizer on click.
- Registers `yamlValidation` with RedHat YAML (`redhat.vscode-yaml`) using the bundled `schemas/dfsm-v1.schema.json`.

### 2. YAML AST Source-Mapped Diagnostics
In addition to Draft-07 JSON Schema validation against `dfsm-v1.schema.json`, the extension runs a dedicated CST/AST semantic analyzer with exact line & column source ranges:

| Diagnostic Code | Severity | Rule Description |
| --- | --- | --- |
| `dfsm/untyped-context` | Error | Rejects untyped `context:` in YAML (DFSM defines strongly typed generic `TContext` & runtime validators in host code). |
| `dfsm/compound-missing-initial` | Error | Compound state (or compound root machine) is missing a required `initial` child key. |
| `dfsm/invalid-initial-target` | Error | `initial` references a child key that does not exist in `states`. |
| `dfsm/parallel-with-initial` | Error | `parallel` state defines `initial` (`parallel` activates all orthogonal child regions simultaneously). |
| `dfsm/final-invalid-properties` | Error | `final` state defines child `states`, `initial`, `on`, or `onDone`. |
| `dfsm/unresolved-target` | Error | Broken `target` or `onFail.target` across `#<machineId>.<path>`, `#<path>`, relative dot-paths, sibling keys, and implicit root `error`. |
| `dfsm/unreachable-state` | Warning | State is never reachable from `initial`, `parallel` entry, `on`, `onDone`, or `onFail.target` (excluding implicit/explicit `error` referenced implicitly). |
| `dfsm/error-state-implicit` / `dfsm/error-state-custom` | Info | Indicates whether `error` uses the built-in implicit final `error` state or a custom overridden `states.error`. |

### 3. Interactive Statechart Visualizer & Policy Inspector
Run **`DFSM: Open Statechart Visualizer`** (`dfsm.openVisualizer`) or click the editor title icon / status bar item:
- **Hierarchical Statechart Canvas**:
  - `atomic` state cards with `entry` / `exit` effect hooks
  - `compound` nested containers with initial child bullseye markers (`● → child`)
  - `parallel` nested containers with **dashed orthogonal region dividers**
  - `final` terminal states with double-border & bullseye (`◉`) badge
  - `error` state cards styled distinctly as `error (default)` (implicit final) or `error (custom)` (overridden in YAML)
- **Transition & Resilience Badges**:
  - Solid event transitions (`EVENT · handler`), emerald `onDone` transitions, and dashed orange/red `onFail` fallback transitions
  - Compact pills for `retry: N`, `CB` (Circuit Breaker), `compensate: <fn>` (LIFO Saga), and `effects`
- **State & Effective Policy Inspector Sidebar**:
  - Previews the normalized leaf-by-leaf policy merge (`SDK Default <- Machine defaults <- Transition YAML`) with layer provenance tags (`transition`, `defaults`, `sdk`).
- **Live Two-Way Editor Sync**:
  - Editing YAML live-updates the statechart while preserving pan & zoom.
  - Clicking any state card, transition pill, or diagnostic item jumps to and highlights that exact YAML line in the editor.
  - Moving the editor cursor inside any state block highlights the active state node in the Webview.

### 4. Commands & YAML Snippets
- **Commands**:
  - `DFSM: Open Statechart Visualizer` (`dfsm.openVisualizer`)
  - `DFSM: Validate Machine Definition` (`dfsm.validateMachine`)
  - `DFSM: New Machine Template` (`dfsm.newMachineFromTemplate`)
- **YAML Snippets** (`snippets/dfsm.code-snippets`):
  - `dfsm-machine` — Complete DFSM v1.0 machine scaffold
  - `dfsm-compound` — Hierarchical compound state with `initial` and `onDone`
  - `dfsm-parallel` — Orthogonal parallel state with concurrent regions and `onDone`
  - `dfsm-policy` — Transition with `retry`/`backoff`, `circuitBreaker`, `compensate`, and `onFail`
  - `dfsm-defaults` — Machine-wide `defaults` policy block
  - `dfsm-error-override` — Custom `states.error` override with alerting and recovery transition

---

## Development & Packaging

```bash
# Sync canonical schema from ../../spec/dfsm-v1.schema.json
npm run sync-schema

# Typecheck & bundle extension into dist/extension.js
npm run build

# Run Vitest unit & conformance test suite
npm test

# Package standalone VSIX archive
npx @vscode/vsce package --no-dependencies
```
