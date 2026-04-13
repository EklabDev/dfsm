# Saga helper (`createSaga`)

`createSaga` is an **optional in-process helper** for ordering async steps and running **compensations in reverse** when a step fails. It is **not** part of the persistence protocol; call it from inside an action implementation.

## What it does

- Runs `steps[i].execute()` **sequentially** from `i = 0` upward.
- On first `execute` failure at index `k`, runs `compensate()` for indices `k-1 … 0` **in that order**, then **rethrows** the original error.
- On full success, returns an array of each step’s execute result in order.

```typescript
import { createSaga, type SagaStep } from '@eklabdev/dfsm'

const steps: SagaStep<string>[] = [
  { execute: async () => 'a', compensate: async () => {} },
  { execute: async () => 'b', compensate: async () => {} },
]
const results = await createSaga(steps) // ['a', 'b']
```

## What it does **not** do

- **Not a distributed transaction** — each `execute`/`compensate` is a normal async call; failures leave the world partially updated unless you design compensations carefully.
- **Best-effort compensation** — there is no cross-service atomicity guarantee.
- **Not wired into MongoDB** — the workflow engine does not interpret saga steps; one failed `execute` still fails the **whole action** and outbox handling as usual.

## When to use it

Use when **one named action** should orchestrate multiple external effects that must be undone if a later step fails, for example **charge payment** then **reserve inventory** in a single slot.

## Example: Stripe charge + inventory

```typescript
import { createSaga } from '@eklabdev/dfsm'

async chargeAndReserve(/* input */) {
  let chargeId: string | undefined
  let reservationId: string | undefined

  await createSaga([
    {
      execute: async () => {
        const ch = await stripe.charges.create({ amount, currency: 'usd', customer })
        chargeId = ch.id
        return ch.id
      },
      compensate: async () => {
        if (chargeId) await stripe.refunds.create({ charge: chargeId })
      },
    },
    {
      execute: async () => {
        const rsv = await inventory.reserve(sku, qty)
        reservationId = rsv.id
        return rsv.id
      },
      compensate: async () => {
        if (reservationId) await inventory.release(reservationId)
      },
    },
  ])

  return { chargeId: chargeId!, reservationId: reservationId! }
}
```

Keep compensations **idempotent** where possible (release/refund may already have happened).

## If compensation fails

If a `compensate` throws, that error **propagates** (the implementation does not swallow the original failure). In tests, a compensation error surfaces as the compensation’s message — callers see whichever throw occurs last during the unwind.

From a workflow perspective the **action still failed**: the outbox item can be marked **`failed`**, the transition may not commit context advances, and you should alert/monitor on stuck partial state (e.g. charged but not reserved).

## Related

- [Implementing actions](./implementing-actions.md)
- [Migration](./migration.md) — contract changes and type gates
