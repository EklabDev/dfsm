package io.github.eklabdev.dfsm.policy;

import java.util.Locale;

public enum BackoffStrategy {
    FIXED("fixed"),
    LINEAR("linear"),
    EXPONENTIAL("exponential"),
    EXPONENTIAL_JITTER("exponential_jitter");

    private final String wireName;

    BackoffStrategy(String wireName) {
        this.wireName = wireName;
    }

    public String wireName() {
        return wireName;
    }

    public static BackoffStrategy fromString(String raw) {
        if (raw == null || raw.isBlank()) {
            return EXPONENTIAL;
        }
        String normalized = raw.trim().toLowerCase(Locale.ROOT);
        for (BackoffStrategy s : values()) {
            if (s.wireName.equals(normalized) || s.name().toLowerCase(Locale.ROOT).equals(normalized)) {
                return s;
            }
        }
        throw new IllegalArgumentException("Unsupported backoff strategy: " + raw);
    }
}

