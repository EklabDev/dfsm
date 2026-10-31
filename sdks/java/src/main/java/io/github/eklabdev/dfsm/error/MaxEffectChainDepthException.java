package io.github.eklabdev.dfsm.error;

public class MaxEffectChainDepthException extends DfsmException {
    private final String transactionId;
    private final int maxDepth;

    public MaxEffectChainDepthException(String transactionId, int maxDepth) {
        super(
                "DFSM_MAX_EFFECT_CHAIN_DEPTH",
                "Exceeded maxEffectChainDepth (" + maxDepth + ") on transaction '" + transactionId + "'"
        );
        this.transactionId = transactionId;
        this.maxDepth = maxDepth;
    }

    public String getTransactionId() {
        return transactionId;
    }

    public int getMaxDepth() {
        return maxDepth;
    }
}

