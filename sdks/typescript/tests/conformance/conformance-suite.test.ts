import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FSMRegistry } from "../../src/index.js";

const SPEC_CONFORMANCE_DIR = resolve(import.meta.dirname, "../../../../spec/conformance");

interface ConformanceScenario {
  id: string;
  file: string;
  machineId: string;
  description: string;
  expectedInitialState: unknown;
  steps?: Array<{
    event: string;
    input: Record<string, unknown>;
    expectedState: unknown;
    expectedStatus: string;
  }>;
  decoratorOverrides?: Record<string, { retry?: { maxAttempts?: number } }>;
  expectedEffectiveMaxAttempts?: number;
  expectedEffectiveCircuitBreakerEnabled?: boolean;
  expectedCompensationOrder?: string[];
}

describe("Canonical Cross-Language Conformance Suite (spec/conformance)", () => {
  const suite = JSON.parse(
    readFileSync(resolve(SPEC_CONFORMANCE_DIR, "conformance-suite.json"), "utf8")
  ) as { scenarios: ConformanceScenario[] };

  for (const scenario of suite.scenarios) {
    it(`[${scenario.id}] ${scenario.description}`, async () => {
      const compensationLog: string[] = [];
      const registry = new FSMRegistry({
        clock: { now: () => 1000, sleep: async () => {} },
      });

      // Register standard conformance handlers
      for (const txName of [
        "conformance.traffic.recordStep",
        "conformance.hierarchy.beginAuth",
        "conformance.hierarchy.captureFunds",
        "conformance.hierarchy.markCancelled",
        "conformance.parallel.initFulfillment",
        "conformance.parallel.recordPaid",
        "conformance.parallel.recordPacked",
        "conformance.saga.bookFlight",
        "conformance.saga.bookHotel",
      ]) {
        registry.registerTransition(txName, ({ input, context }) => ({
          context: { ...(context.data as object), ...((input as object) ?? {}) },
        }));
      }

      for (const failTxName of [
        "conformance.traffic.brokenBulb",
        "conformance.resilience.callPrimary",
        "conformance.resilience.alwaysFail",
        "conformance.saga.bookCar",
      ]) {
        const overridePolicy = scenario.decoratorOverrides?.[failTxName];
        registry.registerTransition(
          failTxName,
          ({ input }) => {
            if ((input as { fail?: boolean })?.fail !== false) {
              throw new Error(`Simulated failure in ${failTxName}`);
            }
            return {};
          },
          overridePolicy ? { retry: overridePolicy.retry } : undefined
        );
      }

      for (const compName of [
        "conformance.saga.cancelFlight",
        "conformance.saga.cancelHotel",
        "conformance.saga.cancelCar",
      ]) {
        registry.registerCompensate(compName, () => {
          compensationLog.push(compName);
        });
      }

      for (const effName of [
        "conformance.traffic.onEnterRed",
        "conformance.traffic.onExitRed",
        "conformance.hierarchy.enterActive",
        "conformance.hierarchy.exitActive",
        "conformance.hierarchy.enterIdle",
        "conformance.hierarchy.exitIdle",
        "conformance.hierarchy.enterAuthorizing",
        "conformance.hierarchy.exitAuthorizing",
        "conformance.parallel.notifyShipped",
        "conformance.resilience.alertError",
      ]) {
        registry.registerEffect(effName, () => {});
      }

      registry.registerYamlFile(resolve(SPEC_CONFORMANCE_DIR, scenario.file));
      const actor = await registry.createActor<Record<string, unknown>>(scenario.machineId);

      if (scenario.expectedEffectiveMaxAttempts !== undefined) {
        const eff = actor.getEffectiveConfig().transitions.find((t) => t.event === "CALL_PRIMARY")!;
        expect(eff.policy.retry.maxAttempts).toBe(scenario.expectedEffectiveMaxAttempts);
        expect(eff.policy.circuitBreaker.enabled).toBe(
          scenario.expectedEffectiveCircuitBreakerEnabled
        );
      }

      const txId = await actor.startTransaction({});
      const initialSnap = await actor.getTransaction(txId);
      expect(initialSnap?.stateValue).toEqual(scenario.expectedInitialState);

      if (scenario.steps) {
        for (const step of scenario.steps) {
          const out = await actor.transition(txId, step.event, step.input);
          expect(out.currentState).toEqual(step.expectedState);
          expect(out.status).toBe(step.expectedStatus);
        }
      }

      if (scenario.expectedCompensationOrder) {
        expect(compensationLog).toEqual(scenario.expectedCompensationOrder);
      }

      await registry.shutdown();
    });
  }
});

