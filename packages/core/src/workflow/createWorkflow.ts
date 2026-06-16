import type { WorkflowDefinitionJson, WorkflowVizGraph } from '../types/workflow.js'
import type { EndpointBinding } from '../types/store.js'

export function createWorkflow(definition: WorkflowDefinitionJson) {
  validateWorkflow(definition)
  return definition
}

export function validateWorkflow(definition: WorkflowDefinitionJson): void {
  const stepIds = new Set(Object.keys(definition.steps))
  if (!stepIds.has(definition.initial)) {
    throw new Error(`Initial step '${definition.initial}' not in steps`)
  }
}

export function buildWorkflowVizGraph(
  definition: WorkflowDefinitionJson,
): WorkflowVizGraph {
  const nodes: WorkflowVizGraph['nodes'] = []
  const edges: WorkflowVizGraph['edges'] = []

  for (const [stepId, step] of Object.entries(definition.steps)) {
    nodes.push({
      id: stepId,
      label: stepId,
      type: stepId === definition.initial ? 'initial' : step.type === 'exit' ? 'terminal' : 'step',
      stepType: step.type,
    })

    if (step.type === 'entry' && step.next) {
      edges.push({ from: stepId, to: step.next, label: 'next' })
    }
    if (step.type === 'machine' || step.type === 'subworkflow') {
      if (step.onComplete) {
        edges.push({ from: stepId, to: step.onComplete, label: 'onComplete' })
      }
      if (step.onFailure) {
        edges.push({ from: stepId, to: step.onFailure, label: 'onFailure' })
      }
    }
    if (step.type === 'choice') {
      for (const branch of step.branches) {
        edges.push({ from: stepId, to: branch.target, label: branch.when })
      }
      if (step.otherwise) {
        edges.push({ from: stepId, to: step.otherwise, label: 'otherwise' })
      }
    }
    if (step.type === 'parallel') {
      for (const branch of step.branches) {
        edges.push({ from: stepId, to: branch, label: 'branch' })
      }
      edges.push({ from: stepId, to: step.join, label: 'join' })
    }
  }

  return { nodes, edges }
}

export function extractEntryBindings(
  definition: WorkflowDefinitionJson,
): EndpointBinding[] {
  const bindings: EndpointBinding[] = []
  for (const step of Object.values(definition.steps)) {
    if (step.type === 'entry') {
      bindings.push(step.endpoint)
    }
  }
  return bindings
}

export function extractExitBindings(
  definition: WorkflowDefinitionJson,
): EndpointBinding[] {
  const bindings: EndpointBinding[] = []
  for (const step of Object.values(definition.steps)) {
    if (step.type === 'exit') {
      bindings.push(step.endpoint)
    }
  }
  return bindings
}

export function applyJsonPath(
  context: Record<string, unknown>,
  expr: string,
): unknown {
  if (!expr.startsWith('$.')) return expr
  const path = expr.slice(2).split('.')
  let current: unknown = context
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export function mapContext(
  source: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, expr] of Object.entries(mapping)) {
    result[key] = applyJsonPath(source, expr)
  }
  return result
}
