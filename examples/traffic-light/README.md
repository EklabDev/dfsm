# Traffic light example

Minimal `@eklabdev/dfsm` setup — 3 states cycling with a single action. Uses in-memory SQLite and an in-memory queue (no external services).

## Run

From the repo root:

```bash
pnpm install
pnpm build
pnpm --filter traffic-light-example example
```

Or from this directory:

```bash
pnpm example
```

## Expected output

```
Changed to green
Changed to yellow
Changed to red
Changed to green
Changed to yellow
Changed to red
Final state: red
History: 6 transitions
```
