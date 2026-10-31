import { describe, expect, it } from "vitest";
import { createMachine, FSMRegistry, InvalidTransitionError } from "../../src/index.js";

describe("XState Hierarchical & Parallel Statechart Engine", () => {
  it("executes LCA exit effects bottom-up and entry effects top-down with event bubbling", async () => {
    const trace: string[] = [];
    const registry = new FSMRegistry();

    for (const eff of [
      "enterParent",
      "exitParent",
      "enterChildA",
      "exitChildA",
      "enterChildB",
      "exitChildB",
      "enterAborted",
    ]) {
      registry.registerEffect(eff, () => {
        trace.push(eff);
      });
    }

    registry.registerTransition("toB", () => {
      trace.push("tx:toB");
    });
    registry.registerTransition("abortAll", () => {
      trace.push("tx:abortAll");
    });

    const machine = createMachine("lca-machine")
      .initial("parent")
      .compoundState("parent", "childA", (p) =>
        p
          .entry("enterParent")
          .exit("exitParent")
          .on("ABORT", { target: "aborted", transition: "abortAll" })
          .state("childA", (c) =>
            c
              .entry("enterChildA")
              .exit("exitChildA")
              .on("STEP", { target: "childB", transition: "toB" })
          )
          .state("childB", (c) => c.entry("enterChildB").exit("exitChildB"))
      )
      .finalState("aborted", (f) => f.entry("enterAborted"));

    const actor = await registry.createActor(machine);
    const txId = await actor.startTransaction({});
    expect(trace).toEqual(["enterParent", "enterChildA"]);
    trace.length = 0;

    // Sibling transition inside parent: must NOT exit/re-enter parent!
    const stepRes = await actor.transition(txId, "STEP");
    expect(stepRes.currentState).toEqual({ parent: "childB" });
    expect(trace).toEqual(["tx:toB", "exitChildA", "enterChildB"]);
    trace.length = 0;

    // Bubbled ABORT handled by parent -> exits childB BEFORE parent (bottom-up), then enters aborted!
    const abortRes = await actor.transition(txId, "ABORT");
    expect(abortRes.currentState).toBe("aborted");
    expect(abortRes.status).toBe("COMPLETED");
    expect(trace).toEqual(["tx:abortAll", "exitChildB", "exitParent", "enterAborted"]);

    // Further transitions on final state throw InvalidTransitionError
    await expect(actor.transition(txId, "STEP")).rejects.toThrow(InvalidTransitionError);

    await registry.shutdown();
  });

  it("handles parallel broadcast events across orthogonal regions and fires onDone when all regions finish", async () => {
    const registry = new FSMRegistry();

    registry.registerTransition<{ aDone: boolean; bDone: boolean }>("finishA", ({ context }) => ({
      context: { ...context.data, aDone: true },
    }));
    registry.registerTransition<{ aDone: boolean; bDone: boolean }>("finishB", ({ context }) => ({
      context: { ...context.data, bDone: true },
    }));

    const machine = createMachine<{ aDone: boolean; bDone: boolean }>("parallel-broadcast")
      .initial("running")
      .parallelState("running", (p) =>
        p
          .onDone("all_complete")
          .compoundState("regA", "workingA", (r) =>
            r
              .state("workingA", (s) =>
                s.on("FINISH_BOTH", { target: "doneA", transition: "finishA" })
              )
              .finalState("doneA")
          )
          .compoundState("regB", "workingB", (r) =>
            r
              .state("workingB", (s) =>
                s.on("FINISH_BOTH", { target: "doneB", transition: "finishB" })
              )
              .finalState("doneB")
          )
      )
      .finalState("all_complete");

    const actor = await registry.createActor(machine);
    const txId = await actor.startTransaction({ aDone: false, bDone: false });

    const res = await actor.transition(txId, "FINISH_BOTH");
    expect(res.currentState).toBe("all_complete");
    expect(res.status).toBe("COMPLETED");
    expect(res.context).toEqual({ aDone: true, bDone: true });

    await registry.shutdown();
  });
});

