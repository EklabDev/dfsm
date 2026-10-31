package io.github.eklabdev.dfsm.error;

/**
 * Base runtime exception for all DFSM errors.
 */
public class DfsmException extends RuntimeException {
    private final String code;

    public DfsmException(String code, String message) {
        super(message);
        this.code = code;
    }

    public DfsmException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public String getCode() {
        return code;
    }
}

