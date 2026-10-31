package io.github.eklabdev.dfsm.error;

public class UnregisteredHandlerException extends DfsmException {
    private final String machineId;
    private final String handlerKind;
    private final String handlerKey;

    public UnregisteredHandlerException(String machineId, String handlerKind, String handlerKey) {
        super(
                "DFSM_UNREGISTERED_HANDLER",
                "Machine '" + machineId + "' references unregistered " + handlerKind + " handler '" + handlerKey + "'"
        );
        this.machineId = machineId;
        this.handlerKind = handlerKind;
        this.handlerKey = handlerKey;
    }

    public String getMachineId() {
        return machineId;
    }

    public String getHandlerKind() {
        return handlerKind;
    }

    public String getHandlerKey() {
        return handlerKey;
    }
}

