import { describe, expect, it } from "vitest";
import {
  ActorStoppedByRecoveryError,
  createMachine,
  FSMRegistry,
  SqliteStateStore,
  StaleTransactionVersionError,
  type Clock,
} from "../../src/index.js";

describe("In-Flight Crash Recovery, Scheduler Control, Introspection & ForceCleanUp", () => {
  it("supports all 5 OnRestartMode behaviors: STOP, MARK_FAIL, DELETE, COMPENSATE, and CONTINUE", async () => {
    let now = 50_000;
    const clock: Clock = {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    };

    const store = new SqliteStateStore({ filename: ":memory:" });
    const registry = new FSMRegistry({ store, clock });
    const compensatedIds: string[] = [];

    registry.registerTransition<{ step: string }, { tag?: string }>("advance", ({ input }) => ({
      context: { step: input?.tag ?? "advanced" },
    }));
    registry.registerCompensate("undoAdvance", ({ transactionId }) => {
      compensatedIds.push(transactionId);
      return { step: "rolled_back" };
    });

    const machine = createMachine<{ step: string }>("recovery-modes")
      .initial("s_stop")
      .state("s_stop", (s) => s.on("GO", { target: "s_fail", transition: "advance" }))
      .state("s_fail", (s) => s.on("GO", { target: "s_delete", transition: "advance" }))
      .state("s_delete", (s) =>
        s.on("GO", { target: "s_comp", transition: "advance", compensate: "undoAdvance" })
      )
      .state("s_comp", (s) => s.on("GO", { target: "s_continue", transition: "advance" }))
      .state("s_continue", (s) => s.on("FINISH", { target: "done", transition: "advance" }))
      .finalState("done");

    registry.registerBuilder(machine);

    const seedActor = await registry.createActor<{ step: string }>("recovery-modes", {
      recovery: { enabled: false },
    });

    // Seed 5 transactions in each of the 5 states and simulate stuck IN_FLIGHT leases
    const txStop = await seedActor.startTransaction({ step: "init" }, "tx-stop");
    await store.updateTransaction(txStop, 1, { status: "IN_FLIGHT", updatedAt: now });

    const txFail = await seedActor.startTransaction({ step: "init" }, "tx-fail");
    await seedActor.transition(txFail, "GO");
    await store.updateTransaction(txFail, 3, { status: "IN_FLIGHT", updatedAt: now });

    const txDel = await seedActor.startTransaction({ step: "init" }, "tx-del");
    await seedActor.transition(txDel, "GO");
    await seedActor.transition(txDel, "GO");
    await store.updateTransaction(txDel, 5, { status: "IN_FLIGHT", updatedAt: now });

    const txComp = await seedActor.startTransaction({ step: "init" }, "tx-comp");
    await seedActor.transition(txComp, "GO");
    await seedActor.transition(txComp, "GO");
    await seedActor.transition(txComp, "GO"); // pushes undoAdvance compensation!
    await store.updateTransaction(txComp, 7, { status: "IN_FLIGHT", updatedAt: now });

    const txCont = await seedActor.startTransaction({ step: "init" }, "tx-cont");
    await seedActor.transition(txCont, "GO");
    await seedActor.transition(txCont, "GO");
    await seedActor.transition(txCont, "GO");
    await seedActor.transition(txCont, "GO"); // now in s_continue
    await store.updateTransaction(txCont, 9, {
      status: "IN_FLIGHT",
      activeStep: { event: "FINISH", input: { tag: "replayed_by_continue" }, startedAt: now },
      updatedAt: now,
    });

    await seedActor.close();

    // Advance time beyond stuckThresholdMs (5,000ms)
    now += 10_000;

    // 1. Verify haltActorOnStop = true throws ActorStoppedByRecoveryError when STOP is encountered
    await expect(
      registry.createActor("recovery-modes", {
        recovery: {
          enabled: true,
          stuckThresholdMs: 5000,
          defaultAction: "STOP",
          haltActorOnStop: true,
        },
      })
    ).rejects.toThrow(ActorStoppedByRecoveryError);

    // 2. Configure per-state recovery actions for all 5 transactions!
    const recoveryActor = await registry.createActor<{ step: string }>("recovery-modes", {
      recovery: {
        enabled: true,
        stuckThresholdMs: 5000,
        defaultAction: "MARK_FAIL",
        stateActions: {
          s_stop: "STOP",
          s_fail: "MARK_FAIL",
          s_delete: "DELETE",
          s_comp: "COMPENSATE",
          s_continue: "CONTINUE",
        },
      },
    });

    const sweep = recoveryActor.getSchedulerStatus().lastSweepReport!;
    expect(sweep.actionsTaken.STOP).toEqual(["tx-stop"]);
    expect(sweep.actionsTaken.MARK_FAIL).toEqual(["tx-fail"]);
    expect(sweep.actionsTaken.DELETE).toEqual(["tx-del"]);
    expect(sweep.actionsTaken.COMPENSATE).toEqual(["tx-comp"]);
    expect(sweep.actionsTaken.CONTINUE).toEqual(["tx-cont"]);

    // Verify outcomes in DB
    expect((await recoveryActor.getTransaction("tx-stop"))?.status).toBe("IN_FLIGHT");
    expect((await recoveryActor.getTransaction("tx-fail"))?.status).toBe("FAILED");
    expect(await recoveryActor.getTransaction("tx-del")).toBeNull();

    const compSnap = await recoveryActor.getTransaction("tx-comp");
    expect(compSnap?.status).toBe("COMPENSATED");
    expect(compensatedIds).toEqual(["tx-comp"]);

    const contSnap = await recoveryActor.getTransaction("tx-cont");
    expect(contSnap?.stateValue).toBe("done");
    expect(contSnap?.status).toBe("COMPLETED");
    expect(contSnap?.context.step).toBe("replayed_by_continue");

    await registry.shutdown();
  });

  it("exposes Registry/Actor introspection, background scheduler updates, and concurrency-safe forceCleanUp", async () => {
    await FSMRegistry.resetInstance();
    const registry = FSMRegistry.getInstance();

    registry.registerTransition("noop", () => ({}));
    registry.registerBuilder(
      createMachine("ops-machine")
        .initial("open")
        .state("open", (s) => s.on("CLOSE", { target: "closed", transition: "noop" }))
        .finalState("closed")
    );

    const actor = await registry.createActor("ops-machine", {
      actorId: "ops-actor-main",
      scheduler: {
        enabled: true,
        sweepIntervalMs: 50,
        stuckThresholdMs: 1000,
        retentionMs: 5000,
        batchSize: 25,
      },
    });

    expect(registry.listMachines()).toHaveLength(1);
    expect(registry.listActors()).toHaveLength(1);
    expect(registry.getRegistryConfig().activeActorCount).toBe(1);
    expect(actor.getSchedulerStatus().isRunning).toBe(true);

    // Dynamically update scheduler config
    const updatedSched = actor.updateSchedulerConfig({ sweepIntervalMs: 120, enabled: false });
    expect(updatedSched.sweepIntervalMs).toBe(120);
    expect(actor.getSchedulerStatus().isRunning).toBe(false);

    // Simulate zombie worker optimistic lock conflict when admin runs forceCleanUp!
    const txId = await actor.startTransaction({}, "tx-zombie-race");
    const staleSnapshot = (await actor.getTransaction(txId))!;
    expect(staleSnapshot.version).toBe(1);

    // Admin force-marks transaction FAILED
    const cleanRes = await actor.forceCleanUpTransaction(txId, "MARK_FAIL");
    expect(cleanRes.markedFailed).toEqual(["tx-zombie-race"]);

    // Stale zombie worker attempting to update with old version=1 MUST be rejected!
    const store = (registry as unknown as { defaultStore: SqliteStateStore }).defaultStore;
    await expect(
      store.updateTransaction(txId, staleSnapshot.version, {
        stateValue: "closed",
        status: "COMPLETED",
        updatedAt: Date.now(),
      })
    ).rejects.toThrow(StaleTransactionVersionError);

    await FSMRegistry.resetInstance();
  });
});
