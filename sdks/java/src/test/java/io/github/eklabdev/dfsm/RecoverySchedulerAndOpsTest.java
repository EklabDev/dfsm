package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.DfsmModels.ActiveStepInfo;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpAction;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpOptions;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpReport;
import io.github.eklabdev.dfsm.DfsmModels.OnRestartMode;
import io.github.eklabdev.dfsm.DfsmModels.RecoveryConfig;
import io.github.eklabdev.dfsm.DfsmModels.SchedulerConfig;
import io.github.eklabdev.dfsm.DfsmModels.SweepReport;
import io.github.eklabdev.dfsm.DfsmModels.TransactionRecord;
import io.github.eklabdev.dfsm.error.StaleTransactionVersionException;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.runtime.ActorConfig;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.store.H2StateStore;
import io.github.eklabdev.dfsm.store.StateStore.NewCompensationEntry;
import io.github.eklabdev.dfsm.store.StateStore.TransactionPatch;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RecoverySchedulerAndOpsTest {

    private static final String YAML = """
            dfsm: "1.0"
            id: ops-recovery-machine
            version: "1.0.0"
            initial: stepA
            registry:
              namespace: ops
              strict: true
            states:
              stepA:
                on:
                  TO_B:
                    target: stepB
                    transition: runStepA
                    compensate: undoStepA
              stepB:
                on:
                  FINISH:
                    target: done
                    transition: runFinish
              done:
                type: final
            """;

    private static void seedStuckInFlightTx(
            H2StateStore store,
            String txId,
            long createdAt,
            boolean withSagaEntry
    ) {
        store.createTransaction(new TransactionRecord<>(
                txId,
                "ops-recovery-machine",
                "1.0.0",
                "dead-worker",
                StateValue.of("stepB"),
                Map.of("seeded", true),
                TransactionStatus.IDLE,
                null,
                null,
                1L,
                null,
                null,
                createdAt,
                createdAt
        ));
        List<NewCompensationEntry> comps = withSagaEntry
                ? List.of(new NewCompensationEntry(
                        txId, "ops.runStepA", "ops.undoStepA",
                        StateValue.of("stepA"), Map.of(), Map.of(), createdAt + 10L
                ))
                : List.of();
        store.updateTransaction(
                txId,
                1L,
                TransactionPatch.<Map<String, Object>>builder(createdAt + 20L)
                        .status(TransactionStatus.IN_FLIGHT)
                        .activeStep(new ActiveStepInfo("FINISH", Map.of("resumed", true), createdAt + 20L))
                        .lease("dead-worker", createdAt + 5_000L)
                        .build(),
                comps
        );
    }

    @Test
    void executesAllRecoveryModesSchedulerCleanupAndRegistryIntrospection() {
        H2StateStore store = new H2StateStore();
        Clock.VirtualClock clock = new Clock.VirtualClock(1_000L);
        List<String> compensated = new ArrayList<>();
        List<String> finished = new ArrayList<>();

        FSMRegistry registry = new FSMRegistry(
                store, BenchmarkLogEngine.noop(), clock, PartialTransitionPolicy.EMPTY, null
        );
        registry.registerTransition("ops.runStepA", req -> TransitionOutput.ofContext(Map.of("a", true)));
        registry.registerCompensate("ops.undoStepA", req -> compensated.add(req.transactionId()));
        registry.registerTransition("ops.runFinish", req -> {
            finished.add(req.context().transactionId());
            return TransitionOutput.ofContext(Map.of("done", true));
        });
        registry.registerYaml(YAML);

        // Seed 4 stuck IN_FLIGHT transactions at t=1_000 and advance clock past stuckThresholdMs (30s)
        seedStuckInFlightTx(store, "tx-mark-fail", 1_000L, false);
        seedStuckInFlightTx(store, "tx-delete", 1_000L, false);
        seedStuckInFlightTx(store, "tx-compensate", 1_000L, true);
        seedStuckInFlightTx(store, "tx-continue", 1_000L, false);
        clock.advance(45_000L);

        assertThat(registry.getInFlightSummary().totalStuck()).isEqualTo(4L);

        DfsmActor<Map> actor = registry.createActor(
                "ops-recovery-machine",
                Map.class,
                ActorConfig.<Map>builder()
                        .actorId("ops-worker-1")
                        .recovery(new RecoveryConfig(false, 30_000L, OnRestartMode.STOP, Map.of()))
                        .scheduler(new SchedulerConfig(false, 10_000L, 30_000L, 60_000L, 50))
                        .build()
        );

        // Introspection checks
        assertThat(registry.listMachines()).hasSize(1);
        assertThat(registry.listRegisteredHandlers("ops")).hasSize(3);
        assertThat(registry.listActors()).hasSize(1);
        assertThat(actor.getSchedulerStatus().enabled()).isFalse();

        // 1. Dry-run forceCleanUp does not mutate state
        ForceCleanUpReport dryRun = actor.forceCleanUp(new ForceCleanUpOptions(
                ForceCleanUpAction.MARK_FAIL, List.of(), true, true, null, true, 100
        ));
        assertThat(dryRun.dryRun()).isTrue();
        assertThat(dryRun.matchedCount()).isEqualTo(4);
        assertThat(dryRun.affectedCount()).isZero();

        // 2. Targeted forceCleanUp actions: MARK_FAIL, DELETE, COMPENSATE
        assertThat(actor.forceCleanUpTransaction("tx-mark-fail", ForceCleanUpAction.MARK_FAIL)).isTrue();
        assertThat(actor.getTransaction("tx-mark-fail").status()).isEqualTo(TransactionStatus.FAILED);

        assertThat(actor.forceCleanUpTransaction("tx-delete", ForceCleanUpAction.DELETE)).isTrue();
        assertThat(actor.getTransaction("tx-delete")).isNull();

        assertThat(actor.forceCleanUpTransaction("tx-compensate", ForceCleanUpAction.COMPENSATE)).isTrue();
        assertThat(actor.getTransaction("tx-compensate").status()).isEqualTo(TransactionStatus.COMPENSATED);
        assertThat(compensated).containsExactly("tx-compensate");

        // 3. Recovery sweep with OnRestartMode.CONTINUE resumes 'tx-continue' to 'done' (COMPLETED)!
        DfsmActor<Map> continueActor = registry.createActor(
                "ops-recovery-machine",
                Map.class,
                ActorConfig.<Map>builder()
                        .actorId("ops-continue-worker")
                        .recovery(new RecoveryConfig(false, 30_000L, OnRestartMode.CONTINUE, Map.of()))
                        .scheduler(new SchedulerConfig(false, 10_000L, 30_000L, 60_000L, 50))
                        .build()
        );
        SweepReport sweep = continueActor.triggerSweepNow();
        assertThat(sweep.stuckRecoveredCount()).isEqualTo(1);
        assertThat(finished).containsExactly("tx-continue");
        assertThat(continueActor.getTransaction("tx-continue").status()).isEqualTo(TransactionStatus.COMPLETED);

        // 4. Optimistic locking rejects stale zombie worker write with StaleTransactionVersionException
        long currentVersion = continueActor.getTransaction("tx-continue").version();
        assertThatThrownBy(() -> store.updateTransaction(
                "tx-continue",
                currentVersion - 1,
                TransactionPatch.<Map>builder(clock.now()).status(TransactionStatus.FAILED).build(),
                List.of()
        )).isInstanceOf(StaleTransactionVersionException.class);

        // 5. Retention sweep purges expired terminal transactions
        clock.advance(120_000L);
        SweepReport retentionSweep = continueActor.triggerSweepNow();
        assertThat(retentionSweep.expiredPurgedCount()).isGreaterThanOrEqualTo(3);

        registry.shutdown();
    }
}

