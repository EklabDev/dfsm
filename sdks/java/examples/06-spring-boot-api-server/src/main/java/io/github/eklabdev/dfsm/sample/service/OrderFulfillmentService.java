package io.github.eklabdev.dfsm.sample.service;

import io.github.eklabdev.dfsm.ActorLifecycleHooks.AfterTransitionEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.BeforeTransitionEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnCompensateEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnCompleteEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnStartEvent;
import io.github.eklabdev.dfsm.ActorLifecycleHooks.OnTerminalEvent;
import io.github.eklabdev.dfsm.CompensationRequest;
import io.github.eklabdev.dfsm.EffectRequest;
import io.github.eklabdev.dfsm.TransitionOutput;
import io.github.eklabdev.dfsm.TransitionRequest;
import io.github.eklabdev.dfsm.annotation.CompensateWith;
import io.github.eklabdev.dfsm.annotation.DfsmCompensate;
import io.github.eklabdev.dfsm.annotation.DfsmEffect;
import io.github.eklabdev.dfsm.annotation.DfsmHook;
import io.github.eklabdev.dfsm.annotation.DfsmTransition;
import io.github.eklabdev.dfsm.annotation.OnFail;
import io.github.eklabdev.dfsm.annotation.Retry;
import io.github.eklabdev.dfsm.sample.model.OrderApiContext;
import io.github.eklabdev.dfsm.sample.model.OrderItem;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.AuthorizePaymentInput;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.BookCarrierInput;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.CancelOrderRequest;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.PackCompleteInput;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.ResetOrderRequest;
import io.github.eklabdev.dfsm.sample.model.OrderRequests.SubmitOrderInput;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class OrderFulfillmentService {
    private static final Logger log = LoggerFactory.getLogger(OrderFulfillmentService.class);

    private final List<String> notifications = Collections.synchronizedList(new ArrayList<>());
    private final List<String> routingEvents = Collections.synchronizedList(new ArrayList<>());
    private final List<Map<String, Object>> lifecycleHooksLog = Collections.synchronizedList(new ArrayList<>());

    public List<String> getNotifications() {
        return List.copyOf(notifications);
    }

    public List<String> getRoutingEvents() {
        return List.copyOf(routingEvents);
    }

    public List<Map<String, Object>> getLifecycleHooksLog() {
        return List.copyOf(lifecycleHooksLog);
    }

    private void recordHook(String hook, String txId, Map<String, Object> summary) {
        long now = System.currentTimeMillis();
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("hook", hook);
        entry.put("transactionId", txId);
        entry.put("timestamp", now);
        entry.put("summary", summary);
        lifecycleHooksLog.add(entry);
        log.info("[DFSM-HOOK] hook={} | tx={} | {}", hook, txId, summary);
    }

    // -------------------------------------------------------------------------
    // Transitions & Compensations (`api.orders` namespace)
    // -------------------------------------------------------------------------

    @DfsmTransition("reserveInventory")
    @CompensateWith("releaseInventory")
    public TransitionOutput<OrderApiContext, Map<String, Object>> reserveInventory(
            TransitionRequest<OrderApiContext, SubmitOrderInput> req
    ) {
        SubmitOrderInput in = req.input();
        int totalCents = in.items().stream()
                .mapToInt(i -> i.quantity() * i.unitPriceCents())
                .sum();

        boolean autoApprove = Boolean.TRUE.equals(in.autoApprovePayment());
        List<String> audit = new ArrayList<>(req.data().auditLog());
        audit.add("inventory_reserved:totalCents=" + totalCents);

        OrderApiContext updated = new OrderApiContext(
                req.data().customerEmail(),
                in.items(),
                totalCents,
                true,
                autoApprove,
                req.data().paymentAuthId(),
                req.data().boxWeightKg(),
                req.data().trackingNumber(),
                req.data().carrier(),
                List.copyOf(audit)
        );

        return TransitionOutput.of(updated, Map.of(
                "reservedSkus", in.items().size(),
                "totalCents", totalCents
        ));
    }

    @DfsmCompensate("releaseInventory")
    public OrderApiContext releaseInventory(CompensationRequest<OrderApiContext> req) {
        List<String> audit = new ArrayList<>(req.currentContext().auditLog());
        audit.add("compensated:releaseInventory(step=" + req.stepSeq() + ")");
        return new OrderApiContext(
                req.currentContext().customerEmail(),
                req.currentContext().items(),
                req.currentContext().totalCents(),
                false,
                req.currentContext().autoApprovePayment(),
                req.currentContext().paymentAuthId(),
                req.currentContext().boxWeightKg(),
                req.currentContext().trackingNumber(),
                req.currentContext().carrier(),
                List.copyOf(audit)
        );
    }

    @DfsmTransition("authorizePayment")
    @Retry(maxAttempts = 3) // Overrides YAML retry: 2 -> normalized to 3 total attempts!
    @CompensateWith("refundPayment")
    @OnFail(compensate = true, target = "error")
    public TransitionOutput<OrderApiContext, Map<String, Object>> authorizePayment(
            TransitionRequest<OrderApiContext, AuthorizePaymentInput> req
    ) {
        AuthorizePaymentInput in = req.input();
        if (Boolean.TRUE.equals(in.simulateFailure())) {
            throw new RuntimeException("Payment gateway declined '" + in.paymentMethod() + "'");
        }

        String txShort = req.context().transactionId().length() >= 8
                ? req.context().transactionId().substring(0, 8)
                : req.context().transactionId();
        String paymentAuthId = "AUTH-" + txShort + "-" + in.paymentMethod();

        List<String> audit = new ArrayList<>(req.data().auditLog());
        audit.add("payment_authorized:" + paymentAuthId);

        OrderApiContext updated = new OrderApiContext(
                req.data().customerEmail(),
                req.data().items(),
                req.data().totalCents(),
                req.data().inventoryReserved(),
                req.data().autoApprovePayment(),
                paymentAuthId,
                req.data().boxWeightKg(),
                req.data().trackingNumber(),
                req.data().carrier(),
                List.copyOf(audit)
        );

        return TransitionOutput.of(updated, Map.of("paymentAuthId", paymentAuthId));
    }

    @DfsmCompensate("refundPayment")
    public OrderApiContext refundPayment(CompensationRequest<OrderApiContext> req) {
        List<String> audit = new ArrayList<>(req.currentContext().auditLog());
        audit.add("compensated:refundPayment(step=" + req.stepSeq() + ")");
        return new OrderApiContext(
                req.currentContext().customerEmail(),
                req.currentContext().items(),
                req.currentContext().totalCents(),
                req.currentContext().inventoryReserved(),
                req.currentContext().autoApprovePayment(),
                null,
                req.currentContext().boxWeightKg(),
                req.currentContext().trackingNumber(),
                req.currentContext().carrier(),
                List.copyOf(audit)
        );
    }

    @DfsmTransition("completePacking")
    public TransitionOutput<OrderApiContext, Map<String, Object>> completePacking(
            TransitionRequest<OrderApiContext, PackCompleteInput> req
    ) {
        PackCompleteInput in = req.input();
        List<String> audit = new ArrayList<>(req.data().auditLog());
        audit.add("packed:" + in.boxWeightKg() + "kg");

        OrderApiContext updated = new OrderApiContext(
                req.data().customerEmail(),
                req.data().items(),
                req.data().totalCents(),
                req.data().inventoryReserved(),
                req.data().autoApprovePayment(),
                req.data().paymentAuthId(),
                in.boxWeightKg(),
                req.data().trackingNumber(),
                req.data().carrier(),
                List.copyOf(audit)
        );

        return TransitionOutput.of(updated, Map.of("packed", true));
    }

    @DfsmTransition("bookShippingCarrier")
    public TransitionOutput<OrderApiContext, Map<String, Object>> bookShippingCarrier(
            TransitionRequest<OrderApiContext, BookCarrierInput> req
    ) {
        BookCarrierInput in = req.input();
        List<String> audit = new ArrayList<>(req.data().auditLog());
        audit.add("carrier_booked:" + in.carrier() + ":" + in.trackingNumber());

        OrderApiContext updated = new OrderApiContext(
                req.data().customerEmail(),
                req.data().items(),
                req.data().totalCents(),
                req.data().inventoryReserved(),
                req.data().autoApprovePayment(),
                req.data().paymentAuthId(),
                req.data().boxWeightKg(),
                in.trackingNumber(),
                in.carrier(),
                List.copyOf(audit)
        );

        return TransitionOutput.of(updated, Map.of("trackingNumber", in.trackingNumber()));
    }

    @DfsmTransition("cancelDraftOrder")
    public TransitionOutput<OrderApiContext, Void> cancelDraftOrder(
            TransitionRequest<OrderApiContext, CancelOrderRequest> req
    ) {
        String reason = req.input() != null && req.input().reason() != null ? req.input().reason() : "user_cancelled";
        List<String> audit = new ArrayList<>(req.data().auditLog());
        audit.add("cancelled_draft:" + reason);

        OrderApiContext updated = new OrderApiContext(
                req.data().customerEmail(),
                req.data().items(),
                req.data().totalCents(),
                req.data().inventoryReserved(),
                req.data().autoApprovePayment(),
                req.data().paymentAuthId(),
                req.data().boxWeightKg(),
                req.data().trackingNumber(),
                req.data().carrier(),
                List.copyOf(audit)
        );
        return TransitionOutput.ofContext(updated);
    }

    @DfsmTransition("cancelReservedOrder")
    public TransitionOutput<OrderApiContext, Void> cancelReservedOrder(
            TransitionRequest<OrderApiContext, CancelOrderRequest> req
    ) {
        String reason = req.input() != null && req.input().reason() != null ? req.input().reason() : "user_cancelled";
        List<String> audit = new ArrayList<>(req.data().auditLog());
        audit.add("cancelled_reserved_stock_released:" + reason);

        OrderApiContext updated = new OrderApiContext(
                req.data().customerEmail(),
                req.data().items(),
                req.data().totalCents(),
                false,
                req.data().autoApprovePayment(),
                req.data().paymentAuthId(),
                req.data().boxWeightKg(),
                req.data().trackingNumber(),
                req.data().carrier(),
                List.copyOf(audit)
        );
        return TransitionOutput.ofContext(updated);
    }

    @DfsmTransition("resetAfterError")
    public TransitionOutput<OrderApiContext, Void> resetAfterError(
            TransitionRequest<OrderApiContext, ResetOrderRequest> req
    ) {
        List<String> audit = new ArrayList<>(req.data().auditLog());
        audit.add("reset_to_created");

        OrderApiContext updated = new OrderApiContext(
                req.data().customerEmail(),
                List.of(),
                0,
                false,
                false,
                null,
                null,
                null,
                null,
                List.copyOf(audit)
        );
        return TransitionOutput.ofContext(updated);
    }

    // -------------------------------------------------------------------------
    // Conditional Router Effects (`req.runEffect(...)` + `req.actor().transition(...)`)
    // -------------------------------------------------------------------------

    @DfsmEffect("evaluatePostReserveRouting")
    public void onInventoryReservedEntry(EffectRequest<OrderApiContext> req) {
        if (req.context().autoApprovePayment()) {
            req.runEffect("autoAuthorizeWalletEffect", Map.of("paymentMethod", "spring_auto_wallet"));
        } else {
            req.runEffect("awaitManualPaymentEffect");
        }
    }

    @DfsmEffect("autoAuthorizeWalletEffect")
    public void onAutoAuthorizeWallet(EffectRequest<OrderApiContext> req) {
        String method = "spring_auto_wallet";
        if (req.payload() instanceof Map<?, ?> m && m.containsKey("paymentMethod")) {
            method = String.valueOf(m.get("paymentMethod"));
        }
        routingEvents.add("auto_authorize_triggered:" + req.transactionId() + ":" + method);
        req.actor().transition(req.transactionId(), "AUTHORIZE_PAYMENT", new AuthorizePaymentInput(method, false));
    }

    @DfsmEffect("awaitManualPaymentEffect")
    public void onAwaitManualPayment(EffectRequest<OrderApiContext> req) {
        routingEvents.add("awaiting_manual_payment:" + req.transactionId());
    }

    @DfsmEffect("sendDeliveryNotification")
    public void onDelivered(EffectRequest<OrderApiContext> req) {
        notifications.add("Delivered notification sent to " + req.context().customerEmail()
                + " (tracking=" + req.context().trackingNumber() + ")");
    }

    @DfsmEffect("recordErrorAlert")
    public void onError(EffectRequest<OrderApiContext> req) {
        notifications.add("Error alert recorded for order tx=" + req.transactionId());
    }

    // -------------------------------------------------------------------------
    // YAML-Bound Transaction Lifecycle Hooks
    // -------------------------------------------------------------------------

    @DfsmHook("onOrderStarted")
    public void onOrderStarted(OnStartEvent<OrderApiContext> evt) {
        recordHook("onStart", evt.transactionId(), Map.of(
                "initialState", evt.initialState().toRaw(),
                "status", evt.status().name()
        ));
    }

    @DfsmHook("onBeforeOrderStep")
    public void onBeforeOrderStep(BeforeTransitionEvent<OrderApiContext> evt) {
        recordHook("beforeTransition", evt.transactionId(), Map.of(
                "event", evt.event(),
                "currentState", evt.currentState().toRaw()
        ));
    }

    @DfsmHook("onAfterOrderStep")
    public void onAfterOrderStep(AfterTransitionEvent<OrderApiContext> evt) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("event", evt.event());
        summary.put("previousState", evt.previousState().toRaw());
        summary.put("currentState", evt.currentState().toRaw());
        summary.put("status", evt.status().name());
        summary.put("compensatedSteps", evt.compensatedSteps());
        recordHook("afterTransition", evt.transactionId(), summary);
    }

    @DfsmHook("onOrderCompensated")
    public void onOrderCompensated(OnCompensateEvent<OrderApiContext> evt) {
        recordHook("onCompensate", evt.transactionId(), Map.of(
                "stepSeq", evt.stepSeq(),
                "compensateHandler", evt.compensateHandler(),
                "fromState", evt.fromState().toRaw()
        ));
    }

    @DfsmHook("onOrderCompleted")
    public void onOrderCompleted(OnCompleteEvent<OrderApiContext> evt) {
        recordHook("onComplete", evt.transactionId(), Map.of(
                "finalState", evt.finalState().toRaw()
        ));
    }

    @DfsmHook("onOrderTerminal")
    public void onOrderTerminal(OnTerminalEvent<OrderApiContext> evt) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("finalState", evt.finalState().toRaw());
        summary.put("status", evt.status().name());
        if (evt.error() != null) summary.put("error", evt.error());
        recordHook("onTerminal", evt.transactionId(), summary);
    }
}

