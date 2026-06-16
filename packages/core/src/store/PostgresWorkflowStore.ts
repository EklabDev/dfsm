import pg from 'pg'
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
import { POSTGRES_SCHEMA } from './sqlSchema.js'
import { newId, nowIso } from '../util/ids.js'

const { Pool } = pg

export class PostgresWorkflowStore implements IWorkflowStore {
  private pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString })
  }

  async setup(): Promise<void> {
    await this.pool.query(POSTGRES_SCHEMA)
  }

  async upsertMachineDefinition(
    record: MachineDefinitionRecord,
  ): Promise<UpsertResult> {
    const client = await this.pool.connect()
    try {
      const existing = await client.query(
        `SELECT version FROM machine_definitions WHERE machine_id = $1 AND checksum = $2 AND status = 'active'`,
        [record.machineId, record.checksum],
      )
      if (existing.rows.length > 0) {
        return {
          machineId: record.machineId,
          version: existing.rows[0].version,
          created: false,
          topicsAdded: [],
          topicsUnchanged: [],
        }
      }

      await client.query('BEGIN')
      await client.query(
        `UPDATE machine_definitions SET status = 'deprecated', updated_at = $1 WHERE machine_id = $2 AND status = 'active'`,
        [nowIso(), record.machineId],
      )
      await client.query(
        `INSERT INTO machine_definitions (
          id, machine_id, version, checksum, config, transition_table,
          viz_graph, topic_bindings, slot_schemas, status, migrated_from,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          record.id,
          record.machineId,
          record.version,
          record.checksum,
          record.config,
          record.transitionTable,
          record.vizGraph,
          record.topicBindings,
          record.slotSchemas,
          record.status,
          record.migratedFrom,
          record.createdAt,
          record.updatedAt,
        ],
      )
      await client.query('COMMIT')

      return {
        machineId: record.machineId,
        version: record.version,
        created: true,
        topicsAdded: [],
        topicsUnchanged: [],
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async getActiveMachine(
    machineId: string,
  ): Promise<MachineDefinitionRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM machine_definitions WHERE machine_id = $1 AND status = 'active'`,
      [machineId],
    )
    return result.rows[0] ? this.mapMachine(result.rows[0]) : null
  }

  async getMachineVersion(
    machineId: string,
    version: number,
  ): Promise<MachineDefinitionRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM machine_definitions WHERE id = $1`,
      [`${machineId}:${version}`],
    )
    return result.rows[0] ? this.mapMachine(result.rows[0]) : null
  }

  async createWorkflowInstance(params: CreateWorkflowParams): Promise<void> {
    const now = nowIso()
    await this.pool.query(
      `INSERT INTO workflow_instances (
        id, machine_id, machine_version, current_state, context, status,
        version, locked_until, orchestration_id, orchestration_step_id,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,'active',0,NULL,$6,$7,$8,$9)`,
      [
        params.workflowId,
        params.machineId,
        params.machineVersion,
        params.initialState,
        params.initialContext,
        params.orchestrationId ?? null,
        params.orchestrationStepId ?? null,
        now,
        now,
      ],
    )
  }

  async getWorkflowInstance(id: string): Promise<WorkflowInstanceRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_instances WHERE id = $1`,
      [id],
    )
    return result.rows[0] ? this.mapWorkflow(result.rows[0]) : null
  }

  async getActiveWorkflowInstances(
    machineId: string,
  ): Promise<WorkflowInstanceRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_instances WHERE machine_id = $1 AND status = 'active'`,
      [machineId],
    )
    return result.rows.map((r) => this.mapWorkflow(r))
  }

  async getWorkflowHistory(
    workflowId: string,
  ): Promise<WorkflowHistoryRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_history WHERE workflow_id = $1 ORDER BY seq ASC`,
      [workflowId],
    )
    return result.rows.map((r) => this.mapHistory(r))
  }

  async acquireLease(id: string, ttlMs: number): Promise<boolean> {
    const now = nowIso()
    const lockedUntil = new Date(Date.now() + ttlMs).toISOString()
    const result = await this.pool.query(
      `UPDATE workflow_instances SET locked_until = $1
       WHERE id = $2 AND (locked_until IS NULL OR locked_until < $3)`,
      [lockedUntil, id, now],
    )
    return (result.rowCount ?? 0) > 0
  }

  async releaseLease(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_instances SET locked_until = NULL WHERE id = $1`,
      [id],
    )
  }

  async transitionWithOutbox(params: TransitionParams): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const mergedContext = { ...params.contextUpdate }
      const update = await client.query(
        `UPDATE workflow_instances SET
          current_state = $1,
          context = context || $2::jsonb,
          version = version + 1,
          updated_at = $3,
          status = CASE WHEN $4 THEN 'completed' ELSE status END
         WHERE id = $5 AND version = $6
         RETURNING id`,
        [
          params.nextState,
          JSON.stringify(mergedContext),
          nowIso(),
          params.isTerminal,
          params.workflowId,
          params.expectedVersion,
        ],
      )

      if (update.rowCount === 0) {
        throw new ConcurrentModificationError(
          params.workflowId,
          params.expectedVersion,
        )
      }

      await client.query(
        `INSERT INTO workflow_history (
          id, workflow_id, seq, from_state, to_state, event, event_payload,
          context_snapshot, dispatched_actions, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          newId(),
          params.workflowId,
          params.historyEntry.seq,
          params.historyEntry.fromState,
          params.historyEntry.toState,
          params.historyEntry.event,
          params.historyEntry.eventPayload,
          params.historyEntry.contextSnapshot,
          params.historyEntry.dispatchedActions,
          nowIso(),
        ],
      )

      for (const item of params.outboxItems) {
        await client.query(
          `INSERT INTO pending_actions (
            id, workflow_id, action_name, idempotency_key, payload, status,
            attempts, last_error, created_at
          ) VALUES ($1,$2,$3,$4,$5,'pending',0,NULL,$6)`,
          [
            newId(),
            params.workflowId,
            item.actionName,
            item.idempotencyKey,
            item.payload,
            nowIso(),
          ],
        )
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async mergeContext(
    id: string,
    partial: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_instances SET context = context || $1::jsonb, updated_at = $2 WHERE id = $3`,
      [JSON.stringify(partial), nowIso(), id],
    )
  }

  async claimPendingActions(limit: number): Promise<PendingActionRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
      [limit],
    )
    return result.rows.map((r) => this.mapPendingAction(r))
  }

  async markActionExecuting(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_actions SET status = 'executing' WHERE id = $1`,
      [id],
    )
  }

  async markActionDone(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_actions SET status = 'done' WHERE id = $1`,
      [id],
    )
  }

  async markActionFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_actions SET status = 'failed', last_error = $1 WHERE id = $2`,
      [error, id],
    )
  }

  async incrementActionAttempts(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_actions SET attempts = attempts + 1 WHERE id = $1`,
      [id],
    )
  }

  async resetActionPending(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_actions SET status = 'pending' WHERE id = $1`,
      [id],
    )
  }

  async upsertWorkflowDefinition(
    record: WorkflowDefinitionRecord,
  ): Promise<UpsertResult> {
    const existing = await this.pool.query(
      `SELECT version FROM workflow_definitions WHERE workflow_id = $1 AND checksum = $2 AND status = 'active'`,
      [record.workflowId, record.checksum],
    )
    if (existing.rows.length > 0) {
      return {
        machineId: record.workflowId,
        version: existing.rows[0].version,
        created: false,
        topicsAdded: [],
        topicsUnchanged: [],
      }
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE workflow_definitions SET status = 'deprecated', updated_at = $1 WHERE workflow_id = $2 AND status = 'active'`,
        [nowIso(), record.workflowId],
      )
      await client.query(
        `INSERT INTO workflow_definitions (
          id, workflow_id, version, checksum, definition, viz_graph,
          entry_bindings, exit_bindings, status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          record.id,
          record.workflowId,
          record.version,
          record.checksum,
          record.definition,
          record.vizGraph,
          record.entryBindings,
          record.exitBindings,
          record.status,
          record.createdAt,
          record.updatedAt,
        ],
      )
      await client.query('COMMIT')
      return {
        machineId: record.workflowId,
        version: record.version,
        created: true,
        topicsAdded: [],
        topicsUnchanged: [],
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async getActiveWorkflowDefinition(
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_definitions WHERE workflow_id = $1 AND status = 'active'`,
      [workflowId],
    )
    return result.rows[0] ? this.mapWorkflowDef(result.rows[0]) : null
  }

  async createOrchestrationInstance(
    params: CreateOrchestrationParams,
  ): Promise<void> {
    const now = nowIso()
    await this.pool.query(
      `INSERT INTO orchestration_instances (
        id, workflow_def_id, workflow_def_version, current_step_id, context,
        status, version, child_refs, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,'active',0,'[]',$6,$7)`,
      [
        params.orchestrationId,
        params.workflowDefId,
        params.workflowDefVersion,
        params.initialStepId,
        params.initialContext,
        now,
        now,
      ],
    )
  }

  async getOrchestrationInstance(
    id: string,
  ): Promise<OrchestrationInstanceRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM orchestration_instances WHERE id = $1`,
      [id],
    )
    return result.rows[0] ? this.mapOrchestration(result.rows[0]) : null
  }

  async advanceOrchestration(
    params: AdvanceOrchestrationParams,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE orchestration_instances SET
        current_step_id = $1,
        context = context || $2::jsonb,
        child_refs = COALESCE($3::jsonb, child_refs),
        status = COALESCE($4, status),
        version = version + 1,
        updated_at = $5
       WHERE id = $6 AND version = $7`,
      [
        params.nextStepId,
        JSON.stringify(params.contextUpdate),
        params.childRefs ? JSON.stringify(params.childRefs) : null,
        params.status ?? null,
        nowIso(),
        params.orchestrationId,
        params.expectedVersion,
      ],
    )
    if (result.rowCount === 0) {
      throw new ConcurrentModificationError(
        params.orchestrationId,
        params.expectedVersion,
      )
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private mapMachine(row: Record<string, unknown>): MachineDefinitionRecord {
    return {
      id: row.id as string,
      machineId: row.machine_id as string,
      version: row.version as number,
      checksum: row.checksum as string,
      config: row.config as MachineDefinitionRecord['config'],
      transitionTable: row.transition_table as MachineDefinitionRecord['transitionTable'],
      vizGraph: row.viz_graph as MachineDefinitionRecord['vizGraph'],
      topicBindings: row.topic_bindings as MachineDefinitionRecord['topicBindings'],
      slotSchemas: row.slot_schemas as MachineDefinitionRecord['slotSchemas'],
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
      context: row.context as WorkflowInstanceRecord['context'],
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
      eventPayload: row.event_payload as WorkflowHistoryRecord['eventPayload'],
      contextSnapshot: row.context_snapshot as WorkflowHistoryRecord['contextSnapshot'],
      dispatchedActions: row.dispatched_actions as string[],
      createdAt: row.created_at as string,
    }
  }

  private mapPendingAction(row: Record<string, unknown>): PendingActionRecord {
    return {
      id: row.id as string,
      workflowId: row.workflow_id as string,
      actionName: row.action_name as string,
      idempotencyKey: row.idempotency_key as string,
      payload: row.payload as PendingActionRecord['payload'],
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
      definition: row.definition as WorkflowDefinitionRecord['definition'],
      vizGraph: row.viz_graph as WorkflowDefinitionRecord['vizGraph'],
      entryBindings: row.entry_bindings as WorkflowDefinitionRecord['entryBindings'],
      exitBindings: row.exit_bindings as WorkflowDefinitionRecord['exitBindings'],
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
      context: row.context as OrchestrationInstanceRecord['context'],
      status: row.status as OrchestrationInstanceRecord['status'],
      version: row.version as number,
      childRefs: row.child_refs as OrchestrationInstanceRecord['childRefs'],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }
}
