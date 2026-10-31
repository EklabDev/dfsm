import { describe, expect, it } from "vitest";
import {
  Backoff,
  CircuitBreaker,
  decorateTransition,
  DfsmTransition,
  FSMRegistry,
  OnFail,
  Retry,
  UnregisteredHandlerError,
  withOnFail,
  withRetry,
} from "../../src/index.js";

describe("Decorators, Strict Handler Resolution & Policy Deduplication/Merger", () => {
  it("fails fast with UnregisteredHandlerError when YAML references missing handlers in FSMRegistry", async () => {
    const registry = new FSMRegistry();
    registry.registerYaml(`
dfsm: "1.0"
id: missing-fn-machine
initial: start
registry:
  namespace: "orders"
  strict: true
states:
  start:
    on:
      GO:
        target: end
        transition: missingTransitionFn
        compensate: missingCompensateFn
  end:
    type: final
`);

    await expect(registry.createActor("missing-fn-machine")).rejects.toThrow(
      UnregisteredHandlerError
    );
    await registry.shutdown();
  });

  it("normalizes and deduplicates Decorator + YAML policies with Decorator precedence and zero duplicate loops", async () => {
    // Exact scenario requested:
    // Function Decorator: retry = 4, onFail = { compensate: true, target: 'fallback_state' }
    // YAML Transition:    retry = 3 (with linear backoff 200ms), circuitBreaker = { enabled: true, failureThreshold: 5 }
    // Expected Merged:    retry = 4 (with linear backoff 200ms), onFail from Decorator, circuitBreaker from YAML!
    // Actual invocations on failure MUST be 4 (NOT 3 * 4 = 12)!
    let invocationCount = 0;

    class PaymentHandlers {
      @DfsmTransition("processPayment")
      @Retry(4)
      @OnFail({ compensate: true, target: "fallback_state" })
      processPayment() {
        invocationCount++;
        throw new Error("Transient upstream timeout");
      }
    }

    const registry = new FSMRegistry({
      clock: { now: () => 1000, sleep: async () => {} },
    });
    registry.registerService(new PaymentHandlers(), "pay");

    registry.registerYaml(`
dfsm: "1.0"
id: merge-verification
initial: charging
registry:
  namespace: "pay"
states:
  charging:
    on:
      CHARGE:
        target: paid
        transition: processPayment
        retry:
          maxAttempts: 3
          backoff:
            strategy: linear
            initialDelayMs: 200
        circuitBreaker:
          enabled: true
          failureThreshold: 5
  fallback_state:
    type: atomic
  paid:
    type: final
`);

    const actor = await registry.createActor("merge-verification");
    const effective = actor.getEffectiveConfig().transitions.find((t) => t.event === "CHARGE")!;

    expect(effective.policy.retry.maxAttempts).toBe(4);
    expect(effective.policy.retry.backoff.strategy).toBe("linear");
    expect(effective.policy.retry.backoff.initialDelayMs).toBe(200);
    expect(effective.policy.circuitBreaker.enabled).toBe(true);
    expect(effective.policy.circuitBreaker.failureThreshold).toBe(5);
    expect(effective.policy.onFail).toEqual({
      compensate: true,
      target: "fallback_state",
    });

    const txId = await actor.startTransaction({});
    const res = await actor.transition(txId, "CHARGE");

    expect(invocationCount).toBe(4); // Strictly 4 attempts — never duplicated!
    expect(res.currentState).toBe("fallback_state");

    await registry.shutdown();
  });

  it("supports functional decorateTransition(fn, withRetry(...), withOnFail(...)) identically to class decorators", async () => {
    let calls = 0;
    const decoratedFn = decorateTransition(
      () => {
        calls++;
        if (calls < 3) throw new Error("flaky");
        return { value: "RECOVERED" };
      },
      withRetry({ maxAttempts: 3, backoff: { strategy: "fixed", initialDelayMs: 0 } }),
      withOnFail({ compensate: false, target: "error" })
    );

    class ExtraService {
      @DfsmTransition("noopExtra")
      @Backoff({ strategy: "exponential", initialDelayMs: 10 })
      @CircuitBreaker({ failureThreshold: 3 })
      noopExtra() {
        return {};
      }
    }

    const registry = new FSMRegistry();
    registry.registerTransition("flakyStep", decoratedFn);
    registry.registerService(new ExtraService());

    registry.registerYaml(`
dfsm: "1.0"
id: functional-dec
initial: s1
states:
  s1:
    on:
      RUN:
        target: s2
        transition: flakyStep
      EXTRA:
        target: s2
        transition: noopExtra
  s2:
    type: final
`);

    const actor = await registry.createActor("functional-dec");
    const txId = await actor.startTransaction({});
    const out = await actor.transition<unknown, string>(txId, "RUN");

    expect(calls).toBe(3);
    expect(out.value).toBe("RECOVERED");
    expect(out.currentState).toBe("s2");

    await registry.shutdown();
  });
});

