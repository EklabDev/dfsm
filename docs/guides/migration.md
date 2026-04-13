# Migration and machine versions

## When to run `dfsm compile`

Run **`dfsm compile` whenever the machine definition changes**: states, events, guards, action slots, Zod shapes, TTLs (`after`), `initial` / `terminal`, or defaults in `context`.

Compile writes:

- **`.dfsm/<machineId>.json`** — serialised transition table + viz graph + slot name lists (used by migrate and tooling).
- **`generated/I<Machine>Actions.ts`** — regenerated interfaces from Zod.

Commit both artifacts (or regenerate in CI) so `migrate up` reads a consistent version number from the JSON artifact.

## What `dfsm migrate up` does

For each target machine (all, or `--machine <id>`):

1. **Resolve artifacts** — requires `.dfsm/<id>.json` and `generated/I<Name>Actions.ts`; exits if missing (`compile` first).
2. **TypeScript gate** — runs **`npx tsc --noEmit`** from your project root. On **any** diagnostic, prints output and **exits without writing to MongoDB**.
3. **Connect + setup** — Mongo client connects; `MongoStateStore.setup()` ensures collections/indexes exist.
4. **Re-compile in memory** — loads version from the JSON artifact and runs `compile(machine, version)` to build a `CompiledMachine`.
5. **Persist version** — `saveMachineVersion` deprecates the previous active registry row and inserts the new transition table + metadata as the active version.

There is **no partial DB write** if TypeScript fails: the gate runs before connect/migrate logic.

## TypeScript gate: why it matters

Generated interfaces drift whenever slots change. **`tsc --noEmit`** proves your `OrderActions` / `OrderGuards` (and any other TS) still satisfy those contracts. That prevents deploying a machine version to MongoDB that your running code cannot implement — which would break new transitions or outbox processing at runtime.

## In-flight workflow pinning

Each workflow document stores **`machineVersion`** captured at `startWorkflow` from the then-active registry entry.

- **New workflows** pick up the latest active version after migrate.
- **Existing workflows** keep using their pinned version’s transition table when the engine resolves transitions (same major flow as tests: v1 in-flight vs v2 new starts).

So old rows remain valid until those workflows complete or are migrated by application-specific tooling.

## Breaking vs non-breaking (practical guide)

| Change | Typically | Notes |
|--------|-------------|--------|
| Add a new state | **Non-breaking** for in-flight pins | New transitions only used when config + compile allow paths to it. |
| Add an **action slot** to an existing transition | **Breaking** | Generated `I*Actions` gains a method → **`tsc` fails** until you implement it. |
| Rename a state | **Breaking** | Pinned and new tables disagree; history and docs drift. |
| Change Zod **output** type of an action | **Breaking** | Return type mismatch → **`tsc` catches**. |
| Add a new TTL (`after` entry) | **Non-breaking for in-flight** | New synthetic `__AFTER_*` event; workflows already in that state were created under a version that may not have had that edge — pinned v1 keeps old table until replaced. |
| Remove / rename an action | **Breaking** | Implementations and outbox names must align with the active compiled table. |

## `dfsm migrate status`

Prints active and deprecated versions per `machineId` from `machine_registry`.

## `dfsm migrate down`

Current CLI behaviour refuses rollback if **active workflows** exist for that machine (drain first). Check the command output in your tree for any additional registry updates.

## Related

- [Getting started](./getting-started.md)
- [Defining machines](./defining-machines.md)
