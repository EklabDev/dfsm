# Traffic light example

Minimal @eklabdev/dfsm setup — 3 states cycling with a single action.

## Run

```bash
# From repo root, with MongoDB running
pnpm install
tsx run.ts
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
