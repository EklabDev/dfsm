# Order fulfilment example

## Prerequisites

- Docker
- Node.js 20+
- pnpm

## Run it

```bash
docker-compose up -d
pnpm install
dfsm lint
dfsm compile
dfsm migrate up
pnpm run example
```

## Expected output

```
[pending] Starting order ORD-001...
[payment_processing] After SUBMIT
[fulfilling] After PAYMENT_CAPTURED
[shipped] After SHIPPED
[delivered] After DELIVERED

Context: { orderId: 'ORD-001', chargeId: '...', reservationId: '...', trackingNumber: 'TRK123' }
History: 4 transitions
```

## View the statechart

```bash
dfsm viz
```

Open http://localhost:4242
