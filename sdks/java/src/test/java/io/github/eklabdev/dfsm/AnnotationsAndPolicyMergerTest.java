package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.annotation.Backoff;
import io.github.eklabdev.dfsm.annotation.CompensateWith;
import io.github.eklabdev.dfsm.annotation.DfsmCompensate;
import io.github.eklabdev.dfsm.annotation.DfsmTransition;
import io.github.eklabdev.dfsm.annotation.OnFail;
import io.github.eklabdev.dfsm.annotation.Retry;
import io.github.eklabdev.dfsm.annotation.TransitionDecoratorBuilder;
import io.github.eklabdev.dfsm.error.UnregisteredHandlerException;
import io.github.eklabdev.dfsm.error.ValidationException;
import io.github.eklabdev.dfsm.policy.BackoffStrategy;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.runtime.MachineHandlerBindings;
import io.github.eklabdev.dfsm.store.H2StateStore;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AnnotationsAndPolicyMergerTest {

    public record PaymentCtx(@NotBlank String currency, @Min(0) int totalCents) {}

    public record ChargeInput(@NotBlank String cardToken, @Min(100) int amountCents) {}

    public static class AnnotatedPaymentHandlers {
        final AtomicInteger callCount = new AtomicInteger();
        final AtomicInteger compensateCount = new AtomicInteger();

        @DfsmTransition("chargeCard")
        @Retry(maxAttempts = 4) // Overrides YAML retry: 3 -> single loop of 4 attempts!
        @Backoff(strategy = BackoffStrategy.FIXED, initialDelayMs = 10, maxDelayMs = 10)
        @OnFail(compensate = false, target = "manualQueue")
        @CompensateWith("refundCard")
        public TransitionOutput<PaymentCtx, String> chargeCard(TransitionRequest<PaymentCtx, ChargeInput> req) {
            int attempt = callCount.incrementAndGet();
            if ("tok_always_fail".equals(req.input().cardToken())) {
                throw new RuntimeException("Gateway timeout on attempt " + attempt);
            }
            return TransitionOutput.of(
                    new PaymentCtx(req.data().currency(), req.data().totalCents() + req.input().amountCents()),
                    "ch_" + attempt
            );
        }

        @DfsmCompensate("refundCard")
        public void refundCard(CompensationRequest<PaymentCtx> req) {
            compensateCount.incrementAndGet();
        }
    }

    @Test
    void mergesCodeAnnotationOverYamlWithoutNestedRetryMultiplication() {
        String yaml = """
                dfsm: "1.0"
                id: policy-dedup-test
                version: "1.0.0"
                initial: ready
                registry:
                  namespace: pay
                  strict: true
                states:
                  ready:
                    on:
                      CHARGE:
                        target: paid
                        transition: chargeCard
                        retry:
                          maxAttempts: 3
                        circuitBreaker:
                          enabled: true
                          failureThreshold: 5
                          slidingWindowSize: 10
                          openDurationMs: 30000
                          halfOpenMaxCalls: 1
                  manualQueue:
                    on:
                      ABORT: cancelled
                  paid:
                    type: final
                  cancelled:
                    type: final
                """;

        Clock.VirtualClock clock = new Clock.VirtualClock(5_000L);
        FSMRegistry registry = new FSMRegistry(
                new H2StateStore(), BenchmarkLogEngine.noop(), clock, PartialTransitionPolicy.EMPTY, null
        );
        AnnotatedPaymentHandlers svc = new AnnotatedPaymentHandlers();
        registry.registerYaml(yaml, MachineHandlerBindings.ofServices(svc));

        DfsmActor<PaymentCtx> actor = registry.createActor("policy-dedup-test", PaymentCtx.class);
        var eff = actor.getEffectiveConfig().transitions().stream()
                .filter(t -> "CHARGE".equals(t.event()))
                .findFirst()
                .orElseThrow();

        // Code @Retry(4) wins over YAML retry: 3; YAML circuitBreaker: enabled=true is preserved!
        assertThat(eff.policy().retry().maxAttempts()).isEqualTo(4);
        assertThat(eff.policy().circuitBreaker().enabled()).isTrue();
        assertThat(eff.policy().onFail().target()).isEqualTo("manualQueue");

        String txId = actor.startTransaction(new PaymentCtx("USD", 0));
        var res = actor.transition(txId, "CHARGE", new ChargeInput("tok_always_fail", 500));

        // Exactly 4 attempts (single normalized loop, NOT 4 * 3 = 12!)
        assertThat(svc.callCount.get()).isEqualTo(4);
        assertThat(res.currentState()).isEqualTo(StateValue.of("manualQueue"));
        assertThat(res.status()).isEqualTo(TransactionStatus.IDLE);

        registry.shutdown();
    }

    @Test
    void jakartaValidationFailsPreFlightWithZeroRetriesAndThrowsOnMissingHandler() {
        String yaml = """
                dfsm: "1.0"
                id: strict-validation-test
                version: "1.0.0"
                initial: ready
                registry:
                  namespace: pay
                  strict: true
                states:
                  ready:
                    on:
                      CHARGE:
                        target: paid
                        transition: chargeCard
                  paid:
                    type: final
                """;

        // 1. Strict mode rejects unregistered handler immediately at registerYaml(..., bindings) / createActor
        FSMRegistry emptyRegistry = new FSMRegistry();
        assertThatThrownBy(() -> emptyRegistry.registerYaml(yaml, MachineHandlerBindings.builder().build()))
                .isInstanceOf(UnregisteredHandlerException.class)
                .hasMessageContaining("pay.chargeCard");
        emptyRegistry.shutdown();

        // 2. Functional TransitionDecoratorBuilder + Jakarta pre-flight validation
        AtomicInteger executionCounter = new AtomicInteger();
        var decorated = TransitionDecoratorBuilder.<PaymentCtx, ChargeInput, String>of(req -> {
                    executionCounter.incrementAndGet();
                    return TransitionOutput.of(
                            new PaymentCtx(req.data().currency(), req.input().amountCents()),
                            "ok"
                    );
                })
                .named("pay.chargeCard")
                .inputType(ChargeInput.class)
                .retry(5)
                .build();

        FSMRegistry registry = new FSMRegistry();
        registry.registerTransition(decorated);
        registry.registerYaml(yaml);

        DfsmActor<PaymentCtx> actor = registry.createActor("strict-validation-test", PaymentCtx.class);

        // Invalid initial TContext (blank currency) rejected at startTransaction
        assertThatThrownBy(() -> actor.startTransaction(new PaymentCtx("", 0)))
                .isInstanceOf(ValidationException.class);

        String txId = actor.startTransaction(new PaymentCtx("USD", 0));

        // Invalid TInput (amountCents < 100) rejected pre-flight BEFORE retry loop!
        assertThatThrownBy(() -> actor.transition(txId, "CHARGE", new ChargeInput("tok_live", 25)))
                .isInstanceOf(ValidationException.class);
        assertThat(executionCounter.get()).isZero();
        assertThat(actor.getTransaction(txId).stateValue()).isEqualTo(StateValue.of("ready"));

        // Valid TInput succeeds cleanly
        var ok = actor.transition(txId, "CHARGE", new ChargeInput("tok_live", 2500));
        assertThat(ok.currentState()).isEqualTo(StateValue.of("paid"));
        assertThat(executionCounter.get()).isEqualTo(1);

        registry.shutdown();
    }
}
