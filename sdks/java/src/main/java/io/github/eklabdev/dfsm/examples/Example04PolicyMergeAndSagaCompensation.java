package io.github.eklabdev.dfsm.examples;

import io.github.eklabdev.dfsm.Clock;
import io.github.eklabdev.dfsm.CompensationRequest;
import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.TransitionOutput;
import io.github.eklabdev.dfsm.TransitionRequest;
import io.github.eklabdev.dfsm.annotation.Backoff;
import io.github.eklabdev.dfsm.annotation.Benchmark;
import io.github.eklabdev.dfsm.annotation.CompensateWith;
import io.github.eklabdev.dfsm.annotation.DfsmCompensate;
import io.github.eklabdev.dfsm.annotation.DfsmTransition;
import io.github.eklabdev.dfsm.annotation.OnFail;
import io.github.eklabdev.dfsm.annotation.Retry;
import io.github.eklabdev.dfsm.policy.BackoffStrategy;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.runtime.MachineHandlerBindings;
import io.github.eklabdev.dfsm.store.H2StateStore;
import io.github.eklabdev.dfsm.telemetry.TransitionBenchmarkRecord;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Progressive Example 04 (Policy Normalization Deduplicator + LIFO Saga Rollback + Benchmark Telemetry):
 * Demonstrates:
 * 1) {@code Code Decorator > YAML} policy merger: YAML specifies {@code retry.maxAttempts: 3} + {@code circuitBreaker},
 *    while Java {@code @Retry(maxAttempts = 4)} overrides {@code retry} to a SINGLE loop of 4 attempts (never 4*3=12)
 *    while preserving YAML's {@code circuitBreaker};
 * 2) Multi-step distributed Saga unwinding in strict LIFO order ({@code cancelHotel -> cancelFlight});
 * 3) Pluggable {@code BenchmarkLogEngine} capturing structured timing &amp; attempt telemetry.
 */
public final class Example04PolicyMergeAndSagaCompensation {

    private static final String YAML = """
            dfsm: "1.0"
            id: travel-booking-saga
            version: "1.0.0"
            initial: idle
            registry:
              namespace: travel
              strict: true
            states:
              idle:
                on:
                  BOOK_FLIGHT:
                    target: flightBooked
                    transition: bookFlight
              flightBooked:
                on:
                  BOOK_HOTEL:
                    target: hotelBooked
                    transition: bookHotel
              hotelBooked:
                on:
                  BOOK_CAR:
                    target: confirmed
                    transition: bookCar
                    retry:
                      maxAttempts: 3
                    circuitBreaker:
                      enabled: true
                      failureThreshold: 5
                      slidingWindowSize: 10
                      openDurationMs: 60000
                      halfOpenMaxCalls: 1
              confirmed:
                type: final
            """;

    public record TravelContext(String flightPnr, String hotelConf, String carRentalId) {}

    public record CarBookingInput(boolean simulateProviderOutage) {}

    public static final class TravelSagaService {
        private final AtomicInteger carAttempts = new AtomicInteger();
        private final List<String> rollbackOrder = new ArrayList<>();

        @DfsmTransition("bookFlight")
        @CompensateWith("cancelFlight")
        @Benchmark
        public TransitionOutput<TravelContext, String> bookFlight(TransitionRequest<TravelContext, Void> req) {
            TravelContext c = req.data();
            return TransitionOutput.of(new TravelContext("PNR-8821", c.hotelConf(), c.carRentalId()), "PNR-8821");
        }

        @DfsmCompensate("cancelFlight")
        public void cancelFlight(CompensationRequest<TravelContext> req) {
            rollbackOrder.add("cancelFlight");
        }

        @DfsmTransition("bookHotel")
        @CompensateWith("cancelHotel")
        @Benchmark
        public TransitionOutput<TravelContext, String> bookHotel(TransitionRequest<TravelContext, Void> req) {
            TravelContext c = req.data();
            return TransitionOutput.of(new TravelContext(c.flightPnr(), "HTL-9940", c.carRentalId()), "HTL-9940");
        }

        @DfsmCompensate("cancelHotel")
        public void cancelHotel(CompensationRequest<TravelContext> req) {
            rollbackOrder.add("cancelHotel");
        }

        @DfsmTransition("bookCar")
        @Retry(maxAttempts = 4) // Overrides YAML's maxAttempts: 3 -> single loop of 4 attempts!
        @Backoff(strategy = BackoffStrategy.EXPONENTIAL, initialDelayMs = 50, maxDelayMs = 500, multiplier = 2.0)
        @OnFail(compensate = true, target = "error")
        @CompensateWith("cancelCar")
        @Benchmark
        public TransitionOutput<TravelContext, String> bookCar(TransitionRequest<TravelContext, CarBookingInput> req) {
            carAttempts.incrementAndGet();
            if (req.input() != null && req.input().simulateProviderOutage()) {
                throw new IllegalStateException("Car rental gateway HTTP 503");
            }
            TravelContext c = req.data();
            return TransitionOutput.of(new TravelContext(c.flightPnr(), c.hotelConf(), "CAR-301"), "CAR-301");
        }

        @DfsmCompensate("cancelCar")
        public void cancelCar(CompensationRequest<TravelContext> req) {
            rollbackOrder.add("cancelCar");
        }

        public int getCarAttempts() {
            return carAttempts.get();
        }

        public List<String> getRollbackOrder() {
            return List.copyOf(rollbackOrder);
        }
    }

    public record DemoSummary(
            int mergedMaxAttempts,
            boolean mergedCircuitBreakerEnabled,
            int actualCarAttemptsExecuted,
            List<String> lifoRollbackOrder,
            StateValue finalState,
            TransactionStatus finalStatus,
            List<TransitionBenchmarkRecord> benchmarks
    ) {}

    private Example04PolicyMergeAndSagaCompensation() {}

    public static DemoSummary runDemo() {
        List<TransitionBenchmarkRecord> benchmarks = new ArrayList<>();
        Clock.VirtualClock clock = new Clock.VirtualClock(1_000_000L);
        FSMRegistry registry = new FSMRegistry(
                new H2StateStore(),
                benchmarks::add,
                clock,
                PartialTransitionPolicy.EMPTY,
                null
        );

        TravelSagaService sagaService = new TravelSagaService();
        registry.registerYaml(YAML, MachineHandlerBindings.ofServices(sagaService));

        DfsmActor<TravelContext> actor = registry.createActor("travel-booking-saga", TravelContext.class);

        var bookCarEffective = actor.getEffectiveConfig().transitions().stream()
                .filter(t -> "BOOK_CAR".equals(t.event()))
                .findFirst()
                .orElseThrow();

        String txId = actor.startTransaction(new TravelContext(null, null, null));
        actor.transition(txId, "BOOK_FLIGHT", null);
        actor.transition(txId, "BOOK_HOTEL", null);
        var failedCar = actor.transition(txId, "BOOK_CAR", new CarBookingInput(true));

        registry.shutdown();
        return new DemoSummary(
                bookCarEffective.policy().retry().maxAttempts(),
                bookCarEffective.policy().circuitBreaker().enabled(),
                sagaService.getCarAttempts(),
                sagaService.getRollbackOrder(),
                failedCar.currentState(),
                failedCar.status(),
                List.copyOf(benchmarks)
        );
    }

    public static void main(String[] args) {
        DemoSummary summary = runDemo();
        System.out.println("=== Example 04: Policy Normalization & LIFO Saga Compensation ===");
        System.out.println("Effective Retry MaxAttempts : " + summary.mergedMaxAttempts() + " (Code @Retry(4) > YAML 3)");
        System.out.println("Effective CircuitBreaker    : " + summary.mergedCircuitBreakerEnabled() + " (Inherited from YAML)");
        System.out.println("Actual Car Attempts Run     : " + summary.actualCarAttemptsExecuted());
        System.out.println("LIFO Saga Rollback Order    : " + summary.lifoRollbackOrder());
        System.out.println("Final State / Status        : " + summary.finalState() + " / " + summary.finalStatus());
        System.out.println("Benchmark Records Captured  : " + summary.benchmarks().size());
    }
}
