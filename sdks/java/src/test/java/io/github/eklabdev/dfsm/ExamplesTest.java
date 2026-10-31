package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.examples.Example01SimpleTrafficLight;
import io.github.eklabdev.dfsm.examples.Example02YamlJakartaValidation;
import io.github.eklabdev.dfsm.examples.Example03HierarchicalParallelWorkflow;
import io.github.eklabdev.dfsm.examples.Example04PolicyMergeAndSagaCompensation;
import io.github.eklabdev.dfsm.examples.Example05MultiActorOpsHooksAndRecovery;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Executes all 5 progressive Java SDK examples end-to-end as automated JUnit 5 assertions.
 */
class ExamplesTest {

    @Test
    void example01SimpleTrafficLightRunsCleanly() {
        var summary = Example01SimpleTrafficLight.runDemo();
        assertThat(summary.finalState()).isEqualTo(StateValue.of("maintenance"));
        assertThat(summary.finalStatus()).isEqualTo(TransactionStatus.COMPLETED);
        assertThat(summary.finalContext().cycles()).isEqualTo(3);
        assertThat(summary.lastOutput().totalCycles()).isEqualTo(3);
        assertThat(summary.effectLog()).containsExactly(
                "enter:red", "exit:red", "enter:green", "enter:red", "exit:red", "enter:maintenance"
        );
    }

    @Test
    void example02YamlJakartaValidationRunsCleanly() {
        var summary = Example02YamlJakartaValidation.runDemo();
        assertThat(summary.invalidRejectedPreFlight()).isTrue();
        assertThat(summary.invocationsAfterInvalidCall()).isZero();
        assertThat(summary.finalStateAfterValidCall()).isEqualTo(StateValue.of("submitted"));
        assertThat(summary.finalStatus()).isEqualTo(TransactionStatus.COMPLETED);
        assertThat(summary.computedTotal()).isEqualTo(200.0);
        assertThat(summary.sentEmails()).containsExactly("alice@example.com");
    }

    @Test
    void example03HierarchicalParallelWorkflowRunsCleanly() {
        var summary = Example03HierarchicalParallelWorkflow.runDemo();
        assertThat(summary.parallelMidwayState()).isEqualTo(StateValue.fromRaw(Map.of(
                "fulfillment", Map.of("payment", "paid", "inventory", "picking")
        )));
        assertThat(summary.completedParallelState()).isEqualTo(StateValue.of("shipped"));
        assertThat(summary.completedStatus()).isEqualTo(TransactionStatus.COMPLETED);
        assertThat(summary.bubbledCancelState()).isEqualTo(StateValue.of("cancelled"));
        assertThat(summary.cancelledContext().cancelled()).isTrue();
        assertThat(summary.notifications()).hasSize(1);
    }

    @Test
    void example04PolicyMergeAndSagaCompensationRunsCleanly() {
        var summary = Example04PolicyMergeAndSagaCompensation.runDemo();
        assertThat(summary.mergedMaxAttempts()).isEqualTo(4);
        assertThat(summary.mergedCircuitBreakerEnabled()).isTrue();
        assertThat(summary.actualCarAttemptsExecuted()).isEqualTo(4);
        assertThat(summary.lifoRollbackOrder()).containsExactly("cancelHotel", "cancelFlight");
        assertThat(summary.finalState()).isEqualTo(StateValue.of("error"));
        assertThat(summary.finalStatus()).isEqualTo(TransactionStatus.COMPENSATED);
        assertThat(summary.benchmarks()).hasSize(3);
    }

    @Test
    void example05MultiActorOpsHooksAndRecoveryRunsCleanly() {
        var summary = Example05MultiActorOpsHooksAndRecovery.runDemo();
        assertThat(summary.lowRiskFinalState()).isEqualTo(StateValue.of("settled"));
        assertThat(summary.lowRiskStatus()).isEqualTo(TransactionStatus.COMPLETED);
        assertThat(summary.highRiskState()).isEqualTo(StateValue.of("manualReview"));
        assertThat(summary.highRiskStatus()).isEqualTo(TransactionStatus.IDLE);
        assertThat(summary.activeNonTerminalCount()).isEqualTo(1L);
        assertThat(summary.terminalStates().topLevelTerminalStates())
                .containsExactlyInAnyOrder("settled", "rejected", "error");
        assertThat(summary.dryRunCleanUpReport().matchedCount()).isEqualTo(1);
        assertThat(summary.crashRecoverySweepReport().stuckRecoveredCount()).isEqualTo(1);
        assertThat(summary.voidedTransactions()).containsExactly("tx-crashed-900");
        assertThat(summary.hookAuditTrail()).isNotEmpty();
    }
}

