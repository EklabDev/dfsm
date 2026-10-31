import type { Collection, Db, Filter, MongoClient } from "mongodb";
import { StaleTransactionVersionError } from "../errors.js";
import type {
  ActiveStepInfo,
  CompensationEntryRecord,
  StateValue,
  TransactionRecord,
  TransactionSnapshot,
  TransactionStatus,
  TransactionSummary,
} from "../types.js";
import type {
  StateStore,
  TransactionQueryFilter,
  TransactionUpdatePatch,
} from "./store.js";

interface MongoTransactionDocument {
  _id: string;
  machineId: string;
  machineVersion: string;
  actorId: string;
  stateValue: StateValue;
  context: unknown;
  status: TransactionStatus;
  activeStep: ActiveStepInfo | null;
  lastError: string | null;
  version: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  nextCompStepSeq: number;
  compensationStack: CompensationEntryRecord[];
}

export interface MongoStoreOptions {
  uri?: string;
  client?: MongoClient;
  databaseName?: string;
  collectionName?: string;
}

export class MongoStateStore implements StateStore {
  public readonly driverName = "mongodb";
  private client: MongoClient | null;
  private readonly ownsClient: boolean;
  private readonly uri?: string;
  private readonly databaseName: string;
  private readonly collectionName: string;
  private collection: Collection<MongoTransactionDocument> | null = null;

  constructor(options: MongoStoreOptions) {
    this.databaseName = options.databaseName ?? "dfsm";
    this.collectionName = options.collectionName ?? "dfsm_transactions";

    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
    } else {
      this.client = null;
      this.ownsClient = true;
      this.uri = options.uri ?? "mongodb://127.0.0.1:27017";
    }
  }

  private async getCollection(): Promise<Collection<MongoTransactionDocument>> {
    if (this.collection) return this.collection;
    await this.initialize();
    return this.collection!;
  }

  async initialize(): Promise<void> {
    if (this.collection) return;
    if (!this.client) {
      const mongoModule = await import("mongodb");
      this.client = new mongoModule.MongoClient(this.uri!);
      await this.client.connect();
    }
    const db: Db = this.client.db(this.databaseName);
    this.collection = db.collection<MongoTransactionDocument>(this.collectionName);

    await this.collection.createIndexes([
      {
        key: { machineId: 1, status: 1, updatedAt: 1 },
        name: "idx_machine_status_updated",
      },
      {
        key: { actorId: 1, status: 1, leaseExpiresAt: 1 },
        name: "idx_actor_status_lease",
      },
    ]);
  }

  async createTransaction<TContext = unknown>(
    record: TransactionRecord<TContext>
  ): Promise<void> {
    const col = await this.getCollection();
    await col.insertOne({
      _id: record.transactionId,
      machineId: record.machineId,
      machineVersion: record.machineVersion,
      actorId: record.actorId,
      stateValue: record.stateValue,
      context: record.context ?? null,
      status: record.status,
      activeStep: record.activeStep,
      lastError: record.lastError,
      version: record.version,
      leaseOwner: record.leaseOwner,
      leaseExpiresAt: record.leaseExpiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      nextCompStepSeq: 1,
      compensationStack: [],
    });
  }

  async getTransaction<TContext = unknown>(
    transactionId: string
  ): Promise<TransactionSnapshot<TContext> | null> {
    const col = await this.getCollection();
    const doc = await col.findOne({ _id: transactionId });
    if (!doc) return null;

    const sortedStack = [...doc.compensationStack].sort((a, b) => b.stepSeq - a.stepSeq);

    return {
      transactionId: doc._id,
      machineId: doc.machineId,
      machineVersion: doc.machineVersion,
      actorId: doc.actorId,
      stateValue: doc.stateValue,
      context: doc.context as TContext,
      status: doc.status,
      activeStep: doc.activeStep,
      lastError: doc.lastError,
      version: doc.version,
      leaseOwner: doc.leaseOwner,
      leaseExpiresAt: doc.leaseExpiresAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      compensationStack: sortedStack,
    };
  }

  async updateTransaction<TContext = unknown>(
    transactionId: string,
    expectedVersion: number,
    patch: TransactionUpdatePatch<TContext>,
    appendCompensations?: Array<Omit<CompensationEntryRecord, "id" | "stepSeq">>
  ): Promise<number> {
    const col = await this.getCollection();
    const nextVersion = expectedVersion + 1;

    // Fetch current nextCompStepSeq only when appending compensations so stepSeq stays strictly monotonic
    let baseSeq = 1;
    if (appendCompensations && appendCompensations.length > 0) {
      const existing = await col.findOne(
        { _id: transactionId, version: expectedVersion },
        { projection: { nextCompStepSeq: 1 } }
      );
      if (!existing) {
        throw new StaleTransactionVersionError(transactionId, expectedVersion);
      }
      baseSeq = existing.nextCompStepSeq ?? 1;
    }

    const setDoc: Record<string, unknown> = {
      version: nextVersion,
      updatedAt: patch.updatedAt,
    };
    if (patch.stateValue !== undefined) setDoc.stateValue = patch.stateValue;
    if (patch.context !== undefined) setDoc.context = patch.context ?? null;
    if (patch.status !== undefined) setDoc.status = patch.status;
    if (patch.activeStep !== undefined) setDoc.activeStep = patch.activeStep;
    if (patch.lastError !== undefined) setDoc.lastError = patch.lastError;
    if (patch.leaseOwner !== undefined) setDoc.leaseOwner = patch.leaseOwner;
    if (patch.leaseExpiresAt !== undefined) setDoc.leaseExpiresAt = patch.leaseExpiresAt;

    const updateOp: Record<string, unknown> = { $set: setDoc };

    if (appendCompensations && appendCompensations.length > 0) {
      const prepared: CompensationEntryRecord[] = appendCompensations.map((c, idx) => ({
        transactionId,
        stepSeq: baseSeq + idx,
        transitionKey: c.transitionKey,
        compensateKey: c.compensateKey,
        fromState: c.fromState,
        inputSnapshot: c.inputSnapshot ?? null,
        contextBefore: c.contextBefore ?? null,
        createdAt: c.createdAt,
        compensatedAt: c.compensatedAt,
      }));
      setDoc.nextCompStepSeq = baseSeq + prepared.length;
      updateOp.$push = { compensationStack: { $each: prepared } };
    }

    const res = await col.updateOne(
      { _id: transactionId, version: expectedVersion },
      updateOp
    );

    if (res.matchedCount !== 1) {
      throw new StaleTransactionVersionError(transactionId, expectedVersion);
    }

    return nextVersion;
  }

  async getUncompensatedStack(transactionId: string): Promise<CompensationEntryRecord[]> {
    const col = await this.getCollection();
    const doc = await col.findOne(
      { _id: transactionId },
      { projection: { compensationStack: 1 } }
    );
    if (!doc) return [];
    return doc.compensationStack
      .filter((c) => c.compensatedAt === null)
      .sort((a, b) => b.stepSeq - a.stepSeq);
  }

  async markCompensationExecuted(
    transactionId: string,
    stepSeq: number,
    compensatedAt: number
  ): Promise<void> {
    const col = await this.getCollection();
    await col.updateOne(
      { _id: transactionId, "compensationStack.stepSeq": stepSeq },
      { $set: { "compensationStack.$.compensatedAt": compensatedAt } }
    );
  }

  private buildMongoFilter(filter?: TransactionQueryFilter): Filter<MongoTransactionDocument> {
    if (!filter) return {};
    const q: Record<string, unknown> = {};

    if (filter.machineId) q.machineId = filter.machineId;
    if (filter.actorId) q.actorId = filter.actorId;
    if (filter.transactionIds && filter.transactionIds.length > 0) {
      q._id = { $in: filter.transactionIds };
    }
    if (filter.statuses && filter.statuses.length > 0) {
      q.status = { $in: filter.statuses };
    }

    const maxUpdated =
      filter.stuckBeforeTimestamp !== undefined && filter.olderThanTimestamp !== undefined
        ? Math.min(filter.stuckBeforeTimestamp, filter.olderThanTimestamp)
        : (filter.stuckBeforeTimestamp ?? filter.olderThanTimestamp);

    if (maxUpdated !== undefined) {
      q.updatedAt = { $lte: maxUpdated };
    }

    if (filter.stateEquals !== undefined) {
      q.stateValue = filter.stateEquals;
    }

    return q as Filter<MongoTransactionDocument>;
  }

  async countTransactions(filter?: TransactionQueryFilter): Promise<number> {
    const col = await this.getCollection();
    return col.countDocuments(this.buildMongoFilter(filter));
  }

  async queryTransactions<TContext = unknown>(
    filter?: TransactionQueryFilter,
    nowTimestamp = Date.now(),
    stuckThresholdMs = 30000
  ): Promise<TransactionSummary<TContext>[]> {
    const col = await this.getCollection();
    let cursor = col.find(this.buildMongoFilter(filter)).sort({ updatedAt: 1 });
    if (filter?.offset !== undefined) cursor = cursor.skip(Math.max(0, filter.offset));
    if (filter?.limit !== undefined) cursor = cursor.limit(Math.max(0, filter.limit));

    const docs = await cursor.toArray();
    return docs.map((doc) => {
      const isStuck =
        (doc.status === "IN_FLIGHT" || doc.status === "COMPENSATING") &&
        nowTimestamp - doc.updatedAt >= stuckThresholdMs;
      const uncompDepth = doc.compensationStack.filter((c) => c.compensatedAt === null).length;

      return {
        transactionId: doc._id,
        machineId: doc.machineId,
        actorId: doc.actorId,
        stateValue: doc.stateValue,
        status: doc.status,
        context: doc.context as TContext,
        isStuck,
        activeStep: doc.activeStep,
        compensationDepth: uncompDepth,
        version: doc.version,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    });
  }

  async deleteTransactions(transactionIds: string[]): Promise<number> {
    if (transactionIds.length === 0) return 0;
    const col = await this.getCollection();
    const res = await col.deleteMany({ _id: { $in: transactionIds } });
    return res.deletedCount ?? 0;
  }

  async close(): Promise<void> {
    this.collection = null;
    if (this.client && this.ownsClient) {
      await this.client.close();
      this.client = null;
    }
  }
}

