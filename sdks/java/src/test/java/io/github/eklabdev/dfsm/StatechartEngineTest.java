package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.DfsmModels.TerminalStatesInfo;
import io.github.eklabdev.dfsm.definition.MachineDefinition;
import io.github.eklabdev.dfsm.definition.YamlMachineParser;
import io.github.eklabdev.dfsm.engine.StatechartEngine;
import io.github.eklabdev.dfsm.error.InvalidTransitionException;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class StatechartEngineTest {

    @Test
    void executesCompoundHierarchyLcaExitEntryOrderAndBubbling() {
        String yaml = """
                dfsm: "1.0"
                id: lca-hierarchy
                version: "1.0.0"
                initial: active
                registry:
                  strict: false
                states:
                  active:
                    type: compound
                    initial: step1
                    entry: [enterActive]
                    exit: [exitActive]
                    on:
                      ABORT:
                        target: aborted
                        effects: [onAbortEdge]
                    states:
                      step1:
                        entry: [enterStep1]
                        exit: [exitStep1]
                        on:
                          ADVANCE: step2
                      step2:
                        entry: [enterStep2]
                        exit: [exitStep2]
                  aborted:
                    type: final
                    entry: [enterAborted]
                """;

        List<String> effects = new ArrayList<>();
        FSMRegistry registry = new FSMRegistry();
        for (String name : List.of(
                "enterActive", "exitActive", "enterStep1", "exitStep1",
                "enterStep2", "exitStep2", "onAbortEdge", "enterAborted"
        )) {
            final String effName = name;
            registry.registerEffect(effName, req -> effects.add(effName));
        }

        registry.registerYaml(yaml);
        DfsmActor<Map> actor = registry.createActor("lca-hierarchy", Map.class);

        String txId = actor.startTransaction(Map.of());
        assertThat(actor.getTransaction(txId).stateValue()).isEqualTo(StateValue.fromRaw(Map.of("active", "step1")));
        assertThat(effects).containsExactly("enterActive", "enterStep1");
        effects.clear();

        // Sibling transition inside 'active': active is LCA -> should NOT exit/re-enter active!
        var step2 = actor.transition(txId, "ADVANCE", null);
        assertThat(step2.currentState()).isEqualTo(StateValue.fromRaw(Map.of("active", "step2")));
        assertThat(effects).containsExactly("exitStep1", "enterStep2");
        assertThat(actor.getAvailableEvents(step2.currentState())).containsExactly("ABORT");
        effects.clear();

        // Parent bubbled ABORT exits child first, then parent, runs edge effect, enters target
        var aborted = actor.transition(txId, "ABORT", null);
        assertThat(aborted.currentState()).isEqualTo(StateValue.of("aborted"));
        assertThat(aborted.status()).isEqualTo(TransactionStatus.COMPLETED);
        assertThat(effects).containsExactly("exitStep2", "exitActive", "onAbortEdge", "enterAborted");

        registry.shutdown();
    }

    @Test
    void advancesOrthogonalParallelRegionsAndFiresOnDoneAutomatically() {
        String yaml = """
                dfsm: "1.0"
                id: parallel-engine-test
                version: "1.0.0"
                initial: processing
                registry:
                  strict: false
                states:
                  processing:
                    type: parallel
                    onDone:
                      target: complete
                    states:
                      kyc:
                        initial: checking
                        states:
                          checking:
                            on:
                              KYC_PASS: verified
                          verified:
                            type: final
                      fraud:
                        initial: scanning
                        states:
                          scanning:
                            on:
                              FRAUD_CLEAR: cleared
                          cleared:
                            type: final
                  complete:
                    type: final
                """;

        FSMRegistry registry = new FSMRegistry();
        registry.registerYaml(yaml);
        DfsmActor<Map> actor = registry.createActor("parallel-engine-test", Map.class);

        String txId = actor.startTransaction(Map.of());
        StateValue initState = actor.getTransaction(txId).stateValue();
        assertThat(initState).isEqualTo(StateValue.fromRaw(Map.of(
                "processing", Map.of("kyc", "checking", "fraud", "scanning")
        )));
        assertThat(StatechartEngine.getAvailableEvents(YamlMachineParser.parseYaml(yaml), initState))
                .containsExactlyInAnyOrder("KYC_PASS", "FRAUD_CLEAR");

        var afterKyc = actor.transition(txId, "KYC_PASS", null);
        assertThat(afterKyc.currentState()).isEqualTo(StateValue.fromRaw(Map.of(
                "processing", Map.of("kyc", "verified", "fraud", "scanning")
        )));
        assertThat(afterKyc.status()).isEqualTo(TransactionStatus.IDLE);

        var afterFraud = actor.transition(txId, "FRAUD_CLEAR", null);
        assertThat(afterFraud.currentState()).isEqualTo(StateValue.of("complete"));
        assertThat(afterFraud.status()).isEqualTo(TransactionStatus.COMPLETED);

        assertThatThrownBy(() -> actor.transition(txId, "KYC_PASS", null))
                .isInstanceOf(InvalidTransitionException.class);

        MachineDefinition def = YamlMachineParser.parseYaml(yaml);
        TerminalStatesInfo termInfo = StatechartEngine.getTerminalStatesInfo(def);
        assertThat(termInfo.topLevelTerminalStates()).containsExactlyInAnyOrder("complete", "error");
        assertThat(termInfo.allFinalStatePaths()).contains(
                "processing.kyc.verified", "processing.fraud.cleared", "complete", "error"
        );
        registry.shutdown();
    }
}
