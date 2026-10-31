import { DatabaseSync } from "node:sqlite";
import { StaleTransactionVersionError } from "../errors.js";
import type {
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

export interface SqliteStoreOptions {
  /**
   * Database file path, or `":memory:"` (default) for an embedded in-memory relational SQL store.
   */
  filename?: string;
}

export class SqliteStateStore implements StateStore {
  public readonly driverName = "sqlite";
  private readonly filename: string;
  private db: DatabaseSync | null = null;

  constructor(options?: SqliteStoreOptions) {
    this.filename = options?.filename ?? ":memory:";
  }

  private ensureDb(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(this.filename);
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.setupSchema(this.db);
    }
    return this.db;
  }

  private setupSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dfsm_transactions (
        transaction_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        machine_version TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        status TEXT NOT NULL,
        active_step_json TEXT,
        last_error TEXT,
        version INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dfsm_tx_machine_status_updated
        ON dfsm_transactions (machine_id, status, updated_at);

      CREATE INDEX IF NOT EXISTS idx_dfsm_tx_actor_status_lease
        ON dfsm_transactions (actor_id, status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS dfsm_compensation_stack (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT NOT NULL REFERENCES dfsm_transactions(transaction_id) ON DELETE CASCADE,
        step_seq INTEGER NOT NULL,
        transition_key TEXT NOT NULL,
        compensate_key TEXT NOT NULL,
        from_state_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        context_before_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        compensated_at INTEGER,
        UNIQUE(transaction_id, step_seq)
      );

      CREATE INDEX IF NOT EXISTS idx_dfsm_comp_tx_uncomp
        ON dfsm_compensation_stack (transaction_id, compensated_at, step_seq DESC);
    `);
  }

  async initialize(): Promise<void> {
    this.ensureDb();
  }

  async createTransaction<TContext = unknown>(
    record: TransactionRecord<TContext>
  ): Promise<void> {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT INTO dfsm_transactions (
        transaction_id, machine_id, machine_version, actor_id,
        state_json, context_json, status, active_step_json, last_error,
        version, lease_owner, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.transactionId,
      record.machineId,
      record.machineVersion,
      record.actorId,
      JSON.stringify(record.stateValue),
      JSON.stringify(record.context ?? null),
      record.status,
      record.activeStep ? JSON.stringify(record.activeStep) : null,
      record.lastError,
      record.version,
      record.leaseOwner,
      record.leaseExpiresAt,
      record.createdAt,
      record.updatedAt
    );
  }

  async getTransaction<TContext = unknown>(
    transactionId: string
  ): Promise<TransactionSnapshot<TContext> | null> {
    const db = this.ensureDb();
    const row = db
      .prepare(`SELECT * FROM dfsm_transactions WHERE transaction_id = ?`)
      .get(transactionId) as Record<string, any> | undefined;

    if (!row) return null;

    const stackRows = db
      .prepare(
        `SELECT * FROM dfsm_compensation_stack WHERE transaction_id = ? ORDER BY step_seq DESC`
      )
      .all(transactionId) as Array<Record<string, any>>;

    const compensationStack: CompensationEntryRecord[] = stackRows.map((s) => ({
      id: Number(s.id),
      transactionId: String(s.transaction_id),
      stepSeq: Number(s.step_seq),
      transitionKey: String(s.transition_key),
      compensateKey: String(s.compensate_key),
      fromState: JSON.parse(String(s.from_state_json)) as StateValue,
      inputSnapshot: JSON.parse(String(s.input_json)),
      contextBefore: JSON.parse(String(s.context_before_json)),
      createdAt: Number(s.created_at),
      compensatedAt: s.compensated_at !== null ? Number(s.compensated_at) : null,
    }));

    return {
      transactionId: String(row.transaction_id),
      machineId: String(row.machine_id),
      machineVersion: String(row.machine_version),
      actorId: String(row.actor_id),
      stateValue: JSON.parse(String(row.state_json)) as StateValue,
      context: JSON.parse(String(row.context_json)) as TContext,
      status: String(row.status) as TransactionStatus,
      activeStep: row.active_step_json ? JSON.parse(String(row.active_step_json)) : null,
      lastError: row.last_error !== null ? String(row.last_error) : null,
      version: Number(row.version),
      leaseOwner: row.lease_owner !== null ? String(row.lease_owner) : null,
      leaseExpiresAt: row.lease_expires_at !== null ? Number(row.lease_expires_at) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      compensationStack,
    };
  }

  async updateTransaction<TContext = unknown>(
    transactionId: string,
    expectedVersion: number,
    patch: TransactionUpdatePatch<TContext>,
    appendCompensations?: Array<Omit<CompensationEntryRecord, "id" | "stepSeq">>
  ): Promise<number> {
    const db = this.ensureDb();
    const nextVersion = expectedVersion + 1;

    db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const setClauses: string[] = ["version = ?", "updated_at = ?"];
      const params: Array<string | number | null> = [nextVersion, patch.updatedAt];

      if (patch.stateValue !== undefined) {
        setClauses.push("state_json = ?");
        params.push(JSON.stringify(patch.stateValue));
      }
      if (patch.context !== undefined) {
        setClauses.push("context_json = ?");
        params.push(JSON.stringify(patch.context ?? null));
      }
      if (patch.status !== undefined) {
        setClauses.push("status = ?");
        params.push(patch.status);
      }
      if (patch.activeStep !== undefined) {
        setClauses.push("active_step_json = ?");
        params.push(patch.activeStep ? JSON.stringify(patch.activeStep) : null);
      }
      if (patch.lastError !== undefined) {
        setClauses.push("last_error = ?");
        params.push(patch.lastError);
      }
      if (patch.leaseOwner !== undefined) {
        setClauses.push("lease_owner = ?");
        params.push(patch.leaseOwner);
      }
      if (patch.leaseExpiresAt !== undefined) {
        setClauses.push("lease_expires_at = ?");
        params.push(patch.leaseExpiresAt);
      }

      params.push(transactionId, expectedVersion);

      const res = db
        .prepare(
          `UPDATE dfsm_transactions SET ${setClauses.join(", ")} WHERE transaction_id = ? AND version = ?`
        )
        .run(...params);

      if (Number(res.changes) !== 1) {
        throw new StaleTransactionVersionError(transactionId, expectedVersion);
      }

      if (appendCompensations && appendCompensations.length > 0) {
        const maxRow = db
          .prepare(
            `SELECT COALESCE(MAX(step_seq), 0) AS max_seq FROM dfsm_compensation_stack WHERE transaction_id = ?`
          )
          .get(transactionId) as { max_seq: number };
        let nextSeq = Number(maxRow.max_seq) + 1;

        const insertComp = db.prepare(`
          INSERT INTO dfsm_compensation_stack (
            transaction_id, step_seq, transition_key, compensate_key,
            from_state_json, input_json, context_before_json, created_at, compensated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const item of appendCompensations) {
          insertComp.run(
            transactionId,
            nextSeq++,
            item.transitionKey,
            item.compensateKey,
            JSON.stringify(item.fromState),
            JSON.stringify(item.inputSnapshot ?? null),
            JSON.stringify(item.contextBefore ?? null),
            item.createdAt,
            item.compensatedAt
          );
        }
      }

      db.exec("COMMIT");
      return nextVersion;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async getUncompensatedStack(transactionId: string): Promise<CompensationEntryRecord[]> {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `SELECT * FROM dfsm_compensation_stack
         WHERE transaction_id = ? AND compensated_at IS NULL
         ORDER BY step_seq DESC`
      )
      .all(transactionId) as Array<Record<string, any>>;

    return rows.map((s) => ({
      id: Number(s.id),
      transactionId: String(s.transaction_id),
      stepSeq: Number(s.step_seq),
      transitionKey: String(s.transition_key),
      compensateKey: String(s.compensate_key),
      fromState: JSON.parse(String(s.from_state_json)) as StateValue,
      inputSnapshot: JSON.parse(String(s.input_json)),
      contextBefore: JSON.parse(String(s.context_before_json)),
      createdAt: Number(s.created_at),
      compensatedAt: null,
    }));
  }

  async markCompensationExecuted(
    transactionId: string,
    stepSeq: number,
    compensatedAt: number
  ): Promise<void> {
    const db = this.ensureDb();
    db.prepare(
      `UPDATE dfsm_compensation_stack
       SET compensated_at = ?
       WHERE transaction_id = ? AND step_seq = ?`
    ).run(compensatedAt, transactionId, stepSeq);
  }

  private buildWhereClause(filter?: TransactionQueryFilter): {
    whereSql: string;
    params: Array<string | number>;
  } {
    if (!filter) return { whereSql: "", params: [] };
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.machineId) {
      clauses.push("t.machine_id = ?");
      params.push(filter.machineId);
    }
    if (filter.actorId) {
      clauses.push("t.actor_id = ?");
      params.push(filter.actorId);
    }
    if (filter.transactionIds && filter.transactionIds.length > 0) {
      clauses.push(`t.transaction_id IN (${filter.transactionIds.map(() => "?").join(", ")})`);
      params.push(...filter.transactionIds);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`t.status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    if (filter.stuckBeforeTimestamp !== undefined) {
      clauses.push("t.updated_at <= ?");
      params.push(filter.stuckBeforeTimestamp);
    }
    if (filter.olderThanTimestamp !== undefined) {
      clauses.push("t.updated_at <= ?");
      params.push(filter.olderThanTimestamp);
    }
    if (filter.stateEquals !== undefined) {
      clauses.push("t.state_json = ?");
      params.push(JSON.stringify(filter.stateEquals));
    }

    return {
      whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }

  async countTransactions(filter?: TransactionQueryFilter): Promise<number> {
    const db = this.ensureDb();
    const { whereSql, params } = this.buildWhereClause(filter);
    const row = db
      .prepare(`SELECT COUNT(*) AS cnt FROM dfsm_transactions t ${whereSql}`)
      .get(...params) as { cnt: number };
    return Number(row.cnt);
  }

  async queryTransactions<TContext = unknown>(
    filter?: TransactionQueryFilter,
    nowTimestamp = Date.now(),
    stuckThresholdMs = 30000
  ): Promise<TransactionSummary<TContext>[]> {
    const db = this.ensureDb();
    const { whereSql, params } = this.buildWhereClause(filter);
    const limitSql = filter?.limit !== undefined ? `LIMIT ${Math.max(0, filter.limit)}` : "";
    const offsetSql = filter?.offset !== undefined ? `OFFSET ${Math.max(0, filter.offset)}` : "";

    const rows = db
      .prepare(
        `SELECT t.*,
          (SELECT COUNT(*) FROM dfsm_compensation_stack c
           WHERE c.transaction_id = t.transaction_id AND c.compensated_at IS NULL) AS comp_depth
         FROM dfsm_transactions t
         ${whereSql}
         ORDER BY t.updated_at ASC
         ${limitSql} ${offsetSql}`
      )
      .all(...params) as Array<Record<string, any>>;

    return rows.map((row) => {
      const status = String(row.status) as TransactionStatus;
      const updatedAt = Number(row.updated_at);
      const isStuck =
        (status === "IN_FLIGHT" || status === "COMPENSATING") &&
        nowTimestamp - updatedAt >= stuckThresholdMs;

      return {
        transactionId: String(row.transaction_id),
        machineId: String(row.machine_id),
        actorId: String(row.actor_id),
        stateValue: JSON.parse(String(row.state_json)) as StateValue,
        status,
        context: JSON.parse(String(row.context_json)) as TContext,
        isStuck,
        activeStep: row.active_step_json ? JSON.parse(String(row.active_step_json)) : null,
        compensationDepth: Number(row.comp_depth),
        version: Number(row.version),
        createdAt: Number(row.created_at),
        updatedAt,
      };
    });
  }

  async deleteTransactions(transactionIds: string[]): Promise<number> {
    if (transactionIds.length === 0) return 0;
    const db = this.ensureDb();
    const placeholders = transactionIds.map(() => "?").join(", ");
    const res = db
      .prepare(`DELETE FROM dfsm_transactions WHERE transaction_id IN (${placeholders})`)
      .run(...transactionIds);
    return Number(res.changes);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

