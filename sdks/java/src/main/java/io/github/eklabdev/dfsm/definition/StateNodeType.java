package io.github.eklabdev.dfsm.definition;

import java.util.Locale;

public enum StateNodeType {
    ATOMIC,
    COMPOUND,
    PARALLEL,
    FINAL;

    public static StateNodeType fromString(String raw, boolean hasChildren) {
        if (raw == null || raw.isBlank()) {
            return hasChildren ? COMPOUND : ATOMIC;
        }
        return switch (raw.trim().toLowerCase(Locale.ROOT)) {
            case "atomic" -> ATOMIC;
            case "compound" -> COMPOUND;
            case "parallel" -> PARALLEL;
            case "final" -> FINAL;
            default -> throw new IllegalArgumentException("Unknown state type: " + raw);
        };
    }
}

