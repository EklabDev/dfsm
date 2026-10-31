import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMachine,
  FSMRegistry,
  MongoStateStore,
  PostgresStateStore,
  StaleTransactionVersionError,
  type StateStore,
} from "../../src/index.js";

const PG_URL =
  process.env.DFSM_POSTGRES_URL ?? "postgresql://dfsm:dfsm_password@127.0.0.1:55432/dfsm_test";
const MONGO_URL = process.env.DFSM_MONGO_URL ?? "mongodb://127.0.0.1:27018";

async function runFullStoreContractSuite(createStore: () => StateStore) {
  const store = createStore();
  const compensatedSteps: string[] = [];

  const registry = new FSMRegistry({ store });

  registry.registerTransition<{ steps: string[] }, { item: string }>(
    "stepReserve",
    ({ input, context }) => ({
      context: { steps: [...context.data.steps, `reserved:${input.item}`] },
      value: `OK:${input.item}`,
    })
  );

  registry.registerCompensate<{ steps: string[] }, { item: string }>(
    "undoReserve",
    ({ inputSnapshot, currentContext }) => {
      compensatedSteps.push(`undo:${inputSnapshot.item}`);
      return {
        steps: [...currentContext.steps, `undo:${inputSnapshot.item}`],
      };
    }
  );

  registry.registerTransition("stepChargeFail", () => {
    throw new Error("Payment declined in external DB test");
  });

  const machineId = `db-contract-${randomUUID().slice(0, 8)}`;
  const builder = createMachine<{ steps: string[] }>(machineId)
    .initial("step1")
    .defaults({ onFail: { compensate: true, target: "error" } })
    .state("step1", (s) =>
      s.on("RESERVE_1", {
        target: "step2",
        transition: "stepReserve",
        compensate: "undoReserve",
      })
    )
    .state("step2", (s) =>
      s.on("RESERVE_2", {
        target: "step3",
        transition: "stepReserve",
        compensate: "undoReserve",
      })
    )
    .state("step3", (s) =>
      s.on("CHARGE", {
        target: "completed",
        transition: "stepChargeFail",
      })
    )
    .finalState("completed");

  registry.registerBuilder(builder);
  const actor = await registry.createActor<{ steps: string[] }>(machineId);

  // 1. Start transaction & advance two steps, then fail 3rd step -> LIFO Saga unwind!
  const txSaga = await actor.startTransaction({ steps: [] });
  await actor.transition(txSaga, "RESERVE_1", { item: "A" });
  await actor.transition(txSaga, "RESERVE_2", { item: "B" });
  const failRes = await actor.transition(txSaga, "CHARGE");

  expect(failRes.status).toBe("COMPENSATED");
  expect(failRes.currentState).toBe("error");
  expect(compensatedSteps).toEqual(["undo:B", "undo:A"]);

  const persisted = await actor.getTransaction(txSaga);
  expect(persisted?.context.steps).toEqual([
    "reserved:A",
    "reserved:B",
    "undo:B",
    "undo:A",
  ]);
  expect(persisted?.compensationStack).toHaveLength(2);
  expect(persisted?.compensationStack.every((c) => c.compensatedAt !== null)).toBe(true);

  // 2. Test optimistic concurrency conflict protection
  const txRace = await actor.startTransaction({ steps: [] });
  const snapRace = (await actor.getTransaction(txRace))!;
  await store.updateTransaction(txRace, snapRace.version, {
    status: "IN_FLIGHT",
    updatedAt: Date.now() - 60_000,
  });

  await expect(
    store.updateTransaction(txRace, snapRace.version, {
      status: "COMPLETED",
      updatedAt: Date.now(),
    })
  ).rejects.toThrow(StaleTransactionVersionError);

  // 3. Test live in-flight count & administrative forceCleanUp
  expect(await actor.getInFlightCount({ stuckOnly: true })).toBe(1);

  const cleanReport = await actor.forceCleanUp({
    includeInFlight: true,
    action: "DELETE",
  });
  expect(cleanReport.deleted.length).toBeGreaterThanOrEqual(2);
  expect(await actor.getInFlightCount()).toBe(0);

  await registry.shutdown();
}

describe("Live Database Integration Suite (PostgreSQL 17 & MongoDB 8)", () => {
  it("passes full durable Saga, LIFO rollback, optimistic locking & forceCleanUp on PostgreSQL", async () => {
    const prefix = `dfsm_${randomUUID().slice(0, 6).replace(/-/g, "")}_`;
    await runFullStoreContractSuite(
      () =>
        new PostgresStateStore({
          connectionString: PG_URL,
          tablePrefix: prefix,
        })
    );
  });

  it("passes full durable Saga, LIFO rollback, optimistic locking & forceCleanUp on MongoDB", async () => {
    const colName = `dfsm_tx_${randomUUID().slice(0, 8)}`;
    await runFullStoreContractSuite(
      () =>
        new MongoStateStore({
          uri: MONGO_URL,
          databaseName: "dfsm_integration_test",
          collectionName: colName,
        })
    );
  });
});

