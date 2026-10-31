import type {
  ActiveStepInfo,
  CompensationEntryRecord,
  StateValue,
  TransactionRecord,
  TransactionSnapshot,
  TransactionStatus,
  TransactionSummary,
} from "../types.js";

export interface TransactionQueryFilter {
  machineId?: string;
  actorId?: string;
  transactionIds?: string[];
  statuses?: TransactionStatus[];
  stuckBeforeTimestamp?: number; // updatedAt <= stuckBeforeTimestamp
  olderThanTimestamp?: number; // updatedAt <= olderThanTimestamp
  stateEquals?: StateValue;
  limit?: number;
  offset?: number;
}

export interface TransactionUpdatePatch<TContext = unknown> {
  stateValue?: StateValue;
  context?: TContext;
  status?: TransactionStatus;
  activeStep?: ActiveStepInfo | null;
  lastError?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  updatedAt: number;
}

export interface StateStore {
  readonly driverName: string;

  initialize(): Promise<void>;

  createTransaction<TContext = unknown>(record: TransactionRecord<TContext>): Promise<void>;

  getTransaction<TContext = unknown>(
    transactionId: string
  ): Promise<TransactionSnapshot<TContext> | null>;

  /**
   * Atomically updates transaction fields and optionally appends compensation stack entries,
   * enforcing `version === expectedVersion` (incrementing `version` by 1).
   * Throws `StaleTransactionVersionError` on version mismatch or missing transaction.
   */
  updateTransaction<TContext = unknown>(
    transactionId: string,
    expectedVersion: number,
    patch: TransactionUpdatePatch<TContext>,
    appendCompensations?: Array<Omit<CompensationEntryRecord, "id" | "stepSeq">>
  ): Promise<number>; // returns new version

  getUncompensatedStack(transactionId: string): Promise<CompensationEntryRecord[]>;

  markCompensationExecuted(
    transactionId: string,
    stepSeq: number,
    compensatedAt: number
  ): Promise<void>;

  countTransactions(filter?: TransactionQueryFilter): Promise<number>;

  queryTransactions<TContext = unknown>(
    filter?: TransactionQueryFilter,
    nowTimestamp?: number,
    stuckThresholdMs?: number
  ): Promise<TransactionSummary<TContext>[]>;

  deleteTransactions(transactionIds: string[]): Promise<number>;

  close(): Promise<void>;
}

