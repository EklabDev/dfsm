import { describe, expect, it } from "vitest";
import {
  createMachine,
  MachineValidationError,
  parseYamlMachine,
} from "../../src/index.js";

describe("YAML Parser & MachineBuilder IR Parity", () => {
  it("injects implicit final 'error' state when omitted and marks hasCustomErrorState = false", () => {
    const def = parseYamlMachine(`
dfsm: "1.0"
id: simple-doc
initial: draft
states:
  draft:
    on:
      PUBLISH: published
  published:
    type: final
`);
    expect(def.id).toBe("simple-doc");
    expect(def.hasCustomErrorState).toBe(false);
    expect(def.states.error).toBeDefined();
    expect(def.states.error?.type).toBe("final");
    expect(def.states.error?.isImplicitError).toBe(true);
  });

  it("allows overriding 'error' state in YAML and MachineBuilder", () => {
    const yamlDef = parseYamlMachine(`
dfsm: "1.0"
id: custom-err-machine
initial: idle
states:
  idle:
    on:
      RUN: done
  done:
    type: final
  error:
    entry: [notifyFailure]
    on:
      RETRY: idle
`);
    expect(yamlDef.hasCustomErrorState).toBe(true);
    expect(yamlDef.states.error?.type).toBe("atomic");
    expect(yamlDef.states.error?.entry).toEqual(["notifyFailure"]);
    expect(yamlDef.states.error?.on.RETRY?.target).toBe("idle");

    const builderDef = createMachine("custom-err-builder")
      .initial("idle")
      .state("idle", (s) => s.on("RUN", "done"))
      .finalState("done")
      .errorState((e) => e.entry("notifyFailure").on("RETRY", "idle"))
      .build();

    expect(builderDef.hasCustomErrorState).toBe(true);
    expect(builderDef.states.error?.on.RETRY?.target).toBe("idle");
  });

  it("rejects untyped 'context' blocks in YAML to enforce code-first generics", () => {
    expect(() =>
      parseYamlMachine(`
dfsm: "1.0"
id: bad-ctx
initial: a
context:
  count: 0
states:
  a:
    type: final
`)
    ).toThrow(MachineValidationError);
  });

  it("rejects broken targets, missing compound initial, and parallel states with initial", () => {
    // Broken target
    expect(() =>
      parseYamlMachine(`
dfsm: "1.0"
id: broken-target
initial: s1
states:
  s1:
    on:
      GO: non_existent_state
`)
    ).toThrow(MachineValidationError);

    // Compound state missing initial
    expect(() =>
      parseYamlMachine(`
dfsm: "1.0"
id: missing-compound-init
initial: parent
states:
  parent:
    states:
      child_a:
        type: atomic
`)
    ).toThrow(MachineValidationError);

    // Parallel state specifying initial
    expect(() =>
      parseYamlMachine(`
dfsm: "1.0"
id: invalid-parallel
initial: par
states:
  par:
    type: parallel
    initial: reg1
    states:
      reg1:
        type: atomic
`)
    ).toThrow(MachineValidationError);
  });

  it("produces equivalent IR structure from MachineBuilder and YAML", () => {
    const built = createMachine("parity-check")
      .version("2.1.0")
      .registry({ namespace: "ns.demo", strict: true })
      .defaults({ retry: { maxAttempts: 2 } })
      .initial("pending")
      .compoundState("pending", "step1", (p) =>
        p
          .state("step1", (s) => s.on("NEXT", { target: "step2", transition: "doStep1" }))
          .finalState("step2")
          .onDone("complete")
      )
      .finalState("complete")
      .build();

    expect(built.version).toBe("2.1.0");
    expect(built.registry.namespace).toBe("ns.demo");
    expect(built.states.pending?.type).toBe("compound");
    expect(built.states.pending?.initial).toBe("step1");
    expect(built.states.pending?.onDone?.target).toBe("complete");
  });
});

