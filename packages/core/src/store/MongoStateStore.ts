import { type Db, type Collection, ObjectId, type ClientSession } from 'mongodb'
import type {
  IStateStore,
  WorkflowDoc,
  OutboxDoc,
  OutboxItem,
  MachineRegistryDoc,
  TransitionWithOutboxParams,
} from './IStateStore.js'
import type { CompiledMachine } from '../types/engine.js'

export class ConcurrentModificationError extends Error {
  constructor(workflowId: string, expected: number) {
    super(
      `Concurrent modification on workflow '${workflowId}' (expected version ${expected})`,
    )
    this.name = 'ConcurrentModificationError'
  }
}

export class MongoStateStore implements IStateStore {
  private workflows: Collection<WorkflowDoc>
  private outbox: Collection<OutboxDoc>
  private registry: Collection<MachineRegistryDoc>

  constructor(private db: Db) {
    this.workflows = db.collection('workflow_state')
    this.outbox = db.collection('action_outbox')
    this.registry = db.collection('machine_registry')
  }

  async setup(): Promise<void> {
    await this.workflows.createIndex(
      { status: 1, machineId: 1, updatedAt: 1 },
    )
    await this.workflows.createIndex({ machineId: 1, currentState: 1 })
    await this.outbox.createIndex({ idempotencyKey: 1 }, { unique: true })
    await this.outbox.createIndex({ status: 1, createdAt: 1 })
    await this.registry.createIndex({ machineId: 1, status: 1 })
  }

  async createWorkflow(params: {
    workflowId: string
    machineId: string
    machineVersion: number
    initialContext: Record<string, unknown>
    initialState: string
  }): Promise<void> {
    const now = new Date()
    await this.workflows.insertOne({
      _id: params.workflowId,
      machineId: params.machineId,
      machineVersion: params.machineVersion,
      currentState: params.initialState,
      context: params.initialContext,
      history: [],
      version: 0,
      lockedUntil: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as any)
  }

  async getWorkflow(workflowId: string): Promise<WorkflowDoc | null> {
    return this.workflows.findOne({ _id: workflowId } as any) as any
  }

  async acquireLease(workflowId: string, ttlMs: number): Promise<boolean> {
    const result = await this.workflows.findOneAndUpdate(
      {
        _id: workflowId,
        $or: [
          { lockedUntil: null },
          { lockedUntil: { $lt: new Date() } },
        ],
      } as any,
      { $set: { lockedUntil: new Date(Date.now() + ttlMs) } },
    )
    return result !== null
  }

  async releaseLease(workflowId: string): Promise<void> {
    await this.workflows.updateOne(
      { _id: workflowId } as any,
      { $set: { lockedUntil: null } },
    )
  }

  async transitionWithOutbox(params: TransitionWithOutboxParams): Promise<void> {
    const session = this.db.client.startSession()
    try {
      await session.withTransaction(async () => {
        const updateResult = await this.workflows.updateOne(
          { _id: params.workflowId, version: params.expectedVersion } as any,
          {
            $set: {
              currentState: params.nextState,
              updatedAt: new Date(),
              ...(params.isTerminal ? { status: 'completed' as const } : {}),
            },
            $inc: { version: 1 },
            $push: { history: params.historyEntry as any },
            ...(Object.keys(params.contextUpdate).length > 0
              ? {
                  $set: Object.fromEntries(
                    Object.entries(params.contextUpdate).map(([k, v]) => [
                      `context.${k}`,
                      v,
                    ]),
                  ),
                }
              : {}),
          },
          { session },
        )

        if (updateResult.matchedCount === 0) {
          throw new ConcurrentModificationError(
            params.workflowId,
            params.expectedVersion,
          )
        }

        if (params.outboxItems.length > 0) {
          const now = new Date()
          await this.outbox.insertMany(
            params.outboxItems.map((item) => ({
              _id: new ObjectId(),
              workflowId: item.workflowId,
              actionName: item.actionName,
              idempotencyKey: item.idempotencyKey,
              payload: item.payload,
              status: 'pending' as const,
              attempts: 0,
              lastError: null,
              createdAt: now,
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
    workflowId: string,
    partial: Record<string, unknown>,
  ): Promise<void> {
    const setFields = Object.fromEntries(
      Object.entries(partial).map(([k, v]) => [`context.${k}`, v]),
    )
    await this.workflows.updateOne(
      { _id: workflowId } as any,
      { $set: setFields },
    )
  }

  async getPendingOutboxItems(limit: number): Promise<OutboxDoc[]> {
    return this.outbox
      .find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray() as any
  }

  async markOutboxExecuting(id: ObjectId): Promise<void> {
    await this.outbox.updateOne({ _id: id }, { $set: { status: 'executing' } })
  }

  async markOutboxDone(id: ObjectId): Promise<void> {
    await this.outbox.updateOne({ _id: id }, { $set: { status: 'done' } })
  }

  async markOutboxFailed(id: ObjectId, error: string): Promise<void> {
    await this.outbox.updateOne(
      { _id: id },
      { $set: { status: 'failed', lastError: error } },
    )
  }

  async incrementOutboxAttempts(id: ObjectId): Promise<void> {
    await this.outbox.updateOne({ _id: id }, { $inc: { attempts: 1 } })
  }

  async getActiveWorkflows(machineId: string): Promise<WorkflowDoc[]> {
    return this.workflows
      .find({ machineId, status: 'active' })
      .toArray() as any
  }

  async saveMachineVersion(compiled: CompiledMachine): Promise<void> {
    await this.registry.updateMany(
      { machineId: compiled.machineId, status: 'active' },
      { $set: { status: 'deprecated' } },
    )

    const serialisedTable: Record<string, Record<string, any>> = {}
    for (const [state, events] of compiled.transitionTable) {
      serialisedTable[state] = Object.fromEntries(events)
    }

    const previous = await this.registry.findOne(
      { machineId: compiled.machineId },
      { sort: { version: -1 } },
    )

    await this.registry.insertOne({
      _id: `${compiled.machineId}:${compiled.version}`,
      machineId: compiled.machineId,
      version: compiled.version,
      transitionTable: serialisedTable,
      vizGraph: compiled.vizGraph,
      allActionSlotNames: compiled.allActionSlots.map((s) => s.name),
      allGuardSlotNames: compiled.allGuardSlots.map((s) => s.name),
      status: 'active',
      createdAt: new Date(),
      migratedFrom: previous?.version ?? null,
    } as any)
  }

  async getActiveMachine(
    machineId: string,
  ): Promise<MachineRegistryDoc | null> {
    return this.registry.findOne({
      machineId,
      status: 'active',
    }) as any
  }

  async getMachineVersion(
    machineId: string,
    version: number,
  ): Promise<MachineRegistryDoc | null> {
    return this.registry.findOne({
      _id: `${machineId}:${version}`,
    } as any) as any
  }
}
