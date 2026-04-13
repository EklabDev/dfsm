import type { ObjectId } from 'mongodb'
import type { HistoryEntry } from '../types/context.js'
import type { CompiledMachine, VizGraph } from '../types/engine.js'

export interface WorkflowDoc {
  _id: string
  machineId: string
  machineVersion: number
  currentState: string
  context: Record<string, unknown>
  history: HistoryEntry<any>[]
  version: number
  lockedUntil: Date | null
  status: 'active' | 'completed' | 'failed'
  createdAt: Date
  updatedAt: Date
}

export interface OutboxDoc {
  _id: ObjectId
  workflowId: string
  actionName: string
  idempotencyKey: string
  payload: Record<string, unknown>
  status: 'pending' | 'executing' | 'done' | 'failed'
  attempts: number
  lastError: string | null
  createdAt: Date
}

export interface OutboxItem {
  workflowId: string
  actionName: string
  idempotencyKey: string
  payload: Record<string, unknown>
}

export interface MachineRegistryDoc {
  _id: string
  machineId: string
  version: number
  transitionTable: Record<string, Record<string, any>>
  vizGraph: VizGraph
  allActionSlotNames: string[]
  allGuardSlotNames: string[]
  status: 'active' | 'deprecated'
  createdAt: Date
  migratedFrom: number | null
}

export interface TransitionWithOutboxParams {
  workflowId: string
  nextState: string
  contextUpdate: Record<string, unknown>
  historyEntry: HistoryEntry<any>
  outboxItems: OutboxItem[]
  expectedVersion: number
  isTerminal: boolean
}

export interface IStateStore {
  setup(): Promise<void>

  createWorkflow(params: {
    workflowId: string
    machineId: string
    machineVersion: number
    initialContext: Record<string, unknown>
    initialState: string
  }): Promise<void>

  getWorkflow(workflowId: string): Promise<WorkflowDoc | null>

  acquireLease(workflowId: string, ttlMs: number): Promise<boolean>
  releaseLease(workflowId: string): Promise<void>

  transitionWithOutbox(params: TransitionWithOutboxParams): Promise<void>

  mergeContext(
    workflowId: string,
    partial: Record<string, unknown>,
  ): Promise<void>

  getPendingOutboxItems(limit: number): Promise<OutboxDoc[]>
  markOutboxExecuting(id: ObjectId): Promise<void>
  markOutboxDone(id: ObjectId): Promise<void>
  markOutboxFailed(id: ObjectId, error: string): Promise<void>
  incrementOutboxAttempts(id: ObjectId): Promise<void>

  getActiveWorkflows(machineId: string): Promise<WorkflowDoc[]>

  saveMachineVersion(compiled: CompiledMachine): Promise<void>
  getActiveMachine(machineId: string): Promise<MachineRegistryDoc | null>
  getMachineVersion(
    machineId: string,
    version: number,
  ): Promise<MachineRegistryDoc | null>
}
