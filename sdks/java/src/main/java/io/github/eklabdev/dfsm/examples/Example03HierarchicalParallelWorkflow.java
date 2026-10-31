package io.github.eklabdev.dfsm.examples;

import io.github.eklabdev.dfsm.EffectRequest;
import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.TransitionOutput;
import io.github.eklabdev.dfsm.TransitionRequest;
import io.github.eklabdev.dfsm.annotation.DfsmEffect;
import io.github.eklabdev.dfsm.annotation.DfsmTransition;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.runtime.MachineHandlerBindings;

import java.util.ArrayList;
import java.util.List;

/**
 * Progressive Example 03 (Compound Hierarchy + Orthogonal Parallel Regions + Automatic onDone):
 * Demonstrates:
 * 1) Parent-level {@code CANCEL} event bubbling out of deeply nested compound states;
 * 2) Orthogonal {@code parallel} regions ({@code payment} + {@code inventory}) advancing independently
 *    and automatically firing {@code onDone} to {@code shipped} once all regions reach final child states.
 */
public final class Example03HierarchicalParallelWorkflow {

    private static final String YAML = """
            dfsm: "1.0"
            id: fulfillment-workflow
            version: "1.0.0"
            initial: checkout
            registry:
              namespace: fulfill
              strict: true
            states:
              checkout:
                type: compound
                initial: cart
                on:
                  CANCEL:
                    target: cancelled
                    transition: markCancelled
                states:
                  cart:
                    on:
                      LOCK_ORDER:
                        target: "#fulfillment-workflow.fulfillment"
                        transition: lockOrder
              fulfillment:
                type: parallel
                on:
                  CANCEL:
                    target: cancelled
                    transition: markCancelled
                onDone:
                  target: shipped
                  effects:
                    - notifyCustomerShipped
                states:
                  payment:
                    initial: pending
                    states:
                      pending:
                        on:
                          PAYMENT_CAPTURED:
                            target: paid
                            transition: recordPaid
                      paid:
                        type: final
                  inventory:
                    initial: picking
                    states:
                      picking:
                        on:
                          ITEMS_PACKED:
                            target: packed
                            transition: recordPacked
                      packed:
                        type: final
              shipped:
                type: final
              cancelled:
                type: final
            """;

    public record FulfillmentContext(
            boolean locked,
            boolean paid,
            boolean packed,
            boolean cancelled,
            String cancelReason
    ) {}

    public record CancelInput(String reason) {}

    public static final class FulfillmentService {
        private final List<String> notifications = new ArrayList<>();

        @DfsmTransition("lockOrder")
        public TransitionOutput<FulfillmentContext, Void> lockOrder(TransitionRequest<FulfillmentContext, Void> req) {
            FulfillmentContext c = req.data();
            return TransitionOutput.ofContext(new FulfillmentContext(true, c.paid(), c.packed(), false, null));
        }

        @DfsmTransition("recordPaid")
        public TransitionOutput<FulfillmentContext, Void> recordPaid(TransitionRequest<FulfillmentContext, Void> req) {
            FulfillmentContext c = req.data();
            return TransitionOutput.ofContext(new FulfillmentContext(c.locked(), true, c.packed(), c.cancelled(), c.cancelReason()));
        }

        @DfsmTransition("recordPacked")
        public TransitionOutput<FulfillmentContext, Void> recordPacked(TransitionRequest<FulfillmentContext, Void> req) {
            FulfillmentContext c = req.data();
            return TransitionOutput.ofContext(new FulfillmentContext(c.locked(), c.paid(), true, c.cancelled(), c.cancelReason()));
        }

        @DfsmTransition("markCancelled")
        public TransitionOutput<FulfillmentContext, Void> markCancelled(TransitionRequest<FulfillmentContext, CancelInput> req) {
            FulfillmentContext c = req.data();
            String reason = req.input() != null ? req.input().reason() : "Customer request";
            return TransitionOutput.ofContext(new FulfillmentContext(c.locked(), c.paid(), c.packed(), true, reason));
        }

        @DfsmEffect("notifyCustomerShipped")
        public void notifyShipped(EffectRequest<FulfillmentContext> req) {
            notifications.add("SHIPPED:" + req.transactionId());
        }

        public List<String> getNotifications() {
            return List.copyOf(notifications);
        }
    }

    public record DemoSummary(
            StateValue parallelMidwayState,
            StateValue completedParallelState,
            TransactionStatus completedStatus,
            StateValue bubbledCancelState,
            FulfillmentContext cancelledContext,
            List<String> notifications
    ) {}

    private Example03HierarchicalParallelWorkflow() {}

    public static DemoSummary runDemo() {
        FSMRegistry registry = new FSMRegistry();
        FulfillmentService svc = new FulfillmentService();
        registry.registerYaml(YAML, MachineHandlerBindings.ofServices(svc));

        DfsmActor<FulfillmentContext> actor = registry.createActor("fulfillment-workflow", FulfillmentContext.class);

        // Order A: Parallel completion -> automatic onDone -> shipped
        String txA = actor.startTransaction(new FulfillmentContext(false, false, false, false, null));
        actor.transition(txA, "LOCK_ORDER", null);
        var midway = actor.transition(txA, "PAYMENT_CAPTURED", null);
        var shipped = actor.transition(txA, "ITEMS_PACKED", null);

        // Order B: Parent CANCEL bubbles out of nested compound state checkout.cart -> cancelled
        String txB = actor.startTransaction(new FulfillmentContext(false, false, false, false, null));
        var cancelled = actor.transition(txB, "CANCEL", new CancelInput("Changed shipping address"));

        registry.shutdown();
        return new DemoSummary(
                midway.currentState(),
                shipped.currentState(),
                shipped.status(),
                cancelled.currentState(),
                cancelled.context(),
                svc.getNotifications()
        );
    }

    public static void main(String[] args) {
        DemoSummary summary = runDemo();
        System.out.println("=== Example 03: Compound Hierarchy & Orthogonal Parallel Regions ===");
        System.out.println("Parallel Midway State  : " + summary.parallelMidwayState().toRaw());
        System.out.println("Parallel onDone State  : " + summary.completedParallelState());
        System.out.println("Parallel Final Status  : " + summary.completedStatus());
        System.out.println("Bubbled Cancel State   : " + summary.bubbledCancelState());
        System.out.println("Cancelled Context      : " + summary.cancelledContext());
        System.out.println("Shipped Notifications  : " + summary.notifications());
    }
}
