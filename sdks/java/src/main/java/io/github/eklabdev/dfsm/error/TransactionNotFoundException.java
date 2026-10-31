package io.github.eklabdev.dfsm.error;

public class TransactionNotFoundException extends DfsmException {
    private final String transactionId;

    public TransactionNotFoundException(String transactionId) {
        super("DFSM_TRANSACTION_NOT_FOUND", "Transaction '" + transactionId + "' was not found");
        this.transactionId = transactionId;
    }

    public String getTransactionId() {
        return transactionId;
    }
}

