import { describe, expect, it } from "vitest";
import { runExample01SimpleTrafficLight } from "../../examples/01-simple-traffic-light.js";
import { runExample02YamlTypedValidation } from "../../examples/02-yaml-typed-validation.js";
import { runExample03HierarchicalParallelWorkflow } from "../../examples/03-hierarchical-parallel-workflow.js";
import { runExample04PolicyMergeAndSagaCompensation } from "../../examples/04-policy-merge-and-saga-compensation.js";
import { runExample05MultiActorOpsAndRecovery } from "../../examples/05-multi-actor-ops-and-recovery.js";

describe("Progressive Examples (01 Simple -> 05 Hard)", () => {
  it("01-simple-traffic-light executes standalone MachineBuilder workflow", async () => {
    const res = await runExample01SimpleTrafficLight();
    expect(res.steps.map((s) => s?.nextColor)).toEqual(["green", "yellow", "red"]);
    expect(res.finalState).toBe("retired");
    expect(res.finalStatus).toBe("COMPLETED");
    expect(res.finalContext.cycles).toBe(1);
    expect(res.auditEvents).toContain("ENTER:red:cycles=0");
    expect(res.auditEvents).toContain("ENTER:red:cycles=1");
  });

  it("02-yaml-typed-validation validates generic TContext & TInput via Zod", async () => {
    const res = await runExample02YamlTypedValidation();
    expect(res.rejectedInvalidInput).toBe(true);
    expect(res.stateAfterInvalidAttempt).toBe("draft");
    expect(res.calculatedTotalCents).toBe(3600);
    expect(res.finalState).toBe("confirmed");
    expect(res.finalStatus).toBe("COMPLETED");
    expect(res.notifications).toEqual(["Order ORD-900 confirmed for 3600c"]);
  });

  it("03-hierarchical-parallel-workflow handles orthogonal regions, onDone, and bubbling", async () => {
    const res = await runExample03HierarchicalParallelWorkflow();
    expect(res.parallelEnteredState).toEqual({
      active_order: {
        executing: {
          payment_region: "awaiting_capture",
          warehouse_region: "picking_items",
        },
      },
    });
    expect(res.partialParallelState).toEqual({
      active_order: {
        executing: {
          payment_region: "payment_done",
          warehouse_region: "picking_items",
        },
      },
    });
    expect(res.completedState).toBe("dispatched");
    expect(res.completedStatus).toBe("COMPLETED");
    expect(res.bubbledCancelState).toBe("cancelled");
    expect(res.bubbledCancelStatus).toBe("COMPLETED");
  });

  it("04-policy-merge-and-saga-compensation deduplicates Decorator+YAML policies and unwinds LIFO Saga", async () => {
    const res = await runExample04PolicyMergeAndSagaCompensation();
    expect(res.mergedMaxAttempts).toBe(4);
    expect(res.mergedCircuitBreakerEnabled).toBe(true);
    expect(res.mergedOnFailTarget).toBe("manual_escalation");
    expect(res.actualChargeAttempts).toBe(4);
    expect(res.payOutcomeState).toBe("manual_escalation");
    expect(res.payOutcomeStatus).toBe("COMPENSATED");
    expect(res.compensationOrder).toEqual(["cancelHotel", "cancelFlight"]); // Strict LIFO!
    expect(res.flightBookedAfterRollback).toBe(false);
    expect(res.hotelBookedAfterRollback).toBe(false);
    expect(res.errorOverrideState).toBe("error");
    expect(res.recoveredState).toBe("reserve_flight");
    expect(res.opsAlerts).toHaveLength(1);
    expect(res.benchmarkEntriesCount).toBeGreaterThanOrEqual(4);
  });

  it("05-multi-actor-ops-and-recovery isolates multiple actors, queries in-flight counts, sweeps stuck txs, and runs forceCleanUp", async () => {
    const res = await runExample05MultiActorOpsAndRecovery();
    expect(res.loadedMachineIds).toEqual(["payment-settlement", "audit-pipeline"]);
    expect(res.schedulerSweepIntervalMs).toBe(10000);
    expect(res.inFlightBeforeTimeout).toBe(1);
    expect(res.stuckBeforeTimeout).toBe(0);
    expect(res.stuckAfterTimeout).toBe(1);
    expect(res.sweepCompensatedIds).toEqual(["pay-stuck-comp"]);
    expect(res.recoveredPayStatus).toBe("COMPENSATED");
    expect(res.ledgerReleasedAfterRecovery).toBe(true);
    expect(res.dryRunMatchedCount).toBe(2);
    expect(res.deletedCount).toBe(2);
  });
});

