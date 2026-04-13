# Visualization (`dfsm viz`)

The viz server exposes a small React UI plus JSON APIs over the statechart derived from the compiled **viz graph**.

## Launch

```bash
dfsm viz --port 4242
```

(Use your built CLI; see [getting-started.md](./getting-started.md).) Open `http://localhost:4242`.

## What you see

- **States** — one tile per node: name, optional **TTL** label when the state has `after`.
- **Transitions** — list of edges: source → target, event, optional guard in `[brackets]`, action names after `/`.

This mirrors `buildVizGraph`: normal transitions from `on`, delayed transitions as `__AFTER_<ms>`.

## Node types

| `type` | Meaning in UI |
|--------|----------------|
| `initial` | Blue styling — machine `initial` state. |
| `state` | Default grey tile — non-terminal work states. |
| `terminal` | Double-border grey — listed in `terminal`. |

## Edge labels

- **Event** — external event name from `on`, or synthetic **`__AFTER_<ttlMs>`** from `after`.
- **`[guard]`** — guard slot `name` when present.
- **Action names** — ordered slot `name`s for that transition (empty array omitted).

## Live overlay

The **amber** panel (`#fffbeb` / `#f59e0b` border) polls `/api/live/<machineId>` and shows **counts of active workflows per `currentState`** plus a total. Use it to see backlog hotspots while the state list stays static.

## History panel

Enter a **workflow id** to load `/api/workflow/<id>`:

- Each row: **`fromState` → `toState`**, **`event`**, and **`actionsDispatched`** (comma-separated).
- Chronological timeline top-to-bottom matches persisted `history` order.

Click a row to fetch **`/api/workflow/<id>/diff/<index>`** and expand a **context diff** for that transition.

## Context diff semantics

- **`added`** (`+`, green) — keys present after the transition but not before (within the diff algorithm’s view).
- **`changed`** (`~`, amber) — key existed before; shows `from` → `to`.
- **`removed`** (`-`, red) — keys dropped relative to the prior snapshot.

If nothing changed, the UI shows “No context changes”. Use this to confirm which action writes landed for a step.

## Debugging tips

- Compare **live counts** with stuck states to spot missing events or failing outbox actions.
- Use **`__AFTER_*`** edges to confirm TTL wiring matches what the supervisor will emit.
- Correlate **history** rows with **Mongo** `workflow_state` and `action_outbox` for a single `workflowId`.

## Related

- [Defining machines](./defining-machines.md) — `after` and events
- [Getting started](./getting-started.md)
