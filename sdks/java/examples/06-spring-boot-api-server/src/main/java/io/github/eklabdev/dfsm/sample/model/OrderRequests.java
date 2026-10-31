package io.github.eklabdev.dfsm.sample.model;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Positive;

import java.util.List;

public final class OrderRequests {
    private OrderRequests() {}

    public record CreateOrderRequest(
            String transactionId,
            @Email String customerEmail
    ) {}

    public record GenericTransitionRequest(
            @NotBlank(message = "'event' is required") String event,
            Object input
    ) {}

    public record SubmitOrderInput(
            @NotEmpty(message = "Order must contain at least 1 item") List<@Valid OrderItem> items,
            Boolean autoApprovePayment
    ) {}

    public record AuthorizePaymentInput(
            @NotBlank String paymentMethod,
            Boolean simulateFailure
    ) {}

    public record PackCompleteInput(
            @Positive Double boxWeightKg
    ) {}

    public record BookCarrierInput(
            @NotBlank String carrier,
            @NotBlank String trackingNumber
    ) {}

    public record CancelOrderRequest(
            String reason
    ) {}

    public record ResetOrderRequest(
            String note
    ) {}
}

