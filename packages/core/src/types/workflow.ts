import type { EndpointBinding } from './store.js'

export interface WorkflowDefinitionJson {
  id: string
  initial: string
  context: Record<string, unknown>
  steps: Record<string, WorkflowStep>
}

export type WorkflowStep =
  | {
      type: 'machine'
      machineId: string
      inputMap: Record<string, string>
      outputMap: Record<string, string>
      onComplete?: string
      onFailure?: string
    }
  | {
      type: 'subworkflow'
      workflowId: string
      inputMap: Record<string, string>
      outputMap: Record<string, string>
      onComplete?: string
      onFailure?: string
    }
  | {
      type: 'choice'
      branches: { when: string; target: string }[]
      otherwise?: string
    }
  | { type: 'parallel'; branches: string[]; join: string }
  | { type: 'entry'; endpoint: EndpointBinding; next?: string }
  | { type: 'exit'; endpoint: EndpointBinding }

export interface WorkflowVizNode {
  id: string
  label: string
  type: 'step' | 'initial' | 'terminal' | 'choice' | 'parallel'
  stepType: WorkflowStep['type']
}

export interface WorkflowVizEdge {
  from: string
  to: string
  label?: string
}

export interface WorkflowVizGraph {
  nodes: WorkflowVizNode[]
  edges: WorkflowVizEdge[]
}
