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

export class ConcurrentModificationError extends Error {
  constructor(workflowId: string, expected: number) {
    super(
      `Concurrent modification on workflow '${workflowId}' (expected version ${expected})`,
    )
    this.name = 'ConcurrentModificationError'
  }
}

export interface IWorkflowStore {
  setup(): Promise<void>

  upsertMachineDefinition(
    record: MachineDefinitionRecord,
  ): Promise<UpsertResult>

  getActiveMachine(machineId: string): Promise<MachineDefinitionRecord | null>
  getMachineVersion(
    machineId: string,
    version: number,
  ): Promise<MachineDefinitionRecord | null>

  createWorkflowInstance(params: CreateWorkflowParams): Promise<void>
  getWorkflowInstance(id: string): Promise<WorkflowInstanceRecord | null>
  getActiveWorkflowInstances(machineId: string): Promise<WorkflowInstanceRecord[]>
  getWorkflowHistory(workflowId: string): Promise<WorkflowHistoryRecord[]>

  acquireLease(id: string, ttlMs: number): Promise<boolean>
  releaseLease(id: string): Promise<void>

  transitionWithOutbox(params: TransitionParams): Promise<void>
  mergeContext(id: string, partial: Record<string, unknown>): Promise<void>

  claimPendingActions(limit: number): Promise<PendingActionRecord[]>
  markActionExecuting(id: string): Promise<void>
  markActionDone(id: string): Promise<void>
  markActionFailed(id: string, error: string): Promise<void>
  incrementActionAttempts(id: string): Promise<void>
  resetActionPending(id: string): Promise<void>

  upsertWorkflowDefinition(
    record: WorkflowDefinitionRecord,
  ): Promise<UpsertResult>

  getActiveWorkflowDefinition(
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null>

  createOrchestrationInstance(params: CreateOrchestrationParams): Promise<void>
  getOrchestrationInstance(
    id: string,
  ): Promise<OrchestrationInstanceRecord | null>
  advanceOrchestration(params: AdvanceOrchestrationParams): Promise<void>
}
