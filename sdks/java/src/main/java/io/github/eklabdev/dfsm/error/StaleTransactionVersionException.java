package io.github.eklabdev.dfsm.error;

public class StaleTransactionVersionException extends DfsmException {
    private final String transactionId;
    private final long expectedVersion;

    public StaleTransactionVersionException(String transactionId, long expectedVersion) {
        super(
                "DFSM_STALE_TRANSACTION_VERSION",
                "Optimistic concurrency conflict on transaction '" + transactionId +
                        "' (expected version " + expectedVersion + ")"
        );
        this.transactionId = transactionId;
        this.expectedVersion = expectedVersion;
    }

    public String getTransactionId() {
        return transactionId;
    }

    public long getExpectedVersion() {
        return expectedVersion;
    }
}

