package io.github.eklabdev.dfsm.sample.model;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;

public record OrderItem(
        @NotBlank String sku,
        @Positive int quantity,
        @Positive int unitPriceCents
) {}

