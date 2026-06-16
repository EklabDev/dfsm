# Order fulfilment example

End-to-end order workflow with durable actions, guards, and Zod contracts. Uses a local SQLite file (`order-fulfilment.db`) and an in-memory queue — no Docker or external services required.

## Run

From the repo root:

```bash
pnpm install
pnpm build
pnpm --filter order-fulfilment-example example
```

Or from this directory:

```bash
pnpm example
```

To start with a clean database, delete `order-fulfilment.db` first.

## Expected output

```
[pending] Starting order ORD-001...
  Processing payment, history has 1 prior transitions
[payment_processing] After SUBMIT
[fulfilling] After PAYMENT_CAPTURED
  Shipping notification sent: TRK123
[shipped] After SHIPPED
[delivered] After DELIVERED

Context: { orderId: 'ORD-001', chargeId: '...', reservationId: '...', trackingNumber: 'TRK123', ... }
History: 4 transitions
```

## View the statechart

Add `startVizServer()` to `run.ts` (see `packages/core/README.md`) or use `@eklabdev/dfsm-viz` to inspect the machine interactively.
