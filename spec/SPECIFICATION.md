# DFSM v1.0 Canonical Specification

This document defines the language-agnostic behavioral contract for **DFSM (`eklabdev/dfsm`)** across all five official SDKs (**TypeScript**, **Java**, **C#**, **Go**, and **Rust**) and the **VS Code Extension (`eklabdev.vscode-dfsm`)**.

---

## 1. Design Principles

1. **XState-Aligned Statechart Topology**: Supports `atomic` (standalone), `compound` (hierarchical parent/child), `parallel` (orthogonal concurrent regions), and `final` states, plus an implicit overridable top-level `error` state.
2. **Code-First Generics & Validation**: YAML defines topology, handler references, and resilience policies; host code defines strongly typed `<TContext, TInput, TOutput>` generics and runtime validators (e.g., Zod, Jakarta Validation, DataAnnotations/FluentValidation, Go `validator`, Rust `validator`).
3. **Normalized Decorator & YAML Policy Deduplication**: Policies declared via user code decorators and YAML normalize into a single deduplicated internal representation (`NormalizedTransitionPolicy`) before constructing the decorator chain.
4. **Durable Multi-Actor Saga Execution**: Multiple `DfsmActor<TContext>` instances coexist with isolated machines, persisting state, typed context, optimistic concurrency versions, and a LIFO compensation stack in embedded SQL stores by default (SQLite `:memory:` / H2) or PostgreSQL / MongoDB.

---

## 2. Statechart Semantics

### 2.1 State Node Types & Inference
- **`atomic`**: Leaf state with no `states` children. Inferred when `type` and `states` are both omitted.
- **`compound`**: Parent state with `states` children and a mandatory `initial` child key. Inferred when `states` is present and `type` is omitted.
- **`parallel`**: Orthogonal state with `states` child regions and **no** `initial` key. Entering a `parallel` state enters **all** child regions simultaneously.
- **`final`**: Terminal leaf state. Cannot define `states` or `initial`.
- **Implicit Default `error` State**: If `states.error` is not explicitly declared in YAML or `MachineBuilder`, the compiler automatically injects:
  ```yaml
  error:
    type: final
  ```
  Users may explicitly define `states.error` (e.g., as `atomic` with recovery transitions like `RESET` or `entry` alert effects) to override the default.

### 2.2 State Value Representation
- Active leaf at root: `"validating"` (string).
- Active leaf inside compound parent `payment`: `{ "payment": "charging" }`.
- Active `parallel` state `processing` with regions `payment` and `inventory`:
  ```json
  {
    "processing": {
      "payment": "charging",
      "inventory": "reserving"
    }
  }
  ```

### 2.3 Target Resolution Rules
Transition `target` references resolve as follows:
1. **ID / Root Path (`#<machineId>.<dot.path>` or `#<dot.path>`)**: Resolves directly from the root machine (e.g., `#order-checkout.payment_review` or `#error`).
2. **Relative Dot Path (`parent.child`)**: Resolves relative to the source state's parent container, falling back to root `states` if not found in the immediate parent.
3. **Sibling Key (`charged`)**: Resolves to the sibling state inside the same parent `states` map; if not found in the parent, resolves against root `states` (allowing `target: error` from any nested depth).

### 2.4 Event Dispatch, Bubbling & Entry/Exit Ordering
1. **Deepest-First Bubbling**: When an event arrives, DFSM evaluates active leaf state(s) first. If an active child does not handle the event, lookup bubbles up through its `compound` ancestors toward the root.
2. **Parallel Broadcast**: Inside an active `parallel` state, if multiple orthogonal regions match the event, region transitions execute deterministically in declaration order, threading updated `TContext`. If unhandled by children, lookup bubbles to the `parallel` node itself.
3. **LCA Exit/Entry Ordering**: Transitioning from source `S` to target `T` computes their Lowest Common Ancestor (`LCA`):
   - `exit` effects run **bottom-up** from active leaves under `S` up to (excluding) `LCA`.
   - The transition handler runs.
   - `entry` effects run **top-down** from below `LCA` down to `T` and recursively into `T`'s initial children (or all regions if `T` is `parallel`).
4. **`onDone` Completion**:
   - In a `compound` state with `onDone`, entering a child with `type: final` immediately evaluates `onDone`.
   - In a `parallel` state with `onDone`, when **every** child region is in a `type: final` state, the `parallel` state's `onDone` transition fires automatically.

---

## 3. Policy Normalization & Decorator Precedence

Policies can be configured at four levels (highest to lowest priority):

1. **User Code Decorator** (`@DfsmTransition`, `@Retry`, `@Backoff`, `@CircuitBreaker`, `@OnFail`, `@CompensateWith`, `@Benchmark` / functional wrappers)
2. **Transition-Level YAML / Builder** (`states.<S>.on.<EVENT>.*`)
3. **Machine-Level Defaults** (`defaults.*`)
4. **SDK Built-in Defaults**:
   - `retry`: `{ maxAttempts: 1, backoff: { strategy: "exponential", initialDelayMs: 100, maxDelayMs: 5000, multiplier: 2.0 } }`
   - `circuitBreaker`: `{ enabled: false, failureThreshold: 5, slidingWindowSize: 10, openDurationMs: 30000, halfOpenMaxCalls: 1 }`
   - `onFail`: `{ compensate: false, target: "error" }`
   - `benchmark`: `{ enabled: true }`

### Explicit-Field Deep Merge & Single-Instance Materialization
- Each layer produces a partial policy with only explicitly provided fields set.
- Merging combines fields leaf-by-leaf from lowest to highest priority (`SDK Default <- Machine Defaults <- Transition YAML <- Code Decorator`).
- **Example**:
  - Code Decorator specifies `retry.maxAttempts = 4` and `onFail = { compensate: true, target: "review" }`.
  - Transition YAML specifies `retry = { maxAttempts: 3, backoff: { strategy: "linear", initialDelayMs: 250 } }` and `circuitBreaker = { enabled: true, failureThreshold: 5 }`.
  - **Normalized Effective Policy**:
    - `retry`: `{ maxAttempts: 4, backoff: { strategy: "linear", initialDelayMs: 250, maxDelayMs: 5000, multiplier: 2.0 } }`
    - `circuitBreaker`: `{ enabled: true, failureThreshold: 5, ... }`
    - `onFail`: `{ compensate: true, target: "review" }`
- Exactly **one** decorator wrapper per capability is instantiated in outer-to-inner order:
  `InputValidator -> BenchmarkDecorator -> FallbackCompensateDecorator -> CircuitBreakerDecorator -> RetryBackoffDecorator -> UserFunction -> ContextValidator`.

---

## 4. Validation, Saga Compensation & Crash Recovery

1. **Input vs. Runtime Validation**:
   - Pre-transition `TInput` validation failure throws `ValidationError` immediately **without** mutating state, **without** consuming retries or tripping the circuit breaker, and **without** triggering Saga compensation.
   - Runtime exceptions inside a transition function (after exhausting `retry.maxAttempts` or on `CircuitOpenError`) or post-transition `TContext` validation errors trigger `FallbackCompensateDecorator`.
2. **Saga Compensation Stack (LIFO)**:
   - Every succeeded transition that has an associated `compensate` handler pushes a durable `CompensationEntry` (`stepSeq`, `transitionKey`, `compensateKey`, `fromState`, `inputSnapshot`, `contextBefore`) to the transaction's stack.
   - When terminal failure occurs and `onFail.compensate === true`, status becomes `COMPENSATING`, entries execute in strict **LIFO** order (`stepSeq DESC`), marking each entry compensated durably, and the transaction moves to `onFail.target` (default `"error"`) with status `COMPENSATED` (or `FAILED` if `compensate === false`).
3. **Transaction Status Lifecycle**:
   - `IDLE` (active and waiting for next event)
   - `IN_FLIGHT` (currently executing a transition step under an actor lease)
   - `COMPLETED` (root state reached `type: final`, excluding `error`)
   - `COMPENSATING` (unwinding compensation stack)
   - `COMPENSATED` (rolled back via compensation stack)
   - `FAILED` (in `error` / failed terminal state without compensation or after failed compensation)
4. **Startup & Scheduled `OnRestartBehavior`**:
   - Transactions in `IN_FLIGHT` or `COMPENSATING` with `now - updatedAt > stuckThresholdMs` are handled according to configured policy (`STOP`, `MARK_FAIL`, `DELETE`, `COMPENSATE`, `CONTINUE`).

---

## 5. Effect Conditional Routing, Lifecycle Hooks & Non-Terminal Queries

1. **Conditional Routing & Automatic Transitions via `EffectRequest` (No YAML `always:`)**:
   - Every `EffectRequest<TContext>` (`entry`, `exit`, or post-step `effects`) provides:
     - `actor`: direct reference to the owning `DfsmActor<TContext>` so effects can inspect state or trigger follow-up transitions (`actor.transition(transactionId, "NEXT_EVENT", payload)`).
     - `runEffect(effectHandlerName, payload?)`: invokes another registered DFSM effect handler by name so an effect can act as a clean `if / else` router.
   - Sub-effects invoked conditionally via `runEffect(...)` (rather than directly in `entry`/`exit`) can be declared in the machine's top-level `effects: [...]` YAML array (`MachineBuilder.effects(...)`) so `strict: true` validates their registration right on machine/actor creation.
   - When an effect triggers nested `actor.transition(...)` calls, the outer `actor.transition(...)` refreshes from `StateStore` before returning so callers always observe the final settled `currentState`, `status`, and `context`.
   - Machines and actors guard against runaway recursive effect/transition loops via YAML/Builder `maxEffectChainDepth` (overridable per `ActorConfig`, default `25`), raising `DFSM_MAX_EFFECT_CHAIN_DEPTH`.
2. **YAML & Programmatic Transaction Lifecycle Hooks (`hooks:` / `@DfsmHook` / `ActorLifecycleHooks<TContext>`)**:
   - Definable directly in YAML under top-level `hooks:` (as a single handler name or `string[]` array), via `MachineBuilder.hooks(...)` / `.hook(...)`, globally on `FSMRegistry`, or per-Actor (`config.hooks` / `actor.addHooks`):
     - `onStart`: fired immediately after `startTransaction` commits initial state.
     - `beforeTransition`: fired after pre-step input validation passes and before executing the step.
     - `afterTransition`: fired immediately after a step's state & context commit to `StateStore`.
     - `onCompensate`: fired after each LIFO compensation step commits.
     - `onComplete`: fired when a transaction reaches `COMPLETED`.
     - `onTerminal`: fired whenever a transaction settles into any terminal status (`COMPLETED`, `COMPENSATED`, or `FAILED`).
   - Hook methods decorated with `@DfsmHook(...)` (or `decorateHook(...)`) are discovered automatically when registering services/bindings on machine creation (`registerYaml(yaml, { services, transitions, compensations, effects, hooks })` or `createActor(yamlOrId, { bindings })`) and strictly validated under `registry.strict: true`.
   - Hook execution order: `Global FSMRegistry Hooks -> Machine YAML/Builder Registered Hooks -> ActorConfig Inline Hooks -> Dynamic actor.addHooks()`.
3. **Non-Terminal ("Active") vs. Terminal Inspection**:
   - **Non-Terminal Statuses**: `["IDLE", "IN_FLIGHT", "COMPENSATING"]` (`getActiveCount`, `listActiveTransactions`, `getStatusBreakdown`).
   - **Terminal Statuses**: `["COMPLETED", "COMPENSATED", "FAILED"]`.
   - `getTerminalStates()` inspects the compiled `MachineDefinition` and returns all `type: "final"` states and the top-level `error` state (indicating whether `error` is implicit or overridden with recovery transitions).


