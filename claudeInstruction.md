# @eklabdev/dfsm — Project Plan v3
## For Claude Code / Cursor

> Machine config declares action/guard **names + Zod type contracts**.
> `dfsm compile` + `dfsm migrate up` generates TypeScript interfaces into `generated/`.
> Developer implements the generated interfaces freely — no ceremony, just type safety.
> MongoDB-native durability. Order fulfilment example.

---

## The exact mental model — read this first

```
┌─────────────────────────────────────────────────────────────────┐
│  order.machine.ts  (developer writes)                           │
│                                                                 │
│  defineMachine({                                                │
│    states: {                                                    │
│      pending: {                                                 │
│        on: {                                                    │
│          SUBMIT: {                                              │
│            target: 'processing',                               │
│            guard: {                                             │
│              name: 'hasStock',                                  │
│              input: z.object({ sku: z.string() })              │
│            },                                                   │
│            actions: [{                                          │
│              name: 'chargePayment',                             │
│              input:  z.object({ amount: z.number() }),          │
│              output: z.object({ chargeId: z.string() })         │
│            }]                                                   │
│          }                                                      │
│        }                                                        │
│      }                                                          │
│    }                                                            │
│  })                                                             │
└────────────────────────┬────────────────────────────────────────┘
                         │
                  dfsm compile
                  dfsm migrate up
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  generated/IOrderActions.ts  (DO NOT EDIT — auto-generated)     │
│                                                                 │
│  export interface IOrderActions {                               │
│    chargePayment(                                               │
│      input: ActionInput<OrderContext> & { amount: number }      │
│    ): Promise<{ chargeId: string }>                             │
│  }                                                              │
│                                                                 │
│  export interface IOrderGuards {                                │
│    hasStock(                                                    │
│      input: ActionInput<OrderContext> & { sku: string }         │
│    ): boolean | Promise<boolean>                                │
│  }                                                              │
└────────────────────────┬────────────────────────────────────────┘
                         │  implements
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  actions/order.actions.ts  (developer writes freely)            │
│                                                                 │
│  export class OrderActions implements IOrderActions {           │
│    async chargePayment({ context, history, event }) {           │
│      // context — full accumulated state                        │
│      // history — all prior transitions, read-only             │
│      // event   — the triggering event + payload               │
│      const r = await stripe.charges.create({                   │
│        amount: context.amount                                   │
│      })                                                         │
│      return { chargeId: r.id }  // merged into context         │
│    }                                                            │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘

Machine adds new action slot → dfsm compile regenerates interface →
TypeScript error in order.actions.ts → developer fills gap →
dfsm migrate up succeeds.
```

### What the machine config stores vs what the generated interface provides

| Thing | Stored in machine config | In generated interface |
|---|---|---|
| Action name | `name: 'chargePayment'` | method name `chargePayment()` |
| Input shape | `input: z.object({...})` | typed parameter |
| Output shape | `output: z.object({...})` | typed return `Promise<...>` |
| Guard name | `name: 'hasStock'` | method name `hasStock()` |
| Guard input | `input: z.object({...})` | typed parameter |
| Implementation | **NOT HERE** | **NOT HERE** — lives in actions/ |

### What `dfsm compile` does and does NOT do

**Does:**
- Lint graph structure (unreachable states, missing targets, broken TTLs)
- Extract all action/guard slot declarations → generate `generated/I{MachineName}Actions.ts`
- Build `TransitionTable` (state → event → nextState, serialisable, no functions)
- Build `VizGraph` (nodes + edges for visualiser)
- Write `machine_registry` document to MongoDB

**Does NOT:**
- Touch implementations in `actions/`
- Validate that implementations are correct (TypeScript compiler does that)
- Store any functions — functions are never serialised

---

## Repository structure

```
dfsm/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   ├── machine.ts          # MachineConfig with typed slot declarations
│   │   │   │   ├── context.ts          # ActionInput, HistoryEntry, ActionHandler
│   │   │   │   ├── engine.ts           # IWorkflowEngine, CompiledMachine, VizGraph
│   │   │   │   └── index.ts
│   │   │   ├── define/
│   │   │   │   ├── defineMachine.ts    # validates + registers MachineConfig
│   │   │   │   └── createSaga.ts       # best-effort saga/compensation helper
│   │   │   ├── compiler/
│   │   │   │   ├── compile.ts          # MachineConfig → CompiledMachine
│   │   │   │   ├── lint.ts             # graph-only static analysis
│   │   │   │   ├── generateInterface.ts # slot declarations → TS interface source
│   │   │   │   └── vizGraph.ts         # builds VizGraph from config
│   │   │   ├── engine/
│   │   │   │   ├── WorkflowEngine.ts   # main class
│   │   │   │   ├── TransitionExecutor.ts # pure fn: (state,event,table) → result
│   │   │   │   ├── ActionExecutor.ts   # outbox relay loop
│   │   │   │   ├── TimeoutSupervisor.ts
│   │   │   │   └── ConcurrencyManager.ts # MongoDB lease acquire/release
│   │   │   ├── store/
│   │   │   │   ├── IStateStore.ts
│   │   │   │   └── MongoStateStore.ts
│   │   │   └── index.ts
│   │   └── test/
│   │       ├── unit/
│   │       │   ├── compiler/
│   │       │   │   ├── compile.test.ts
│   │       │   │   ├── lint.test.ts
│   │       │   │   └── generateInterface.test.ts
│   │       │   ├── engine/
│   │       │   │   ├── TransitionExecutor.test.ts
│   │       │   │   ├── ActionExecutor.test.ts
│   │       │   │   ├── ConcurrencyManager.test.ts
│   │       │   │   └── TimeoutSupervisor.test.ts
│   │       │   └── define/
│   │       │       ├── defineMachine.test.ts
│   │       │       └── createSaga.test.ts
│   │       ├── integration/
│   │       │   ├── happy-path.test.ts
│   │       │   ├── crash-recovery.test.ts
│   │       │   ├── concurrent-workflows.test.ts
│   │       │   ├── timeout-stuck.test.ts
│   │       │   ├── outbox-retry.test.ts
│   │       │   ├── saga-compensation.test.ts
│   │       │   └── migration.test.ts
│   │       └── fixtures/
│   │           ├── orderMachine.ts
│   │           ├── orderActions.ts     # implements generated IOrderActions
│   │           └── trafficMachine.ts
│   │
│   ├── cli/
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── lint.ts
│   │   │   │   ├── compile.ts         # runs lint + generateInterface + writes artifact
│   │   │   │   ├── migrate.ts         # up / down / status
│   │   │   │   └── viz.ts
│   │   │   ├── config/
│   │   │   │   └── loadConfig.ts
│   │   │   └── index.ts
│   │   └── test/
│   │       └── commands/
│   │           ├── compile.test.ts
│   │           └── migrate.test.ts
│   │
│   └── viz/
│       ├── src/
│       │   ├── server.ts
│       │   ├── api/
│       │   │   ├── graph.ts
│       │   │   └── live.ts
│       │   └── ui/
│       │       ├── App.tsx
│       │       ├── StatechartCanvas.tsx
│       │       ├── LiveOverlay.tsx
│       │       └── HistoryPanel.tsx
│       └── package.json
│
├── examples/
│   ├── order-fulfilment/
│   │   ├── machines/
│   │   │   └── order.machine.ts       # defineMachine with slot declarations
│   │   ├── generated/                 # DO NOT EDIT — written by dfsm compile
│   │   │   └── IOrderActions.ts
│   │   ├── actions/
│   │   │   └── order.actions.ts       # implements IOrderActions freely
│   │   ├── run.ts
│   │   ├── dfsm.config.ts
│   │   ├── docker-compose.yml
│   │   └── README.md
│   │
│   └── traffic-light/                 # minimal hello world
│       ├── machine.ts
│       ├── generated/
│       │   └── ITrafficActions.ts
│       ├── actions.ts
│       ├── run.ts
│       └── README.md
│
├── docs/
│   ├── architecture.md
│   ├── decisions/
│   │   ├── 001-db-native-state.md
│   │   ├── 002-outbox-atomicity.md
│   │   ├── 003-mongodb-concurrency.md
│   │   ├── 004-context-history.md
│   │   ├── 005-compile-time-migration.md
│   │   └── 006-machine-contract-generation.md
│   └── guides/
│       ├── getting-started.md
│       ├── defining-machines.md
│       ├── implementing-actions.md
│       ├── saga-helper.md
│       ├── migration.md
│       └── visualization.md
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

---

## Phase 1 — Core types

**Prompt for Claude Code / Cursor:**

```
Create packages/core/src/types/ with these files.

machine.ts — MachineConfig and slot declarations:

import { z } from 'zod'

export interface ActionSlot<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> {
  name: string
  input: TInput          // Zod schema for the data this action reads from context
  output: TOutput        // Zod schema for the Partial<context> this action returns
}

export interface GuardSlot<TInput extends z.ZodTypeAny> {
  name: string
  input: TInput          // Zod schema for the context fields this guard reads
}

export interface TransitionConfig {
  target: string
  guard?: GuardSlot<any>
  actions?: ActionSlot<any, any>[]
}

export interface StateConfig {
  on?: Record<string, TransitionConfig>
  after?: Record<number, string>   // ttlMs → targetState
  entry?: ActionSlot<any, any>[]   // run on state entry
  exit?: ActionSlot<any, any>[]    // run on state exit
}

export interface MachineConfig<TContext extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  initial: string
  terminal: string[]
  context: TContext              // initial context shape with defaults
  states: Record<string, StateConfig>
}

IMPORTANT RULES:
- ActionSlot and GuardSlot contain name + Zod schemas only. NO function references.
- Functions live exclusively in the developer's implementation file (actions/).
- The Zod schemas are used by generateInterface.ts to produce TypeScript interface types.
- MachineConfig is fully serialisable except for the Zod schema objects
  (which are used at compile time only, not stored in MongoDB).

context.ts — ActionInput and HistoryEntry:

export interface HistoryEntry<TContext> {
  transitionedAt: Date
  fromState: string
  toState: string
  event: string
  eventPayload: unknown
  contextSnapshot: TContext        // deep clone of context at this transition
  actionsDispatched: string[]      // action slot names queued to outbox
}

export interface ActionInput<TContext> {
  workflowId: string
  context: TContext                // current accumulated context — read/write
  history: Readonly<HistoryEntry<TContext>[]>  // full history — READ ONLY
  event: { type: string; payload: unknown }
}

// The shape every action handler must follow.
// TIn: the specific context fields this action declares it needs (from slot.input schema)
// TOut: the Partial<context> fields this action returns (from slot.output schema)
export type ActionHandler<TContext, TIn, TOut extends Partial<TContext>> =
  (input: ActionInput<TContext> & TIn) => Promise<TOut>

export type GuardHandler<TContext, TIn> =
  (input: ActionInput<TContext> & TIn) => boolean | Promise<boolean>

engine.ts — CompiledMachine and VizGraph:

export interface VizNode {
  id: string
  label: string
  type: 'initial' | 'state' | 'terminal'
  meta: {
    ttlMs?: number
    entryActions?: string[]
    exitActions?: string[]
  }
}

export interface VizEdge {
  from: string
  to: string
  event: string
  guard?: string
  actions: string[]
}

export interface VizGraph {
  nodes: VizNode[]
  edges: VizEdge[]
}

export interface TransitionTableEntry {
  nextState: string
  guardName?: string
  actionNames: string[]    // ordered list of action slot names to enqueue
}

export type TransitionTable = Map<string, Map<string, TransitionTableEntry>>

export interface CompiledMachine {
  machineId: string
  version: number
  transitionTable: TransitionTable
  vizGraph: VizGraph
  allActionSlots: ActionSlot<any, any>[]   // deduplicated across all states
  allGuardSlots: GuardSlot<any>[]          // deduplicated across all states
}
```

---

## Phase 2 — defineMachine and createSaga

**Prompt for Claude Code / Cursor:**

```
Implement packages/core/src/define/defineMachine.ts:

import { MachineConfig } from '../types/machine'

const registry = new Map<string, MachineConfig>()

export function defineMachine<TContext extends Record<string, unknown>>(
  config: MachineConfig<TContext>
): MachineConfig<TContext> {
  // Validate: exactly one state must equal config.initial
  // Validate: all config.terminal entries must exist in config.states
  // Validate: all transition targets must exist in config.states
  // Throw descriptive Error if any validation fails
  // Register in registry Map
  registry.set(config.id, config)
  return config
}

export function getMachineRegistry(): Map<string, MachineConfig> {
  return registry
}

Implement packages/core/src/define/createSaga.ts:

// Best-effort saga helper. User opt-in — not required.
// Wraps multiple async steps. If step N fails, runs compensations[0..N-1] in reverse.
// This is NOT enforced by the engine. Developer calls createSaga() inside an action handler.

export interface SagaStep<T> {
  execute: () => Promise<T>
  compensate: () => Promise<void>
}

export async function createSaga<T>(
  steps: SagaStep<T>[]
): Promise<T[]> {
  const results: T[] = []
  const executed: number[] = []
  for (let i = 0; i < steps.length; i++) {
    try {
      results.push(await steps[i].execute())
      executed.push(i)
    } catch (err) {
      // compensate in reverse order
      for (const j of [...executed].reverse()) {
        await steps[j].compensate()
      }
      throw err
    }
  }
  return results
}

Unit tests in packages/core/test/unit/define/:

defineMachine.test.ts:
- Test: missing initial state throws with message identifying which state is missing
- Test: terminal state name not in states throws
- Test: transition target not in states throws
- Test: valid config registers and returns correctly
- Test: duplicate machine id overwrites previous registration

createSaga.test.ts:
- Test: all steps succeed → returns all results in order
- Test: step 2 of 3 fails → compensation runs for step 1 and step 0 in reverse, step 2 not compensated
- Test: compensation itself throws → error propagates, does not swallow original
- Test: single step saga — success and failure paths
```

---

## Phase 3 — Compiler and interface generator

**Prompt for Claude Code / Cursor:**

```
Implement packages/core/src/compiler/lint.ts:

export interface LintError { code: string; message: string }
export interface LintWarning { code: string; message: string }
export interface LintResult { errors: LintError[]; warnings: LintWarning[] }

export function lint(config: MachineConfig): LintResult {
  const errors: LintError[] = []
  const warnings: LintWarning[] = []
  const stateNames = new Set(Object.keys(config.states))

  // ERROR: initial state not in states
  if (!stateNames.has(config.initial))
    errors.push({ code: 'INVALID_INITIAL', message: `Initial state '${config.initial}' not in states` })

  // ERROR: terminal state not in states
  for (const t of config.terminal)
    if (!stateNames.has(t))
      errors.push({ code: 'INVALID_TERMINAL', message: `Terminal state '${t}' not in states` })

  // ERROR: transition target not in states
  for (const [stateName, stateConfig] of Object.entries(config.states))
    for (const [event, tx] of Object.entries(stateConfig.on ?? {}))
      if (!stateNames.has(tx.target))
        errors.push({ code: 'INVALID_TARGET', message: `State '${stateName}' event '${event}' target '${tx.target}' not in states` })

  // ERROR: after target not in states
  for (const [stateName, stateConfig] of Object.entries(config.states))
    for (const [, target] of Object.entries(stateConfig.after ?? {}))
      if (!stateNames.has(target as string))
        errors.push({ code: 'INVALID_AFTER_TARGET', message: `State '${stateName}' after target '${target}' not in states` })

  // WARNING: non-terminal state with no outgoing transitions
  for (const [stateName, stateConfig] of Object.entries(config.states))
    if (!config.terminal.includes(stateName))
      if (!stateConfig.on && !stateConfig.after)
        warnings.push({ code: 'DEAD_STATE', message: `State '${stateName}' has no outgoing transitions and is not terminal` })

  // WARNING: state has after TTL but no TIMEOUT transition and target is not in after map
  // (already covered by INVALID_AFTER_TARGET but warn about missing TIMEOUT handler separately)

  return { errors, warnings }
}

Implement packages/core/src/compiler/generateInterface.ts:

This is the key file. It receives a CompiledMachine and writes a TypeScript interface
source string — the generated/I{MachineName}Actions.ts file.

import { z } from 'zod'
import { zodToTs, printNode } from 'zod-to-ts'  // use zod-to-ts package

export function generateInterface(compiled: CompiledMachine, config: MachineConfig): string {
  const name = pascalCase(compiled.machineId)  // 'order' → 'Order'

  // Collect all unique action slots across all states (deduplicate by name)
  const actionSlots = compiled.allActionSlots
  const guardSlots  = compiled.allGuardSlots

  // For each action slot:
  // - Convert slot.input Zod schema → TypeScript type string via zodToTs
  // - Convert slot.output Zod schema → TypeScript type string via zodToTs
  // - Produce: methodName(input: ActionInput<Context> & InputType): Promise<OutputType>

  const contextTypeName = `${name}Context`

  const actionMethods = actionSlots.map(slot => {
    const inputTs  = printNode(zodToTs(slot.input).node)
    const outputTs = printNode(zodToTs(slot.output).node)
    return `  ${slot.name}(\n    input: ActionInput<${contextTypeName}> & ${inputTs}\n  ): Promise<${outputTs}>`
  }).join('\n\n')

  const guardMethods = guardSlots.map(slot => {
    const inputTs = printNode(zodToTs(slot.input).node)
    return `  ${slot.name}(\n    input: ActionInput<${contextTypeName}> & ${inputTs}\n  ): boolean | Promise<boolean>`
  }).join('\n\n')

  return `// AUTO-GENERATED by dfsm compile — DO NOT EDIT
// Machine: ${compiled.machineId}  Version: ${compiled.version}
// Re-run 'dfsm compile' after editing the machine config.

import type { ActionInput } from '@eklabdev/dfsm'

export type ${contextTypeName} = ${printNode(zodToTs(z.object(config.context as any)).node)}

export interface I${name}Actions {
${actionMethods}
}

export interface I${name}Guards {
${guardMethods}
}
`
}

Implement packages/core/src/compiler/compile.ts:

export function compile(config: MachineConfig, version: number): CompiledMachine {
  const lintResult = lint(config)
  if (lintResult.errors.length > 0)
    throw new Error(`Machine '${config.id}' lint failed:\n` + lintResult.errors.map(e => e.message).join('\n'))

  // Build TransitionTable
  const transitionTable: TransitionTable = new Map()
  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    const eventMap = new Map<string, TransitionTableEntry>()
    for (const [event, tx] of Object.entries(stateConfig.on ?? {})) {
      eventMap.set(event, {
        nextState: tx.target,
        guardName: tx.guard?.name,
        actionNames: tx.actions?.map(a => a.name) ?? []
      })
    }
    // after TTL → synthetic TIMEOUT event
    for (const [ttlMs, target] of Object.entries(stateConfig.after ?? {})) {
      eventMap.set(`__AFTER_${ttlMs}`, { nextState: target as string, actionNames: [] })
    }
    transitionTable.set(stateName, eventMap)
  }

  // Collect deduplicated action + guard slots
  const actionSlotMap = new Map<string, ActionSlot<any,any>>()
  const guardSlotMap  = new Map<string, GuardSlot<any>>()

  const collectSlots = (stateConfig: StateConfig) => {
    for (const tx of Object.values(stateConfig.on ?? {})) {
      if (tx.guard) guardSlotMap.set(tx.guard.name, tx.guard)
      for (const a of tx.actions ?? []) actionSlotMap.set(a.name, a)
    }
    for (const a of [...(stateConfig.entry ?? []), ...(stateConfig.exit ?? [])])
      actionSlotMap.set(a.name, a)
  }
  for (const stateConfig of Object.values(config.states)) collectSlots(stateConfig)

  // Build VizGraph
  const vizGraph = buildVizGraph(config)

  return {
    machineId: config.id,
    version,
    transitionTable,
    vizGraph,
    allActionSlots: [...actionSlotMap.values()],
    allGuardSlots: [...guardSlotMap.values()]
  }
}

Unit tests in packages/core/test/unit/compiler/:

generateInterface.test.ts:
- Test: single action slot with z.object input/output → correct interface method signature
- Test: guard slot → correct guard interface method signature
- Test: multiple slots with same name → deduplicated to one method
- Test: generated file contains DO NOT EDIT banner with machine id and version
- Test: generated context type matches machine config context shape

compile.test.ts:
- Test: valid config produces correct TransitionTable (spot-check state+event→target)
- Test: after TTL entries produce __AFTER_{ms} synthetic events in table
- Test: action slot names collected from all states deduplicated correctly
- Test: lint errors cause compile to throw
- Test: compiledMachine.allActionSlots contains correct Zod schemas

lint.test.ts:
- Test: unreachable initial state → INVALID_INITIAL error
- Test: terminal state not in states → INVALID_TERMINAL error
- Test: transition target not in states → INVALID_TARGET error
- Test: dead state (non-terminal, no transitions) → DEAD_STATE warning
- Test: valid machine → no errors, no warnings
```

---

## Phase 4 — MongoDB state store

**Prompt for Claude Code / Cursor:**

```
Implement packages/core/src/store/IStateStore.ts and MongoStateStore.ts.

MongoDB collections:

workflow_state:
  _id: workflowId (string — user-supplied correlation key)
  machineId: string
  machineVersion: number
  currentState: string
  context: Document              (free-form BSON — accumulates across transitions)
  history: HistoryEntry[]        (append-only, never mutated after appended)
  version: number                (optimistic concurrency counter)
  lockedUntil: Date | null       (worker lease TTL)
  status: 'active' | 'completed' | 'failed'
  createdAt: Date
  updatedAt: Date

action_outbox:
  _id: ObjectId
  workflowId: string
  actionName: string             (the slot name — e.g. 'chargePayment')
  idempotencyKey: string         (unique index — workflowId:fromState:actionName:version)
  payload: Document              (contextSnapshot at time of dispatch)
  status: 'pending' | 'executing' | 'done' | 'failed'
  attempts: number
  lastError: string | null
  createdAt: Date

machine_registry:
  _id: machineId + ':' + version
  machineId: string
  version: number
  transitionTable: Document      (serialised — no functions, only names + targets)
  vizGraph: VizGraph
  allActionSlotNames: string[]   (names only — Zod schemas not stored)
  allGuardSlotNames: string[]
  status: 'active' | 'deprecated'
  createdAt: Date
  migratedFrom: number | null

IStateStore interface methods:
  createWorkflow(params: { workflowId, machineId, machineVersion, initialContext }): Promise<void>
  getWorkflow(workflowId): Promise<WorkflowDoc | null>

  acquireLease(workflowId: string, ttlMs: number): Promise<boolean>
    → findOneAndUpdate with filter:
      { _id: workflowId, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: new Date() } }] }
      update: { $set: { lockedUntil: new Date(Date.now() + ttlMs) } }
    → returns true if acquired, false if another worker holds it

  releaseLease(workflowId: string): Promise<void>
    → { $set: { lockedUntil: null } }

  transitionWithOutbox(params: {
    workflowId: string
    nextState: string
    contextUpdate: Record<string, unknown>   // shallow-merged into context
    historyEntry: HistoryEntry<any>
    outboxItems: OutboxItem[]               // one per action slot name dispatched
    expectedVersion: number                 // optimistic lock check
  }): Promise<void>
    → MUST use session.withTransaction():
      1. UPDATE workflow_state: $set currentState, $set status if terminal,
         $inc version, $push history, $set updatedAt,
         $set context (merge), filter includes { version: expectedVersion }
      2. INSERT MANY action_outbox with all outboxItems
      → if UPDATE matched 0 docs: throw ConcurrentModificationError

  getPendingOutboxItems(limit: number): Promise<OutboxDoc[]>
  markOutboxExecuting(id: ObjectId): Promise<void>
  markOutboxDone(id: ObjectId): Promise<void>
  markOutboxFailed(id: ObjectId, error: string): Promise<void>
  incrementOutboxAttempts(id: ObjectId): Promise<void>

  getActiveWorkflows(machineId: string): Promise<WorkflowDoc[]>
    → used by TimeoutSupervisor to scan for TTL breaches

  saveMachineVersion(compiled: CompiledMachine): Promise<void>
  getActiveMachine(machineId: string): Promise<MachineRegistryDoc | null>

Required MongoDB indexes (call in setup() method):
  workflow_state: { status: 1, machineId: 1, updatedAt: 1 }  (supervisor scans)
  workflow_state: { machineId: 1, currentState: 1 }           (viz live counts)
  action_outbox:  { idempotencyKey: 1 } unique
  action_outbox:  { status: 1, createdAt: 1 }                 (relay polling)
  machine_registry: { machineId: 1, status: 1 }
```

---

## Phase 5 — Execution engine

**Prompt for Claude Code / Cursor:**

```
Implement packages/core/src/engine/ConcurrencyManager.ts:

export class ConcurrencyManager {
  constructor(private store: IStateStore, private leaseTtlMs = 30_000) {}

  async acquire(workflowId: string): Promise<boolean> {
    return this.store.acquireLease(workflowId, this.leaseTtlMs)
  }

  async release(workflowId: string): Promise<void> {
    return this.store.releaseLease(workflowId)
  }

  async withLease<T>(workflowId: string, fn: () => Promise<T>): Promise<T | null> {
    const acquired = await this.acquire(workflowId)
    if (!acquired) return null
    try {
      return await fn()
    } finally {
      await this.release(workflowId)
    }
  }
}

Implement packages/core/src/engine/TransitionExecutor.ts:

PURE FUNCTION — no DB, no async, no side effects. Unit testable in isolation.

export interface TransitionInput {
  currentState: string
  event: { type: string; payload: unknown }
  transitionTable: TransitionTable
  guards: Map<string, GuardHandler<any, any>>  // live function refs passed at runtime
  context: Record<string, unknown>
  history: HistoryEntry<any>[]
}

export interface TransitionResult {
  nextState: string
  actionNames: string[]     // ordered slot names to enqueue in outbox
  guardEvaluated: boolean
}

export class GuardRejectedError extends Error {}
export class NoTransitionError extends Error {}

export async function executeTransition(input: TransitionInput): Promise<TransitionResult> {
  const stateMap = input.transitionTable.get(input.currentState)
  if (!stateMap) throw new NoTransitionError(`No transitions from state '${input.currentState}'`)

  const entry = stateMap.get(input.event.type)
  if (!entry) throw new NoTransitionError(`No transition from '${input.currentState}' on event '${input.event.type}'`)

  if (entry.guardName) {
    const guardFn = input.guards.get(entry.guardName)
    if (!guardFn) throw new Error(`Guard '${entry.guardName}' not registered`)
    const actionInput = { workflowId: '', context: input.context, history: input.history, event: input.event }
    const passed = await guardFn(actionInput as any)
    if (!passed) throw new GuardRejectedError(`Guard '${entry.guardName}' rejected transition`)
  }

  return {
    nextState: entry.nextState,
    actionNames: entry.actionNames,
    guardEvaluated: !!entry.guardName
  }
}

Implement packages/core/src/engine/WorkflowEngine.ts:

export interface EngineConfig {
  store: IStateStore
  machines: Map<string, MachineConfig>           // machineId → config
  compiledMachines: Map<string, CompiledMachine>  // machineId → compiled
  actions: Map<string, ActionHandler<any, any, any>>  // slotName → live fn
  guards:  Map<string, GuardHandler<any, any>>        // slotName → live fn
  leaseTtlMs?: number
  outboxPollIntervalMs?: number
}

export class WorkflowEngine {
  async start(): Promise<void>    // starts ActionExecutor + TimeoutSupervisor loops
  async stop(): Promise<void>     // graceful drain

  async startWorkflow(params: {
    workflowId: string
    machineId: string
    initialContext: Record<string, unknown>
  }): Promise<void>
    // 1. Load latest active machine version from DB
    // 2. create workflow_state doc with currentState = machine.initial

  async sendEvent(workflowId: string, event: { type: string; payload?: unknown }): Promise<void>
    // 1. concurrencyManager.withLease(workflowId, async () => {
    // 2.   doc = await store.getWorkflow(workflowId)
    // 3.   compiled = compiledMachines.get(doc.machineId + ':' + doc.machineVersion)
    //      (load from DB if not in map — supports in-flight workflows on old versions)
    // 4.   result = await executeTransition({ currentState: doc.currentState, event,
    //               transitionTable: compiled.transitionTable, guards, context: doc.context,
    //               history: doc.history })
    // 5.   historyEntry = { transitionedAt: new Date(), fromState: doc.currentState,
    //               toState: result.nextState, event: event.type,
    //               eventPayload: event.payload, contextSnapshot: deepClone(doc.context),
    //               actionsDispatched: result.actionNames }
    // 6.   outboxItems = result.actionNames.map(name => ({
    //               workflowId, actionName: name,
    //               idempotencyKey: workflowId+':'+doc.currentState+':'+name+':'+doc.version,
    //               payload: doc.context }))
    // 7.   await store.transitionWithOutbox({ workflowId, nextState: result.nextState,
    //               contextUpdate: {}, historyEntry, outboxItems,
    //               expectedVersion: doc.version })
    // 8. })

  async getWorkflow(workflowId: string): Promise<WorkflowDoc | null>
  async getHistory(workflowId: string): Promise<HistoryEntry<any>[]>
}

Implement packages/core/src/engine/ActionExecutor.ts:

Background loop that polls action_outbox and executes pending items.

Loop every outboxPollIntervalMs (default 500ms):
  1. getPendingOutboxItems(limit: 10)
  2. For each item:
     a. markOutboxExecuting(item._id)
     b. actionFn = actions.get(item.actionName)
        if not found: markOutboxFailed(item._id, 'Action not registered')
     c. doc = await store.getWorkflow(item.workflowId)
     d. actionInput = { workflowId: item.workflowId, context: doc.context,
                        history: doc.history, event: { type: 'outbox', payload: item.payload } }
     e. result = await actionFn(actionInput)
     f. Merge result into workflow context:
        await store.mergeContext(item.workflowId, result)
     g. markOutboxDone(item._id)
  3. On action throw:
     incrementOutboxAttempts(item._id)
     if attempts >= maxRetries: markOutboxFailed(item._id, error.message)
     else: reset status to 'pending' (will be retried next poll)

Implement packages/core/src/engine/TimeoutSupervisor.ts:

Scans every 30s. For each active workflow:
  - Load its compiled machine's transitionTable
  - Check if currentState has any __AFTER_{ms} synthetic event entries
  - If (now - doc.updatedAt) > ttlMs: call engine.sendEvent(doc._id, { type: `__AFTER_${ttlMs}` })
  - Log warning if TTL breached but no after handler registered (lint should have caught this)
```

---

## Phase 6 — Integration tests

**Prompt for Claude Code / Cursor:**

```
Create the order fulfilment machine fixture used by all integration tests.
File: packages/core/test/fixtures/orderMachine.ts

import { z } from 'zod'
import { defineMachine } from '../../src/define/defineMachine'

export interface OrderContext {
  orderId: string
  customerId: string
  amount: number
  sku: string
  chargeId?: string
  reservationId?: string
  trackingNumber?: string
  cancelReason?: string
  refundId?: string
}

export const orderMachine = defineMachine<OrderContext>({
  id: 'order',
  initial: 'pending',
  terminal: ['delivered', 'cancelled', 'refunded'],
  context: {
    orderId: '', customerId: '', amount: 0, sku: ''
  },
  states: {
    pending: {
      on: {
        SUBMIT: {
          target: 'payment_processing',
          guard: {
            name: 'hasStock',
            input: z.object({ sku: z.string() })
          },
          actions: [{
            name: 'chargePayment',
            input:  z.object({ amount: z.number(), customerId: z.string() }),
            output: z.object({ chargeId: z.string() })
          }]
        },
        CANCEL: {
          target: 'cancelled',
          actions: [{
            name: 'recordCancellation',
            input:  z.object({ orderId: z.string() }),
            output: z.object({ cancelReason: z.string() })
          }]
        }
      }
    },
    payment_processing: {
      after: { 300000: 'cancelled' },  // 5 min timeout in prod; override in tests
      on: {
        PAYMENT_CAPTURED: {
          target: 'fulfilling',
          actions: [{
            name: 'reserveStock',
            input:  z.object({ sku: z.string() }),
            output: z.object({ reservationId: z.string() })
          }]
        },
        PAYMENT_FAILED: { target: 'cancelled', actions: [] },
        __AFTER_300000:  { target: 'cancelled', actions: [] }
      }
    },
    fulfilling: {
      after: { 86400000: 'cancelled' },
      on: {
        SHIPPED: {
          target: 'shipped',
          actions: [{
            name: 'sendShippingNotification',
            input:  z.object({ customerId: z.string(), orderId: z.string() }),
            output: z.object({ trackingNumber: z.string() })
          }]
        },
        CANCEL: { target: 'cancelled', actions: [] }
      }
    },
    shipped: {
      after: { 604800000: 'delivered' },  // 7 days auto-deliver
      on: {
        DELIVERED: { target: 'delivered', actions: [] },
        RETURN_REQUESTED: {
          target: 'refunded',
          actions: [{
            name: 'processRefund',
            input:  z.object({ chargeId: z.string() }),
            output: z.object({ refundId: z.string() })
          }]
        }
      }
    },
    delivered: {},
    cancelled: {},
    refunded: {}
  }
})

Create packages/core/test/fixtures/orderActions.ts:

Stub implementations of all action handlers for testing.
Each action returns deterministic fake data so tests are predictable.
Actions must satisfy the IOrderActions interface (generate it first via compile).

hasStock: always returns true unless context.sku === 'OUT_OF_STOCK'
chargePayment: returns { chargeId: 'ch_test_' + Date.now() }
reserveStock: returns { reservationId: 'rsv_test_' + Date.now() }
sendShippingNotification: returns { trackingNumber: 'TRK123' }
processRefund: returns { refundId: 'ref_test_' + Date.now() }
recordCancellation: returns { cancelReason: 'customer_request' }

Write all integration tests using mongodb-memory-server.

happy-path.test.ts:
- Start order workflow with orderId='ORD-1', amount=100, sku='SKU-A'
- Send: SUBMIT → PAYMENT_CAPTURED → SHIPPED → DELIVERED
- Assert: final state is 'delivered'
- Assert: history has 4 entries with correct from/to state pairs
- Assert: context.chargeId, reservationId, trackingNumber are all set
- Assert: all action_outbox docs are status='done'
- Assert: context never lost earlier fields (accumulator pattern)

crash-recovery.test.ts:
- Start workflow, send SUBMIT (advances to payment_processing)
- Manually set lockedUntil to past timestamp to simulate expired lease
- Create second engine instance against same MongoDB
- Send PAYMENT_CAPTURED via second engine
- Assert: workflow advances to 'fulfilling' correctly
- Assert: history does not have duplicate entries
- Assert: context.chargeId from first engine's action is still present

concurrent-workflows.test.ts:
- Start 50 order workflows with different workflowIds simultaneously
- Send SUBMIT to all 50 concurrently via Promise.all
- Wait for all outbox items to be processed
- Assert: all 50 workflows are in 'payment_processing' state
- Assert: no workflow_state doc has version conflicts (all versions = 1)
- Assert: action_outbox has exactly 50 'chargePayment' items, all 'done'
- Assert: idempotencyKey is unique across all 50 (no duplicates)

timeout-stuck.test.ts:
- Start workflow, advance to payment_processing
- Override TTL to 200ms for test
- Wait 400ms
- Assert: TimeoutSupervisor sent __AFTER_300000 event
- Assert: workflow transitioned to 'cancelled'
- Assert: history entry shows fromState='payment_processing', event='__AFTER_300000'

outbox-retry.test.ts:
- Define chargePayment stub that fails twice then succeeds on third attempt
- Start workflow, send SUBMIT
- Wait for 3 outbox processing cycles
- Assert: action_outbox doc has attempts=3 before status='done'
- Assert: context.chargeId is set after eventual success
- Assert: idempotencyKey appears exactly once in action_outbox

saga-compensation.test.ts:
- Define action that internally uses createSaga with two steps
- Step 2 fails → step 1's compensation must run
- Assert: compensation side effect recorded (e.g. flag set in context)
- Assert: action_outbox item ends in 'failed' (saga threw)
- Assert: workflow state did NOT advance (still at same state since action failed)

migration.test.ts:
- Compile and migrate orderMachine v1
- Start 3 workflows on v1, advance to payment_processing
- Add new action slot 'sendOrderConfirmation' to pending→SUBMIT transition
- Compile and migrate up to v2
- Assert: in-flight workflows still have machineVersion=1 in their docs
- Assert: new workflow started after migration has machineVersion=2
- Send PAYMENT_CAPTURED to a v1 in-flight workflow → assert advances correctly on v1 table
- Send SUBMIT to the v2 workflow → assert 'sendOrderConfirmation' is queued in outbox
- Run migrate down → assert v1 is active, v2 is deprecated
```

---

## Phase 7 — CLI

**Prompt for Claude Code / Cursor:**

```
Implement packages/cli/src/ using commander.js.

dfsm.config.ts shape (project root):
  export default {
    mongoUri: 'mongodb://localhost:27017/myapp',
    machines: [orderMachine],       // MachineConfig array
    actions: new OrderActions(),    // instance implementing the generated interface
    guards: new OrderGuards(),      // instance implementing the generated interface
    generatedDir: './generated',    // where interface files are written
    leaseTtlMs: 30_000,
    outboxPollIntervalMs: 500
  }

Command: dfsm lint [--machine <id>]
  1. Load dfsm.config.ts via tsx
  2. Call lint(config) for each (or named) machine
  3. Print errors red, warnings yellow
  4. Exit 1 if any errors

Command: dfsm compile [--machine <id>]
  1. Run lint — exit 1 if errors
  2. For each machine: call compile(config, nextVersion)
     nextVersion = current active version in MongoDB + 1, or 1 if new machine
  3. Call generateInterface(compiled, config)
  4. Write generated file to {generatedDir}/I{MachineName}Actions.ts
  5. Write .dfsm/{machineId}.json artifact (transitionTable + vizGraph, no functions)
  6. Print: "Compiled order v2 → generated/IOrderActions.ts"
  7. Print action slot count, guard slot count, state count, edge count

Command: dfsm migrate up [--machine <id>]
  1. Read .dfsm/{machineId}.json artifact
  2. Verify generated interface file exists in generatedDir
  3. Run tsc --noEmit on the project to check implementation satisfies interface
     If TypeScript errors: print them and exit 1 with message:
     "Implementation does not satisfy generated interface. Fix errors before migrating."
  4. Connect to MongoDB
  5. Call store.saveMachineVersion(compiled):
     - Insert new machine_registry doc
     - Set previous active version to 'deprecated'
  6. Print: "Migrated order from v1 → v2"

Command: dfsm migrate down [--machine <id>]
  1. Check active workflow count on current version
  2. If any in-flight: print count and exit 1 ("Drain N workflows before rolling back")
  3. Restore previous version as active, mark current as deprecated
  4. Delete generated interface file for rolled-back version
  5. Re-generate interface for restored version

Command: dfsm migrate status
  Print table: machineId | activeVersion | inFlightCount | deprecatedVersions

Command: dfsm viz [--port <n>] [--machine <id>]
  Start viz server on port (default 4242)

Key invariant for migrate up:
  TypeScript compile check MUST pass before any DB write.
  If tsc fails, no machine_registry document is written.
  This ensures the generated interface always matches what is deployed.
```

---

## Phase 8 — Viz server and UI

**Prompt for Claude Code / Cursor:**

```
Implement packages/viz/src/server.ts (Express).

Routes:
GET /api/graph/:machineId
  → vizGraph from active machine_registry version
  → { nodes, edges, machineId, version }

GET /api/live/:machineId
  → aggregate workflow_state by currentState
  → { counts: { [stateName]: number }, total: number }

GET /api/workflow/:workflowId
  → full workflow_state document

GET /api/workflow/:workflowId/diff/:index
  → context diff between history[index-1] and history[index]
  → { added: Record<string,unknown>, changed: Record<string,{ from, to }>, removed: string[] }

GET /* → serve React SPA

StatechartCanvas.tsx:
  - Render VizGraph using elkjs for automatic layout
  - Node shapes: initial (filled circle + rect), terminal (double-border rect), state (rect)
  - Edge labels: event name, guard name in [brackets] if present, action names below edge
  - Click node → side panel showing workflows currently in that state
  - Node badge: count of live workflows in that state (from /api/live)
  - Highlight nodes with live workflows in amber

HistoryPanel.tsx:
  - Given workflowId: vertical timeline of history[]
  - Each row: timestamp | fromState → toState | event | actionsDispatched
  - Expand row → context diff table (calls /api/workflow/:id/diff/:index)
  - Diff table: field | before | after (added = green, changed = amber, removed = red)

LiveOverlay.tsx:
  - Polls /api/live every 3s
  - Updates count badges without full re-render
```

---

## Phase 9 — Order fulfilment example

**Prompt for Claude Code / Cursor:**

```
Create examples/order-fulfilment/ as a fully runnable example.

examples/order-fulfilment/machines/order.machine.ts:
  The full orderMachine definition from the fixtures (copy and adapt).
  Keep it self-contained with its own imports.

examples/order-fulfilment/generated/:
  This directory is created by dfsm compile. Add to .gitignore.
  But commit an initial version so the repo is runnable out of the box.

examples/order-fulfilment/actions/order.actions.ts:
  Implements IOrderActions and IOrderGuards.
  Use realistic-looking stub logic:
    chargePayment: simulates Stripe call with 200ms delay, returns fake chargeId
    reserveStock: simulates inventory check with 100ms delay
    sendShippingNotification: logs tracking number, returns it
    processRefund: simulates refund with 150ms delay
    recordCancellation: logs reason, returns it
    hasStock: returns false if context.sku === 'OUT_OF_STOCK', else true

  Each action demonstrates accessing history:
    chargePayment logs: "Processing order, history has N prior transitions"
    processRefund reads chargeId from context (accumulated by earlier chargePayment action)

examples/order-fulfilment/run.ts:
  1. Connect MongoDB (docker-compose provides it)
  2. Load dfsm.config.ts
  3. Create WorkflowEngine with orderMachine + OrderActions + OrderGuards
  4. await engine.start()
  5. Start workflow: workflowId='ORD-001', customerId='CUST-42', amount=4999, sku='WIDGET-A'
  6. Print state after each sendEvent with 500ms pauses:
     → SUBMIT           (pending → payment_processing)
     → PAYMENT_CAPTURED (payment_processing → fulfilling)
     → SHIPPED          (fulfilling → shipped)
     → DELIVERED        (shipped → delivered)
  7. Print final context (show accumulated chargeId, reservationId, trackingNumber)
  8. Print full history array (show each transition timestamped)
  9. await engine.stop()
  10. console.log('Run: dfsm viz to see the statechart')

examples/order-fulfilment/docker-compose.yml:
  services:
    mongodb:
      image: mongo:7
      ports: ["27017:27017"]
      volumes: [mongo_data:/data/db]
  volumes:
    mongo_data:

examples/order-fulfilment/README.md:
  # Order fulfilment example
  ## Prerequisites
  - Docker
  - Node.js 20+
  - pnpm

  ## Run it
  docker-compose up -d
  pnpm install
  dfsm lint
  dfsm compile
  dfsm migrate up
  pnpm run example

  ## Expected output
  [pending] Starting order ORD-001...
  [payment_processing] Payment charged. chargeId: ch_test_...
  [fulfilling] Stock reserved. reservationId: rsv_test_...
  [shipped] Notification sent. trackingNumber: TRK123
  [delivered] Order complete.

  Context: { orderId: 'ORD-001', chargeId: '...', reservationId: '...', trackingNumber: 'TRK123' }
  History: 4 transitions in Xms

  ## View the statechart
  dfsm viz
  Open http://localhost:4242

examples/traffic-light/ — minimal hello world:
  machine.ts: 3 states (red, green, yellow), cycles via NEXT event, no guards, one action 'logChange'
  generated/ITrafficActions.ts: auto-generated (commit initial version)
  actions.ts: logChange({ context }) { console.log('Changed to', context.currentColour) }
  run.ts: cycles through 6 transitions automatically with 1s delays
  README.md: shortest possible @eklabdev/dfsm setup — 30 lines of user code total
```

---

## Phase 10 — Documentation

**Prompt for Claude Code / Cursor:**

```
Write docs/ in markdown.

docs/architecture.md:
  - The RSA/IIB separation: machine declares contracts, implementation fulfils them
  - Why generated interfaces not hand-written: machine is source of truth, not the interface
  - DB-native state: why workflow_state row IS the machine, not a snapshot
  - Outbox pattern: the dual-write problem and why transitionWithOutbox solves it
  - Context accumulator: how fields survive across states, history as audit log
  - MongoDB concurrency: lockedUntil TTL + findOneAndUpdate as SELECT FOR UPDATE equivalent
  - Migration model: version pinning, in-flight workflow isolation, tsc gate before migrate up
  - Mermaid sequence diagram: full transition lifecycle from sendEvent to outbox relay

docs/decisions/006-machine-contract-generation.md (ADR format):
  Context: Need type-safe contract between machine definition and action implementations
  Decision: Machine config declares Zod schemas per slot → compile generates TS interface
  Consequences: Interface is never hand-written, always in sync with machine config
  Alternatives: String slot names (rejected — no type safety), inline functions (rejected — not serialisable)

docs/guides/defining-machines.md:
  - MachineConfig full field reference
  - ActionSlot: name, input schema, output schema — what each field means
  - GuardSlot: name, input schema
  - after TTL: how it becomes a synthetic event, what to put in handler
  - Example: the full order machine with inline explanations

docs/guides/implementing-actions.md:
  - After dfsm compile: what the generated file contains
  - Creating your implementation class: implements IOrderActions
  - ActionInput shape: context (mutable), history (read-only), event, workflowId
  - Reading history in an action: why and how (e.g. processRefund reads chargeId from context)
  - Returning context updates: shallow merge semantics — only return new/changed fields
  - Using createSaga for multi-step actions: when to use it, what it guarantees
  - Idempotency: the idempotencyKey is built by the engine — your action just needs to be re-runnable

docs/guides/saga-helper.md:
  - What createSaga does: sequential steps + reverse compensation on failure
  - What it does NOT do: it is not a distributed transaction, it is best-effort
  - When to use it: charging payment + reserving inventory (two external calls in one action)
  - Example with Stripe charge + inventory reservation + their compensations
  - What happens if compensation fails: error propagates, action_outbox marked failed

docs/guides/migration.md:
  - When to run dfsm compile: after any change to machine config (states, slots, TTLs)
  - What dfsm migrate up does step by step
  - The tsc gate: why TypeScript must pass before DB write
  - In-flight workflow pinning: why old workflows keep running on old version
  - Breaking vs non-breaking changes table:
    Adding a state: non-breaking (old workflows never visit it)
    Adding an action slot to existing transition: breaking (tsc will catch it)
    Renaming a state: breaking (old in-flight workflows will error)
    Changing Zod schema output type: breaking (tsc will catch it)
    Adding a new TTL: non-breaking for in-flight (they won't have the new supervisor check)

docs/guides/visualization.md:
  - dfsm viz: what it shows, how to read the statechart
  - Node types: initial (dot), normal (rect), terminal (double border)
  - Edge labels: event / [guard] / action names
  - Live overlay: amber-highlighted nodes with workflow counts
  - History panel: how to read a transition timeline
  - Context diff: what added/changed/removed means
  - Using viz for debugging: find stuck workflows by state, inspect their history
```

---

## Toolchain

**Prompt for Claude Code / Cursor:**

```
Root package.json (pnpm workspaces):
  scripts:
    build:            turbo run build
    test:             turbo run test
    test:unit:        turbo run test:unit
    test:integration: turbo run test:integration
    lint:             turbo run lint
    docs:api:         typedoc --entryPoints packages/core/src/index.ts --out docs/api

packages/core dependencies:
  mongodb: ^6.0.0
  zod: ^3.22.0
  zod-to-ts: ^1.2.0         (converts Zod schemas to TypeScript AST for interface generation)
  mongodb-memory-server: ^9.0.0  (devDependency — integration tests)
  vitest: latest             (devDependency)

packages/cli dependencies:
  commander: ^12.0.0
  tsx: ^4.0.0
  chalk: ^5.0.0
  typescript: ^5.4.0        (needed for tsc --noEmit gate in migrate up)

packages/viz dependencies:
  express: ^4.18.0
  react: ^18.0.0
  elkjs: ^0.9.0             (statechart layout)
  vite: ^5.0.0

tsconfig.base.json:
  target: ES2022
  module: NodeNext
  moduleResolution: NodeNext
  strict: true
  exactOptionalPropertyTypes: true

.gitignore:
  node_modules/
  dist/
  .dfsm/
  docs/api/
  examples/*/generated/     ← generated files excluded (but keep initial committed copy)

GitHub Actions (.github/workflows/ci.yml):
  On: push, pull_request to main
  Jobs:
    lint → build → test:unit → test:integration
  Node: 20, pnpm cache
  Integration: uses mongodb service container
```

---

## Invariants Claude Code must never violate

1. `transitionWithOutbox` uses MongoDB session + `withTransaction`. Never separate writes.
2. `executeTransition` is a pure async function — no DB access, no module-level state.
3. `history` array in workflow_state is append-only. No $set on array elements, ever.
4. `idempotencyKey` has a unique MongoDB index. Duplicate action execution impossible at DB level.
5. `lockedUntil` is always checked in the same `findOneAndUpdate` as the lease write.
6. `dfsm migrate up` runs `tsc --noEmit` and only proceeds to DB write if exit code is 0.
7. In-flight workflows keep their `machineVersion` and run against the old compiled table.
8. `generated/` files are always overwritten by `dfsm compile`, never hand-edited.
9. Functions (action handlers, guard handlers) are never stored in MongoDB — only slot names.
10. `createSaga` compensations run in reverse order, starting from the last successfully executed step.