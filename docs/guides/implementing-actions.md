# Implementing actions

After you declare slots on the machine, you implement them in ordinary TypeScript classes. The compiler only generates **interfaces**; your code satisfies them.

## After `dfsm compile`

For machine id `order` you get a single **`generated/IOrderActions.ts`** (filename is actions-oriented) containing:

- **`IOrderActions`** — one async method per action slot; return type is the Zod-derived output shape.
- **`IOrderGuards`** — synchronous or async boolean guard methods.

The banner marks the file as auto-generated. It imports `ActionInput` from `@eklabdev/dfsm` and uses your context type name **`OrderContext`** (PascalCase of `id` + `Context`). Export that type from your machine module (or a shared types module) so the generated signatures type-check.

Re-run compile whenever the machine config changes.

## Implementation class

```typescript
import type { ActionInput } from '@eklabdev/dfsm'
import type { IOrderActions } from '../generated/IOrderActions.js'
import type { OrderContext } from '../machines/order.machine.js'

type Input = ActionInput<OrderContext>

export class OrderActions implements IOrderActions {
  async chargePayment(input: Input & { amount: number; customerId: string }) {
    return { chargeId: 'ch_…' }
  }
  // …other slots
}
```

Register methods on a `Map<string, Function>` keyed by slot `name` when constructing `WorkflowEngine` (see `examples/order-fulfilment/run.ts`).

## `ActionInput` shape

```typescript
export interface ActionInput<TContext> {
  workflowId: string
  context: TContext
  history: Readonly<HistoryEntry<TContext>[]>
  event: { type: string; payload: unknown }
}
```

- **`workflowId`** — durable id for this workflow instance.
- **`context`** — current workflow context (mutate only if you intend to; prefer returning partial updates from the handler so the outbox merge stays clear).
- **`history`** — append-only transition log before this action runs; **read-only** typing.
- **`event`** — the transition that triggered this step (`type` + `payload`).

Guards receive the same `ActionInput` shape (plus Zod-derived fields from the guard slot).

## Reading history

Use `input.history` for audit or to recover values from prior transitions without overloading context:

```typescript
const lastSubmit = [...input.history].reverse().find((h) => h.event === 'SUBMIT')
```

Each `HistoryEntry` includes `fromState`, `toState`, `event`, `eventPayload`, `contextSnapshot`, `actionsDispatched`, and `transitionedAt`.

## Returning context updates

Handlers return **`Partial<TContext>`** matching the slot’s Zod `output`. The store applies updates with **top-level shallow `$set`**: each returned key replaces that key on `context`. Nested objects are replaced as a whole for that key — they are **not** deep-merged.

Return only fields that change.

## `createSaga` for multi-step actions

Import `createSaga` from `@eklabdev/dfsm`. Use it **inside** a single action method to sequence external calls with reverse compensations on failure (see [saga-helper.md](./saga-helper.md)). The engine does not treat sagas specially; it still sees one action and one outbox item.

```typescript
import { createSaga } from '@eklabdev/dfsm'

await createSaga([
  { execute: async () => { /* charge */ }, compensate: async () => { /* refund */ } },
  { execute: async () => { /* reserve */ }, compensate: async () => { /* release */ } },
])
```

## Idempotency

The engine builds **`idempotencyKey`** when enqueueing outbox work:

```text
${workflowId}:${currentState}:${actionName}:${workflowVersion}
```

Your handler should be **safe to retry** with the same key: external side effects should use provider idempotency tokens derived from stable input, or check-before-act patterns. You do not construct `idempotencyKey` yourself.

If the action throws after partial side effects, the outbox item can end in **`failed`** and the transition may not complete — design compensations or sagas accordingly.

## Related

- [Saga helper](./saga-helper.md)
- [Defining machines](./defining-machines.md)
