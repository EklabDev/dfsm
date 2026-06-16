import { type Db, type Collection, ObjectId } from 'mongodb'
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
import { newId, nowIso } from '../util/ids.js'

export class MongoWorkflowStore implements IWorkflowStore {
  private machines: Collection<any>
  private workflows: Collection<any>
  private history: Collection<any>
  private pendingActions: Collection<any>
  private workflowDefs: Collection<any>
  private orchestrations: Collection<any>

  constructor(private db: Db) {
    this.machines = db.collection('machine_definitions')
    this.workflows = db.collection('workflow_instances')
    this.history = db.collection('workflow_history')
    this.pendingActions = db.collection('pending_actions')
    this.workflowDefs = db.collection('workflow_definitions')
    this.orchestrations = db.collection('orchestration_instances')
  }

  async setup(): Promise<void> {
    await this.workflows.createIndex({ machineId: 1, status: 1 })
    await this.workflows.createIndex({ machineId: 1, currentState: 1 })
    await this.history.createIndex({ workflowId: 1, seq: 1 }, { unique: true })
    await this.pendingActions.createIndex(
      { idempotencyKey: 1 },
      { unique: true },
    )
    await this.pendingActions.createIndex({ status: 1, createdAt: 1 })
    await this.machines.createIndex({ machineId: 1, status: 1 })
    await this.machines.createIndex(
      { machineId: 1, version: 1 },
      { unique: true },
    )
  }

  async upsertMachineDefinition(
    record: MachineDefinitionRecord,
  ): Promise<UpsertResult> {
    const existing = await this.machines.findOne({
      machineId: record.machineId,
      checksum: record.checksum,
      status: 'active',
    })
    if (existing) {
      return {
        machineId: record.machineId,
        version: existing.version,
        created: false,
        topicsAdded: [],
        topicsUnchanged: [],
      }
    }

    const latest = await this.machines.findOne(
      { machineId: record.machineId },
      { sort: { version: -1 } },
    )
    const version = latest ? Number(latest.version) + 1 : 1
    const id = `${record.machineId}:${version}`
    const now = nowIso()

    const session = this.db.client.startSession()
    try {
      await session.withTransaction(async () => {
        await this.machines.updateMany(
          { machineId: record.machineId, status: 'active' },
          { $set: { status: 'deprecated', updatedAt: now } },
          { session },
        )
        await this.machines.insertOne(
          {
            _id: id,
            machineId: record.machineId,
            version,
            checksum: record.checksum,
            config: record.config,
            transitionTable: record.transitionTable,
            vizGraph: record.vizGraph,
            topicBindings: record.topicBindings,
            slotSchemas: record.slotSchemas,
            status: 'active',
            migratedFrom: latest?.version ?? null,
            createdAt: now,
            updatedAt: now,
          },
          { session },
        )
      })
    } finally {
      await session.endSession()
    }

    return {
      machineId: record.machineId,
      version,
      created: true,
      topicsAdded: [],
      topicsUnchanged: [],
    }
  }

  async getActiveMachine(
    machineId: string,
  ): Promise<MachineDefinitionRecord | null> {
    const doc = await this.machines.findOne(
      { machineId, status: 'active' },
      { sort: { version: -1 } },
    )
    return doc ? this.mapMachine(doc) : null
  }

  async getMachineVersion(
    machineId: string,
    version: number,
  ): Promise<MachineDefinitionRecord | null> {
    const doc = await this.machines.findOne({ _id: `${machineId}:${version}` })
    return doc ? this.mapMachine(doc) : null
  }

  async createWorkflowInstance(params: CreateWorkflowParams): Promise<void> {
    const now = nowIso()
    await this.workflows.insertOne({
      _id: params.workflowId,
      machineId: params.machineId,
      machineVersion: params.machineVersion,
      currentState: params.initialState,
      context: params.initialContext,
      status: 'active',
      version: 0,
      lockedUntil: null,
      orchestrationId: params.orchestrationId ?? null,
      orchestrationStepId: params.orchestrationStepId ?? null,
      createdAt: now,
      updatedAt: now,
    })
  }

  async getWorkflowInstance(id: string): Promise<WorkflowInstanceRecord | null> {
    const doc = await this.workflows.findOne({ _id: id })
    return doc ? this.mapWorkflow(doc) : null
  }

  async getActiveWorkflowInstances(
    machineId: string,
  ): Promise<WorkflowInstanceRecord[]> {
    const docs = await this.workflows
      .find({ machineId, status: 'active' })
      .toArray()
    return docs.map((d) => this.mapWorkflow(d))
  }

  async getWorkflowHistory(
    workflowId: string,
  ): Promise<WorkflowHistoryRecord[]> {
    const docs = await this.history
      .find({ workflowId })
      .sort({ seq: 1 })
      .toArray()
    return docs.map((d) => this.mapHistory(d))
  }

  async acquireLease(id: string, ttlMs: number): Promise<boolean> {
    const result = await this.workflows.findOneAndUpdate(
      {
        _id: id,
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: nowIso() } }],
      },
      { $set: { lockedUntil: new Date(Date.now() + ttlMs).toISOString() } },
    )
    return result !== null
  }

  async releaseLease(id: string): Promise<void> {
    await this.workflows.updateOne({ _id: id }, { $set: { lockedUntil: null } })
  }

  async transitionWithOutbox(params: TransitionParams): Promise<void> {
    const session = this.db.client.startSession()
    try {
      await session.withTransaction(async () => {
        const contextSet = Object.fromEntries(
          Object.entries(params.contextUpdate).map(([k, v]) => [
            `context.${k}`,
            v,
          ]),
        )

        const updateResult = await this.workflows.updateOne(
          { _id: params.workflowId, version: params.expectedVersion },
          {
            $set: {
              currentState: params.nextState,
              updatedAt: nowIso(),
              ...contextSet,
              ...(params.isTerminal ? { status: 'completed' } : {}),
            },
            $inc: { version: 1 },
          },
          { session },
        )

        if (updateResult.matchedCount === 0) {
          throw new ConcurrentModificationError(
            params.workflowId,
            params.expectedVersion,
          )
        }

        await this.history.insertOne(
          {
            _id: newId(),
            workflowId: params.workflowId,
            seq: params.historyEntry.seq,
            fromState: params.historyEntry.fromState,
            toState: params.historyEntry.toState,
            event: params.historyEntry.event,
            eventPayload: params.historyEntry.eventPayload,
            contextSnapshot: params.historyEntry.contextSnapshot,
            dispatchedActions: params.historyEntry.dispatchedActions,
            createdAt: nowIso(),
          },
          { session },
        )

        if (params.outboxItems.length > 0) {
          await this.pendingActions.insertMany(
            params.outboxItems.map((item) => ({
              _id: newId(),
              workflowId: params.workflowId,
              actionName: item.actionName,
              idempotencyKey: item.idempotencyKey,
              payload: item.payload,
              status: 'pending',
              attempts: 0,
              lastError: null,
              createdAt: nowIso(),
            })),
            { session },
          )
        }
      })
    } finally {
      await session.endSession()
    }
  }

  async mergeContext(
    id: string,
    partial: Record<string, unknown>,
  ): Promise<void> {
    const setFields = Object.fromEntries(
      Object.entries(partial).map(([k, v]) => [`context.${k}`, v]),
    )
    await this.workflows.updateOne({ _id: id }, { $set: setFields })
  }

  async claimPendingActions(limit: number): Promise<PendingActionRecord[]> {
    const docs = await this.pendingActions
      .find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray()
    return docs.map((d) => this.mapPendingAction(d))
  }

  async markActionExecuting(id: string): Promise<void> {
    await this.pendingActions.updateOne(
      { _id: id },
      { $set: { status: 'executing' } },
    )
  }

  async markActionDone(id: string): Promise<void> {
    await this.pendingActions.updateOne(
      { _id: id },
      { $set: { status: 'done' } },
    )
  }

  async markActionFailed(id: string, error: string): Promise<void> {
    await this.pendingActions.updateOne(
      { _id: id },
      { $set: { status: 'failed', lastError: error } },
    )
  }

  async incrementActionAttempts(id: string): Promise<void> {
    await this.pendingActions.updateOne(
      { _id: id },
      { $inc: { attempts: 1 } },
    )
  }

  async resetActionPending(id: string): Promise<void> {
    await this.pendingActions.updateOne(
      { _id: id },
      { $set: { status: 'pending' } },
    )
  }

  async upsertWorkflowDefinition(
    record: WorkflowDefinitionRecord,
  ): Promise<UpsertResult> {
    const existing = await this.workflowDefs.findOne({
      workflowId: record.workflowId,
      checksum: record.checksum,
      status: 'active',
    })
    if (existing) {
      return {
        machineId: record.workflowId,
        version: existing.version,
        created: false,
        topicsAdded: [],
        topicsUnchanged: [],
      }
    }

    await this.workflowDefs.updateMany(
      { workflowId: record.workflowId, status: 'active' },
      { $set: { status: 'deprecated', updatedAt: nowIso() } },
    )
    await this.workflowDefs.insertOne({
      _id: record.id,
      workflowId: record.workflowId,
      version: record.version,
      checksum: record.checksum,
      definition: record.definition,
      vizGraph: record.vizGraph,
      entryBindings: record.entryBindings,
      exitBindings: record.exitBindings,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })

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
    const doc = await this.workflowDefs.findOne({
      workflowId,
      status: 'active',
    })
    return doc ? this.mapWorkflowDef(doc) : null
  }

  async createOrchestrationInstance(
    params: CreateOrchestrationParams,
  ): Promise<void> {
    const now = nowIso()
    await this.orchestrations.insertOne({
      _id: params.orchestrationId,
      workflowDefId: params.workflowDefId,
      workflowDefVersion: params.workflowDefVersion,
      currentStepId: params.initialStepId,
      context: params.initialContext,
      status: 'active',
      version: 0,
      childRefs: [],
      createdAt: now,
      updatedAt: now,
    })
  }

  async getOrchestrationInstance(
    id: string,
  ): Promise<OrchestrationInstanceRecord | null> {
    const doc = await this.orchestrations.findOne({ _id: id })
    return doc ? this.mapOrchestration(doc) : null
  }

  async advanceOrchestration(
    params: AdvanceOrchestrationParams,
  ): Promise<void> {
    const setFields: Record<string, unknown> = {
      currentStepId: params.nextStepId,
      updatedAt: nowIso(),
    }
    for (const [k, v] of Object.entries(params.contextUpdate)) {
      setFields[`context.${k}`] = v
    }
    if (params.childRefs) setFields.childRefs = params.childRefs
    if (params.status) setFields.status = params.status

    const result = await this.orchestrations.updateOne(
      { _id: params.orchestrationId, version: params.expectedVersion },
      { $set: setFields, $inc: { version: 1 } },
    )
    if (result.matchedCount === 0) {
      throw new ConcurrentModificationError(
        params.orchestrationId,
        params.expectedVersion,
      )
    }
  }

  private mapMachine(doc: Record<string, unknown>): MachineDefinitionRecord {
    return {
      id: doc._id as string,
      machineId: doc.machineId as string,
      version: doc.version as number,
      checksum: doc.checksum as string,
      config: doc.config as MachineDefinitionRecord['config'],
      transitionTable: doc.transitionTable as MachineDefinitionRecord['transitionTable'],
      vizGraph: doc.vizGraph as MachineDefinitionRecord['vizGraph'],
      topicBindings: doc.topicBindings as MachineDefinitionRecord['topicBindings'],
      slotSchemas: doc.slotSchemas as MachineDefinitionRecord['slotSchemas'],
      status: doc.status as 'active' | 'deprecated',
      migratedFrom: doc.migratedFrom as number | null,
      createdAt: doc.createdAt as string,
      updatedAt: doc.updatedAt as string,
    }
  }

  private mapWorkflow(doc: Record<string, unknown>): WorkflowInstanceRecord {
    return {
      id: doc._id as string,
      machineId: doc.machineId as string,
      machineVersion: doc.machineVersion as number,
      currentState: doc.currentState as string,
      context: doc.context as WorkflowInstanceRecord['context'],
      status: doc.status as WorkflowInstanceRecord['status'],
      version: doc.version as number,
      lockedUntil: doc.lockedUntil as string | null,
      orchestrationId: doc.orchestrationId as string | null,
      orchestrationStepId: doc.orchestrationStepId as string | null,
      createdAt: doc.createdAt as string,
      updatedAt: doc.updatedAt as string,
    }
  }

  private mapHistory(doc: Record<string, unknown>): WorkflowHistoryRecord {
    return {
      id: doc._id as string,
      workflowId: doc.workflowId as string,
      seq: doc.seq as number,
      fromState: doc.from_state as string ?? doc.fromState as string,
      toState: doc.to_state as string ?? doc.toState as string,
      event: doc.event as string,
      eventPayload: doc.eventPayload as WorkflowHistoryRecord['eventPayload'],
      contextSnapshot: doc.contextSnapshot as WorkflowHistoryRecord['contextSnapshot'],
      dispatchedActions: doc.dispatchedActions as string[],
      createdAt: doc.createdAt as string,
    }
  }

  private mapPendingAction(doc: Record<string, unknown>): PendingActionRecord {
    return {
      id: doc._id as string,
      workflowId: doc.workflowId as string,
      actionName: doc.actionName as string,
      idempotencyKey: doc.idempotencyKey as string,
      payload: doc.payload as PendingActionRecord['payload'],
      status: doc.status as PendingActionRecord['status'],
      attempts: doc.attempts as number,
      lastError: doc.lastError as string | null,
      createdAt: doc.createdAt as string,
    }
  }

  private mapWorkflowDef(
    doc: Record<string, unknown>,
  ): WorkflowDefinitionRecord {
    return {
      id: doc._id as string,
      workflowId: doc.workflowId as string,
      version: doc.version as number,
      checksum: doc.checksum as string,
      definition: doc.definition as WorkflowDefinitionRecord['definition'],
      vizGraph: doc.vizGraph as WorkflowDefinitionRecord['vizGraph'],
      entryBindings: doc.entryBindings as WorkflowDefinitionRecord['entryBindings'],
      exitBindings: doc.exitBindings as WorkflowDefinitionRecord['exitBindings'],
      status: doc.status as 'active' | 'deprecated',
      createdAt: doc.createdAt as string,
      updatedAt: doc.updatedAt as string,
    }
  }

  private mapOrchestration(
    doc: Record<string, unknown>,
  ): OrchestrationInstanceRecord {
    return {
      id: doc._id as string,
      workflowDefId: doc.workflowDefId as string,
      workflowDefVersion: doc.workflowDefVersion as number,
      currentStepId: doc.currentStepId as string,
      context: doc.context as OrchestrationInstanceRecord['context'],
      status: doc.status as OrchestrationInstanceRecord['status'],
      version: doc.version as number,
      childRefs: doc.childRefs as OrchestrationInstanceRecord['childRefs'],
      createdAt: doc.createdAt as string,
      updatedAt: doc.updatedAt as string,
    }
  }
}
