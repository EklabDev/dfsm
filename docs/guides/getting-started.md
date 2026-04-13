# Getting started

Quick path from zero to a running workflow with **@eklabdev/dfsm (dfsm)**.

## Prerequisites

- **Node.js** 20 or newer (see root `package.json` `engines`)
- **pnpm** 9.x (repository `packageManager` field)
- **Docker** (recommended) for local **MongoDB**, e.g. `mongo:7` on port `27017`
- A project **`dfsm.config.ts`** at the repository root (see below)

## Install

From the monorepo root:

```bash
pnpm install
pnpm build
```

Build produces the `dfsm` CLI (`packages/cli`). From a **project directory** that contains `dfsm.config.ts`, run the CLI with the built binary, for example:

```bash
cd examples/order-fulfilment
node ../../packages/cli/dist/index.js compile
```

(Alternatively add `dfsm-cli` as a devDependency and use `pnpm exec dfsm` once wired to your workspace.)

## Start MongoDB

```bash
docker run -d --name dfsm-mongo -p 27017:27017 mongo:7
```

Point `mongoUri` in `dfsm.config.ts` at this instance (for example `mongodb://localhost:27017/order-example`).

## First machine

1. Define context + `defineMachine({ ... })` in `machines/*.machine.ts` (see [defining-machines.md](./defining-machines.md)).
2. Implement actions/guards in `actions/*.ts` (see [implementing-actions.md](./implementing-actions.md)).

Minimal `dfsm.config.ts`:

```typescript
import { orderMachine } from './machines/order.machine.js'
import { OrderActions, OrderGuards } from './actions/order.actions.js'

export default {
  mongoUri: 'mongodb://localhost:27017/my-app',
  machines: [orderMachine],
  actions: new OrderActions(),
  guards: new OrderGuards(),
  generatedDir: './generated',
}
```

## Compile

Validates the machine, writes **`.dfsm/<machineId>.json`** (transition table + viz metadata) and **`generated/I<Machine>Actions.ts`** (and guards interface).

```bash
node ../../packages/cli/dist/index.js compile
```

## Migrate

Persists the compiled machine version to MongoDB (collections are created on demand). **Requires a clean `tsc --noEmit` first** — see [migration.md](./migration.md).

```bash
node ../../packages/cli/dist/index.js migrate up
```

## Run

Use `WorkflowEngine` with `MongoStateStore`, the same `compile()` output version you migrated, and handler maps (see `examples/order-fulfilment/run.ts`).

```bash
pnpm exec tsx run.ts
```

## Visualise

With MongoDB populated and optional API wired to your store:

```bash
node ../../packages/cli/dist/index.js viz --port 4242
```

Open `http://localhost:4242` (see [visualization.md](./visualization.md)).

## Next steps

- [Defining machines](./defining-machines.md) — full config reference
- [Implementing actions](./implementing-actions.md) — handlers, history, sagas
- [Migration](./migration.md) — when to compile/migrate and breaking changes
