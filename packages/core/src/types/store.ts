import type { MachineConfigJson, TopicBindings } from './machine.js'
import type { VizGraph } from './engine.js'
import type { WorkflowDefinitionJson, WorkflowVizGraph } from './workflow.js'

export type JsonObject = Record<string, unknown>

export interface MachineDefinitionRecord {
  id: string
  machineId: string
  version: number
  checksum: string
  config: MachineConfigJson
  transitionTable: Record<string, Record<string, TransitionEntry>>
  vizGraph: VizGraph
  topicBindings: TopicBindings
  slotSchemas: SlotSchemaRegistry
  status: 'active' | 'deprecated'
  migratedFrom: number | null
  createdAt: string
  updatedAt: string
}

export interface TransitionEntry {
  nextState: string
  guardName?: string
  actionNames: string[]
}

export interface SlotSchemaRegistry {
  guards: Record<string, unknown>
  actions: Record<string, { input: unknown; output: unknown }>
}

export interface WorkflowInstanceRecord {
  id: string
  machineId: string
  machineVersion: number
  currentState: string
  context: JsonObject
  status: 'active' | 'completed' | 'failed' | 'suspended'
  version: number
  lockedUntil: string | null
  orchestrationId: string | null
  orchestrationStepId: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowHistoryRecord {
  id: string
  workflowId: string
  seq: number
  fromState: string
  toState: string
  event: string
  eventPayload: JsonObject
  contextSnapshot: JsonObject
  dispatchedActions: string[]
  createdAt: string
}

export interface PendingActionRecord {
  id: string
  workflowId: string
  actionName: string
  idempotencyKey: string
  payload: JsonObject
  status: 'pending' | 'executing' | 'done' | 'failed'
  attempts: number
  lastError: string | null
  createdAt: string
}

export interface WorkflowDefinitionRecord {
  id: string
  workflowId: string
  version: number
  checksum: string
  definition: WorkflowDefinitionJson
  vizGraph: WorkflowVizGraph
  entryBindings: EndpointBinding[]
  exitBindings: EndpointBinding[]
  status: 'active' | 'deprecated'
  createdAt: string
  updatedAt: string
}

export interface EndpointBinding {
  kind: 'queue' | 'http' | 'timer'
  ref: string
}

export interface OrchestrationInstanceRecord {
  id: string
  workflowDefId: string
  workflowDefVersion: number
  currentStepId: string
  context: JsonObject
  status: 'active' | 'completed' | 'failed' | 'suspended'
  version: number
  childRefs: ChildRef[]
  createdAt: string
  updatedAt: string
}

export interface ChildRef {
  stepId: string
  kind: 'machine' | 'subworkflow'
  instanceId: string
  machineId?: string
}

export interface UpsertResult {
  machineId: string
  version: number
  created: boolean
  topicsAdded: string[]
  topicsUnchanged: string[]
}

export interface CreateWorkflowParams {
  workflowId: string
  machineId: string
  machineVersion: number
  initialContext: JsonObject
  initialState: string
  orchestrationId?: string | null
  orchestrationStepId?: string | null
}

export interface TransitionParams {
  workflowId: string
  nextState: string
  contextUpdate: JsonObject
  historyEntry: Omit<WorkflowHistoryRecord, 'id' | 'workflowId' | 'createdAt'>
  outboxItems: Array<{
    actionName: string
    idempotencyKey: string
    payload: JsonObject
  }>
  expectedVersion: number
  isTerminal: boolean
}

export interface CreateOrchestrationParams {
  orchestrationId: string
  workflowDefId: string
  workflowDefVersion: number
  initialStepId: string
  initialContext: JsonObject
}

export interface AdvanceOrchestrationParams {
  orchestrationId: string
  nextStepId: string
  contextUpdate: JsonObject
  childRefs?: ChildRef[]
  expectedVersion: number
  status?: OrchestrationInstanceRecord['status']
}
