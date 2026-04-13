# ADR-006: Machine-declared Zod slots with generated TypeScript interfaces

## Status

Accepted

## Context

We need a **type-safe contract** between:

- The **declarative machine** (transitions, slot names, and the shapes guards/actions read/write), and  
- The **imperative implementations** (functions keyed by slot name).

Hand-maintained interfaces drift from configs. Stringly slot maps catch errors only at runtime. Embedding inline functions in the config would couple execution to a non-serialisable artefact and block persisting clean transition tables.

## Decision

The machine config declares **`ActionSlot`** and **`GuardSlot`** entries as **`name` + Zod `input` / `output` schemas only**—no function references in persisted or compiled-table form. **`dfsm compile`** uses **`zod-to-ts`** (via **`generateInterface`**) to emit **`I{Name}Actions`** and **`I{Name}Guards`** in **`generated/`**, including a **`DO NOT EDIT`** banner. Developers implement those interfaces in application modules. **`dfsm migrate up`** refuses to proceed unless **`tsc --noEmit`** passes, aligning code with the latest generated contracts.

## Consequences

- **Pros**: Generated method signatures stay **in sync** with Zod on every compile; duplicate hand-written types are unnecessary.
- **Pros**: Machine definitions remain **serialisable** for compilation into **`machine_registry`** (names and structural metadata, not live closures).
- **Cons**: Developers must rerun **`dfsm compile`** after slot changes and fix downstream TypeScript.
- **Cons**: Generated files should not be hand-edited; edits belong in machine configs or implementation files.

## Alternatives Considered

- **String slot names only** — Rejected: no compile-time linkage between config and handlers.
- **Inline functions on transition config** — Rejected: not serialisable; blurs config vs implementation; complicates persistence and codegen.
- **Hand-written parallel interfaces** — Rejected: guaranteed drift; duplicates Zod as a second source of truth.
