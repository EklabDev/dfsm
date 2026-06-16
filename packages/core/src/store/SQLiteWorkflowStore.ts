import Database from 'better-sqlite3'
import type {
  MachineDefinitionRecord,
  WorkflowInstanceRecord,
  WorkflowHistoryRecord,
  PendingActionRecord,
  WorkflowDefinitionRecord,
  OrchestrationInstanceRecord,
  UpsertResult,
  CreateWorkflowParams,
  TransitionParams,
  CreateOrchestrationParams,
  AdvanceOrchestrationParams,
} from '../types/store.js'
import {
  ConcurrentModificationError,
  type IWorkflowStore,
} from './IWorkflowStore.js'
import { SQL_SCHEMA } from './sqlSchema.js'
import { newId, nowIso } from '../util/ids.js'

export class SQLiteWorkflowStore implements IWorkflowStore {
  private db: Database.Database

  constructor(path: string = ':memory:') {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  async setup(): Promise<void> {
    this.db.exec(SQL_SCHEMA)
  }

  async upsertMachineDefinition(
    record: MachineDefinitionRecord,
  ): Promise<UpsertResult> {
    const existing = this.db
      .prepare(
        `SELECT * FROM machine_definitions WHERE machine_id = ? AND checksum = ? AND status = 'active'`,
      )
      .get(record.machineId, record.checksum) as MachineDefinitionRecord | undefined

    if (existing) {
      return {
        machineId: record.machineId,
        version: existing.version,
        created: false,
        topicsAdded: [],
        topicsUnchanged: [],
      }
    }

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE machine_definitions SET status = 'deprecated', updated_at = ? WHERE machine_id = ? AND status = 'active'`,
        )
        .run(nowIso(), record.machineId)

      this.db
        .prepare(
          `INSERT INTO machine_definitions (
            id, machine_id, version, checksum, config, transition_table,
            viz_graph, topic_bindings, slot_schemas, status, migrated_from,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.machineId,
          record.version,
          record.checksum,
          JSON.stringify(record.config),
          JSON.stringify(record.transitionTable),
          JSON.stringify(record.vizGraph),
          JSON.stringify(record.topicBindings),
          JSON.stringify(record.slotSchemas),
          record.status,
          record.migratedFrom,
          record.createdAt,
          record.updatedAt,
        )
    })
    txn()

    return {
      machineId: record.machineId,
      version: record.version,
      created: true,
      topicsAdded: [],
      topicsUnchanged: [],
    }
  }

  async getActiveMachine(
    machineId: string,
  ): Promise<MachineDefinitionRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM machine_definitions WHERE machine_id = ? AND status = 'active'`,
      )
      .get(machineId) as Record<string, unknown> | undefined
    return row ? this.mapMachine(row) : null
  }

  async getMachineVersion(
    machineId: string,
    version: number,
  ): Promise<MachineDefinitionRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM machine_definitions WHERE id = ?`)
      .get(`${machineId}:${version}`) as Record<string, unknown> | undefined
    return row ? this.mapMachine(row) : null
  }

  async createWorkflowInstance(params: CreateWorkflowParams): Promise<void> {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO workflow_instances (
          id, machine_id, machine_version, current_state, context, status,
          version, locked_until, orchestration_id, orchestration_step_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        params.workflowId,
        params.machineId,
        params.machineVersion,
        params.initialState,
        JSON.stringify(params.initialContext),
        params.orchestrationId ?? null,
        params.orchestrationStepId ?? null,
        now,
        now,
      )
  }

  async getWorkflowInstance(id: string): Promise<WorkflowInstanceRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM workflow_instances WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.mapWorkflow(row) : null
  }

  async getActiveWorkflowInstances(
    machineId: string,
  ): Promise<WorkflowInstanceRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_instances WHERE machine_id = ? AND status = 'active'`,
      )
      .all(machineId) as Record<string, unknown>[]
    return rows.map((r) => this.mapWorkflow(r))
  }

  async getWorkflowHistory(
    workflowId: string,
  ): Promise<WorkflowHistoryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_history WHERE workflow_id = ? ORDER BY seq ASC`,
      )
      .all(workflowId) as Record<string, unknown>[]
    return rows.map((r) => this.mapHistory(r))
  }

  async acquireLease(id: string, ttlMs: number): Promise<boolean> {
    const now = nowIso()
    const lockedUntil = new Date(Date.now() + ttlMs).toISOString()
    const result = this.db
      .prepare(
        `UPDATE workflow_instances SET locked_until = ?
         WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)`,
      )
      .run(lockedUntil, id, now)
    return result.changes > 0
  }

  async releaseLease(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE workflow_instances SET locked_until = NULL WHERE id = ?`)
      .run(id)
  }

  async transitionWithOutbox(params: TransitionParams): Promise<void> {
    const txn = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT context FROM workflow_instances WHERE id = ?`)
        .get(params.workflowId) as { context: string } | undefined
      const mergedContext = {
        ...(existing ? JSON.parse(existing.context) : {}),
        ...params.contextUpdate,
      }

      const result = this.db
        .prepare(
          `UPDATE workflow_instances SET
            current_state = ?, context = ?,
            version = version + 1, updated_at = ?,
            status = CASE WHEN ? THEN 'completed' ELSE status END
           WHERE id = ? AND version = ?`,
        )
        .run(
          params.nextState,
          JSON.stringify(mergedContext),
          nowIso(),
          params.isTerminal ? 1 : 0,
          params.workflowId,
          params.expectedVersion,
        )

      if (result.changes === 0) {
        throw new ConcurrentModificationError(
          params.workflowId,
          params.expectedVersion,
        )
      }

      const historyId = newId()
      this.db
        .prepare(
          `INSERT INTO workflow_history (
            id, workflow_id, seq, from_state, to_state, event, event_payload,
            context_snapshot, dispatched_actions, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          historyId,
          params.workflowId,
          params.historyEntry.seq,
          params.historyEntry.fromState,
          params.historyEntry.toState,
          params.historyEntry.event,
          JSON.stringify(params.historyEntry.eventPayload),
          JSON.stringify(params.historyEntry.contextSnapshot),
          JSON.stringify(params.historyEntry.dispatchedActions),
          nowIso(),
        )

      const insertAction = this.db.prepare(
        `INSERT INTO pending_actions (
          id, workflow_id, action_name, idempotency_key, payload, status,
          attempts, last_error, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?)`,
      )

      for (const item of params.outboxItems) {
        insertAction.run(
          newId(),
          params.workflowId,
          item.actionName,
          item.idempotencyKey,
          JSON.stringify(item.payload),
          nowIso(),
        )
      }
    })
    txn()
  }

  async mergeContext(
    id: string,
    partial: Record<string, unknown>,
  ): Promise<void> {
    const row = this.db
      .prepare(`SELECT context FROM workflow_instances WHERE id = ?`)
      .get(id) as { context: string } | undefined
    if (!row) return
    const merged = { ...JSON.parse(row.context), ...partial }
    this.db
      .prepare(
        `UPDATE workflow_instances SET context = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(merged), nowIso(), id)
  }

  async claimPendingActions(limit: number): Promise<PendingActionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[]
    return rows.map((r) => this.mapPendingAction(r))
  }

  async markActionExecuting(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE pending_actions SET status = 'executing' WHERE id = ?`)
      .run(id)
  }

  async markActionDone(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE pending_actions SET status = 'done' WHERE id = ?`)
      .run(id)
  }

  async markActionFailed(id: string, error: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE pending_actions SET status = 'failed', last_error = ? WHERE id = ?`,
      )
      .run(error, id)
  }

  async incrementActionAttempts(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE pending_actions SET attempts = attempts + 1 WHERE id = ?`)
      .run(id)
  }

  async resetActionPending(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE pending_actions SET status = 'pending' WHERE id = ?`)
      .run(id)
  }

  async upsertWorkflowDefinition(
    record: WorkflowDefinitionRecord,
  ): Promise<UpsertResult> {
    const existing = this.db
      .prepare(
        `SELECT * FROM workflow_definitions WHERE workflow_id = ? AND checksum = ? AND status = 'active'`,
      )
      .get(record.workflowId, record.checksum)

    if (existing) {
      return {
        machineId: record.workflowId,
        version: record.version,
        created: false,
        topicsAdded: [],
        topicsUnchanged: [],
      }
    }

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE workflow_definitions SET status = 'deprecated', updated_at = ? WHERE workflow_id = ? AND status = 'active'`,
        )
        .run(nowIso(), record.workflowId)

      this.db
        .prepare(
          `INSERT INTO workflow_definitions (
            id, workflow_id, version, checksum, definition, viz_graph,
            entry_bindings, exit_bindings, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.workflowId,
          record.version,
          record.checksum,
          JSON.stringify(record.definition),
          JSON.stringify(record.vizGraph),
          JSON.stringify(record.entryBindings),
          JSON.stringify(record.exitBindings),
          record.status,
          record.createdAt,
          record.updatedAt,
        )
    })
    txn()

    return {
      machineId: record.workflowId,
      version: record.version,
      created: true,
      topicsAdded: [],
      topicsUnchanged: [],
    }
  }

  async getActiveWorkflowDefinition(
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM workflow_definitions WHERE workflow_id = ? AND status = 'active'`,
      )
      .get(workflowId) as Record<string, unknown> | undefined
    return row ? this.mapWorkflowDef(row) : null
  }

  async createOrchestrationInstance(
    params: CreateOrchestrationParams,
  ): Promise<void> {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO orchestration_instances (
          id, workflow_def_id, workflow_def_version, current_step_id, context,
          status, version, child_refs, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 0, '[]', ?, ?)`,
      )
      .run(
        params.orchestrationId,
        params.workflowDefId,
        params.workflowDefVersion,
        params.initialStepId,
        JSON.stringify(params.initialContext),
        now,
        now,
      )
  }

  async getOrchestrationInstance(
    id: string,
  ): Promise<OrchestrationInstanceRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM orchestration_instances WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.mapOrchestration(row) : null
  }

  async advanceOrchestration(
    params: AdvanceOrchestrationParams,
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE orchestration_instances SET
          current_step_id = ?, context = json_patch(context, ?),
          child_refs = COALESCE(?, child_refs),
          status = COALESCE(?, status),
          version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        params.nextStepId,
        JSON.stringify(params.contextUpdate),
        params.childRefs ? JSON.stringify(params.childRefs) : null,
        params.status ?? null,
        nowIso(),
        params.orchestrationId,
        params.expectedVersion,
      )

    if (result.changes === 0) {
      throw new ConcurrentModificationError(
        params.orchestrationId,
        params.expectedVersion,
      )
    }
  }

  close(): void {
    this.db.close()
  }

  private mapMachine(row: Record<string, unknown>): MachineDefinitionRecord {
    return {
      id: row.id as string,
      machineId: row.machine_id as string,
      version: row.version as number,
      checksum: row.checksum as string,
      config: JSON.parse(row.config as string),
      transitionTable: JSON.parse(row.transition_table as string),
      vizGraph: JSON.parse(row.viz_graph as string),
      topicBindings: JSON.parse(row.topic_bindings as string),
      slotSchemas: JSON.parse(row.slot_schemas as string),
      status: row.status as 'active' | 'deprecated',
      migratedFrom: row.migrated_from as number | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }

  private mapWorkflow(row: Record<string, unknown>): WorkflowInstanceRecord {
    return {
      id: row.id as string,
      machineId: row.machine_id as string,
      machineVersion: row.machine_version as number,
      currentState: row.current_state as string,
      context: JSON.parse(row.context as string),
      status: row.status as WorkflowInstanceRecord['status'],
      version: row.version as number,
      lockedUntil: row.locked_until as string | null,
      orchestrationId: row.orchestration_id as string | null,
      orchestrationStepId: row.orchestration_step_id as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }

  private mapHistory(row: Record<string, unknown>): WorkflowHistoryRecord {
    return {
      id: row.id as string,
      workflowId: row.workflow_id as string,
      seq: row.seq as number,
      fromState: row.from_state as string,
      toState: row.to_state as string,
      event: row.event as string,
      eventPayload: JSON.parse(row.event_payload as string),
      contextSnapshot: JSON.parse(row.context_snapshot as string),
      dispatchedActions: JSON.parse(row.dispatched_actions as string),
      createdAt: row.created_at as string,
    }
  }

  private mapPendingAction(row: Record<string, unknown>): PendingActionRecord {
    return {
      id: row.id as string,
      workflowId: row.workflow_id as string,
      actionName: row.action_name as string,
      idempotencyKey: row.idempotency_key as string,
      payload: JSON.parse(row.payload as string),
      status: row.status as PendingActionRecord['status'],
      attempts: row.attempts as number,
      lastError: row.last_error as string | null,
      createdAt: row.created_at as string,
    }
  }

  private mapWorkflowDef(
    row: Record<string, unknown>,
  ): WorkflowDefinitionRecord {
    return {
      id: row.id as string,
      workflowId: row.workflow_id as string,
      version: row.version as number,
      checksum: row.checksum as string,
      definition: JSON.parse(row.definition as string),
      vizGraph: JSON.parse(row.viz_graph as string),
      entryBindings: JSON.parse(row.entry_bindings as string),
      exitBindings: JSON.parse(row.exit_bindings as string),
      status: row.status as 'active' | 'deprecated',
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }

  private mapOrchestration(
    row: Record<string, unknown>,
  ): OrchestrationInstanceRecord {
    return {
      id: row.id as string,
      workflowDefId: row.workflow_def_id as string,
      workflowDefVersion: row.workflow_def_version as number,
      currentStepId: row.current_step_id as string,
      context: JSON.parse(row.context as string),
      status: row.status as OrchestrationInstanceRecord['status'],
      version: row.version as number,
      childRefs: JSON.parse(row.child_refs as string),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }
}
