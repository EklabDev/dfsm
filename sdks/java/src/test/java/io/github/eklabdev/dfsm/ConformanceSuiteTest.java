package io.github.eklabdev.dfsm;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.eklabdev.dfsm.annotation.TransitionDecoratorBuilder;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.store.H2StateStore;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Executes the shared Canonical Cross-Language Conformance Suite ({@code spec/conformance/conformance-suite.json})
 * against the Java SDK runtime.
 */
class ConformanceSuiteTest {

    private static final Path SPEC_CONFORMANCE_DIR = Path.of("../../spec/conformance").toAbsolutePath().normalize();

    @TestFactory
    Stream<DynamicTest> canonicalCrossLanguageConformanceSuite() throws Exception {
        String suiteJson = Files.readString(SPEC_CONFORMANCE_DIR.resolve("conformance-suite.json"));
        JsonNode root = JsonCodec.jsonMapper().readTree(suiteJson);
        List<DynamicTest> tests = new ArrayList<>();

        for (JsonNode scenario : root.get("scenarios")) {
            String id = scenario.get("id").asText();
            String description = scenario.get("description").asText();
            tests.add(DynamicTest.dynamicTest("[" + id + "] " + description, () -> runScenario(scenario)));
        }
        return tests.stream();
    }

    @SuppressWarnings("unchecked")
    private void runScenario(JsonNode scenario) {
        List<String> compensationLog = new ArrayList<>();
        Clock.VirtualClock clock = new Clock.VirtualClock(1_000L);
        FSMRegistry registry = new FSMRegistry(
                new H2StateStore(), BenchmarkLogEngine.noop(), clock, PartialTransitionPolicy.EMPTY, null
        );

        for (String txName : List.of(
                "conformance.traffic.recordStep",
                "conformance.hierarchy.beginAuth",
                "conformance.hierarchy.captureFunds",
                "conformance.hierarchy.markCancelled",
                "conformance.parallel.initFulfillment",
                "conformance.parallel.recordPaid",
                "conformance.parallel.recordPacked",
                "conformance.saga.bookFlight",
                "conformance.saga.bookHotel"
        )) {
            registry.registerTransition(txName, (TransitionRequest<Map<String, Object>, Map<String, Object>> req) -> {
                Map<String, Object> merged = new LinkedHashMap<>();
                if (req.data() != null) merged.putAll(req.data());
                if (req.input() != null) merged.putAll(req.input());
                return TransitionOutput.ofContext(merged);
            });
        }

        JsonNode decoratorOverrides = scenario.get("decoratorOverrides");
        for (String failTxName : List.of(
                "conformance.traffic.brokenBulb",
                "conformance.resilience.callPrimary",
                "conformance.resilience.alwaysFail",
                "conformance.saga.bookCar"
        )) {
            TransitionFunction<Map<String, Object>, Map<String, Object>, Object> fn = req -> {
                Object failFlag = req.input() != null ? req.input().get("fail") : null;
                if (!Boolean.FALSE.equals(failFlag)) {
                    throw new RuntimeException("Simulated failure in " + failTxName);
                }
                return TransitionOutput.empty();
            };

            if (decoratorOverrides != null && decoratorOverrides.has(failTxName)) {
                JsonNode retryOverride = decoratorOverrides.get(failTxName).path("retry").path("maxAttempts");
                var builder = TransitionDecoratorBuilder.of(fn).named(failTxName);
                if (!retryOverride.isMissingNode()) {
                    builder.retry(retryOverride.asInt());
                }
                registry.registerTransition(builder.build());
            } else {
                registry.registerTransition(failTxName, fn);
            }
        }

        for (String compName : List.of(
                "conformance.saga.cancelFlight",
                "conformance.saga.cancelHotel",
                "conformance.saga.cancelCar"
        )) {
            registry.registerCompensate(compName, req -> compensationLog.add(compName));
        }

        for (String effName : List.of(
                "conformance.traffic.onEnterRed",
                "conformance.traffic.onExitRed",
                "conformance.hierarchy.enterActive",
                "conformance.hierarchy.exitActive",
                "conformance.hierarchy.enterIdle",
                "conformance.hierarchy.exitIdle",
                "conformance.hierarchy.enterAuthorizing",
                "conformance.hierarchy.exitAuthorizing",
                "conformance.parallel.notifyShipped",
                "conformance.resilience.alertError"
        )) {
            registry.registerEffect(effName, req -> {});
        }

        String file = scenario.get("file").asText();
        String machineId = scenario.get("machineId").asText();
        registry.registerYamlFile(SPEC_CONFORMANCE_DIR.resolve(file));

        DfsmActor<Map> actor = registry.createActor(machineId, Map.class);

        if (scenario.has("expectedEffectiveMaxAttempts")) {
            var eff = actor.getEffectiveConfig().transitions().stream()
                    .filter(t -> "CALL_PRIMARY".equals(t.event()))
                    .findFirst()
                    .orElseThrow();
            assertThat(eff.policy().retry().maxAttempts())
                    .isEqualTo(scenario.get("expectedEffectiveMaxAttempts").asInt());
            assertThat(eff.policy().circuitBreaker().enabled())
                    .isEqualTo(scenario.get("expectedEffectiveCircuitBreakerEnabled").asBoolean());
        }

        StateValue expectedInit = StateValue.fromRaw(
                JsonCodec.jsonMapper().convertValue(scenario.get("expectedInitialState"), Object.class)
        );
        String txId = actor.startTransaction(new LinkedHashMap<>());
        assertThat(actor.getTransaction(txId).stateValue()).isEqualTo(expectedInit);

        if (scenario.has("steps")) {
            for (JsonNode step : scenario.get("steps")) {
                String event = step.get("event").asText();
                Map<String, Object> input = JsonCodec.jsonMapper().convertValue(step.get("input"), Map.class);
                StateValue expectedState = StateValue.fromRaw(
                        JsonCodec.jsonMapper().convertValue(step.get("expectedState"), Object.class)
                );
                TransactionStatus expectedStatus = TransactionStatus.valueOf(step.get("expectedStatus").asText());

                var out = actor.transition(txId, event, input);
                assertThat(out.currentState()).isEqualTo(expectedState);
                assertThat(out.status()).isEqualTo(expectedStatus);
            }
        }

        if (scenario.has("expectedCompensationOrder")) {
            List<String> expectedOrder = JsonCodec.jsonMapper().convertValue(
                    scenario.get("expectedCompensationOrder"), List.class
            );
            assertThat(compensationLog).containsExactlyElementsOf(expectedOrder);
        }

        registry.shutdown();
    }
}

