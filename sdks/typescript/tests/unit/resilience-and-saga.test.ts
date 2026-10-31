import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  computeBackoffDelayMs,
  createMachine,
  FSMRegistry,
  InMemoryBenchmarkLogger,
  ValidationError,
} from "../../src/index.js";

describe("Resilience Policies, Validation Semantics & Saga Compensation", () => {
  it("computes fixed, linear, exponential, and exponential_jitter backoff accurately", () => {
    expect(
      computeBackoffDelayMs(3, {
        strategy: "fixed",
        initialDelayMs: 100,
        maxDelayMs: 5000,
        multiplier: 2,
      })
    ).toBe(100);

    expect(
      computeBackoffDelayMs(3, {
        strategy: "linear",
        initialDelayMs: 100,
        maxDelayMs: 5000,
        multiplier: 2,
      })
    ).toBe(300);

    expect(
      computeBackoffDelayMs(4, {
        strategy: "exponential",
        initialDelayMs: 100,
        maxDelayMs: 500,
        multiplier: 2,
      })
    ).toBe(500); // capped at maxDelayMs

    const jitter = computeBackoffDelayMs(
      2,
      {
        strategy: "exponential_jitter",
        initialDelayMs: 100,
        maxDelayMs: 1000,
        multiplier: 2,
      },
      () => 0.5
    );
    expect(jitter).toBe(150); // ceiling=200 * (0.5 + 0.5*0.5) = 150
  });

  it("transitions Circuit Breaker through CLOSED -> OPEN -> HALF_OPEN -> CLOSED", async () => {
    let now = 10_000;
    let shouldFail = true;
    let handlerCalls = 0;

    const logger = new InMemoryBenchmarkLogger();
    const registry = new FSMRegistry({
      logEngine: logger,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });

    registry.registerTransition("callDownstream", () => {
      handlerCalls++;
      if (shouldFail) throw new Error("Downstream 500");
      return { value: "OK" };
    });

    const machine = createMachine("cb-machine")
      .initial("idle")
      .state("idle", (s) =>
        s.on("PING", {
          target: "done",
          transition: "callDownstream",
          circuitBreaker: {
            enabled: true,
            key: "downstream-cb",
            failureThreshold: 2,
            slidingWindowSize: 4,
            openDurationMs: 5000,
            halfOpenMaxCalls: 1,
          },
          onFail: { compensate: false, target: "idle" },
        })
      )
      .finalState("done");

    const actor = await registry.createActor(machine);
    const txId = await actor.startTransaction({});

    // 2 failures trip circuit to OPEN
    await actor.transition(txId, "PING");
    await actor.transition(txId, "PING");
    expect(handlerCalls).toBe(2);
    expect(actor.getEffectiveConfig().transitions[0]?.circuitBreakerState).toBe("OPEN");

    // 3rd call while OPEN fast-fails WITHOUT calling handlerCalls!
    const fastFail = await actor.transition(txId, "PING");
    expect(handlerCalls).toBe(2);
    expect(fastFail.error).toContain("Circuit breaker 'downstream-cb' is OPEN");

    // Advance clock past openDurationMs (5000ms) -> enters HALF_OPEN; downstream recovers -> CLOSED!
    now += 6000;
    shouldFail = false;
    expect(actor.getEffectiveConfig().transitions[0]?.circuitBreakerState).toBe("HALF_OPEN");

    const recovered = await actor.transition<unknown, string>(txId, "PING");
    expect(recovered.value).toBe("OK");
    expect(recovered.currentState).toBe("done");
    expect(actor.getEffectiveConfig().transitions[0]?.circuitBreakerState).toBe("CLOSED");
    expect(logger.entries.length).toBe(4);

    await registry.shutdown();
  });

  it("does NOT retry, trip circuit breaker, or compensate when pre-transition TInput validation fails", async () => {
    let calls = 0;
    let compensated = false;

    const InputSchema = z.object({ amount: z.number().positive() });
    const ContextSchema = z.object({ balance: z.number().nonnegative() });

    const registry = new FSMRegistry();
    registry.registerTransition("deposit", ({ input, context }) => ({
      context: { balance: context.data.balance + input.amount },
    }));
    registry.registerCompensate("undoDeposit", () => {
      compensated = true;
    });
    registry.registerTransition("withdraw", ({ input, context }) => {
      calls++;
      return { context: { balance: context.data.balance - input.amount } };
    });

    const machine = createMachine<{ balance: number }>("wallet")
      .initial("funded")
      .state("funded", (s) =>
        s
          .on("DEPOSIT", {
            target: "ready",
            transition: "deposit",
            compensate: "undoDeposit",
          })
      )
      .state("ready", (s) =>
        s.on("WITHDRAW", {
          target: "closed",
          transition: "withdraw",
          retry: { maxAttempts: 4 },
          circuitBreaker: { enabled: true, failureThreshold: 1, key: "withdraw-cb" },
          onFail: { compensate: true, target: "error" },
        })
      )
      .finalState("closed");

    const actor = await registry.createActor<{ balance: number }>(machine, {
      contextValidator: ContextSchema,
      inputValidators: { WITHDRAW: InputSchema },
    });

    const txId = await actor.startTransaction({ balance: 100 });
    await actor.transition(txId, "DEPOSIT", { amount: 50 });

    // Caller passes negative amount -> immediate ValidationError!
    await expect(actor.transition(txId, "WITHDRAW", { amount: -10 })).rejects.toThrow(
      ValidationError
    );
    expect(calls).toBe(0);
    expect(compensated).toBe(false);
    expect(actor.getEffectiveConfig().transitions.find((t) => t.event === "WITHDRAW")?.circuitBreakerState).toBe("CLOSED");

    // Now pass valid input (amount: 200) which causes post-transition ContextSchema (nonnegative) to fail!
    // Post-transition context validation failure triggers Saga rollback!
    const failOutcome = await actor.transition(txId, "WITHDRAW", { amount: 200 });
    expect(compensated).toBe(true);
    expect(failOutcome.status).toBe("COMPENSATED");
    expect(failOutcome.currentState).toBe("error");

    await registry.shutdown();
  });
});

