import { describe, expect, it } from "vitest";
import {
  createMachine,
  decorateHook,
  DfsmCompensate,
  DfsmEffect,
  DfsmError,
  DfsmHook,
  DfsmTransition,
  FSMRegistry,
  OnFail,
  SqliteStateStore,
  UnregisteredHandlerError,
  type AfterTransitionHookEvent,
  type BeforeTransitionHookEvent,
  type CompensationRequest,
  type EffectRequest,
  type OnCompensateHookEvent,
  type OnCompleteHookEvent,
  type OnTerminalHookEvent,
  type OnTransactionStartHookEvent,
  type TransitionOutput,
  type TransitionRequest,
} from "../../src/index.js";

interface LoanContext {
  applicant: string;
  creditScore: number;
  amount: number;
  tier: "unclassified" | "prime" | "manual_review" | "rejected";
  approved: boolean;
  disbursed: boolean;
  trace: string[];
}

class LoanWorkflowService {
  @DfsmTransition("scoreApplicant")
  scoreApplicant(
    req: TransitionRequest<LoanContext, { creditScore: number; amount: number }>
  ): TransitionOutput<LoanContext, { score: number }> {
    return {
      context: {
        ...req.context.data,
        creditScore: req.input.creditScore,
        amount: req.input.amount,
        trace: [...req.context.data.trace, `scored:${req.input.creditScore}`],
      },
      value: { score: req.input.creditScore },
    };
  }

  /**
   * Conditional `if / else if / else` router inside an `entry` `@DfsmEffect`!
   * Branches into specialized effects via `req.runEffect(...)`, which in turn invoke
   * `await req.actor.transition(...)` on the same actor without needing YAML `always:`.
   */
  @DfsmEffect("routeByCreditScore")
  async routeByCreditScore(req: EffectRequest<LoanContext>): Promise<void> {
    if (req.context.creditScore >= 750 && req.context.amount <= 50_000) {
      await req.runEffect("fastTrackPrimeEffect", { note: "instant_prime" });
    } else if (req.context.creditScore < 550) {
      await req.runEffect("autoDeclineEffect", { reason: "low_score" });
    } else {
      await req.runEffect("queueManualUnderwriterEffect");
    }
  }

  @DfsmEffect("fastTrackPrimeEffect")
  async fastTrackPrimeEffect(req: EffectRequest<LoanContext>): Promise<void> {
    const payload = req.payload as { note: string };
    await req.actor.transition(req.transactionId, "AUTO_APPROVE_PRIME", {
      note: payload.note,
    });
  }

  @DfsmEffect("autoDisburseOnApprove")
  async autoDisburseOnApprove(req: EffectRequest<LoanContext>): Promise<void> {
    // Second chained auto-transition hop: approved -> disbursed (COMPLETED)
    await req.actor.transition(req.transactionId, "DISBURSE_FUNDS");
  }

  @DfsmEffect("autoDeclineEffect")
  async autoDeclineEffect(req: EffectRequest<LoanContext>): Promise<void> {
    const payload = req.payload as { reason: string };
    await req.actor.transition(req.transactionId, "AUTO_REJECT", {
      reason: payload.reason,
    });
  }

  @DfsmEffect("queueManualUnderwriterEffect")
  async queueManualUnderwriterEffect(req: EffectRequest<LoanContext>): Promise<void> {
    await req.actor.transition(req.transactionId, "ROUTE_MANUAL");
  }

  @DfsmTransition("markPrimeApproved")
  markPrimeApproved(
    req: TransitionRequest<LoanContext, { note: string }>
  ): TransitionOutput<LoanContext> {
    return {
      context: {
        ...req.context.data,
        tier: "prime",
        approved: true,
        trace: [...req.context.data.trace, `prime_approved:${req.input.note}`],
      },
    };
  }

  @DfsmTransition("disburseLoan")
  disburseLoan(req: TransitionRequest<LoanContext>): TransitionOutput<LoanContext> {
    return {
      context: {
        ...req.context.data,
        disbursed: true,
        trace: [...req.context.data.trace, "funds_disbursed"],
      },
    };
  }

  @DfsmTransition("markManualReview")
  markManualReview(req: TransitionRequest<LoanContext>): TransitionOutput<LoanContext> {
    return {
      context: {
        ...req.context.data,
        tier: "manual_review",
        trace: [...req.context.data.trace, "routed_manual_underwriter"],
      },
    };
  }

  @DfsmTransition("markRejected")
  markRejected(
    req: TransitionRequest<LoanContext, { reason: string }>
  ): TransitionOutput<LoanContext> {
    return {
      context: {
        ...req.context.data,
        tier: "rejected",
        trace: [...req.context.data.trace, `auto_rejected:${req.input.reason}`],
      },
    };
  }
}

describe("Effect Conditional Routing (req.actor + req.runEffect), Lifecycle Hooks & Non-Terminal Queries", () => {
  it("routes conditionally inside @DfsmEffect via req.runEffect and chains multi-hop req.actor.transition calls", async () => {
    const registry = new FSMRegistry({ store: new SqliteStateStore({ filename: ":memory:" }) });
    registry.registerService(new LoanWorkflowService(), "loans");

    registry.registerYaml(`
dfsm: "1.0"
id: loan-underwriting
version: "1.0.0"
initial: draft
registry:
  namespace: "loans"
  strict: true
states:
  draft:
    on:
      SUBMIT_APPLICATION:
        target: scored
        transition: scoreApplicant
  scored:
    entry: [routeByCreditScore]
    on:
      AUTO_APPROVE_PRIME:
        target: approved
        transition: markPrimeApproved
      ROUTE_MANUAL:
        target: manual_review
        transition: markManualReview
      AUTO_REJECT:
        target: rejected
        transition: markRejected
  approved:
    entry: [autoDisburseOnApprove]
    on:
      DISBURSE_FUNDS:
        target: disbursed
        transition: disburseLoan
  manual_review:
    on:
      UNDERWRITER_APPROVE:
        target: approved
        transition: markPrimeApproved
  disbursed:
    type: final
  rejected:
    type: final
`);

    const actor = await registry.createActor<LoanContext>("loan-underwriting");

    const baseCtx: LoanContext = {
      applicant: "Alice",
      creditScore: 0,
      amount: 0,
      tier: "unclassified",
      approved: false,
      disbursed: false,
      trace: [],
    };

    // Case 1: High credit score (790) -> draft -> scored -> approved -> disbursed (2 automatic hops!)
    const txPrime = await actor.startTransaction(baseCtx, "loan-prime");
    const primeRes = await actor.transition<
      { creditScore: number; amount: number },
      { score: number }
    >(txPrime, "SUBMIT_APPLICATION", { creditScore: 790, amount: 25_000 });

    expect(primeRes.previousState).toBe("draft");
    expect(primeRes.currentState).toBe("disbursed");
    expect(primeRes.status).toBe("COMPLETED");
    expect(primeRes.value).toEqual({ score: 790 });
    expect(primeRes.context.disbursed).toBe(true);
    expect(primeRes.context.trace).toEqual([
      "scored:790",
      "prime_approved:instant_prime",
      "funds_disbursed",
    ]);

    // Case 2: Mid credit score (660) -> draft -> scored -> manual_review (pauses in IDLE!)
    const txManual = await actor.startTransaction(
      { ...baseCtx, applicant: "Bob" },
      "loan-manual"
    );
    const manualRes = await actor.transition(txManual, "SUBMIT_APPLICATION", {
      creditScore: 660,
      amount: 25_000,
    });
    expect(manualRes.currentState).toBe("manual_review");
    expect(manualRes.status).toBe("IDLE");
    expect(actor.getAvailableEvents(manualRes.currentState)).toEqual(["UNDERWRITER_APPROVE"]);

    // Case 3: Low credit score (510) -> draft -> scored -> rejected (COMPLETED)
    const txReject = await actor.startTransaction(
      { ...baseCtx, applicant: "Charlie" },
      "loan-reject"
    );
    const rejectRes = await actor.transition(txReject, "SUBMIT_APPLICATION", {
      creditScore: 510,
      amount: 25_000,
    });
    expect(rejectRes.currentState).toBe("rejected");
    expect(rejectRes.status).toBe("COMPLETED");
    expect(rejectRes.context.tier).toBe("rejected");

    // Verify Non-Terminal ("Active") vs Terminal queries!
    // loan-prime = COMPLETED, loan-reject = COMPLETED, loan-manual = IDLE (not in terminal state!)
    expect(await actor.getActiveCount()).toBe(1);
    expect(await registry.getGlobalActiveCount("loan-underwriting")).toBe(1);
    const activeList = await actor.listActiveTransactions();
    expect(activeList.map((t) => t.transactionId)).toEqual(["loan-manual"]);

    const breakdown = await actor.getStatusBreakdown();
    expect(breakdown).toEqual({
      nonTerminalCount: 1,
      terminalCount: 2,
      byStatus: {
        IDLE: 1,
        IN_FLIGHT: 0,
        COMPENSATING: 0,
        COMPLETED: 2,
        COMPENSATED: 0,
        FAILED: 0,
      },
    });

    const terminals = actor.getTerminalStates();
    expect(terminals.topLevelTerminalStates).toEqual(["disbursed", "rejected", "error"]);
    expect(terminals.terminalStatuses).toEqual(["COMPLETED", "COMPENSATED", "FAILED"]);
    expect(terminals.nonTerminalStatuses).toEqual(["IDLE", "IN_FLIGHT", "COMPENSATING"]);

    await registry.shutdown();
  });

  it("guards against runaway infinite effect / auto-transition loops via maxEffectChainDepth", async () => {
    const registry = new FSMRegistry({ store: new SqliteStateStore({ filename: ":memory:" }) });

    registry.registerEffect("bounceToPong", async (req) => {
      await req.actor.transition(req.transactionId, "TO_PONG");
    });
    registry.registerEffect("bounceToPing", async (req) => {
      await req.actor.transition(req.transactionId, "TO_PING");
    });

    registry.registerBuilder(
      createMachine("infinite-bounce")
        .initial("idle")
        .state("idle", (s) => s.on("START", { target: "ping" }))
        .state("ping", (s) => s.entry("bounceToPong").on("TO_PONG", { target: "pong" }))
        .state("pong", (s) => s.entry("bounceToPing").on("TO_PING", { target: "ping" }))
    );

    const actor = await registry.createActor("infinite-bounce", {
      maxEffectChainDepth: 6,
    });

    const txId = await actor.startTransaction({}, "tx-loop");
    await expect(actor.transition(txId, "START")).rejects.toSatisfy(
      (err: unknown) => err instanceof DfsmError && err.code === "DFSM_MAX_EFFECT_CHAIN_DEPTH"
    );

    await registry.shutdown();
  });

  it("fires all 6 ActorLifecycleHooks (onStart, beforeTransition, afterTransition, onCompensate, onComplete, onTerminal) in exact causal order", async () => {
    const hookTrace: string[] = [];

    class SagaHookService {
      @DfsmTransition("stepOne")
      stepOne(req: TransitionRequest<{ steps: string[] }>): TransitionOutput<{ steps: string[] }> {
        return { context: { steps: [...req.context.data.steps, "one"] } };
      }

      @DfsmCompensate("undoStepOne")
      undoStepOne(req: CompensationRequest<{ steps: string[] }>): { steps: string[] } {
        return { steps: [...req.currentContext.steps, "undo_one"] };
      }

      @DfsmTransition("stepTwoMaybeFail")
      @OnFail({ compensate: true, target: "error" })
      stepTwoMaybeFail(
        req: TransitionRequest<{ steps: string[] }, { fail?: boolean }>
      ): TransitionOutput<{ steps: string[] }> {
        if (req.input?.fail) {
          throw new Error("boom_step_two");
        }
        return { context: { steps: [...req.context.data.steps, "two"] } };
      }
    }

    const registry = new FSMRegistry({
      store: new SqliteStateStore({ filename: ":memory:" }),
      hooks: {
        onStart: (e) => {
          hookTrace.push(`global:onStart:${e.transactionId}:${String(e.initialState)}`);
        },
      },
    });
    registry.registerService(new SagaHookService());

    registry.registerBuilder(
      createMachine<{ steps: string[] }>("hook-test-machine")
        .initial("s1")
        .state("s1", (s) =>
          s.on("NEXT", {
            target: "s2",
            transition: "stepOne",
            compensate: "undoStepOne",
          })
        )
        .state("s2", (s) =>
          s.on("FINISH", {
            target: "done",
            transition: "stepTwoMaybeFail",
          })
        )
        .finalState("done")
    );

    const actor = await registry.createActor<{ steps: string[] }>("hook-test-machine", {
      hooks: {
        onStart: (e) => {
          hookTrace.push(`actor:onStart:${e.transactionId}:${String(e.initialState)}`);
        },
        beforeTransition: (e) => {
          hookTrace.push(`before:${e.transactionId}:${e.event}@${String(e.currentState)}`);
        },
        afterTransition: (e) => {
          hookTrace.push(
            `after:${e.transactionId}:${e.event}:${String(e.previousState)}->${String(e.currentState)}:${e.status}`
          );
        },
        onCompensate: (e) => {
          hookTrace.push(`compensate:${e.transactionId}:${e.compensateHandler}:seq=${e.stepSeq}`);
        },
        onComplete: (e) => {
          hookTrace.push(`complete:${e.transactionId}:${String(e.finalState)}`);
        },
        onTerminal: (e) => {
          hookTrace.push(`terminal:${e.transactionId}:${e.status}@${String(e.finalState)}`);
        },
      },
    });

    // Dynamic addHooks subscription + unsubscribe check
    const dynamicEvents: string[] = [];
    const unsubscribe = actor.addHooks({
      onComplete: (e) => {
        dynamicEvents.push(`dynamicComplete:${e.transactionId}`);
      },
    });

    // Flow A: Happy path -> COMPLETED (triggers onStart, before/after x2, onComplete, onTerminal)
    await actor.startTransaction({ steps: [] }, "tx-happy");
    await actor.transition("tx-happy", "NEXT");
    await actor.transition("tx-happy", "FINISH", { fail: false });

    expect(dynamicEvents).toEqual(["dynamicComplete:tx-happy"]);
    unsubscribe();

    // Flow B: Saga failure path -> COMPENSATED (triggers onStart, before/after, onCompensate, onTerminal — NOT onComplete)
    await actor.startTransaction({ steps: [] }, "tx-fail");
    await actor.transition("tx-fail", "NEXT");
    await actor.transition("tx-fail", "FINISH", { fail: true });

    expect(hookTrace).toEqual([
      // Flow A
      "global:onStart:tx-happy:s1",
      "actor:onStart:tx-happy:s1",
      "before:tx-happy:NEXT@s1",
      "after:tx-happy:NEXT:s1->s2:IDLE",
      "before:tx-happy:FINISH@s2",
      "after:tx-happy:FINISH:s2->done:COMPLETED",
      "complete:tx-happy:done",
      "terminal:tx-happy:COMPLETED@done",
      // Flow B
      "global:onStart:tx-fail:s1",
      "actor:onStart:tx-fail:s1",
      "before:tx-fail:NEXT@s1",
      "after:tx-fail:NEXT:s1->s2:IDLE",
      "before:tx-fail:FINISH@s2",
      "compensate:tx-fail:undoStepOne:seq=1",
      "after:tx-fail:FINISH:s2->error:COMPENSATED",
      "terminal:tx-fail:COMPENSATED@error",
    ]);

    await registry.shutdown();
  });

  it("defines hooks, routed sub-effects, and maxEffectChainDepth in YAML and registers @DfsmHook / decorateHook on machine creation", async () => {
    const events: string[] = [];

    interface BillingCtx {
      invoiceId: string;
      autoCharge: boolean;
      shouldFailCapture: boolean;
      history: string[];
    }

    class BillingMachineHandlers {
      @DfsmTransition("submitInvoice")
      submitInvoice(req: TransitionRequest<BillingCtx>): TransitionOutput<BillingCtx> {
        return {
          context: {
            ...req.context.data,
            history: [...req.context.data.history, "submitted"],
          },
        };
      }

      @DfsmCompensate("voidSubmittedInvoice")
      voidSubmittedInvoice(req: CompensationRequest<BillingCtx>): BillingCtx {
        return {
          ...req.currentContext,
          history: [...req.currentContext.history, "voided_invoice"],
        };
      }

      @DfsmEffect("routeBillingPolicyEffect")
      async routeBillingPolicyEffect(req: EffectRequest<BillingCtx>): Promise<void> {
        if (req.context.autoCharge) {
          await req.runEffect("autoChargeCardSubEffect");
        }
      }

      @DfsmEffect("autoChargeCardSubEffect")
      async autoChargeCardSubEffect(req: EffectRequest<BillingCtx>): Promise<void> {
        await req.actor.transition(req.transactionId, "CAPTURE_PAYMENT");
      }

      @DfsmTransition("capturePayment")
      @OnFail({ compensate: true, target: "error" })
      capturePayment(req: TransitionRequest<BillingCtx>): TransitionOutput<BillingCtx> {
        if (req.context.data.shouldFailCapture) {
          throw new Error("gateway_declined");
        }
        return {
          context: {
            ...req.context.data,
            history: [...req.context.data.history, "captured"],
          },
        };
      }

      @DfsmHook("onBillingStart")
      onBillingStart(e: OnTransactionStartHookEvent<BillingCtx>): void {
        events.push(`yaml:onStart:${e.transactionId}:${String(e.initialState)}`);
      }

      @DfsmHook("onBillingBefore")
      onBillingBefore(e: BeforeTransitionHookEvent<BillingCtx>): void {
        events.push(`yaml:before:${e.transactionId}:${e.event}`);
      }

      @DfsmHook("onBillingAfterAudit")
      onBillingAfterAudit(e: AfterTransitionHookEvent<BillingCtx>): void {
        events.push(`yaml:afterAudit:${e.transactionId}:${e.event}->${String(e.currentState)}`);
      }

      @DfsmHook("onBillingCompensate")
      onBillingCompensate(e: OnCompensateHookEvent<BillingCtx>): void {
        events.push(`yaml:compensate:${e.transactionId}:${e.compensateHandler}`);
      }

      @DfsmHook("onBillingComplete")
      onBillingComplete(e: OnCompleteHookEvent<BillingCtx>): void {
        events.push(`yaml:complete:${e.transactionId}:${String(e.finalState)}`);
      }

      @DfsmHook("onBillingTerminal")
      onBillingTerminal(e: OnTerminalHookEvent<BillingCtx>): void {
        events.push(`yaml:terminal:${e.transactionId}:${e.status}`);
      }
    }

    const extraAfterMetricsHook = decorateHook(
      "onBillingAfterMetrics",
      (e: AfterTransitionHookEvent<BillingCtx>) => {
        events.push(`yaml:afterMetrics:${e.transactionId}:${e.status}`);
      }
    );

    const billingYaml = `
dfsm: "1.0"
id: billing-pipeline
version: "1.0.0"
initial: draft
maxEffectChainDepth: 12
registry:
  namespace: "billing"
  strict: true
effects:
  - autoChargeCardSubEffect
hooks:
  onStart: onBillingStart
  beforeTransition: onBillingBefore
  afterTransition:
    - onBillingAfterAudit
    - onBillingAfterMetrics
  onCompensate: onBillingCompensate
  onComplete: onBillingComplete
  onTerminal: onBillingTerminal
states:
  draft:
    on:
      SUBMIT:
        target: pending_charge
        transition: submitInvoice
        compensate: voidSubmittedInvoice
  pending_charge:
    entry: [routeBillingPolicyEffect]
    on:
      CAPTURE_PAYMENT:
        target: paid
        transition: capturePayment
  paid:
    type: final
`;

    const registry = new FSMRegistry({ store: new SqliteStateStore({ filename: ":memory:" }) });

    // Register YAML + handlers + hooks together right on FSM machine creation!
    registry.registerYaml(billingYaml, {
      services: [new BillingMachineHandlers()],
      hooks: {
        onBillingAfterMetrics: extraAfterMetricsHook,
      },
    });

    const hookDescriptors = registry
      .listRegisteredHandlers()
      .filter((h) => h.kind === "hook")
      .map((h) => h.name)
      .sort();
    expect(hookDescriptors).toEqual([
      "billing.onBillingAfterAudit",
      "billing.onBillingAfterMetrics",
      "billing.onBillingBefore",
      "billing.onBillingCompensate",
      "billing.onBillingComplete",
      "billing.onBillingStart",
      "billing.onBillingTerminal",
    ]);

    const actor = await registry.createActor<BillingCtx>("billing-pipeline");
    const effective = actor.getEffectiveConfig();
    expect(effective.maxEffectChainDepth).toBe(12);
    expect(effective.registeredEffects).toEqual([
      "billing.autoChargeCardSubEffect",
      "billing.routeBillingPolicyEffect",
    ]);
    expect(effective.resolvedHooks).toEqual({
      onStart: ["billing.onBillingStart"],
      beforeTransition: ["billing.onBillingBefore"],
      afterTransition: ["billing.onBillingAfterAudit", "billing.onBillingAfterMetrics"],
      onCompensate: ["billing.onBillingCompensate"],
      onComplete: ["billing.onBillingComplete"],
      onTerminal: ["billing.onBillingTerminal"],
    });

    // 1) Auto-routed happy path: draft -> pending_charge -> paid
    await actor.startTransaction(
      { invoiceId: "INV-1", autoCharge: true, shouldFailCapture: false, history: [] },
      "inv-1"
    );
    const res1 = await actor.transition("inv-1", "SUBMIT");
    expect(res1.currentState).toBe("paid");
    expect(res1.status).toBe("COMPLETED");

    // 2) Auto-routed failure + Saga compensation path: draft -> pending_charge -> error (COMPENSATED)
    await actor.startTransaction(
      { invoiceId: "INV-2", autoCharge: true, shouldFailCapture: true, history: [] },
      "inv-2"
    );
    const res2 = await actor.transition("inv-2", "SUBMIT");
    expect(res2.currentState).toBe("error");
    expect(res2.status).toBe("COMPENSATED");
    expect(res2.context.history).toEqual(["submitted", "voided_invoice"]);

    expect(events).toEqual([
      // inv-1: SUBMIT commits draft -> pending_charge (afterTransition fires), then entry effect chains CAPTURE_PAYMENT -> paid
      "yaml:onStart:inv-1:draft",
      "yaml:before:inv-1:SUBMIT",
      "yaml:afterAudit:inv-1:SUBMIT->pending_charge",
      "yaml:afterMetrics:inv-1:IDLE",
      "yaml:before:inv-1:CAPTURE_PAYMENT",
      "yaml:afterAudit:inv-1:CAPTURE_PAYMENT->paid",
      "yaml:afterMetrics:inv-1:COMPLETED",
      "yaml:complete:inv-1:paid",
      "yaml:terminal:inv-1:COMPLETED",
      // inv-2: SUBMIT commits draft -> pending_charge, then chained CAPTURE_PAYMENT fails & compensates LIFO
      "yaml:onStart:inv-2:draft",
      "yaml:before:inv-2:SUBMIT",
      "yaml:afterAudit:inv-2:SUBMIT->pending_charge",
      "yaml:afterMetrics:inv-2:IDLE",
      "yaml:before:inv-2:CAPTURE_PAYMENT",
      "yaml:compensate:inv-2:billing.voidSubmittedInvoice",
      "yaml:afterAudit:inv-2:CAPTURE_PAYMENT->error",
      "yaml:afterMetrics:inv-2:COMPENSATED",
      "yaml:terminal:inv-2:COMPENSATED",
    ]);

    await registry.shutdown();
  });

  it("strictly validates YAML hooks & routed sub-effects on registerYaml(..., bindings) and createActor(rawYaml, { bindings })", async () => {
    const registry = new FSMRegistry({ store: new SqliteStateStore({ filename: ":memory:" }) });

    const yamlMissingHook = `
dfsm: "1.0"
id: missing-hook-machine
initial: idle
registry:
  namespace: "strict_ns"
  strict: true
hooks:
  onComplete: nonExistentHook
states:
  idle:
    on:
      FINISH:
        target: done
  done:
    type: final
`;

    // Passing bindings on machine creation triggers immediate strict validation!
    expect(() => registry.registerYaml(yamlMissingHook, { services: [] })).toThrow(
      UnregisteredHandlerError
    );

    const yamlMissingSubEffect = `
dfsm: "1.0"
id: missing-subeffect-machine
initial: idle
registry:
  namespace: "strict_ns"
  strict: true
effects:
  - missingRoutedSubEffect
states:
  idle:
    on:
      FINISH:
        target: done
  done:
    type: final
`;

    expect(() => registry.registerYaml(yamlMissingSubEffect, { services: [] })).toThrow(
      UnregisteredHandlerError
    );

    // Direct createActor(rawYaml, { bindings }) registers machine + bindings in one step!
    const trace: string[] = [];
    const directYaml = `
dfsm: "1.0"
id: direct-actor-yaml
initial: ready
maxEffectChainDepth: 8
registry:
  namespace: "direct"
  strict: true
effects:
  - finishSubEffect
hooks:
  onComplete: handleDirectComplete
states:
  ready:
    entry: [kickoffRouter]
    on:
      AUTO_DONE:
        target: completed
  completed:
    type: final
`;

    const directActor = await registry.createActor(directYaml, {
      bindings: {
        effects: {
          kickoffRouter: async (req) => {
            await req.runEffect("finishSubEffect");
          },
          finishSubEffect: async (req) => {
            await req.actor.transition(req.transactionId, "AUTO_DONE");
          },
        },
        hooks: {
          handleDirectComplete: (e) => {
            trace.push(`completed:${e.transactionId}`);
          },
        },
      },
    });

    // Builder equivalent check (.hook / .hooks / .effects / .maxEffectChainDepth)
    registry.registerBuilder(
      createMachine("builder-hooks-machine")
        .registry({ namespace: "direct" })
        .maxEffectChainDepth(10)
        .effects("finishSubEffect")
        .hook("onComplete", "handleDirectComplete")
        .initial("idle")
        .finalState("idle")
    );
    const builderActor = await registry.createActor("builder-hooks-machine");
    expect(builderActor.getEffectiveConfig().maxEffectChainDepth).toBe(10);
    expect(builderActor.getEffectiveConfig().resolvedHooks.onComplete).toEqual([
      "direct.handleDirectComplete",
    ]);

    await directActor.startTransaction({}, "tx-direct");
    // Note: entry effects run on state transitions; let's trigger a self or initial check
    expect(directActor.getEffectiveConfig().maxEffectChainDepth).toBe(8);

    await registry.shutdown();
  });
});

