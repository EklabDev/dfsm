package io.github.eklabdev.dfsm.sample.controller;

import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpAction;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpOptions;
import io.github.eklabdev.dfsm.DfsmModels.ForceCleanUpReport;
import io.github.eklabdev.dfsm.DfsmModels.InFlightFilter;
import io.github.eklabdev.dfsm.DfsmModels.InFlightSummary;
import io.github.eklabdev.dfsm.DfsmModels.SchedulerStatus;
import io.github.eklabdev.dfsm.DfsmModels.StatusBreakdown;
import io.github.eklabdev.dfsm.DfsmModels.SweepReport;
import io.github.eklabdev.dfsm.DfsmModels.TerminalStatesInfo;
import io.github.eklabdev.dfsm.DfsmModels.TransactionSnapshot;
import io.github.eklabdev.dfsm.DfsmModels.TransactionSummary;
import io.github.eklabdev.dfsm.JsonCodec;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.TransitionExecutionResult;
import io.github.eklabdev.dfsm.error.TransactionNotFoundException;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.sample.model.OrderApiContext;
import io.github.eklabdev.dfsm.sample.model.OrderRequests;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.AuthorizePaymentInput;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.BookCarrierInput;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.CancelOrderRequest;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.CreateOrderRequest;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.GenericTransitionRequest;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.PackCompleteInput;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.ResetOrderRequest;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.SubmitOrderInput;
import io.github.eklabdev.dfsm.sample.service.OrderFulfillmentService;
import io.github.eklabdev.dfsm.telemetry.TransitionBenchmarkRecord;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api")
public class OrderFulfillmentController {

    private final DfsmActor<OrderApiContext> actor;
    private final OrderFulfillmentService service;
    private final String yamlSource;
    private final List<TransitionBenchmarkRecord> benchmarkHistory;

    public OrderFulfillmentController(
            DfsmActor<OrderApiContext> actor,
            OrderFulfillmentService service,
            String yamlSource,
            List<TransitionBenchmarkRecord> benchmarkHistory
    ) {
        this.actor = actor;
        this.service = service;
        this.yamlSource = yamlSource;
        this.benchmarkHistory = benchmarkHistory;
    }

    private Map<String, Object> formatTransactionPayload(
            String txId,
            boolean includeYaml,
            Map<String, Object> stepDetails
    ) {
        TransactionSnapshot<OrderApiContext> snap = actor.getTransaction(txId);
        if (snap == null) {
            throw new TransactionNotFoundException(txId);
        }

        List<String> availableEvents = actor.getAvailableEvents(snap.stateValue());
        TransitionBenchmarkRecord lastBenchmark = null;
        synchronized (benchmarkHistory) {
            for (int i = benchmarkHistory.size() - 1; i >= 0; i--) {
                if (txId.equals(benchmarkHistory.get(i).transactionId())) {
                    lastBenchmark = benchmarkHistory.get(i);
                    break;
                }
            }
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("transactionId", snap.transactionId());
        payload.put("machineId", snap.machineId());
        payload.put("machineVersion", snap.machineVersion());
        payload.put("actorId", snap.actorId());
        payload.put("currentState", snap.stateValue().toRaw());
        payload.put("status", snap.status().name());
        payload.put("availableEvents", availableEvents);
        payload.put("version", snap.version());
        payload.put("context", snap.context());
        payload.put("lastError", snap.lastError());
        payload.put("compensationStack", snap.compensationStack());
        if (stepDetails != null) {
            payload.put("stepResult", stepDetails);
        }
        if (lastBenchmark != null) {
            payload.put("lastBenchmark", lastBenchmark);
        }
        payload.put("notifications", service.getNotifications());
        payload.put("routingEvents", service.getRoutingEvents());
        if (includeYaml) {
            payload.put("yaml", yamlSource);
        }
        return payload;
    }

    // -------------------------------------------------------------------------
    // 1. Machine Definition & Metadata
    // -------------------------------------------------------------------------

    @GetMapping("/machine")
    public ResponseEntity<Map<String, Object>> getMachine() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("machineId", actor.getMachineId());
        body.put("version", actor.getEffectiveConfig().version());
        body.put("hasCustomErrorState", actor.getEffectiveConfig().hasCustomErrorState());
        body.put("terminalStates", actor.getTerminalStates());
        body.put("effectiveConfig", actor.getEffectiveConfig());
        body.put("yaml", yamlSource);
        return ResponseEntity.ok(body);
    }

    // -------------------------------------------------------------------------
    // 2. Order Transaction CRUD & Steps
    // -------------------------------------------------------------------------

    @PostMapping("/orders")
    public ResponseEntity<Map<String, Object>> createOrder(
            @RequestBody(required = false) CreateOrderRequest req,
            @RequestParam(defaultValue = "true") boolean includeYaml
    ) {
        String customId = req != null && req.transactionId() != null && !req.transactionId().isBlank()
                ? req.transactionId().trim()
                : UUID.randomUUID().toString();
        String email = req != null && req.customerEmail() != null && !req.customerEmail().isBlank()
                ? req.customerEmail().trim()
                : "customer@example.com";

        OrderApiContext initial = OrderApiContext.createDraft(email);
        String txId = actor.startTransaction(initial, customId);

        Map<String, Object> body = formatTransactionPayload(txId, includeYaml, null);
        return ResponseEntity.status(HttpStatus.CREATED).body(body);
    }

    @GetMapping("/orders/{id}")
    public ResponseEntity<Map<String, Object>> getOrder(
            @PathVariable String id,
            @RequestParam(defaultValue = "true") boolean includeYaml
    ) {
        return ResponseEntity.ok(formatTransactionPayload(id, includeYaml, null));
    }

    @PostMapping("/orders/{id}/transitions")
    public ResponseEntity<Map<String, Object>> executeTransition(
            @PathVariable String id,
            @Valid @RequestBody GenericTransitionRequest req,
            @RequestParam(defaultValue = "true") boolean includeYaml
    ) {
        TransactionSnapshot<OrderApiContext> before = actor.getTransaction(id);
        if (before == null) {
            throw new TransactionNotFoundException(id);
        }

        Object inputConverted = req.input();
        if ("SUBMIT_ORDER".equals(req.event()) && req.input() != null) {
            inputConverted = JsonCodec.convertValue(req.input(), OrderRequests.SubmitOrderInput.class);
        } else if ("AUTHORIZE_PAYMENT".equals(req.event()) && req.input() != null) {
            inputConverted = JsonCodec.convertValue(req.input(), OrderRequests.AuthorizePaymentInput.class);
        } else if ("PACK_COMPLETE".equals(req.event()) && req.input() != null) {
            inputConverted = JsonCodec.convertValue(req.input(), OrderRequests.PackCompleteInput.class);
        } else if ("BOOK_CARRIER".equals(req.event()) && req.input() != null) {
            inputConverted = JsonCodec.convertValue(req.input(), OrderRequests.BookCarrierInput.class);
        }

        TransitionExecutionResult<OrderApiContext, Object> res = actor.transition(id, req.event(), inputConverted);

        Map<String, Object> stepDetails = new LinkedHashMap<>();
        stepDetails.put("event", req.event());
        stepDetails.put("previousState", res.previousState().toRaw());
        stepDetails.put("outputValue", res.value());
        stepDetails.put("compensatedSteps", res.compensatedSteps());
        if (res.error() != null) {
            stepDetails.put("error", res.error());
        }

        return ResponseEntity.ok(formatTransactionPayload(id, includeYaml, stepDetails));
    }

    @PostMapping("/orders/{id}/cancel")
    public ResponseEntity<Map<String, Object>> cancelOrder(
            @PathVariable String id,
            @RequestBody(required = false) CancelOrderRequest req,
            @RequestParam(defaultValue = "true") boolean includeYaml
    ) {
        CancelOrderRequest payload = req != null ? req : new CancelOrderRequest("user_cancelled");
        actor.transition(id, "CANCEL_ORDER", payload);
        return ResponseEntity.ok(formatTransactionPayload(id, includeYaml, Map.of("event", "CANCEL_ORDER")));
    }

    @PostMapping("/orders/{id}/reset")
    public ResponseEntity<Map<String, Object>> resetOrder(
            @PathVariable String id,
            @RequestBody(required = false) ResetOrderRequest req,
            @RequestParam(defaultValue = "true") boolean includeYaml
    ) {
        ResetOrderRequest payload = req != null ? req : new ResetOrderRequest("reset_from_api");
        actor.transition(id, "RESET_ORDER", payload);
        return ResponseEntity.ok(formatTransactionPayload(id, includeYaml, Map.of("event", "RESET_ORDER")));
    }

    // -------------------------------------------------------------------------
    // 3. Operational & Introspection APIs
    // -------------------------------------------------------------------------

    @GetMapping("/orders")
    public ResponseEntity<Map<String, Object>> listOrders(
            @RequestParam(required = false) String status,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam(defaultValue = "0") int offset
    ) {
        StatusBreakdown breakdown = actor.getStatusBreakdown();
        List<TransactionSummary<OrderApiContext>> list = actor.listActiveTransactions(limit, offset);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("nonTerminalCount", breakdown.nonTerminalCount());
        body.put("terminalCount", breakdown.terminalCount());
        body.put("byStatus", breakdown.byStatus());
        body.put("total", list.size());
        body.put("orders", list);
        return ResponseEntity.ok(body);
    }

    @GetMapping("/in-flight")
    public ResponseEntity<Map<String, Object>> listInFlight(
            @RequestParam(defaultValue = "false") boolean stuckOnly,
            @RequestParam(defaultValue = "100") int limit,
            @RequestParam(defaultValue = "0") int offset
    ) {
        InFlightFilter filter = new InFlightFilter(actor.getMachineId(), null, stuckOnly, true, null, limit, offset);
        List<TransactionSummary<OrderApiContext>> items = actor.listInFlightTransactions(filter);
        long inFlightCount = actor.getInFlightCount(filter);
        long stuckCount = actor.getInFlightCount(InFlightFilter.onlyStuck());

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("inFlightCount", inFlightCount);
        body.put("totalStuck", stuckCount);
        body.put("transactions", items);
        return ResponseEntity.ok(body);
    }

    @GetMapping("/terminals")
    public ResponseEntity<TerminalStatesInfo> getTerminalStates() {
        return ResponseEntity.ok(actor.getTerminalStates());
    }

    @GetMapping("/scheduler")
    public ResponseEntity<Map<String, Object>> getScheduler() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("config", actor.getSchedulerConfig());
        body.put("status", actor.getSchedulerStatus());
        return ResponseEntity.ok(body);
    }

    @PostMapping("/scheduler/sweep")
    public ResponseEntity<SweepReport> triggerSweep() {
        return ResponseEntity.ok(actor.triggerSweepNow());
    }

    @PostMapping("/cleanup")
    public ResponseEntity<ForceCleanUpReport> forceCleanUp(
            @RequestParam(defaultValue = "DELETE") String action,
            @RequestParam(defaultValue = "false") boolean stuckOnly,
            @RequestParam(defaultValue = "false") boolean includeInFlight,
            @RequestParam(defaultValue = "false") boolean dryRun,
            @RequestParam(defaultValue = "100") int limit
    ) {
        ForceCleanUpAction act = ForceCleanUpAction.valueOf(action.toUpperCase());
        ForceCleanUpOptions options = new ForceCleanUpOptions(
                act,
                List.of(TransactionStatus.COMPLETED, TransactionStatus.FAILED, TransactionStatus.COMPENSATED),
                includeInFlight,
                stuckOnly,
                null,
                dryRun,
                limit
        );
        return ResponseEntity.ok(actor.forceCleanUp(options));
    }
}
