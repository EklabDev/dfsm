package io.github.eklabdev.dfsm.examples;

import io.github.eklabdev.dfsm.ActorLifecycleHooks.AfterTransitionEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnStartEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnTerminalEvent;
import io.github.eklabdev.dfsm.Clock;
import io.github.eklabdev.dfsm.CompensationRequest;
import io.github.eklabdev.dfsm.DfsmModels.ActiveStepInfo;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpAction;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpOptions;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpReport;
import io.github.eklabdev.dfsm.DfsmModels.OnRestartMode;
import io.github.eklabdev.dfsm.DfsmModels.RecoveryConfig;
import io.github.eklabdev.dfsm.DfsmModels.SchedulerConfig;
import io.github.eklabdev.dfsm.DfsmModels.StatusBreakdown;
import io.github.eklabdev.dfsm.DfsmModels.SweepReport;
import io.github.eklabdev.dfsm.DfsmModels.TerminalStatesInfo;
import io.github.eklabdev.dfsm.DfsmModels.TransactionRecord;
import io.github.eklabdev.dfsm.EffectRequest;
import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.TransitionOutput;
import io.github.eklabdev.dfsm.TransitionRequest;
import io.github.eklabdev.dfsm.annotation.CompensateWith;
import io.github.eklabdev.dfsm.annotation.DfsmCompensate;
import io.github.eklabdev.dfsm.annotation.DfsmEffect;
import io.github.eklabdev.dfsm.annotation.DfsmHook;
import io.github.eklabdev.dfsm.annotation.DfsmTransition;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.runtime.ActorConfig;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.runtime.MachineHandlerBindings;
import io.github.eklabdev.dfsm.store.H2StateStore;
import io.github.eklabdev.dfsm.store.StateStore.NewCompensationEntry;
import io.github.eklabdev.dfsm.store.StateStore.TransactionPatch;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Progressive Example 05 (Hard / Full Production Runtime):
 * Demonstrates:
 * 1) YAML-declared {@code hooks:}, {@code effects:}, and {@code maxEffectChainDepth: 8} bound at machine registration;
 * 2) Conditional {@code @DfsmEffect} router ({@code req.runEffect(...)} + {@code req.actor().transition(...)}
 *    automatically driving low-risk orders straight to {@code settled} while routing high-risk orders to {@code manualReview});
 * 3) Non-Terminal ("Active") vs. Terminal State inspection APIs ({@code getActiveCount}, {@code getStatusBreakdown},
 *    {@code getTerminalStates});
 * 4) Simulated crashed worker ({@code IN_FLIGHT} past {@code stuckThresholdMs}) recovered via {@link OnRestartMode#COMPENSATE}
 *    and {@code forceCleanUp(dryRun)}.
 */
public final class Example05MultiActorOpsHooksAndRecovery {

    private static final String YAML = """
            dfsm: "1.0"
            id: risk-routed-payment
            version: "1.0.0"
            initial: pending
            maxEffectChainDepth: 8
            registry:
              namespace: riskpay
              strict: true
            hooks:
              onStart:
                - auditStart
              afterTransition:
                - auditStep
              onTerminal:
                - auditTerminal
            effects:
              - autoCaptureLowRisk
              - flagHighRiskQueue
            states:
              pending:
                on:
                  AUTHORIZE:
                    target: authorized
                    transition: authorizeCard
                    compensate: voidAuthorization
              authorized:
                entry:
                  - evaluateRiskRouter
                on:
                  AUTO_CAPTURE:
                    target: settled
                    transition: captureFunds
                  ESCALATE_REVIEW:
                    target: manualReview
                    transition: markUnderReview
              manualReview:
                on:
                  APPROVE_MANUAL:
                    target: settled
                    transition: captureFunds
                  REJECT_MANUAL:
                    target: rejected
              settled:
                type: final
              rejected:
                type: final
            """;

    public record PaymentContext(double amount, int riskScore, boolean captured, boolean underReview) {}

    public record AuthorizeInput(double amount, int riskScore) {}

    public static final class RiskPaymentService {
        private final List<String> hookAuditTrail = new ArrayList<>();
        private final List<String> voidedTransactions = new ArrayList<>();

        @DfsmTransition("authorizeCard")
        @CompensateWith("voidAuthorization")
        public TransitionOutput<PaymentContext, String> authorizeCard(
                TransitionRequest<PaymentContext, AuthorizeInput> req
        ) {
            AuthorizeInput in = req.input();
            return TransitionOutput.of(
                    new PaymentContext(in.amount(), in.riskScore(), false, false),
                    "AUTH-" + (int) in.amount()
            );
        }

        @DfsmCompensate("voidAuthorization")
        public void voidAuthorization(CompensationRequest<PaymentContext> req) {
            voidedTransactions.add(req.transactionId());
        }

        @DfsmTransition("captureFunds")
        public TransitionOutput<PaymentContext, Void> captureFunds(TransitionRequest<PaymentContext, Void> req) {
            PaymentContext c = req.data();
            return TransitionOutput.ofContext(new PaymentContext(c.amount(), c.riskScore(), true, false));
        }

        @DfsmTransition("markUnderReview")
        public TransitionOutput<PaymentContext, Void> markUnderReview(TransitionRequest<PaymentContext, Void> req) {
            PaymentContext c = req.data();
            return TransitionOutput.ofContext(new PaymentContext(c.amount(), c.riskScore(), false, true));
        }

        @DfsmEffect("evaluateRiskRouter")
        public void evaluateRiskRouter(EffectRequest<PaymentContext> req) {
            if (req.context().riskScore() < 50) {
                req.runEffect("autoCaptureLowRisk");
            } else {
                req.runEffect("flagHighRiskQueue");
            }
        }

        @DfsmEffect("autoCaptureLowRisk")
        public void autoCaptureLowRisk(EffectRequest<PaymentContext> req) {
            req.actor().transition(req.transactionId(), "AUTO_CAPTURE", null);
        }

        @DfsmEffect("flagHighRiskQueue")
        public void flagHighRiskQueue(EffectRequest<PaymentContext> req) {
            req.actor().transition(req.transactionId(), "ESCALATE_REVIEW", null);
        }

        @DfsmHook("auditStart")
        public void auditStart(OnStartEvent<PaymentContext> ev) {
            hookAuditTrail.add("start:" + ev.transactionId());
        }

        @DfsmHook("auditStep")
        public void auditStep(AfterTransitionEvent<PaymentContext> ev) {
            hookAuditTrail.add("after:" + ev.event() + "->" + ev.currentState().toRaw());
        }

        @DfsmHook("auditTerminal")
        public void auditTerminal(OnTerminalEvent<PaymentContext> ev) {
            hookAuditTrail.add("terminal:" + ev.status() + "@" + ev.finalState().toRaw());
        }

        public List<String> getHookAuditTrail() {
            return List.copyOf(hookAuditTrail);
        }

        public List<String> getVoidedTransactions() {
            return List.copyOf(voidedTransactions);
        }
    }

    public record DemoSummary(
            StateValue lowRiskFinalState,
            TransactionStatus lowRiskStatus,
            StateValue highRiskState,
            TransactionStatus highRiskStatus,
            long activeNonTerminalCount,
            StatusBreakdown statusBreakdown,
            TerminalStatesInfo terminalStates,
            SweepReport crashRecoverySweepReport,
            ForceCleanUpReport dryRunCleanUpReport,
            List<String> hookAuditTrail,
            List<String> voidedTransactions
    ) {}

    private Example05MultiActorOpsHooksAndRecovery() {}

    public static DemoSummary runDemo() {
        H2StateStore store = new H2StateStore();
        Clock.VirtualClock clock = new Clock.VirtualClock(10_000L);
        FSMRegistry registry = new FSMRegistry(store, BenchmarkLogEngine.noop(), clock, PartialTransitionPolicy.EMPTY, null);

        RiskPaymentService service = new RiskPaymentService();
        registry.registerYaml(YAML, MachineHandlerBindings.ofServices(service));

        DfsmActor<PaymentContext> actorA = registry.createActor(
                "risk-routed-payment",
                PaymentContext.class,
                ActorConfig.<PaymentContext>builder()
                        .actorId("payment-worker-a")
                        .recovery(new RecoveryConfig(false, 30_000L, OnRestartMode.STOP, Map.of()))
                        .build()
        );

        // 1. Low-risk order (score 15) -> AUTHORIZE enters 'authorized', entry effect chains AUTO_CAPTURE -> 'settled' (COMPLETED)!
        String txLow = actorA.startTransaction(new PaymentContext(0, 0, false, false));
        actorA.transition(txLow, "AUTHORIZE", new AuthorizeInput(45.0, 15));
        var lowSnap = actorA.getTransaction(txLow);

        // 2. High-risk order (score 85) -> AUTHORIZE chains ESCALATE_REVIEW -> pauses in non-terminal 'manualReview' (IDLE)!
        String txHigh = actorA.startTransaction(new PaymentContext(0, 0, false, false));
        actorA.transition(txHigh, "AUTHORIZE", new AuthorizeInput(4_200.0, 85));
        var highSnap = actorA.getTransaction(txHigh);

        long activeCount = actorA.getActiveCount(); // 1 (txHigh in manualReview; txLow is COMPLETED!)
        StatusBreakdown breakdown = actorA.getStatusBreakdown();
        TerminalStatesInfo terminalStates = actorA.getTerminalStates();

        // 3. Simulate a crashed worker leaving a transaction stuck IN_FLIGHT with a Saga step on disk
        String stuckTxId = "tx-crashed-900";
        PaymentContext stuckCtx = new PaymentContext(999.0, 20, false, false);
        store.createTransaction(new TransactionRecord<>(
                stuckTxId,
                "risk-routed-payment",
                "1.0.0",
                "payment-worker-dead",
                StateValue.of("authorized"),
                stuckCtx,
                TransactionStatus.IDLE,
                null,
                null,
                1L,
                null,
                null,
                10_000L,
                10_000L
        ));
        // Append Saga step & mark IN_FLIGHT at t=10_100
        store.updateTransaction(
                stuckTxId,
                1L,
                TransactionPatch.<PaymentContext>builder(10_100L)
                        .status(TransactionStatus.IN_FLIGHT)
                        .activeStep(new ActiveStepInfo("AUTO_CAPTURE", null, 10_100L))
                        .lease("payment-worker-dead", 40_100L)
                        .build(),
                List.of(new NewCompensationEntry(
                        stuckTxId,
                        "riskpay.authorizeCard",
                        "riskpay.voidAuthorization",
                        StateValue.of("pending"),
                        new AuthorizeInput(999.0, 20),
                        new PaymentContext(0, 0, false, false),
                        10_050L
                ))
        );

        // Advance virtual clock past stuckThresholdMs (30_000 ms)
        clock.advance(60_000L);

        ForceCleanUpReport dryRun = actorA.forceCleanUp(new ForceCleanUpOptions(
                ForceCleanUpAction.COMPENSATE,
                List.of(),
                true,
                true,
                null,
                true,
                100
        ));

        // Spin up secondary recovery worker with OnRestartMode.COMPENSATE -> sweep unwinds stuckTxId!
        DfsmActor<PaymentContext> recoveryActor = registry.createActor(
                "risk-routed-payment",
                PaymentContext.class,
                ActorConfig.<PaymentContext>builder()
                        .actorId("payment-recovery-worker")
                        .recovery(new RecoveryConfig(false, 30_000L, OnRestartMode.COMPENSATE, Map.of()))
                        .scheduler(new SchedulerConfig(false, 15_000L, 30_000L, null, 100))
                        .build()
        );
        SweepReport sweepReport = recoveryActor.triggerSweepNow();

        registry.shutdown();
        return new DemoSummary(
                lowSnap.stateValue(),
                lowSnap.status(),
                highSnap.stateValue(),
                highSnap.status(),
                activeCount,
                breakdown,
                terminalStates,
                sweepReport,
                dryRun,
                service.getHookAuditTrail(),
                service.getVoidedTransactions()
        );
    }

    public static void main(String[] args) {
        DemoSummary summary = runDemo();
        System.out.println("=== Example 05: Multi-Actor Ops, YAML Hooks, Effect Router & Crash Recovery ===");
        System.out.println("Low-Risk Final State       : " + summary.lowRiskFinalState() + " (" + summary.lowRiskStatus() + ")");
        System.out.println("High-Risk Resting State    : " + summary.highRiskState() + " (" + summary.highRiskStatus() + ")");
        System.out.println("Active Non-Terminal Count  : " + summary.activeNonTerminalCount());
        System.out.println("Status Breakdown           : " + summary.statusBreakdown());
        System.out.println("Terminal States            : " + summary.terminalStates().topLevelTerminalStates());
        System.out.println("Dry-Run CleanUp Matched    : " + summary.dryRunCleanUpReport().matchedCount());
        System.out.println("Recovery Sweep Report      : " + summary.crashRecoverySweepReport());
        System.out.println("Voided Stuck Transactions  : " + summary.voidedTransactions());
        System.out.println("Hook Audit Trail           : " + summary.hookAuditTrail());
    }
}
