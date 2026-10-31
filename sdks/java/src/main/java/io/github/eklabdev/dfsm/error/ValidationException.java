package io.github.eklabdev.dfsm.error;

import java.util.List;

/**
 * Thrown when generic {@code TInput}, {@code initialContext}, or mutated {@code TContext}
 * fails Jakarta Bean Validation or a custom {@link io.github.eklabdev.dfsm.validation.SchemaValidator}.
 */
public class ValidationException extends DfsmException {
    private final String target;
    private final List<String> violations;

    public ValidationException(String target, List<String> violations) {
        super("DFSM_VALIDATION_ERROR",
                "Validation failed for '" + target + "': " + String.join("; ", violations));
        this.target = target;
        this.violations = List.copyOf(violations);
    }

    public String getTarget() {
        return target;
    }

    public List<String> getViolations() {
        return violations;
    }
}

