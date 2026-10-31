package io.github.eklabdev.dfsm;

import java.util.List;

/**
 * Canonical DFSM v1.0 Transaction Status lifecycle.
 */
public enum TransactionStatus {
    IDLE(false),
    IN_FLIGHT(false),
    COMPLETED(true),
    COMPENSATING(false),
    COMPENSATED(true),
    FAILED(true);

    public static final List<TransactionStatus> NON_TERMINAL_STATUSES = List.of(
            IDLE, IN_FLIGHT, COMPENSATING
    );

    public static final List<TransactionStatus> TERMINAL_STATUSES = List.of(
            COMPLETED, COMPENSATED, FAILED
    );

    private final boolean terminal;

    TransactionStatus(boolean terminal) {
        this.terminal = terminal;
    }

    public boolean isTerminal() {
        return terminal;
    }

    public boolean isNonTerminal() {
        return !terminal;
    }
}

