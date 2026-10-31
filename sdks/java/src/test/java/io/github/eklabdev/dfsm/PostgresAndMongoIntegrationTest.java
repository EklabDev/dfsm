package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.error.StaleTransactionVersionException;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.store.MongoStateStore;
import io.github.eklabdev.dfsm.store.PostgresStateStore;
import io.github.eklabdev.dfsm.store.StateStore;
import io.github.eklabdev.dfsm.store.StateStore.TransactionPatch;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Live durable persistence &amp; Saga integration tests against Docker PostgreSQL 17 and MongoDB 8.0.
 */
class PostgresAndMongoIntegrationTest {

    private static final String SAGA_PARALLEL_YAML = """
            dfsm: "1.0"
            id: durable-store-e2e
            version: "1.0.0"
            initial: step1
            registry:
              namespace: dbtest
              strict: true
            states:
              step1:
                on:
                  RESERVE:
                    target: parallelWork
                    transition: reserveFunds
                    compensate: releaseFunds
              parallelWork:
                type: parallel
                onDone:
                  target: finalCheck
                states:
                  alpha:
                    initial: pending
                    states:
                      pending:
                        on:
                          ALPHA_DONE:
                            target: done
                            transition: finishAlpha
                            compensate: undoAlpha
                      done:
                        type: final
                  beta:
                    initial: pending
                    states:
                      pending:
                        on:
                          BETA_DONE: done
                      done:
                        type: final
              finalCheck:
                on:
                  COMMIT_ALL:
                    target: completed
                    transition: commitAll
                    onFail:
                      compensate: true
                      target: error
              completed:
                type: final
            """;

    public record StoreCtx(int reservedCents, boolean alphaComplete, boolean committed) {}

    private void verifyStoreEndToEnd(StateStore store) {
        List<String> compensations = new ArrayList<>();
        Clock.VirtualClock clock = new Clock.VirtualClock(50_000L);
        FSMRegistry registry = new FSMRegistry(
                store, BenchmarkLogEngine.noop(), clock, PartialTransitionPolicy.EMPTY, null
        );

        registry.registerTransition("dbtest.reserveFunds", (TransitionRequest<StoreCtx, Integer> req) ->
                TransitionOutput.ofContext(new StoreCtx(req.input(), false, false)));
        registry.registerCompensate("dbtest.releaseFunds", req -> compensations.add("releaseFunds"));

        registry.registerTransition("dbtest.finishAlpha", (TransitionRequest<StoreCtx, Void> req) ->
                TransitionOutput.ofContext(new StoreCtx(req.data().reservedCents(), true, false)));
        registry.registerCompensate("dbtest.undoAlpha", req -> compensations.add("undoAlpha"));

        registry.registerTransition("dbtest.commitAll", (TransitionRequest<StoreCtx, Boolean> req) -> {
            if (Boolean.FALSE.equals(req.input())) {
                throw new RuntimeException("Downstream ledger commit rejected");
            }
            return TransitionOutput.ofContext(new StoreCtx(req.data().reservedCents(), true, true));
        });

        registry.registerYaml(SAGA_PARALLEL_YAML);
        DfsmActor<StoreCtx> actor = registry.createActor("durable-store-e2e", StoreCtx.class);

        // 1. Happy path across nested parallel states -> automatic onDone -> completed
        String txHappy = actor.startTransaction(new StoreCtx(0, false, false));
        actor.transition(txHappy, "RESERVE", 1500);
        var parallelMid = actor.transition(txHappy, "ALPHA_DONE", null);
        assertThat(parallelMid.currentState()).isEqualTo(StateValue.fromRaw(Map.of(
                "parallelWork", Map.of("alpha", "done", "beta", "pending")
        )));
        assertThat(actor.getActiveCount()).isEqualTo(1L);

        var intoFinalCheck = actor.transition(txHappy, "BETA_DONE", null);
        assertThat(intoFinalCheck.currentState()).isEqualTo(StateValue.of("finalCheck"));

        var happyDone = actor.transition(txHappy, "COMMIT_ALL", true);
        assertThat(happyDone.currentState()).isEqualTo(StateValue.of("completed"));
        assertThat(happyDone.status()).isEqualTo(TransactionStatus.COMPLETED);
        assertThat(actor.getActiveCount()).isZero();

        // 2. Failure path -> LIFO Saga unwind persisted cleanly (undoAlpha -> releaseFunds)
        String txFail = actor.startTransaction(new StoreCtx(0, false, false));
        actor.transition(txFail, "RESERVE", 9900);
        actor.transition(txFail, "ALPHA_DONE", null);
        actor.transition(txFail, "BETA_DONE", null);
        var rolledBack = actor.transition(txFail, "COMMIT_ALL", false);

        assertThat(rolledBack.currentState()).isEqualTo(StateValue.of("error"));
        assertThat(rolledBack.status()).isEqualTo(TransactionStatus.COMPENSATED);
        assertThat(compensations).containsExactly("undoAlpha", "releaseFunds");

        // 3. Optimistic concurrency check on live DB
        var snap = actor.getTransaction(txFail);
        assertThatThrownBy(() -> store.updateTransaction(
                txFail,
                snap.version() - 1,
                TransactionPatch.<StoreCtx>builder(clock.now()).status(TransactionStatus.FAILED).build(),
                List.of()
        )).isInstanceOf(StaleTransactionVersionException.class);

        registry.shutdown();
    }

    @Test
    void postgresStateStorePersistsCompoundParallelStatesOptimisticLocksAndLifoSaga() {
        String prefix = "dfsm_it_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8) + "_";
        PostgresStateStore pgStore = new PostgresStateStore(
                "jdbc:postgresql://localhost:55432/dfsm_test",
                "dfsm",
                "dfsm_password",
                prefix
        );
        verifyStoreEndToEnd(pgStore);
    }

    @Test
    void mongoStateStorePersistsCompoundParallelStatesOptimisticLocksAndLifoSaga() {
        String collection = "dfsm_it_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        MongoStateStore mongoStore = new MongoStateStore(
                "mongodb://localhost:27018",
                "dfsm_test",
                collection
        );
        verifyStoreEndToEnd(mongoStore);
    }
}
