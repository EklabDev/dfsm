package io.github.eklabdev.dfsm.examples;

import io.github.eklabdev.dfsm.EffectRequest;
import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.TransitionOutput;
import io.github.eklabdev.dfsm.TransitionRequest;
import io.github.eklabdev.dfsm.annotation.DfsmEffect;
import io.github.eklabdev.dfsm.annotation.DfsmTransition;
import io.github.eklabdev.dfsm.annotation.Retry;
import io.github.eklabdev.dfsm.error.ValidationException;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.runtime.MachineHandlerBindings;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Positive;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Progressive Example 02 (YAML + Jakarta Bean Validation):
 * Demonstrates strict {@code dfsm: "1.0"} YAML parsing combined with automatic pre-flight
 * Jakarta Bean Validation ({@code @NotBlank}, {@code @Email}, {@code @Positive}, {@code @Valid})
 * on both {@code TContext} and {@code TInput}. Validation failures throw {@link ValidationException}
 * BEFORE the retry loop or circuit breaker executes.
 */
public final class Example02YamlJakartaValidation {

    private static final String YAML = """
            dfsm: "1.0"
            id: order-intake
            version: "1.0.0"
            initial: draft
            registry:
              namespace: intake
              strict: true
            states:
              draft:
                on:
                  SUBMIT:
                    target: submitted
                    transition: submitOrder
                    effects:
                      - sendConfirmationEmail
              submitted:
                type: final
            """;

    public record LineItem(
            @NotBlank String sku,
            @Positive int quantity,
            @Positive double unitPrice
    ) {}

    public record SubmitOrderInput(
            @NotBlank @Email String customerEmail,
            @NotEmpty List<@Valid LineItem> items
    ) {}

    public record OrderIntakeContext(
            String customerEmail,
            double totalAmount,
            int itemCount
    ) {}

    public static final class OrderIntakeHandlers {
        private final AtomicInteger invocationCount = new AtomicInteger();
        private final List<String> sentEmails = new ArrayList<>();

        @DfsmTransition("submitOrder")
        @Retry(maxAttempts = 3)
        public TransitionOutput<OrderIntakeContext, Double> submitOrder(
                TransitionRequest<OrderIntakeContext, SubmitOrderInput> req
        ) {
            invocationCount.incrementAndGet();
            SubmitOrderInput in = req.input();
            double total = in.items().stream().mapToDouble(i -> i.quantity() * i.unitPrice()).sum();
            int count = in.items().stream().mapToInt(LineItem::quantity).sum();
            return TransitionOutput.of(
                    new OrderIntakeContext(in.customerEmail(), total, count),
                    total
            );
        }

        @DfsmEffect("sendConfirmationEmail")
        public void sendConfirmationEmail(EffectRequest<OrderIntakeContext> req) {
            sentEmails.add(req.context().customerEmail());
        }

        public int getInvocationCount() {
            return invocationCount.get();
        }

        public List<String> getSentEmails() {
            return List.copyOf(sentEmails);
        }
    }

    public record DemoSummary(
            boolean invalidRejectedPreFlight,
            int invocationsAfterInvalidCall,
            StateValue finalStateAfterValidCall,
            TransactionStatus finalStatus,
            double computedTotal,
            List<String> sentEmails
    ) {}

    private Example02YamlJakartaValidation() {}

    public static DemoSummary runDemo() {
        FSMRegistry registry = new FSMRegistry();
        OrderIntakeHandlers handlers = new OrderIntakeHandlers();

        registry.registerYaml(YAML, MachineHandlerBindings.ofServices(handlers));
        DfsmActor<OrderIntakeContext> actor = registry.createActor("order-intake", OrderIntakeContext.class);

        String txId = actor.startTransaction(new OrderIntakeContext(null, 0.0, 0));

        // 1. Invalid email + negative quantity -> rejected pre-flight with zero handler retries!
        boolean rejected = false;
        try {
            actor.transition(txId, "SUBMIT", new SubmitOrderInput(
                    "not-an-email",
                    List.of(new LineItem("SKU-1", -2, 19.99))
            ));
        } catch (ValidationException ex) {
            rejected = true;
        }
        int invocationsAfterInvalid = handlers.getInvocationCount();

        // 2. Valid order payload -> commits cleanly and triggers post-commit email effect
        var ok = actor.<SubmitOrderInput, Double>transition(txId, "SUBMIT", new SubmitOrderInput(
                "alice@example.com",
                List.of(
                        new LineItem("KB-PRO", 1, 149.0),
                        new LineItem("KEYCAPS", 2, 25.5)
                )
        ));

        registry.shutdown();
        return new DemoSummary(
                rejected,
                invocationsAfterInvalid,
                ok.currentState(),
                ok.status(),
                ok.value(),
                handlers.getSentEmails()
        );
    }

    public static void main(String[] args) {
        DemoSummary summary = runDemo();
        System.out.println("=== Example 02: YAML + Jakarta Bean Validation ===");
        System.out.println("Invalid Rejected Pre-Flight : " + summary.invalidRejectedPreFlight());
        System.out.println("Handler Calls After Invalid : " + summary.invocationsAfterInvalidCall());
        System.out.println("Final State                 : " + summary.finalStateAfterValidCall());
        System.out.println("Final Status                : " + summary.finalStatus());
        System.out.println("Computed Total              : $" + summary.computedTotal());
        System.out.println("Confirmation Emails Sent    : " + summary.sentEmails());
    }
}
