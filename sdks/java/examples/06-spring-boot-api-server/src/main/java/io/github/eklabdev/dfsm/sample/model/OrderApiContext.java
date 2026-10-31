package io.github.eklabdev.dfsm.sample.model;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;

import java.util.ArrayList;
import java.util.List;

public record OrderApiContext(
        @NotBlank @Email String customerEmail,
        @NotNull List<@Valid OrderItem> items,
        @PositiveOrZero int totalCents,
        boolean inventoryReserved,
        boolean autoApprovePayment,
        String paymentAuthId,
        Double boxWeightKg,
        String trackingNumber,
        String carrier,
        List<String> auditLog
) {
    public static OrderApiContext createDraft(String customerEmail) {
        return new OrderApiContext(
                customerEmail != null && !customerEmail.isBlank() ? customerEmail : "customer@example.com",
                List.of(),
                0,
                false,
                false,
                null,
                null,
                null,
                null,
                List.of("Draft created for " + customerEmail)
        );
    }

    public OrderApiContext withAppendedAudit(String log) {
        List<String> updated = new ArrayList<>(this.auditLog != null ? this.auditLog : List.of());
        updated.add(log);
        return new OrderApiContext(
                customerEmail, items, totalCents, inventoryReserved, autoApprovePayment,
                paymentAuthId, boxWeightKg, trackingNumber, carrier, List.copyOf(updated)
        );
    }
}

