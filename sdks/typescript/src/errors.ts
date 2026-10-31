export class DfsmError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class MachineValidationError extends DfsmError {
  public readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super("DFSM_MACHINE_VALIDATION_ERROR", message);
    this.issues = issues;
  }
}

export class UnregisteredHandlerError extends DfsmError {
  public readonly missingHandlers: string[];

  constructor(machineId: string, missingHandlers: string[]) {
    super(
      "DFSM_UNREGISTERED_HANDLER",
      `Machine '${machineId}' references unregistered handler(s) in FSMRegistry: ${missingHandlers.join(", ")}`
    );
    this.missingHandlers = missingHandlers;
  }
}

export class ValidationError extends DfsmError {
  public readonly target: "initialContext" | "input" | "context";
  public readonly details: string[];

  constructor(target: "initialContext" | "input" | "context", message: string, details: string[] = []) {
    super("DFSM_VALIDATION_ERROR", message);
    this.target = target;
    this.details = details;
  }
}

export class InvalidTransitionError extends DfsmError {
  public readonly currentState: unknown;
  public readonly availableEvents: string[];

  constructor(
    machineId: string,
    event: string,
    currentState: unknown,
    availableEvents: string[] = []
  ) {
    super(
      "DFSM_INVALID_TRANSITION",
      `Event '${event}' is not handled in current state ${JSON.stringify(currentState)} of machine '${machineId}'`
    );
    this.currentState = currentState;
    this.availableEvents = availableEvents;
  }
}

export class TransactionNotFoundError extends DfsmError {
  constructor(transactionId: string) {
    super("DFSM_TRANSACTION_NOT_FOUND", `Transaction '${transactionId}' does not exist in StateStore`);
  }
}

export class StaleTransactionVersionError extends DfsmError {
  constructor(transactionId: string, expectedVersion: number) {
    super(
      "DFSM_STALE_TRANSACTION_VERSION",
      `Optimistic concurrency conflict on transaction '${transactionId}' (expected version ${expectedVersion}). It may have been updated concurrently or force-cleaned.`
    );
  }
}

export class CircuitOpenError extends DfsmError {
  public readonly breakerKey: string;
  public readonly remainingOpenMs: number;

  constructor(breakerKey: string, remainingOpenMs: number) {
    super(
      "DFSM_CIRCUIT_OPEN",
      `Circuit breaker '${breakerKey}' is OPEN (${Math.max(0, Math.ceil(remainingOpenMs))}ms remaining)`
    );
    this.breakerKey = breakerKey;
    this.remainingOpenMs = remainingOpenMs;
  }
}

export class ActorStoppedByRecoveryError extends DfsmError {
  public readonly stuckTransactionIds: string[];

  constructor(actorId: string, stuckTransactionIds: string[]) {
    super(
      "DFSM_ACTOR_STOPPED_BY_RECOVERY",
      `Actor '${actorId}' halted startup due to STOP recovery policy on stuck in-flight transaction(s): ${stuckTransactionIds.join(", ")}`
    );
    this.stuckTransactionIds = stuckTransactionIds;
  }
}

