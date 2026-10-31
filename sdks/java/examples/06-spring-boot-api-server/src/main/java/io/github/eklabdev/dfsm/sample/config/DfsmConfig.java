package io.github.eklabdev.dfsm.sample.config;

import io.github.eklabdev.dfsm.Clock;
import io.github.eklabdev.dfsm.DfsmModels.OnRestartMode;
import io.github.eklabdev.dfsm.DfsmModels.RecoveryConfig;
import io.github.eklabdev.dfsm.DfsmModels.SchedulerConfig;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.runtime.ActorConfig;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.runtime.MachineHandlerBindings;
import io.github.eklabdev.dfsm.sample.model.OrderApiContext;
import io.github.eklabdev.dfsm.sample.service.OrderFulfillmentService;
import io.github.eklabdev.dfsm.store.H2StateStore;
import io.github.eklabdev.dfsm.store.MongoStateStore;
import io.github.eklabdev.dfsm.store.PostgresStateStore;
import io.github.eklabdev.dfsm.store.StateStore;
import io.github.eklabdev.dfsm.telemetry.BenchmarkLogEngine;
import io.github.eklabdev.dfsm.telemetry.TransitionBenchmarkRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.Resource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

@Configuration
public class DfsmConfig {
    private static final Logger log = LoggerFactory.getLogger(DfsmConfig.class);

    @Value("${dfsm.store:h2}")
    private String storeDriver;

    @Value("${dfsm.postgres.url:jdbc:postgresql://localhost:55432/dfsm_test}")
    private String postgresUrl;

    @Value("${dfsm.postgres.username:dfsm}")
    private String postgresUsername;

    @Value("${dfsm.postgres.password:dfsm_password}")
    private String postgresPassword;

    @Value("${dfsm.mongo.uri:mongodb://localhost:27018}")
    private String mongoUri;

    @Value("${dfsm.mongo.database:dfsm_spring_api}")
    private String mongoDatabase;

    @Value("classpath:order-fulfillment.dfsm.yaml")
    private Resource yamlResource;

    private final List<TransitionBenchmarkRecord> benchmarkHistory = Collections.synchronizedList(new ArrayList<>());

    @Bean
    public List<TransitionBenchmarkRecord> benchmarkHistory() {
        return benchmarkHistory;
    }

    @Bean
    public String yamlSource() throws IOException {
        return yamlResource.getContentAsString(StandardCharsets.UTF_8);
    }

    @Bean
    public StateStore stateStore() {
        String driver = storeDriver.trim().toLowerCase();
        log.info("Initializing DFSM StateStore with driver: {}", driver);
        if ("postgres".equals(driver)) {
            return new PostgresStateStore(postgresUrl, postgresUsername, postgresPassword, "dfsm_spring_");
        } else if ("mongo".equals(driver) || "mongodb".equals(driver)) {
            return new MongoStateStore(mongoUri, mongoDatabase, "dfsm_spring_transactions");
        }
        return new H2StateStore();
    }

    @Bean
    public BenchmarkLogEngine benchmarkLogEngine() {
        return record -> {
            benchmarkHistory.add(record);
            log.info("[DFSM-STEP] tx={} | event={} | handler={} | attempts={} | outcome={} ({}ms) | {} -> {}{}",
                    record.transactionId(), record.event(), record.transitionHandler(), record.attempts(),
                    record.outcome(), record.durationMs(), record.fromState().toRaw(), record.toState().toRaw(),
                    record.error() != null ? " | error=\"" + record.error() + "\"" : "");
        };
    }

    @Bean
    public FSMRegistry fsmRegistry(StateStore stateStore, BenchmarkLogEngine logEngine) {
        return new FSMRegistry(stateStore, logEngine, Clock.system(), PartialTransitionPolicy.EMPTY, null);
    }

    @Bean
    public DfsmActor<OrderApiContext> orderActor(
            FSMRegistry registry,
            OrderFulfillmentService service,
            String yamlSource
    ) {
        registry.registerYaml(yamlSource, MachineHandlerBindings.ofServices(service));
        return registry.createActor("express-order-fulfillment", OrderApiContext.class, ActorConfig.<OrderApiContext>builder()
                .actorId("spring-order-actor-1")
                .recovery(new RecoveryConfig(true, 30_000L, OnRestartMode.COMPENSATE, Map.of()))
                .scheduler(new SchedulerConfig(true, 30_000L, 30_000L, null, 100))
                .build());
    }
}

