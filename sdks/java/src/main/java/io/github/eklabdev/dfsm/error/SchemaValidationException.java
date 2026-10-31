package io.github.eklabdev.dfsm.error;

import java.util.List;

public class SchemaValidationException extends DfsmException {
    private final List<String> issues;

    public SchemaValidationException(String message, List<String> issues) {
        super("DFSM_SCHEMA_VALIDATION_ERROR", message + ": " + String.join("; ", issues));
        this.issues = List.copyOf(issues);
    }

    public List<String> getIssues() {
        return issues;
    }
}

