import type { IWorkflowStore } from '../store/IWorkflowStore.js'
import type { WorkflowDefinitionRecord } from '../types/store.js'
import type { WorkflowDefinitionJson } from '../types/workflow.js'
import type { DfsmRuntime } from '../runtime/DfsmRuntime.js'
import { mapContext } from '../workflow/createWorkflow.js'
import { newId, nowIso } from '../util/ids.js'
import type { StateEnvelope } from '../types/envelope.js'

export class OrchestratorEngine {
  private entrySubscriptions: Array<{ topic: string }> = []

  constructor(
    private store: IWorkflowStore,
    private runtime: DfsmRuntime,
  ) {}

  async registerWorkflowDefinition(
    record: WorkflowDefinitionRecord,
  ): Promise<void> {
    for (const binding of record.entryBindings) {
      if (binding.kind === 'queue') {
        this.entrySubscriptions.push({ topic: binding.ref })
      }
    }
  }

  async ingest(
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<string | null> {
    const defs = await this.findWorkflowForTopic(topic)
    if (defs.length === 0) return null

    const def = defs[0]!
    const orchestrationId = newId()
    const entryStep = def.definition.steps[def.definition.initial]
    if (!entryStep || entryStep.type !== 'entry') {
      throw new Error(`Workflow '${def.workflowId}' initial step must be entry`)
    }

    await this.store.createOrchestrationInstance({
      orchestrationId,
      workflowDefId: def.workflowId,
      workflowDefVersion: def.version,
      initialStepId: def.definition.initial,
      initialContext: { ...def.definition.context, ...payload },
    })

    const nextStepId = entryStep.next
    if (nextStepId) {
      await this.advanceStep(orchestrationId, def, nextStepId, payload)
    }

    return orchestrationId
  }

  async onMachineComplete(envelope: StateEnvelope): Promise<void> {
    if (!envelope.metadata.orchestrationId) return

    const orch = await this.store.getOrchestrationInstance(
      envelope.metadata.orchestrationId,
    )
    if (!orch) return

    const def = await this.store.getActiveWorkflowDefinition(orch.workflowDefId)
    if (!def) return

    const step = def.definition.steps[orch.currentStepId]
    if (!step || (step.type !== 'machine' && step.type !== 'subworkflow')) return

    const nextStep = step.onComplete
    if (nextStep) {
      await this.advanceStep(
        orch.id,
        def,
        nextStep,
        envelope.context,
      )
    }
  }

  private async advanceStep(
    orchestrationId: string,
    def: WorkflowDefinitionRecord,
    stepId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const orch = await this.store.getOrchestrationInstance(orchestrationId)
    if (!orch) return

    const step = def.definition.steps[stepId]
    if (!step) throw new Error(`Step '${stepId}' not found`)

    await this.store.advanceOrchestration({
      orchestrationId,
      nextStepId: stepId,
      contextUpdate: context,
      expectedVersion: orch.version,
    })

    if (step.type === 'machine') {
      const workflowId = newId()
      const input = mapContext(context, step.inputMap)
      await this.runtime.startWorkflow({
        workflowId,
        machineId: step.machineId,
        initialContext: input,
        orchestrationId,
        orchestrationStepId: stepId,
      })
    } else if (step.type === 'subworkflow') {
      const childOrchId = newId()
      const subDef = await this.store.getActiveWorkflowDefinition(step.workflowId)
      if (!subDef) {
        throw new Error(`Subworkflow '${step.workflowId}' not registered`)
      }
      await this.store.createOrchestrationInstance({
        orchestrationId: childOrchId,
        workflowDefId: step.workflowId,
        workflowDefVersion: subDef.version,
        initialStepId: subDef.definition.initial,
        initialContext: mapContext(context, step.inputMap),
      })
      await this.store.advanceOrchestration({
        orchestrationId: orch.id,
        nextStepId: stepId,
        contextUpdate: {},
        childRefs: [
          ...orch.childRefs,
          {
            stepId,
            kind: 'subworkflow',
            instanceId: childOrchId,
          },
        ],
        expectedVersion: orch.version + 1,
      })
    } else if (step.type === 'exit' && step.endpoint.kind === 'queue') {
      await this.runtime.publishToTopic(step.endpoint.ref, context)
      await this.store.advanceOrchestration({
        orchestrationId,
        nextStepId: stepId,
        contextUpdate: {},
        expectedVersion: orch.version + 1,
        status: 'completed',
      })
    }
  }

  private async findWorkflowForTopic(
    topic: string,
  ): Promise<WorkflowDefinitionRecord[]> {
    const results: WorkflowDefinitionRecord[] = []
    const activeDefs = await this.listActiveWorkflowDefinitions()
    for (const def of activeDefs) {
      if (def.entryBindings.some((b) => b.kind === 'queue' && b.ref === topic)) {
        results.push(def)
      }
    }
    return results
  }

  private async listActiveWorkflowDefinitions(): Promise<WorkflowDefinitionRecord[]> {
    return (this.runtime as any).workflowDefinitions ?? []
  }
}
