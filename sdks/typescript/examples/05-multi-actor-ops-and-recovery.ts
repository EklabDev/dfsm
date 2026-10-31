import {
  createMachine,
  FSMRegistry,
  SqliteStateStore,
  type Clock,
} from "../src/index.js";

export interface PaymentTxContext {
  amount: number;
  ledgerReserved: boolean;
  replayed?: boolean;
}

export interface AuditTxContext {
  batchId: string;
  processedRecords: number;
}

export async function runExample05MultiActorOpsAndRecovery() {
  let virtualNow = 1_700_000_000_000;
  const fakeClock: Clock = {
    now: () => virtualNow,
    sleep: async (ms) => {
      virtualNow += ms;
    },
  };

  const sharedStore = new SqliteStateStore({ filename: ":memory:" });
  const registry = new FSMRegistry({ store: sharedStore, clock: fakeClock });

  // Machine 1: Payment machine with Saga compensation
  registry.registerTransition<PaymentTxContext>("reserveLedger", ({ context }) => ({
    context: { ...context.data, ledgerReserved: true },
  }));
  registry.registerCompensate<PaymentTxContext>("releaseLedger", ({ currentContext }) => ({
    ...currentContext,
    ledgerReserved: false,
  }));
  registry.registerTransition<PaymentTxContext>("settleWire", ({ context }) => ({
    context: { ...context.data, replayed: true },
  }));

  const paymentBuilder = createMachine<PaymentTxContext>("payment-settlement")
    .initial("initiated")
    .state("initiated", (s) =>
      s.on("RESERVE", {
        target: "reserved",
        transition: "reserveLedger",
        compensate: "releaseLedger",
      })
    )
    .state("reserved", (s) => s.on("SETTLE", { target: "settled", transition: "settleWire" }))
    .finalState("settled");

  // Machine 2: Separate internal Audit machine owned by a second Actor
  registry.registerTransition<AuditTxContext, { count: number }>(
    "ingestBatch",
    ({ input, context }) => ({
      context: { ...context.data, processedRecords: context.data.processedRecords + input.count },
    })
  );

  const auditBuilder = createMachine<AuditTxContext>("audit-pipeline")
    .initial("collecting")
    .state("collecting", (s) =>
      s.on("INGEST", { target: "archived", transition: "ingestBatch" })
    )
    .finalState("archived");

  registry.registerBuilder(paymentBuilder);
  registry.registerBuilder(auditBuilder);

  const paymentActor = await registry.createActor<PaymentTxContext>("payment-settlement", {
    actorId: "payment-actor-1",
    recovery: {
      enabled: true,
      stuckThresholdMs: 5000,
      defaultAction: "COMPENSATE",
      stateActions: {
        // State-specific recovery override: if stuck in 'reserved' with active step, CONTINUE!
        initiated: "MARK_FAIL",
      },
    },
    scheduler: {
      enabled: false,
      sweepIntervalMs: 10000,
      stuckThresholdMs: 5000,
      retentionMs: 60000,
      batchSize: 50,
    },
  });

  const auditActor = await registry.createActor<AuditTxContext>("audit-pipeline", {
    actorId: "audit-actor-1",
  });

  // Start transactions on both actors independently
  const payTx1 = await paymentActor.startTransaction({ amount: 250, ledgerReserved: false }, "pay-stuck-comp");
  await paymentActor.transition(payTx1, "RESERVE");

  const auditTx1 = await auditActor.startTransaction({ batchId: "B-1", processedRecords: 0 }, "audit-1");
  await auditActor.transition(auditTx1, "INGEST", { count: 42 });

  // Simulate mid-flight crash on payTx1 while in 'reserved'
  const snapBeforeCrash = (await paymentActor.getTransaction(payTx1))!;
  await sharedStore.updateTransaction(payTx1, snapBeforeCrash.version, {
    status: "IN_FLIGHT",
    leaseOwner: "crashed-node",
    updatedAt: virtualNow,
  });

  // Query live in-flight metrics before threshold elapses
  const inFlightBeforeTimeout = await paymentActor.getInFlightCount();
  const stuckBeforeTimeout = await paymentActor.getInFlightCount({ stuckOnly: true });

  // Advance clock past stuckThresholdMs (5,000ms)
  virtualNow += 10_000;
  const stuckAfterTimeout = await paymentActor.getInFlightCount({ stuckOnly: true });

  // Inspect loaded machines, actors, & scheduler config, then trigger recovery sweep!
  const loadedMachines = registry.listMachines();
  const schedulerCfg = paymentActor.getSchedulerConfig();
  const sweepReport = await paymentActor.triggerSweepNow();
  const snapAfterSweep = await paymentActor.getTransaction(payTx1);

  // Force cleanup terminal transactions via admin API (first dry-run, then actual DELETE)
  const dryCleanup = await registry.forceCleanUp({
    statuses: ["COMPLETED", "COMPENSATED"],
    dryRun: true,
  });
  const realCleanup = await registry.forceCleanUp({
    statuses: ["COMPLETED", "COMPENSATED"],
    action: "DELETE",
  });

  await registry.shutdown();

  return {
    loadedMachineIds: loadedMachines.map((m) => m.id),
    schedulerSweepIntervalMs: schedulerCfg.sweepIntervalMs,
    inFlightBeforeTimeout,
    stuckBeforeTimeout,
    stuckAfterTimeout,
    sweepCompensatedIds: sweepReport.actionsTaken.COMPENSATE,
    recoveredPayStatus: snapAfterSweep?.status,
    ledgerReleasedAfterRecovery: snapAfterSweep?.context.ledgerReserved === false,
    dryRunMatchedCount: dryCleanup.matched,
    deletedCount: realCleanup.deleted.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExample05MultiActorOpsAndRecovery().then((res) => {
    console.log("Example 05 Result:", JSON.stringify(res, null, 2));
  });
}

