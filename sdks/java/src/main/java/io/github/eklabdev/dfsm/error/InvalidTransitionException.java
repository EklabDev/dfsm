package io.github.eklabdev.dfsm.error;

import io.github.eklabdev.dfsm.StateValue;

import java.util.List;

public class InvalidTransitionException extends DfsmException {
    private final String machineId;
    private final String event;
    private final StateValue currentState;
    private final List<String> availableEvents;

    public InvalidTransitionException(
            String machineId,
            String event,
            StateValue currentState,
            List<String> availableEvents
    ) {
        super(
                "DFSM_INVALID_TRANSITION",
                "Machine '" + machineId + "' does not handle event '" + event +
                        "' in state " + currentState + " (availableEvents=" + availableEvents + ")"
        );
        this.machineId = machineId;
        this.event = event;
        this.currentState = currentState;
        this.availableEvents = availableEvents != null ? List.copyOf(availableEvents) : List.of();
    }

    public String getMachineId() {
        return machineId;
    }

    public String getEvent() {
        return event;
    }

    public StateValue getCurrentState() {
        return currentState;
    }

    public List<String> getAvailableEvents() {
        return availableEvents;
    }
}

