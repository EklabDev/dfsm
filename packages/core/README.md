# @eklabdev/dfsm

Durable finite state machines with provider-agnostic persistence and queue-driven execution. Define machines with an XState-compatible API, wire action and guard handlers in application code, and run workflows through a runtime that persists state, dispatches durable actions via an outbox, and routes events over pluggable queues.

## Requirements

- Node.js **20+**
- ESM (`"type": "module"` recommended)

## Install

```bash
pnpm add @eklabdev/dfsm
# or
npm install @eklabdev/dfsm
```

There are **no peer dependencies**. Runtime drivers (SQLite, PostgreSQL, MongoDB, RabbitMQ, Kafka) ship as direct dependencies of this package.

## Quick start

### 1. Define a machine

Machines use an XState-like config. Handler functions are **not** stored in the machine definition — only named slots. Optional `meta.dfsm` Zod schemas describe durable action/guard contracts.

```ts
import { createMachine } from '@eklabdev/dfsm'

export const trafficMachine = createMachine({
  id: 'traffic',
  initial: 'red',
  context: { currentColour: 'red' },
  states: {
    red: {
      on: {
        NEXT: { target: 'green', actions: ['logChange'] },
      },
    },
    green: {
      on: {
        NEXT: { target: 'yellow', actions: ['logChange'] },
      },
    },
    yellow: {
      on: {
        NEXT: { target: 'red', actions: ['logChange'] },
      },
    },
  },
})
```

### 2. Implement action and guard handlers

Handlers are `Map`s keyed by slot name. Actions receive `ActionInput` (context, event, history) and return partial context updates.

```ts
import type { ActionInput } from '@eklabdev/dfsm'

type Input = ActionInput<{ currentColour: string }>

export const trafficActions = new Map([
  [
    'logChange',
    async (input: Input) => {
      const next =
        input.context.currentColour === 'red'
          ? 'green'
          : input.context.currentColour === 'green'
            ? 'yellow'
            : 'red'
      console.log(`Changed to ${next}`)
      return { currentColour: next }
    },
  ],
])
```

### 3. Create a runtime and run a workflow

```ts
import {
  createRuntime,
  createStore,
  createQueue,
} from '@eklabdev/dfsm'
import { trafficMachine } from './machine.js'
import { trafficActions } from './actions.js'

const store = await createStore({ provider: 'sqlite', path: ':memory:' })
const runtime = await createRuntime({
  store,
  queue: createQueue({ provider: 'memory' }),
  actions: trafficActions,
  guards: new Map(),
  outboxPollIntervalMs: 100,
})

await runtime.registerMachine(trafficMachine)
await runtime.start()

await runtime.startWorkflow({
  workflowId: 'LIGHT-1',
  machineId: 'traffic',
  initialContext: { currentColour: 'red' },
})

await runtime.sendEvent('LIGHT-1', { type: 'NEXT' })

const doc = await runtime.getWorkflow('LIGHT-1')
console.log(doc!.currentState)

await runtime.stop()
```

## Durable contracts with Zod

For production machines, attach Zod schemas under `meta.dfsm` on transitions so the runtime can validate handler inputs and outputs at execution time:

```ts
import { z } from 'zod'
import { createMachine } from '@eklabdev/dfsm'

export const orderMachine = createMachine({
  id: 'order',
  initial: 'pending',
  // ...
  states: {
    pending: {
      on: {
        SUBMIT: {
          target: 'payment_processing',
          guard: 'hasStock',
          actions: ['chargePayment'],
          meta: {
            dfsm: {
              guard: { hasStock: { input: z.object({ sku: z.string() }) } },
              actions: {
                chargePayment: {
                  input: z.object({ amount: z.number(), customerId: z.string() }),
                  output: z.object({ chargeId: z.string() }),
                },
              },
            },
          },
        },
      },
    },
  },
})
```

See [examples/order-fulfilment](https://github.com/EklabDev/dfsm/tree/main/examples/order-fulfilment) for a full order workflow with guards, timeouts, and final states.

## Persistence and queues

### Store (`createStore`)

| Provider   | Config |
|-----------|--------|
| `sqlite`  | `{ provider: 'sqlite', path?: string }` — default `:memory:` |
| `postgres`| `{ provider: 'postgres', connectionString: string }` |
| `mongo`   | `{ provider: 'mongo', db: Db }` — pass a connected MongoDB `Db` instance |

`createStore` calls `setup()` on the adapter to create schema/tables.

### Queue (`createQueue`)

| Provider    | Config |
|------------|--------|
| `memory`   | `{ provider: 'memory' }` — in-process, good for tests and local dev |
| `rabbitmq` | `{ provider: 'rabbitmq', url: string }` |
| `kafka`    | `{ provider: 'kafka', brokers: string[], clientId?: string }` |

If omitted, `createRuntime` defaults to an in-memory queue.

## Runtime API

| Method | Description |
|--------|-------------|
| `registerMachine(machine)` | Lint, version, and persist a machine definition; set up queue topics |
| `registerWorkflow(definition)` | Register a multi-step orchestration route |
| `start()` / `stop()` | Start or stop consumers, action executor, and timeout supervisor |
| `startWorkflow({ workflowId, machineId, initialContext })` | Create a new workflow instance |
| `sendEvent(workflowId, event, machineId?, machineVersion?)` | Publish an event to the current state's inbound topic |
| `getWorkflow(workflowId)` | Read current state, context, and metadata |
| `getHistory(workflowId)` | Append-only transition audit log |
| `ingest(topic, payload)` | Entry point for orchestrator-bound inbound messages |
| `startVizServer({ port? })` | Serve a live statechart UI from persisted definitions |

### `createRuntime` options

```ts
interface RuntimeConfig {
  store: IWorkflowStore
  queue?: IQueueAdapter
  actions?: Map<string, ActionHandler>
  guards?: Map<string, GuardHandler>
  leaseTtlMs?: number           // default 30_000
  outboxPollIntervalMs?: number // default 500
  maxRetries?: number           // default 5
  supervisorIntervalMs?: number // default 30_000
}
```

## Multi-step workflows

Use `createWorkflow()` to define orchestration routes (entry, machine, subworkflow, choice, parallel, and exit steps), then `runtime.registerWorkflow()` before `start()`. The orchestrator spawns child machine instances and advances routes as steps complete.

## Visualization

- **Built-in:** `runtime.startVizServer({ port: 4242 })` after registering machines
- **Standalone package:** [`@eklabdev/dfsm-viz`](https://www.npmjs.com/package/@eklabdev/dfsm-viz) — React UI and server for exploring live definitions

## Main exports

```ts
// Machine definition
createMachine, lint, buildTransitionTable, buildVizGraph, buildTopicBindings
getTerminalStates, isTerminalState

// Orchestration
createWorkflow, buildWorkflowVizGraph

// Runtime
createRuntime, DfsmRuntime, MachineRegistry, StateConsumer
OrchestratorEngine, ActionExecutor, TimeoutSupervisor, ConcurrencyManager
executeTransition

// Adapters
createStore, createQueue
SQLiteWorkflowStore, PostgresWorkflowStore, MongoWorkflowStore
InMemoryQueueAdapter, RabbitMQQueueAdapter, KafkaQueueAdapter

// Types
ActionInput, ActionHandler, GuardHandler, MachineConfig, IWorkflowStore, ...
```

## Examples

Runnable examples in the [dfsm monorepo](https://github.com/EklabDev/dfsm):

- [examples/traffic-light](https://github.com/EklabDev/dfsm/tree/main/examples/traffic-light) — minimal three-state loop with in-memory SQLite
- [examples/order-fulfilment](https://github.com/EklabDev/dfsm/tree/main/examples/order-fulfilment) — guards, Zod contracts, timeouts, and final states

## Further reading

- [Architecture overview](https://github.com/EklabDev/dfsm/blob/main/docs/architecture.md) — persistence schema, queue execution model, versioning, and orchestrator design
- Generated API reference: run `pnpm docs:api` from the repo root
