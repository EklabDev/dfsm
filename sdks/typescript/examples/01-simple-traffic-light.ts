import { createMachine, FSMRegistry } from "../src/index.js";

export interface TrafficContext {
  cycles: number;
  lastChangedBy: string;
}

export interface AdvanceInput {
  operator: string;
}

export interface AdvanceOutput {
  nextColor: string;
  totalCycles: number;
}

export async function runExample01SimpleTrafficLight() {
  const registry = new FSMRegistry();
  const auditEvents: string[] = [];

  registry.registerEffect<TrafficContext>("logRedEntry", ({ state, context }) => {
    auditEvents.push(`ENTER:${String(state)}:cycles=${context.cycles}`);
  });

  registry.registerTransition<TrafficContext, AdvanceInput, AdvanceOutput>(
    "advanceSignal",
    ({ currentState, input, context }) => {
      const nextColor =
        currentState === "red" ? "green" : currentState === "green" ? "yellow" : "red";
      const nextCycles = nextColor === "red" ? context.data.cycles + 1 : context.data.cycles;

      return {
        context: {
          cycles: nextCycles,
          lastChangedBy: input.operator,
        },
        value: {
          nextColor,
          totalCycles: nextCycles,
        },
        effects: ["emitTelemetry"],
      };
    }
  );

  registry.registerEffect<TrafficContext>("emitTelemetry", ({ transactionId, state }) => {
    auditEvents.push(`TELEMETRY:${transactionId}:${String(state)}`);
  });

  const builder = createMachine<TrafficContext>("simple-traffic-light")
    .version("1.0.0")
    .initial("red")
    .state("red", (s) =>
      s
        .entry("logRedEntry")
        .on("NEXT", { target: "green", transition: "advanceSignal" })
        .on("DECOMMISSION", "retired")
    )
    .state("green", (s) => s.on("NEXT", { target: "yellow", transition: "advanceSignal" }))
    .state("yellow", (s) => s.on("NEXT", { target: "red", transition: "advanceSignal" }))
    .finalState("retired");

  registry.registerBuilder(builder);

  const actor = await registry.createActor<TrafficContext>("simple-traffic-light");
  const txId = await actor.startTransaction({ cycles: 0, lastChangedBy: "boot" }, "tx-light-1");

  const r1 = await actor.transition<AdvanceInput, AdvanceOutput>(txId, "NEXT", {
    operator: "alice",
  });
  const r2 = await actor.transition<AdvanceInput, AdvanceOutput>(txId, "NEXT", {
    operator: "bob",
  });
  const r3 = await actor.transition<AdvanceInput, AdvanceOutput>(txId, "NEXT", {
    operator: "alice",
  });
  const end = await actor.transition(txId, "DECOMMISSION");

  await registry.shutdown();

  return {
    steps: [r1.value, r2.value, r3.value],
    finalState: end.currentState,
    finalStatus: end.status,
    finalContext: end.context,
    auditEvents,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExample01SimpleTrafficLight().then((res) => {
    console.log("Example 01 Result:", JSON.stringify(res, null, 2));
  });
}

