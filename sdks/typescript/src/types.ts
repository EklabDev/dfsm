import type { DfsmActor } from "./runtime/actor.js";

export type StateValue = string | { [regionOrParent: string]: StateValue };

export type TransactionStatus =
  | "IDLE"
  | "IN_FLIGHT"
  | "COMPLETED"
  | "COMPENSATING"
  | "COMPENSATED"
  | "FAILED";

export const NON_TERMINAL_STATUSES: readonly TransactionStatus[] = Object.freeze([
  "IDLE",
  "IN_FLIGHT",
  "COMPENSATING",
]);

export const TERMINAL_STATUSES: readonly TransactionStatus[] = Object.freeze([
  "COMPLETED",
  "COMPENSATED",
  "FAILED",
]);

export function isTerminalStatus(status: TransactionStatus): boolean {
  return status === "COMPLETED" || status === "COMPENSATED" || status === "FAILED";
}

export interface TerminalStateDescriptor {
  path: string;
  key: string;
  kind: "final" | "error";
  isTopLevel: boolean;
  isImplicitDefaultError: boolean;
  isRecoverableError: boolean;
  recoveryEvents: string[];
}

export interface MachineTerminalStatesSummary {
  machineId: string;
  terminalStatuses: readonly TransactionStatus[];
  nonTerminalStatuses: readonly TransactionStatus[];
  topLevelTerminalStates: string[];
  states: TerminalStateDescriptor[];
}

export interface StatusBreakdown {
  nonTerminalCount: number;
  terminalCount: number;
  byStatus: Record<TransactionStatus, number>;
}

export type BackoffStrategy = "fixed" | "linear" | "exponential" | "exponential_jitter";

export interface PartialBackoffPolicy {
  strategy?: BackoffStrategy;
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
}

export interface NormalizedBackoffPolicy {
  strategy: BackoffStrategy;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

export interface PartialRetryPolicy {
  maxAttempts?: number;
  backoff?: PartialBackoffPolicy;
  retryIf?: (error: unknown) => boolean;
}

export interface NormalizedRetryPolicy {
  maxAttempts: number;
  backoff: NormalizedBackoffPolicy;
  retryIf?: (error: unknown) => boolean;
}

export interface PartialCircuitBreakerPolicy {
  enabled?: boolean;
  key?: string;
  failureThreshold?: number;
  slidingWindowSize?: number;
  openDurationMs?: number;
  halfOpenMaxCalls?: number;
}

export interface NormalizedCircuitBreakerPolicy {
  enabled: boolean;
  key: string;
  failureThreshold: number;
  slidingWindowSize: number;
  openDurationMs: number;
  halfOpenMaxCalls: number;
}

export interface PartialOnFailPolicy {
  compensate?: boolean;
  target?: string;
}

export interface NormalizedOnFailPolicy {
  compensate: boolean;
  target: string;
}

export interface PartialBenchmarkPolicy {
  enabled?: boolean;
}

export interface NormalizedBenchmarkPolicy {
  enabled: boolean;
}

export interface PartialTransitionPolicy {
  retry?: PartialRetryPolicy;
  circuitBreaker?: PartialCircuitBreakerPolicy;
  onFail?: PartialOnFailPolicy;
  benchmark?: PartialBenchmarkPolicy;
  compensateHandler?: string;
}

export interface NormalizedTransitionPolicy {
  retry: NormalizedRetryPolicy;
  circuitBreaker: NormalizedCircuitBreakerPolicy;
  onFail: NormalizedOnFailPolicy;
  benchmark: NormalizedBenchmarkPolicy;
  compensateHandler?: string;
}

export interface TransactionContext<TContext = unknown> {
  readonly transactionId: string;
  readonly machineId: string;
  readonly actorId: string;
  readonly event: string;
  readonly attempt: number;
  readonly startedAt: number;
  data: TContext;
  metadata: Record<string, unknown>;
}

export interface EffectInvocation {
  handler: string;
  payload?: unknown;
}

export interface TransitionOutput<TContext = unknown, TOutput = unknown> {
  value?: TOutput;
  context?: TContext;
  targetState?: string;
  effects?: Array<string | EffectInvocation>;
}

export type TransitionRequest<TContext = unknown, TInput = unknown> = {
  currentState: StateValue;
  input: TInput;
  context: TransactionContext<TContext>;
};

export type TransitionFunction<TContext = any, TInput = any, TOutput = any> = (
  request: TransitionRequest<TContext, TInput>
) => Promise<TransitionOutput<TContext, TOutput> | void> | TransitionOutput<TContext, TOutput> | void;

export interface CompensationRequest<TContext = unknown, TInput = unknown> {
  transactionId: string;
  machineId: string;
  actorId: string;
  stepSeq: number;
  fromState: StateValue;
  inputSnapshot: TInput;
  contextBefore: TContext;
  currentContext: TContext;
  failureError?: string;
}

export type CompensateFunction<TContext = any, TInput = any> = (
  request: CompensationRequest<TContext, TInput>
) => Promise<TContext | void> | TContext | void;

export interface EffectRequest<TContext = unknown> {
  transactionId: string;
  machineId: string;
  actorId: string;
  state: StateValue;
  context: TContext;
  payload?: unknown;
  /**
   * Direct reference to the owning `DfsmActor<TContext>` so effects can inspect state
   * or trigger conditional follow-up transitions (`await req.actor.transition(req.transactionId, ...)`).
   */
  actor: DfsmActor<TContext>;
  /**
   * Invokes another registered DFSM effect handler by name, allowing an effect
   * to act as a conditional (`if / else`) router into specialized effects.
   */
  runEffect: (effectHandlerName: string, payload?: unknown) => Promise<void>;
}

export type EffectFunction<TContext = any> = (
  request: EffectRequest<TContext>
) => Promise<void> | void;

export interface OnTransactionStartHookEvent<TContext = unknown> {
  transactionId: string;
  machineId: string;
  actorId: string;
  initialState: StateValue;
  status: TransactionStatus;
  context: TContext;
  actor: DfsmActor<TContext>;
}

export interface BeforeTransitionHookEvent<TContext = unknown> {
  transactionId: string;
  machineId: string;
  actorId: string;
  event: string;
  input: unknown;
  currentState: StateValue;
  context: TContext;
  actor: DfsmActor<TContext>;
}

export interface AfterTransitionHookEvent<TContext = unknown> {
  transactionId: string;
  machineId: string;
  actorId: string;
  event: string;
  input: unknown;
  previousState: StateValue;
  currentState: StateValue;
  status: TransactionStatus;
  value: unknown;
  context: TContext;
  compensatedSteps: number;
  durationMs: number;
  error?: string;
  actor: DfsmActor<TContext>;
}

export interface OnCompensateHookEvent<TContext = unknown> {
  transactionId: string;
  machineId: string;
  actorId: string;
  stepSeq: number;
  compensateHandler: string;
  fromState: StateValue;
  inputSnapshot: unknown;
  updatedContext: TContext;
  reason?: string;
  actor: DfsmActor<TContext>;
}

export interface OnCompleteHookEvent<TContext = unknown> {
  transactionId: string;
  machineId: string;
  actorId: string;
  finalState: StateValue;
  context: TContext;
  actor: DfsmActor<TContext>;
}

export interface OnTerminalHookEvent<TContext = unknown> {
  transactionId: string;
  machineId: string;
  actorId: string;
  finalState: StateValue;
  status: "COMPLETED" | "COMPENSATED" | "FAILED";
  context: TContext;
  error?: string;
  actor: DfsmActor<TContext>;
}

export interface ActorLifecycleHooks<TContext = unknown> {
  onStart?: (event: OnTransactionStartHookEvent<TContext>) => Promise<void> | void;
  beforeTransition?: (event: BeforeTransitionHookEvent<TContext>) => Promise<void> | void;
  afterTransition?: (event: AfterTransitionHookEvent<TContext>) => Promise<void> | void;
  onCompensate?: (event: OnCompensateHookEvent<TContext>) => Promise<void> | void;
  onComplete?: (event: OnCompleteHookEvent<TContext>) => Promise<void> | void;
  onTerminal?: (event: OnTerminalHookEvent<TContext>) => Promise<void> | void;
}

export type LifecycleHookName = keyof ActorLifecycleHooks<any>;

export interface LifecycleHookEventMap<TContext = unknown> {
  onStart: OnTransactionStartHookEvent<TContext>;
  beforeTransition: BeforeTransitionHookEvent<TContext>;
  afterTransition: AfterTransitionHookEvent<TContext>;
  onCompensate: OnCompensateHookEvent<TContext>;
  onComplete: OnCompleteHookEvent<TContext>;
  onTerminal: OnTerminalHookEvent<TContext>;
}

export type LifecycleHookFunction<TEvent = any> = (event: TEvent) => Promise<void> | void;

export interface TransitionExecutionResult<TContext = unknown, TOutput = unknown> {
  transactionId: string;
  previousState: StateValue;
  currentState: StateValue;
  status: TransactionStatus;
  value: TOutput | undefined;
  context: TContext;
  compensatedSteps: number;
  error?: string;
}

export type OnRestartMode = "STOP" | "MARK_FAIL" | "DELETE" | "COMPENSATE" | "CONTINUE";

export interface InFlightRecoveryConfig {
  enabled?: boolean;
  stuckThresholdMs?: number;
  defaultAction?: OnRestartMode;
  stateActions?: Record<string, OnRestartMode>;
  haltActorOnStop?: boolean;
}

export interface ActorSchedulerConfig {
  enabled: boolean;
  sweepIntervalMs: number;
  stuckThresholdMs: number;
  retentionMs?: number;
  batchSize: number;
}

export interface RecoverySweepReport {
  sweptAt: number;
  scannedInFlight: number;
  stuckDetected: number;
  actionsTaken: Record<OnRestartMode, string[]>;
  retentionDeleted: number;
  errors: Array<{ transactionId: string; error: string }>;
}

export interface SchedulerStatus {
  isRunning: boolean;
  config: Readonly<ActorSchedulerConfig>;
  lastRunAt: number | null;
  nextRunAt: number | null;
  totalSweeps: number;
  totalRecoveredCount: number;
  totalRetentionCleanedCount: number;
  lastSweepReport: RecoverySweepReport | null;
}

export type CleanUpAction = "DELETE" | "MARK_FAIL" | "COMPENSATE" | "FORCE_UNLOCK";

export interface ForceCleanUpOptions {
  machineId?: string;
  actorId?: string;
  transactionIds?: string[];
  statuses?: TransactionStatus[];
  includeInFlight?: boolean;
  stuckOnly?: boolean;
  stuckThresholdMs?: number;
  olderThanMs?: number;
  action?: CleanUpAction;
  dryRun?: boolean;
}

export interface CleanUpReport {
  scanned: number;
  matched: number;
  deleted: string[];
  markedFailed: string[];
  compensated: string[];
  unlocked: string[];
  dryRun: boolean;
  errors: Array<{ transactionId: string; error: string }>;
}

export interface CompensationEntryRecord {
  id?: string | number;
  transactionId: string;
  stepSeq: number;
  transitionKey: string;
  compensateKey: string;
  fromState: StateValue;
  inputSnapshot: unknown;
  contextBefore: unknown;
  createdAt: number;
  compensatedAt: number | null;
}

export interface ActiveStepInfo {
  event: string;
  input: unknown;
  startedAt: number;
}

export interface TransactionRecord<TContext = unknown> {
  transactionId: string;
  machineId: string;
  machineVersion: string;
  actorId: string;
  stateValue: StateValue;
  context: TContext;
  status: TransactionStatus;
  activeStep: ActiveStepInfo | null;
  lastError: string | null;
  version: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TransactionSnapshot<TContext = unknown> extends TransactionRecord<TContext> {
  compensationStack: CompensationEntryRecord[];
}

export interface TransactionSummary<TContext = unknown> {
  transactionId: string;
  machineId: string;
  actorId: string;
  stateValue: StateValue;
  status: TransactionStatus;
  context: TContext;
  isStuck: boolean;
  activeStep: ActiveStepInfo | null;
  compensationDepth: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface MachineSummary {
  id: string;
  version: string;
  source: "yaml" | "builder";
  namespace?: string;
  stateCount: number;
  hasCustomErrorState: boolean;
  boundActorCount: number;
}

export interface HandlerDescriptor {
  name: string;
  kind: "transition" | "compensate" | "effect" | "hook";
  policy?: PartialTransitionPolicy;
}

export type CircuitStatus = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface EffectiveTransitionConfig {
  statePath: string;
  event: string;
  target?: string;
  resolvedTransitionHandler?: string;
  resolvedCompensateHandler?: string;
  policy: NormalizedTransitionPolicy;
  circuitBreakerState: CircuitStatus;
}

export interface EffectiveMachineConfig {
  machineId: string;
  version: string;
  source: "yaml" | "builder";
  hasCustomErrorState: boolean;
  maxEffectChainDepth: number;
  resolvedHooks: Partial<Record<LifecycleHookName, string[]>>;
  registeredEffects: string[];
  transitions: EffectiveTransitionConfig[];
}

export interface ActorSummary {
  actorId: string;
  machineId: string;
  schedulerEnabled: boolean;
  schedulerRunning: boolean;
  recoveryPolicy: Readonly<Required<Omit<InFlightRecoveryConfig, "stateActions">> & { stateActions: Record<string, OnRestartMode> }>;
}

export interface InFlightStats {
  totalIdle: number;
  totalInFlight: number;
  totalCompensating: number;
  totalNonTerminal: number;
  totalStuck: number;
  byMachine: Record<
    string,
    {
      idle: number;
      inFlight: number;
      compensating: number;
      nonTerminal: number;
      stuck: number;
    }
  >;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)),
};

