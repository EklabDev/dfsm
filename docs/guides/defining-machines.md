# Defining machines

Machine definitions are **data only**: Zod schemas and names for guards/actions — no functions in the config. The compiler turns this into a transition table, viz graph, and TypeScript contracts.

## `MachineConfig`

| Field | Meaning |
|--------|---------|
| `id` | Stable machine identifier (used in DB, CLI, codegen names). |
| `initial` | Exactly one state name that must exist in `states`. |
| `terminal` | States that end the workflow (each must exist in `states`). |
| `context` | Default context object; merged with `startWorkflow.initialContext`. |
| `states` | Map of state name → `StateConfig`. |

## `ActionSlot`

| Field | Meaning |
|--------|---------|
| `name` | String key matched at runtime to your action implementation. |
| `input` | Zod object: fields the action **reads** (from context / transition); drives handler parameter typing. |
| `output` | Zod object: **partial context** fields the action **returns** after success; merged into workflow context. |

Slots are **compile-time contracts** only; persistence stores names, not Zod instances.

## `GuardSlot`

| Field | Meaning |
|--------|---------|
| `name` | Matches your guard implementation. |
| `input` | Zod object describing inputs the guard reads (typed extension to `ActionInput`). |

## `after` (TTL)

`after` maps **milliseconds → target state name**:

```typescript
after: { 300000: 'cancelled' }
```

The compiler emits a **synthetic event** `__AFTER_<ttlMs>` (here `__AFTER_300000`). The timeout supervisor sends that event when the TTL elapses, so your transition table treats delayed transitions like any other event (no separate handler name in config).

## `StateConfig`

| Field | Meaning |
|--------|---------|
| `on` | Map **event name → transition** (`target`, optional `guard`, optional ordered `actions`). |
| `after` | Optional delayed transitions (synthetic `__AFTER_*` events). |
| `entry` | Actions run when **entering** this state (ordered). |
| `exit` | Actions run when **leaving** this state (ordered). |

## Order machine (annotated)

Below mirrors `examples/order-fulfilment/machines/order.machine.ts` with inline notes.

```typescript
import { z } from 'zod'
import { defineMachine } from '@eklabdev/dfsm'

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
  id: 'order', // DB + codegen id
  initial: 'pending',
  terminal: ['delivered', 'cancelled', 'refunded'],
  context: { orderId: '', customerId: '', amount: 0, sku: '' },

  states: {
    // Cart / intake: external events only (no TTL here)
    pending: {
      on: {
        SUBMIT: {
          target: 'payment_processing',
          guard: { name: 'hasStock', input: z.object({ sku: z.string() }) },
          actions: [
            {
              name: 'chargePayment',
              input: z.object({ amount: z.number(), customerId: z.string() }),
              output: z.object({ chargeId: z.string() }),
            },
          ],
        },
        CANCEL: {
          target: 'cancelled',
          actions: [
            {
              name: 'recordCancellation',
              input: z.object({ orderId: z.string() }),
              output: z.object({ cancelReason: z.string() }),
            },
          ],
        },
      },
    },

    // Await capture or timeout → synthetic __AFTER_300000
    payment_processing: {
      after: { 300000: 'cancelled' },
      on: {
        PAYMENT_CAPTURED: {
          target: 'fulfilling',
          actions: [
            {
              name: 'reserveStock',
              input: z.object({ sku: z.string() }),
              output: z.object({ reservationId: z.string() }),
            },
          ],
        },
        PAYMENT_FAILED: { target: 'cancelled', actions: [] },
      },
    },

    fulfilling: {
      after: { 86400000: 'cancelled' },
      on: {
        SHIPPED: {
          target: 'shipped',
          actions: [
            {
              name: 'sendShippingNotification',
              input: z.object({ customerId: z.string(), orderId: z.string() }),
              output: z.object({ trackingNumber: z.string() }),
            },
          ],
        },
        CANCEL: { target: 'cancelled', actions: [] },
      },
    },

    shipped: {
      after: { 604800000: 'delivered' },
      on: {
        DELIVERED: { target: 'delivered', actions: [] },
        RETURN_REQUESTED: {
          target: 'refunded',
          actions: [
            {
              name: 'processRefund',
              input: z.object({ chargeId: z.string() }),
              output: z.object({ refundId: z.string() }),
            },
          ],
        },
      },
    },

    delivered: {},
    cancelled: {},
    refunded: {},
  },
})
```

`defineMachine` validates `initial`, all `terminal` names, and every transition `target` (including `after` targets) before registering the config.

## Related

- [Implementing actions](./implementing-actions.md)
- [Migration](./migration.md) — changing this file requires recompile + migrate
