package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.ActorLifecycleHooks.AfterTransitionEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.BeforeTransitionEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnCompensateEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnCompleteEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnStartEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnTerminalEvent;
import io.github.eklabdev.dfsm.DfsmModels.StatusBreakdown;
import io.github.eklabdev.dfsm.DfsmModels.TerminalStatesInfo;
import io.github.eklabdev.dfsm.annotation.DfsmCompensate;
import io.github.eklabdev.dfsm.annotation.DfsmEffect;
import io.github.eklabdev.dfsm.annotation.DfsmHook;
import io.github.eklabdev.dfsm.annotation.DfsmTransition;
import io.github.eklabdev.dfsm.error.MaxEffectChainDepthException;
import io.github.eklabdev.dfsm.error.UnregisteredHandlerException;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.runtime.MachineHandlerBindings;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HooksAndEffectChainingTest {

    public record OrderCtx(int amount, boolean vip, boolean captured, boolean manualReview) {}

    public static class YamlOrderBindingsService {
        final List<String> timeline = new ArrayList<>();

        @DfsmTransition("submitOrder")
        public TransitionOutput<OrderCtx, Void> submitOrder(TransitionRequest<OrderCtx, Map<String, Object>> req) {
            int amt = ((Number) req.input().get("amount")).intValue();
            boolean vip = Boolean.TRUE.equals(req.input().get("vip"));
            timeline.add("tx:submitOrder");
            return TransitionOutput.ofContext(new OrderCtx(amt, vip, false, false));
        }

        @DfsmCompensate("undoSubmit")
        public void undoSubmit(CompensationRequest<OrderCtx> req) {
            timeline.add("comp:undoSubmit");
        }

        @DfsmTransition("autoCapture")
        public TransitionOutput<OrderCtx, Void> autoCapture(TransitionRequest<OrderCtx, Void> req) {
            if (req.data().amount() > 10_000) {
                throw new RuntimeException("Amount exceeds auto-capture ceiling");
            }
            timeline.add("tx:autoCapture");
            return TransitionOutput.ofContext(new OrderCtx(req.data().amount(), req.data().vip(), true, false));
        }

        @DfsmTransition("routeManual")
        public TransitionOutput<OrderCtx, Void> routeManual(TransitionRequest<OrderCtx, Void> req) {
            timeline.add("tx:routeManual");
            return TransitionOutput.ofContext(new OrderCtx(req.data().amount(), req.data().vip(), false, true));
        }

        @DfsmEffect("decideNextStep")
        public void decideNextStep(EffectRequest<OrderCtx> req) {
            timeline.add("effect:decideNextStep");
            if (req.context().vip() || req.context().amount() <= 500) {
                req.runEffect("triggerAutoCapture");
            } else {
                req.runEffect("triggerManualReview");
            }
        }

        @DfsmEffect("triggerAutoCapture")
        public void triggerAutoCapture(EffectRequest<OrderCtx> req) {
            timeline.add("effect:triggerAutoCapture");
            req.actor().transition(req.transactionId(), "CAPTURE_PAYMENT", null);
        }

        @DfsmEffect("triggerManualReview")
        public void triggerManualReview(EffectRequest<OrderCtx> req) {
            timeline.add("effect:triggerManualReview");
            req.actor().transition(req.transactionId(), "SEND_TO_REVIEW", null);
        }

        @DfsmHook("onTxStart")
        public void onTxStart(OnStartEvent<OrderCtx> ev) {
            timeline.add("hook:onStart:" + ev.initialState().asLeaf());
        }

        @DfsmHook("beforeStep")
        public void beforeStep(BeforeTransitionEvent<OrderCtx> ev) {
            timeline.add("hook:before:" + ev.event());
        }

        @DfsmHook("afterStep")
        public void afterStep(AfterTransitionEvent<OrderCtx> ev) {
            timeline.add("hook:after:" + ev.event() + "->" + ev.currentState().asLeaf());
        }

        @DfsmHook("onComp")
        public void onComp(OnCompensateEvent<OrderCtx> ev) {
            timeline.add("hook:onCompensate:" + ev.compensateHandler());
        }

        @DfsmHook("onDoneComplete")
        public void onDoneComplete(OnCompleteEvent<OrderCtx> ev) {
            timeline.add("hook:onComplete:" + ev.finalState().asLeaf());
        }

        @DfsmHook("onTerm")
        public void onTerm(OnTerminalEvent<OrderCtx> ev) {
            timeline.add("hook:onTerminal:" + ev.status() + "@" + ev.finalState().asLeaf());
        }
    }

    private static final String YAML = """
            dfsm: "1.0"
            id: yaml-hooks-effect-router
            version: "1.0.0"
            initial: draft
            maxEffectChainDepth: 6
            registry:
              namespace: shop
              strict: true
            hooks:
              onStart: [onTxStart]
              beforeTransition: [beforeStep]
              afterTransition: [afterStep]
              onCompensate: [onComp]
              onComplete: [onDoneComplete]
              onTerminal: [onTerm]
            effects:
              - triggerAutoCapture
              - triggerManualReview
            states:
              draft:
                on:
                  SUBMIT:
                    target: triage
                    transition: submitOrder
                    compensate: undoSubmit
              triage:
                entry: [decideNextStep]
                on:
                  CAPTURE_PAYMENT:
                    target: fulfilled
                    transition: autoCapture
                    onFail:
                      compensate: true
                      target: error
                  SEND_TO_REVIEW:
                    target: awaitingAgent
                    transition: routeManual
              awaitingAgent:
                on:
                  AGENT_APPROVE:
                    target: fulfilled
                    transition: autoCapture
              fulfilled:
                type: final
            """;

    @Test
    void executesAllSixYamlHooksConditionalEffectChainingAndActiveTerminalQueries() {
        FSMRegistry registry = new FSMRegistry();
        YamlOrderBindingsService svc = new YamlOrderBindingsService();

        registry.registerYaml(YAML, MachineHandlerBindings.ofServices(svc));
        DfsmActor<OrderCtx> actor = registry.createActor("yaml-hooks-effect-router", OrderCtx.class);

        // 1. Low-value order ($120) -> SUBMIT -> triage -> decideNextStep -> triggerAutoCapture -> CAPTURE_PAYMENT -> fulfilled!
        String tx1 = actor.startTransaction(new OrderCtx(0, false, false, false));
        actor.transition(tx1, "SUBMIT", Map.of("amount", 120, "vip", false));

        var snap1 = actor.getTransaction(tx1);
        assertThat(snap1.stateValue()).isEqualTo(StateValue.of("fulfilled"));
        assertThat(snap1.status()).isEqualTo(TransactionStatus.COMPLETED);

        // Verify strict chronological causal order of hooks, transitions, and chained effects!
        assertThat(svc.timeline).containsExactly(
                "hook:onStart:draft",
                "hook:before:SUBMIT",
                "tx:submitOrder",
                "hook:after:SUBMIT->triage",
                "effect:decideNextStep",
                "effect:triggerAutoCapture",
                "hook:before:CAPTURE_PAYMENT",
                "tx:autoCapture",
                "hook:after:CAPTURE_PAYMENT->fulfilled",
                "hook:onComplete:fulfilled",
                "hook:onTerminal:COMPLETED@fulfilled"
        );
        svc.timeline.clear();

        // 2. High-value non-VIP ($2,500) -> pauses in non-terminal 'awaitingAgent' (IDLE)
        String tx2 = actor.startTransaction(new OrderCtx(0, false, false, false));
        actor.transition(tx2, "SUBMIT", Map.of("amount", 2_500, "vip", false));
        assertThat(actor.getTransaction(tx2).stateValue()).isEqualTo(StateValue.of("awaitingAgent"));
        assertThat(actor.getTransaction(tx2).status()).isEqualTo(TransactionStatus.IDLE);

        // 3. VIP over ceiling ($25,000, vip=true) -> autoCapture fails -> compensates undoSubmit -> COMPENSATED @ error!
        String tx3 = actor.startTransaction(new OrderCtx(0, false, false, false));
        actor.transition(tx3, "SUBMIT", Map.of("amount", 25_000, "vip", true));
        assertThat(actor.getTransaction(tx3).stateValue()).isEqualTo(StateValue.of("error"));
        assertThat(actor.getTransaction(tx3).status()).isEqualTo(TransactionStatus.COMPENSATED);
        assertThat(svc.timeline).contains(
                "comp:undoSubmit",
                "hook:onCompensate:shop.undoSubmit",
                "hook:onTerminal:COMPENSATED@error"
        );

        // 4. Verify Non-Terminal ("Active") vs. Terminal State Inspection APIs
        assertThat(actor.getActiveCount()).isEqualTo(1L); // Only tx2 is active (IDLE in awaitingAgent)!
        assertThat(actor.listActiveTransactions()).extracting(DfsmModels.TransactionSummary::transactionId)
                .containsExactly(tx2);

        StatusBreakdown breakdown = actor.getStatusBreakdown();
        assertThat(breakdown.nonTerminalCount()).isEqualTo(1L);
        assertThat(breakdown.terminalCount()).isEqualTo(2L);
        assertThat(breakdown.byStatus().get(TransactionStatus.IDLE)).isEqualTo(1L);
        assertThat(breakdown.byStatus().get(TransactionStatus.COMPLETED)).isEqualTo(1L);
        assertThat(breakdown.byStatus().get(TransactionStatus.COMPENSATED)).isEqualTo(1L);

        TerminalStatesInfo termInfo = actor.getTerminalStates();
        assertThat(termInfo.topLevelTerminalStates()).containsExactlyInAnyOrder("fulfilled", "error");
        assertThat(termInfo.errorStateMode()).isEqualTo("implicit_default");
        assertThat(termInfo.errorStateIsFinal()).isTrue();

        registry.shutdown();
    }

    @Test
    void enforcesStrictYamlHookValidationAndMaxEffectChainDepthLoopGuard() {
        // 1. Missing YAML hook throws UnregisteredHandlerException at registration time
        FSMRegistry badReg = new FSMRegistry();
        assertThatThrownBy(() -> badReg.registerYaml(YAML, MachineHandlerBindings.builder().build()))
                .isInstanceOf(UnregisteredHandlerException.class);
        badReg.shutdown();

        // 2. Infinite effect ping-pong stops cleanly with MaxEffectChainDepthException
        String loopYaml = """
                dfsm: "1.0"
                id: infinite-ping-pong
                version: "1.0.0"
                initial: ping
                maxEffectChainDepth: 3
                states:
                  ping:
                    entry: [bounceToPong]
                    on:
                      TO_PONG: pong
                  pong:
                    entry: [bounceToPing]
                    on:
                      TO_PING: ping
                """;

        FSMRegistry loopReg = new FSMRegistry();
        loopReg.registerEffect("bounceToPong", req -> req.actor().transition(req.transactionId(), "TO_PONG", null));
        loopReg.registerEffect("bounceToPing", req -> req.actor().transition(req.transactionId(), "TO_PING", null));
        loopReg.registerYaml(loopYaml);

        DfsmActor<Map> actor = loopReg.createActor("infinite-ping-pong", Map.class);
        assertThatThrownBy(() -> actor.startTransaction(Map.of()))
                .isInstanceOf(MaxEffectChainDepthException.class)
                .hasMessageContaining("3");

        loopReg.shutdown();
    }
}
