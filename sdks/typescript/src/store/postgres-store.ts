import type { Pool, PoolConfig } from "pg";
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

export interface PostgresStoreOptions {
  connectionString?: string;
  poolConfig?: PoolConfig;
  pool?: Pool;
  tablePrefix?: string;
}

export class PostgresStateStore implements StateStore {
  public readonly driverName = "postgres";
  private pool: Pool | null;
  private readonly ownsPool: boolean;
  private readonly poolConfig?: PoolConfig;
  private readonly txTable: string;
  private readonly compTable: string;
  private initialized = false;

  constructor(options: PostgresStoreOptions) {
    const prefix = options.tablePrefix ?? "dfsm_";
    if (!/^[a-zA-Z0-9_]+$/.test(prefix)) {
      throw new Error(`Invalid Postgres tablePrefix '${prefix}'`);
    }
    this.txTable = `${prefix}transactions`;
    this.compTable = `${prefix}compensation_stack`;

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = null;
      this.ownsPool = true;
      this.poolConfig = options.poolConfig ?? {
        connectionString: options.connectionString,
      };
    }
  }

  private async getPool(): Promise<Pool> {
    if (!this.pool) {
      const pgModule = await import("pg");
      const PoolCtor = pgModule.Pool ?? pgModule.default?.Pool;
      this.pool = new PoolCtor(this.poolConfig);
    }
    if (!this.initialized) {
      await this.initialize();
    }
    return this.pool!;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.pool) {
      const pgModule = await import("pg");
      const PoolCtor = pgModule.Pool ?? pgModule.default?.Pool;
      this.pool = new PoolCtor(this.poolConfig);
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.txTable} (
        transaction_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        machine_version TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        state_json JSONB NOT NULL,
        context_json JSONB NOT NULL,
        status TEXT NOT NULL,
        active_step_json JSONB,
        last_error TEXT,
        version INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_${this.txTable}_machine_status_updated
        ON ${this.txTable} (machine_id, status, updated_at);

      CREATE INDEX IF NOT EXISTS idx_${this.txTable}_actor_status_lease
        ON ${this.txTable} (actor_id, status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS ${this.compTable} (
        id BIGSERIAL PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES ${this.txTable}(transaction_id) ON DELETE CASCADE,
        step_seq INTEGER NOT NULL,
        transition_key TEXT NOT NULL,
        compensate_key TEXT NOT NULL,
        from_state_json JSONB NOT NULL,
        input_json JSONB NOT NULL,
        context_before_json JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        compensated_at BIGINT,
        UNIQUE(transaction_id, step_seq)
      );

      CREATE INDEX IF NOT EXISTS idx_${this.compTable}_tx_uncomp
        ON ${this.compTable} (transaction_id, compensated_at, step_seq DESC);
    `);

    this.initialized = true;
  }

  async createTransaction<TContext = unknown>(
    record: TransactionRecord<TContext>
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.txTable} (
        transaction_id, machine_id, machine_version, actor_id,
        state_json, context_json, status, active_step_json, last_error,
        version, lease_owner, lease_expires_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)`,
      [
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
        record.updatedAt,
      ]
    );
  }

  async getTransaction<TContext = unknown>(
    transactionId: string
  ): Promise<TransactionSnapshot<TContext> | null> {
    const pool = await this.getPool();
    const txRes = await pool.query(
      `SELECT * FROM ${this.txTable} WHERE transaction_id = $1`,
      [transactionId]
    );
    if (txRes.rowCount === 0) return null;
    const row = txRes.rows[0]!;

    const compRes = await pool.query(
      `SELECT * FROM ${this.compTable} WHERE transaction_id = $1 ORDER BY step_seq DESC`,
      [transactionId]
    );

    const compensationStack: CompensationEntryRecord[] = compRes.rows.map((s) => ({
      id: String(s.id),
      transactionId: String(s.transaction_id),
      stepSeq: Number(s.step_seq),
      transitionKey: String(s.transition_key),
      compensateKey: String(s.compensate_key),
      fromState: s.from_state_json as StateValue,
      inputSnapshot: s.input_json,
      contextBefore: s.context_before_json,
      createdAt: Number(s.created_at),
      compensatedAt: s.compensated_at !== null ? Number(s.compensated_at) : null,
    }));

    return {
      transactionId: String(row.transaction_id),
      machineId: String(row.machine_id),
      machineVersion: String(row.machine_version),
      actorId: String(row.actor_id),
      stateValue: row.state_json as StateValue,
      context: row.context_json as TContext,
      status: String(row.status) as TransactionStatus,
      activeStep: row.active_step_json ?? null,
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
    const pool = await this.getPool();
    const client = await pool.connect();
    const nextVersion = expectedVersion + 1;

    try {
      await client.query("BEGIN");

      const sets: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      sets.push(`version = $${idx++}`);
      values.push(nextVersion);

      sets.push(`updated_at = $${idx++}`);
      values.push(patch.updatedAt);

      if (patch.stateValue !== undefined) {
        sets.push(`state_json = $${idx++}::jsonb`);
        values.push(JSON.stringify(patch.stateValue));
      }
      if (patch.context !== undefined) {
        sets.push(`context_json = $${idx++}::jsonb`);
        values.push(JSON.stringify(patch.context ?? null));
      }
      if (patch.status !== undefined) {
        sets.push(`status = $${idx++}`);
        values.push(patch.status);
      }
      if (patch.activeStep !== undefined) {
        sets.push(`active_step_json = $${idx++}::jsonb`);
        values.push(patch.activeStep ? JSON.stringify(patch.activeStep) : null);
      }
      if (patch.lastError !== undefined) {
        sets.push(`last_error = $${idx++}`);
        values.push(patch.lastError);
      }
      if (patch.leaseOwner !== undefined) {
        sets.push(`lease_owner = $${idx++}`);
        values.push(patch.leaseOwner);
      }
      if (patch.leaseExpiresAt !== undefined) {
        sets.push(`lease_expires_at = $${idx++}`);
        values.push(patch.leaseExpiresAt);
      }

      const idParam = idx++;
      const verParam = idx++;
      values.push(transactionId, expectedVersion);

      const updRes = await client.query(
        `UPDATE ${this.txTable} SET ${sets.join(", ")} WHERE transaction_id = $${idParam} AND version = $${verParam}`,
        values
      );

      if (updRes.rowCount !== 1) {
        throw new StaleTransactionVersionError(transactionId, expectedVersion);
      }

      if (appendCompensations && appendCompensations.length > 0) {
        const seqRes = await client.query(
          `SELECT COALESCE(MAX(step_seq), 0) AS max_seq FROM ${this.compTable} WHERE transaction_id = $1`,
          [transactionId]
        );
        let nextSeq = Number(seqRes.rows[0]?.max_seq ?? 0) + 1;

        for (const item of appendCompensations) {
          await client.query(
            `INSERT INTO ${this.compTable} (
              transaction_id, step_seq, transition_key, compensate_key,
              from_state_json, input_json, context_before_json, created_at, compensated_at
            ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
            [
              transactionId,
              nextSeq++,
              item.transitionKey,
              item.compensateKey,
              JSON.stringify(item.fromState),
              JSON.stringify(item.inputSnapshot ?? null),
              JSON.stringify(item.contextBefore ?? null),
              item.createdAt,
              item.compensatedAt,
            ]
          );
        }
      }

      await client.query("COMMIT");
      return nextVersion;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getUncompensatedStack(transactionId: string): Promise<CompensationEntryRecord[]> {
    const pool = await this.getPool();
    const res = await pool.query(
      `SELECT * FROM ${this.compTable}
       WHERE transaction_id = $1 AND compensated_at IS NULL
       ORDER BY step_seq DESC`,
      [transactionId]
    );
    return res.rows.map((s) => ({
      id: String(s.id),
      transactionId: String(s.transaction_id),
      stepSeq: Number(s.step_seq),
      transitionKey: String(s.transition_key),
      compensateKey: String(s.compensate_key),
      fromState: s.from_state_json as StateValue,
      inputSnapshot: s.input_json,
      contextBefore: s.context_before_json,
      createdAt: Number(s.created_at),
      compensatedAt: null,
    }));
  }

  async markCompensationExecuted(
    transactionId: string,
    stepSeq: number,
    compensatedAt: number
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `UPDATE ${this.compTable}
       SET compensated_at = $1
       WHERE transaction_id = $2 AND step_seq = $3`,
      [compensatedAt, transactionId, stepSeq]
    );
  }

  private buildWhereClause(filter?: TransactionQueryFilter): {
    whereSql: string;
    values: unknown[];
  } {
    if (!filter) return { whereSql: "", values: [] };
    const clauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filter.machineId) {
      clauses.push(`t.machine_id = $${idx++}`);
      values.push(filter.machineId);
    }
    if (filter.actorId) {
      clauses.push(`t.actor_id = $${idx++}`);
      values.push(filter.actorId);
    }
    if (filter.transactionIds && filter.transactionIds.length > 0) {
      clauses.push(`t.transaction_id = ANY($${idx++}::text[])`);
      values.push(filter.transactionIds);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`t.status = ANY($${idx++}::text[])`);
      values.push(filter.statuses);
    }
    if (filter.stuckBeforeTimestamp !== undefined) {
      clauses.push(`t.updated_at <= $${idx++}`);
      values.push(filter.stuckBeforeTimestamp);
    }
    if (filter.olderThanTimestamp !== undefined) {
      clauses.push(`t.updated_at <= $${idx++}`);
      values.push(filter.olderThanTimestamp);
    }
    if (filter.stateEquals !== undefined) {
      clauses.push(`t.state_json = $${idx++}::jsonb`);
      values.push(JSON.stringify(filter.stateEquals));
    }

    return {
      whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      values,
    };
  }

  async countTransactions(filter?: TransactionQueryFilter): Promise<number> {
    const pool = await this.getPool();
    const { whereSql, values } = this.buildWhereClause(filter);
    const res = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM ${this.txTable} t ${whereSql}`,
      values
    );
    return Number(res.rows[0]?.cnt ?? 0);
  }

  async queryTransactions<TContext = unknown>(
    filter?: TransactionQueryFilter,
    nowTimestamp = Date.now(),
    stuckThresholdMs = 30000
  ): Promise<TransactionSummary<TContext>[]> {
    const pool = await this.getPool();
    const { whereSql, values } = this.buildWhereClause(filter);
    const limitSql = filter?.limit !== undefined ? `LIMIT ${Math.max(0, filter.limit)}` : "";
    const offsetSql = filter?.offset !== undefined ? `OFFSET ${Math.max(0, filter.offset)}` : "";

    const res = await pool.query(
      `SELECT t.*,
        (SELECT COUNT(*)::int FROM ${this.compTable} c
         WHERE c.transaction_id = t.transaction_id AND c.compensated_at IS NULL) AS comp_depth
       FROM ${this.txTable} t
       ${whereSql}
       ORDER BY t.updated_at ASC
       ${limitSql} ${offsetSql}`,
      values
    );

    return res.rows.map((row) => {
      const status = String(row.status) as TransactionStatus;
      const updatedAt = Number(row.updated_at);
      const isStuck =
        (status === "IN_FLIGHT" || status === "COMPENSATING") &&
        nowTimestamp - updatedAt >= stuckThresholdMs;

      return {
        transactionId: String(row.transaction_id),
        machineId: String(row.machine_id),
        actorId: String(row.actor_id),
        stateValue: row.state_json as StateValue,
        status,
        context: row.context_json as TContext,
        isStuck,
        activeStep: row.active_step_json ?? null,
        compensationDepth: Number(row.comp_depth),
        version: Number(row.version),
        createdAt: Number(row.created_at),
        updatedAt,
      };
    });
  }

  async deleteTransactions(transactionIds: string[]): Promise<number> {
    if (transactionIds.length === 0) return 0;
    const pool = await this.getPool();
    const res = await pool.query(
      `DELETE FROM ${this.txTable} WHERE transaction_id = ANY($1::text[])`,
      [transactionIds]
    );
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    if (this.pool && this.ownsPool) {
      await this.pool.end();
      this.pool = null;
    }
    this.initialized = false;
  }
}

