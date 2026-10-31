package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.annotation.TransitionDecoratorBuilder;
import io.github.eklabdev.dfsm.policy.BackoffStrategy;
import io.github.eklabdev.dfsm.policy.CircuitBreakerInstance;
import io.github.eklabdev.dfsm.policy.CircuitStatus;
import io.github.eklabdev.dfsm.policy.NormalizedTransitionPolicy;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.policy.RetryExecutor;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.store.H2StateStore;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

class ResilienceAndSagaTest {

    @Test
    void computesDeterministicBackoffDelaysAndTransitionsCircuitBreakerLifecycle() {
        var expBackoff = new NormalizedTransitionPolicy.BackoffPolicy(
                BackoffStrategy.EXPONENTIAL, 100L, 1_000L, 2.0
        );
        assertThat(RetryExecutor.computeDelayMs(expBackoff, 1)).isEqualTo(100L);
        assertThat(RetryExecutor.computeDelayMs(expBackoff, 2)).isEqualTo(200L);
        assertThat(RetryExecutor.computeDelayMs(expBackoff, 3)).isEqualTo(400L);
        assertThat(RetryExecutor.computeDelayMs(expBackoff, 5)).isEqualTo(1_000L); // capped at maxDelayMs

        Clock.VirtualClock clock = new Clock.VirtualClock(0L);
        CircuitBreakerInstance cb = new CircuitBreakerInstance(
                "gateway-cb",
                new NormalizedTransitionPolicy.CircuitBreakerPolicy(true, 2, 4, 5_000L, 1),
                clock
        );

        assertThat(cb.getStatus()).isEqualTo(CircuitStatus.CLOSED);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> cb.execute(() -> {
            throw new RuntimeException("boom 1");
        })).isInstanceOf(RuntimeException.class);
        assertThat(cb.getStatus()).isEqualTo(CircuitStatus.CLOSED);

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> cb.execute(() -> {
            throw new RuntimeException("boom 2");
        })).isInstanceOf(RuntimeException.class);
        // 2 failures reached threshold=2 -> OPEN!
        assertThat(cb.getStatus()).isEqualTo(CircuitStatus.OPEN);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> cb.execute(() -> "blocked"))
                .isInstanceOf(io.github.eklabdev.dfsm.error.CircuitOpenException.class);

        // Advance virtual clock past openDurationMs (5,000 ms) -> HALF_OPEN!
        clock.advance(5_001L);
        assertThat(cb.getStatus()).isEqualTo(CircuitStatus.HALF_OPEN);

        assertThat(cb.execute(() -> "recovered")).isEqualTo("recovered");
        assertThat(cb.getStatus()).isEqualTo(CircuitStatus.CLOSED);
    }

    @Test
    void unwindsSagaStackInStrictLifoOrderAndSupportsCustomErrorRecovery() {
        String yaml = """
                dfsm: "1.0"
                id: saga-custom-error
                version: "1.0.0"
                initial: reserveInventory
                registry:
                  strict: true
                states:
                  reserveInventory:
                    on:
                      RESERVE:
                        target: chargePayment
                        transition: doReserve
                        compensate: undoReserve
                  chargePayment:
                    on:
                      CHARGE:
                        target: createShipment
                        transition: doCharge
                        compensate: undoCharge
                  createShipment:
                    on:
                      SHIP:
                        target: completed
                        transition: doShip
                        compensate: undoShip
                        retry:
                          maxAttempts: 2
                        onFail:
                          compensate: true
                          target: error
                  completed:
                    type: final
                  error:
                    on:
                      RESET_ORDER:
                        target: reserveInventory
                """;

        List<String> log = new ArrayList<>();
        AtomicBoolean shipShouldFail = new AtomicBoolean(true);

        Clock.VirtualClock clock = new Clock.VirtualClock(1_000L);
        FSMRegistry registry = new FSMRegistry(
                new H2StateStore(), BenchmarkLogEngine.noop(), clock, PartialTransitionPolicy.EMPTY, null
        );

        registry.registerTransition("doReserve", req -> {
            log.add("doReserve");
            return TransitionOutput.ofContext(Map.of("reserved", true));
        });
        registry.registerCompensate("undoReserve", req -> log.add("undoReserve"));

        registry.registerTransition("doCharge", req -> {
            log.add("doCharge");
            return TransitionOutput.ofContext(Map.of("reserved", true, "charged", true));
        });
        registry.registerCompensate("undoCharge", req -> log.add("undoCharge"));

        registry.registerTransition(TransitionDecoratorBuilder.<Map, Object, Object>of(req -> {
                    log.add("doShip");
                    if (shipShouldFail.get()) {
                        throw new RuntimeException("Carrier API down");
                    }
                    return TransitionOutput.ofContext(Map.of("shipped", true));
                })
                .named("doShip")
                .build());
        registry.registerCompensate("undoShip", req -> log.add("undoShip"));

        registry.registerYaml(yaml);
        DfsmActor<Map> actor = registry.createActor("saga-custom-error", Map.class);

        String txId = actor.startTransaction(Map.of());
        actor.transition(txId, "RESERVE", null);
        actor.transition(txId, "CHARGE", null);
        var failed = actor.transition(txId, "SHIP", null);

        // 2 attempts on doShip, then LIFO unwind: undoCharge -> undoReserve (undoShip never succeeded so not on stack!)
        assertThat(log).containsExactly(
                "doReserve", "doCharge", "doShip", "doShip", "undoCharge", "undoReserve"
        );
        assertThat(failed.currentState()).isEqualTo(StateValue.of("error"));
        assertThat(failed.compensatedSteps()).isEqualTo(2);
        assertThat(failed.status()).isEqualTo(TransactionStatus.COMPENSATED);

        // Recover out of custom error state and succeed!
        shipShouldFail.set(false);
        actor.transition(txId, "RESET_ORDER", null);
        actor.transition(txId, "RESERVE", null);
        actor.transition(txId, "CHARGE", null);
        var completed = actor.transition(txId, "SHIP", null);
        assertThat(completed.currentState()).isEqualTo(StateValue.of("completed"));
        assertThat(completed.status()).isEqualTo(TransactionStatus.COMPLETED);

        registry.shutdown();
    }
}
