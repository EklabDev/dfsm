# dfsm

Monorepo for durable finite state machines with provider-agnostic persistence and queue-driven execution.

## Packages

| Package | Description |
|---------|-------------|
| [`@eklabdev/dfsm`](packages/core) | Core runtime — machines, stores, queues, workflows |
| [`@eklabdev/dfsm-viz`](packages/viz) | Optional visualization server |

## Getting started

Install and use `@eklabdev/dfsm` in your project:

```bash
pnpm add @eklabdev/dfsm
```

See **[packages/core/README.md](packages/core/README.md)** for install requirements, quick start, store/queue providers, and the full runtime API.

## Examples

- [traffic-light](examples/traffic-light) — minimal machine and runtime setup
- [order-fulfilment](examples/order-fulfilment) — Zod contracts and durable actions

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Requires Node.js 20+ and pnpm 9 (see `packageManager` in `package.json`).
