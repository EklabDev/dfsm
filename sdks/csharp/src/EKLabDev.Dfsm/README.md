# DFSM Core — C# .NET SDK (`EKLabDev.Dfsm`)

**XState-Aligned Durable Finite State Machine & Distributed Saga Orchestration Engine for .NET 9+**

[![Spec](https://img.shields.io/badge/DFSM_Spec-v1.0-blue)](../../spec/SPECIFICATION.md)
[![.NET](https://img.shields.io/badge/.NET-9.0%2B-purple)](#1-installation-nuget)
[![NuGet](https://img.shields.io/badge/NuGet-EKLabDev.Dfsm-blue)](https://www.nuget.org/packages/EKLabDev.Dfsm/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](../../LICENSE)

`EKLabDev.Dfsm` is the official .NET SDK for **DFSM (`eklabdev/dfsm`)**. It executes canonical `dfsm: "1.0"` YAML workflows and fluent `MachineBuilder<TContext>` definitions with full XState statechart semantics, GoF decorator resilience pipelines, **System.ComponentModel.DataAnnotations** validation, LIFO Saga compensation, conditional `@DfsmEffect` routing, 6 lifecycle hooks (`@DfsmHook`), and pluggable durable persistence (**SQLite** zero-config in-memory default, **PostgreSQL** via Npgsql, and **MongoDB** via official MongoDB.Driver).

---

## Table of Contents

1. [Installation (NuGet)](#1-installation-nuget)
2. [Key Features](#2-key-features)
3. [Quickstart: YAML + Annotations + DataAnnotations Validation](#3-quickstart-yaml--annotations--dataannotations-validation)
4. [Programmatic `MachineBuilder` & Fluent DSL](#4-programmatic-machinebuilder--fluent-dsl)
5. [Execution Lifecycle: Decorators, Hooks, Saga & Conditional Effects](#5-execution-lifecycle-decorators-hooks-saga--conditional-effects)
6. [Durable State Stores (SQLite, PostgreSQL, MongoDB)](#6-durable-state-stores-sqlite-postgresql-mongodb)
7. [Operations, Active vs. Terminal Queries & Clean-Up](#7-operations-active-vs-terminal-queries--clean-up)
8. [Progressive Examples (`01` to `06`)](#8-progressive-examples-01-to-06)
9. [Running Tests & Conformance Suite](#9-running-tests--conformance-suite)
10. [Publishing Guide: NuGet Gallery](#10-publishing-guide-nuget-gallery)

---

## 1. Installation (NuGet)

### .NET CLI

```bash
dotnet add package EKLabDev.Dfsm
```

### Package Manager Console

```powershell
Install-Package EKLabDev.Dfsm
```

### PackageReference (`.csproj`)

```xml
<PackageReference Include="EKLabDev.Dfsm" Version="1.0.0" />
```

> **Requirements:** .NET **9.0** or newer.

---

## 2. Key Features

- **Dual Authoring Modes**: Load cross-language `dfsm: "1.0"` YAML validated against the bundled Draft 2020-12 JSON Schema (`schemas/dfsm-v1.schema.json`), or build machines in pure C# with `MachineBuilder<TContext>`.
- **Full XState Statechart Semantics**: Atomic, compound (nested hierarchy with parent event bubbling), orthogonal `parallel` regions, `final` states, automatic `onDone` cascades, Lowest Common Ancestor (LCA) `exit` -> `entry` ordering, and implicit `final` `error` state injection (overridable with custom recovery transitions).
- **Annotations & Resilience Pipeline**:
  - Method attributes: `[DfsmTransition]`, `[DfsmCompensate]`, `[DfsmEffect]`, `[DfsmHook]`, `[Retry]`, `[Backoff]`, `[CircuitBreaker]`, `[OnFail]`, `[CompensateWith]`, `[Benchmark]`.
  - **Policy Normalization Deduplicator (`Code Attribute > Transition YAML > Defaults YAML > Global Default`)**: Prevents nested retry multiplication (`[Retry(4)]` overriding YAML `retry: 3` runs **4** attempts total, never `4 * 3 = 12`, while inheriting YAML's `circuitBreaker`).
- **Pre-Flight DataAnnotations Validation**: Automatic `[Required]`, `[Range]`, `[EmailAddress]`, `[MinLength]` validation on generic `TContext` and `TInput` models *before* retries, circuit breakers, or Saga compensation execute.
- **Distributed LIFO Saga Rollback**: Every committed step with a `compensate` handler pushes a durable snapshot (`fromState`, `inputSnapshot`, `contextBefore`) onto the transaction's Saga stack and unwinds in strict LIFO order upon `[OnFail(compensate: true)]`.
- **Conditional `[DfsmEffect]` Routing & Chaining**: Effects receive `EffectRequest<TContext>` with `req.RunEffectAsync(...)` and `req.Actor.TransitionAsync(...)` to act as `if / else` routers and drive automatic multi-step workflows (guarded by `MaxEffectChainDepth`, default `25`).
- **6 Transaction Lifecycle Hooks (`[DfsmHook]`)**: `OnStart`, `BeforeTransition`, `AfterTransition`, `OnCompensate`, `OnComplete`, `OnTerminal` — declarable in YAML (`hooks:`) and bound at machine creation via `FSMRegistry`.
- **Pluggable Durable Stores**: Zero-config `SqliteStateStore` (default), `PostgresStateStore` (JSONB + transactional Saga table), and `MongoStateStore` (atomic document optimistic concurrency + embedded Saga stack).

---

## 3. Quickstart: YAML + Annotations + DataAnnotations Validation

```csharp
using System.ComponentModel.DataAnnotations;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Attributes;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Runtime;

public record OrderContext(string Email, decimal Total, bool Paid);

public record SubmitInput(
    [Required, EmailAddress] string Email,
    [Range(1, 10000)] decimal Total
);

public class CheckoutService
{
    [DfsmTransition("submitOrder")]
    [CompensateWith("cancelOrder")]
    public TransitionOutput<OrderContext, object> SubmitOrder(TransitionRequest<OrderContext, SubmitInput> req)
    {
        return TransitionOutput<OrderContext, object>.OfContext(
            new OrderContext(req.Input.Email, req.Input.Total, false)
        );
    }

    [DfsmCompensate("cancelOrder")]
    public void CancelOrder(CompensationRequest<OrderContext> req)
    {
        Console.WriteLine($"Rolled back order for tx: {req.TransactionId}");
    }

    [DfsmTransition("chargeCard")]
    [Retry(3)]
    [OnFail(compensate: true, target: "error")]
    public TransitionOutput<OrderContext, string> ChargeCard(TransitionRequest<OrderContext, object> req)
    {
        var c = req.Data!;
        return TransitionOutput<OrderContext, string>.Of(new OrderContext(c.Email, c.Total, true), "RECEIPT-1001");
    }
}

// Runtime Setup
string yaml = File.ReadAllText("checkout.dfsm.yaml");
var machine = YamlMachineParser.Parse(yaml);

var registry = new FSMRegistry();
registry.RegisterMachine(machine);
registry.RegisterAnnotatedHandlers(new CheckoutService());

var actor = registry.CreateActor<OrderContext>("checkout-machine");
var res = await actor.TransitionAsync("order-001", "SUBMIT_ORDER", new SubmitInput("alice@example.com", 99.50m));
```

---

## 4. Programmatic `MachineBuilder` & Fluent DSL

```csharp
var machine = MachineBuilder<OrderContext>.Create("checkout-machine")
    .Initial("created")
    .State("created", s => s
        .On("SUBMIT", "paying", policyConfig: p => p.Retry(3, backoffMs: 100))
    )
    .State("paying", s => s
        .On("PAY_SUCCESS", "completed")
        .On("PAY_FAIL", "error")
    )
    .State("completed", s => s.Type("final"))
    .Build();
```

---

## 5. Execution Lifecycle: Decorators, Hooks, Saga & Conditional Effects

```
Trigger Event -> Pre-Flight DataAnnotations Validation
  |
  +--> [DFSM-HOOK] BeforeTransition
  |
  +--> CircuitBreaker Check
  |
  +--> Retry Loop (Attempt 1..N with Backoff + Jitter)
  |      \--> Execute Method Handler
  |
  +--> [Success] -> Push Step to Saga Stack (if CompensateWith defined)
  |               -> Statechart Transition (LCA Exit -> Entry Effects)
  |               -> Check automatic onDone Cascades
  |               -> [DFSM-HOOK] AfterTransition
  |               -> Conditional [DfsmEffect] Chained Auto-Transitions
  |
  +--> [Failure] -> [DFSM-HOOK] OnCompensate (LIFO Reverse Unwind)
                  -> Transition to onFail.target / 'error'
                  -> [DFSM-HOOK] OnTerminal
```

---

## 6. Durable State Stores (SQLite, PostgreSQL, MongoDB)

### 1. SQLite In-Memory / File (Default)
```csharp
var store = new SqliteStateStore("Data Source=dfsm_memory;Mode=Memory;Cache=Shared");
```

### 2. PostgreSQL (Npgsql)
```csharp
var store = new PostgresStateStore("Host=localhost;Port=55432;Database=dfsm_test;Username=dfsm;Password=dfsm_password");
```

### 3. MongoDB (Official MongoDB.Driver)
```csharp
var store = new MongoStateStore("mongodb://localhost:27018", "dfsm_test");
```

---

## 7. Operations, Active vs. Terminal Queries & Clean-Up

```csharp
// 1. In-Flight Summary & Non-Terminal Count
var summary = await actor.GetInFlightSummaryAsync();
Console.WriteLine($"Total In-Flight: {summary.TotalInFlight}, Non-Terminal: {summary.NonTerminalCount}");

// 2. Terminal States List
var terminals = actor.GetTerminalStates();

// 3. Status Breakdown
var breakdown = await actor.GetStatusBreakdownAsync();

// 4. Safe Dry-Run Administrative Clean-Up
var dryRun = await actor.ForceCleanUpAsync(new ForceCleanUpOptions(
    Action: ForceCleanUpAction.COMPENSATE,
    DryRun: true
));
```

---

## 8. Progressive Examples (`01` to `06`)

All runnable examples live under [`examples/`](examples/):

| # | Directory | What It Demonstrates | Run Command |
|---|-----------|----------------------|-------------|
| **01** | [`examples/01-simple-traffic-light`](examples/01-simple-traffic-light) | Fluent `MachineBuilder`, typed outputs, `entry`/`exit` actions | `cd examples/01-simple-traffic-light && dotnet run` |
| **02** | [`examples/02-yaml-validation`](examples/02-yaml-validation) | `dfsm: "1.0"` YAML + DataAnnotations pre-flight rejection | `cd examples/02-yaml-validation && dotnet run` |
| **03** | [`examples/03-hierarchical-parallel`](examples/03-hierarchical-parallel) | Compound event bubbling + parallel orthogonal regions + automatic `onDone` | `cd examples/03-hierarchical-parallel && dotnet run` |
| **04** | [`examples/04-policy-saga-recovery`](examples/04-policy-saga-recovery) | `[Retry(4)]` overriding YAML `retry: 2` (single loop!) + LIFO Saga rollback | `cd examples/04-policy-saga-recovery && dotnet run` |
| **05** | [`examples/05-multi-actor-ops`](examples/05-multi-actor-ops) | YAML `hooks:`/`effects:`, conditional `[DfsmEffect]` router, active/terminal queries, `forceCleanUp` dry-run | `cd examples/05-multi-actor-ops && dotnet run` |
| **06** | [`examples/06-aspnet-api-server`](examples/06-aspnet-api-server) | **Full ASP.NET Core REST API Server**: E2E fulfillment, YAML in response, structured logs, and Postman v2.1 collection | `cd examples/06-aspnet-api-server && dotnet run` |

---

## 9. Running Tests & Conformance Suite

```bash
# Run all unit, conformance, and store integration tests across the solution
cd sdks/csharp
dotnet test EKLabDev.Dfsm.sln
```

---

## 10. Publishing Guide: NuGet Gallery

### Step 1: Pack the Release Artifacts

```bash
cd sdks/csharp/src/EKLabDev.Dfsm
dotnet pack -c Release -o ./nupkg
```

### Step 2: Push to NuGet.org

```bash
export NUGET_API_KEY="your-nuget-api-key"

dotnet nuget push ./nupkg/EKLabDev.Dfsm.1.0.0.nupkg \
  --api-key $NUGET_API_KEY \
  --source https://api.nuget.org/v3/index.json
```
