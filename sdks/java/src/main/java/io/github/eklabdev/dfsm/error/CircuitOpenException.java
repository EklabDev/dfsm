package io.github.eklabdev.dfsm.error;

public class CircuitOpenException extends DfsmException {
    private final String transitionKey;

    public CircuitOpenException(String transitionKey) {
        super("DFSM_CIRCUIT_OPEN", "Circuit breaker is OPEN for transition '" + transitionKey + "'");
        this.transitionKey = transitionKey;
    }

    public String getTransitionKey() {
        return transitionKey;
    }
}

