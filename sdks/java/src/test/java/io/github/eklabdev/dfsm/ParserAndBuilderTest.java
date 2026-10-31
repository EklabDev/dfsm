package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.definition.MachineBuilder;
import io.github.eklabdev.dfsm.definition.MachineDefinition;
import io.github.eklabdev.dfsm.definition.StateNodeType;
import io.github.eklabdev.dfsm.definition.YamlMachineParser;
import io.github.eklabdev.dfsm.error.SchemaValidationException;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ParserAndBuilderTest {

    @Test
    void parsesValidYamlAndSynthesizesImplicitFinalErrorState() {
        String yaml = """
                dfsm: "1.0"
                id: simple-order
                version: "1.2.0"
                initial: pending
                states:
                  pending:
                    on:
                      APPROVE: approved
                  approved:
                    type: final
                """;

        MachineDefinition def = YamlMachineParser.parseYaml(yaml);

        assertThat(def.id()).isEqualTo("simple-order");
        assertThat(def.version()).isEqualTo("1.2.0");
        assertThat(def.hasCustomErrorState()).isFalse();
        assertThat(def.states()).containsKeys("pending", "approved", "error");
        assertThat(def.states().get("error").type()).isEqualTo(StateNodeType.FINAL);
        assertThat(def.states().get("error").isImplicitError()).isTrue();
    }

    @Test
    void preservesCustomErrorStateWithOutgoingRecoveryTransitions() {
        String yaml = """
                dfsm: "1.0"
                id: custom-err-machine
                version: "1.0.0"
                initial: active
                states:
                  active:
                    on:
                      FINISH: done
                  done:
                    type: final
                  error:
                    on:
                      RETRY_FROM_ERROR: active
                """;

        MachineDefinition def = YamlMachineParser.parseYaml(yaml);

        assertThat(def.hasCustomErrorState()).isTrue();
        assertThat(def.states().get("error").type()).isEqualTo(StateNodeType.ATOMIC);
        assertThat(def.states().get("error").isImplicitError()).isFalse();
        assertThat(def.states().get("error").on()).containsKey("RETRY_FROM_ERROR");
    }

    @Test
    void rejectsInvalidYamlSchemaAndUnknownTargets() {
        String missingInitial = """
                dfsm: "1.0"
                id: broken-machine
                states:
                  idle: {}
                """;

        assertThatThrownBy(() -> YamlMachineParser.parseYaml(missingInitial))
                .isInstanceOf(SchemaValidationException.class);

        String badTarget = """
                dfsm: "1.0"
                id: bad-target
                version: "1.0.0"
                initial: idle
                states:
                  idle:
                    on:
                      GO: nonExistentState
                """;

        assertThatThrownBy(() -> YamlMachineParser.parseYaml(badTarget))
                .isInstanceOf(SchemaValidationException.class)
                .hasMessageContaining("nonExistentState");
    }

    @Test
    void machineBuilderProducesEquivalentNormalizedAst() {
        MachineDefinition def = MachineBuilder.<Object>create("builder-order")
                .version("2.0.0")
                .namespace("orders")
                .maxEffectChainDepth(12)
                .hook(LifecycleHookName.ON_START, "logStart")
                .effects("notifyOps")
                .initial("created")
                .compoundState("created", "validating", c -> c
                        .on("CANCEL", "cancelled")
                        .state("validating", v -> v.on("VALIDATED", "#builder-order.completed")))
                .finalState("completed")
                .finalState("cancelled")
                .build();

        assertThat(def.id()).isEqualTo("builder-order");
        assertThat(def.version()).isEqualTo("2.0.0");
        assertThat(def.registry().namespace()).isEqualTo("orders");
        assertThat(def.maxEffectChainDepth()).isEqualTo(12);
        assertThat(def.hooks().onStart()).containsExactly("logStart");
        assertThat(def.effects()).containsExactly("notifyOps");
        assertThat(def.hasCustomErrorState()).isFalse();
        assertThat(io.github.eklabdev.dfsm.engine.StatechartEngine.getNodeByPath(def, "created.validating")).isNotNull();
        assertThat(def.states()).containsKeys("created", "completed", "cancelled", "error");
    }
}
