import type { MachineConfig } from '../types/machine.js'
import type { WorkflowDefinitionJson } from '../types/workflow.js'
import type { ActionHandler, GuardHandler } from '../types/context.js'
import type { IWorkflowStore } from '../store/IWorkflowStore.js'
import type { WorkflowDefinitionRecord } from '../types/store.js'
import { MachineRegistry } from './MachineRegistry.js'
import { StateConsumerManager } from './StateConsumerManager.js'
import { ActionExecutor } from '../engine/ActionExecutor.js'
import { TimeoutSupervisor } from '../engine/TimeoutSupervisor.js'
import { OrchestratorEngine } from '../orchestrator/OrchestratorEngine.js'
import { lint } from '../machine/lint.js'
import { buildTransitionTable, serializeTransitionTable } from '../machine/buildTransitionTable.js'
import { buildVizGraph } from '../machine/buildVizGraph.js'
import { buildTopicBindings, diffTopicBindings } from '../machine/buildTopicBindings.js'
import { collectSlotSchemas } from '../machine/createMachine.js'
import { canonicalizeConfig, computeChecksum, nowIso } from '../util/ids.js'
import {
  buildWorkflowVizGraph,
  extractEntryBindings,
  extractExitBindings,
} from '../workflow/createWorkflow.js'
import type { StateEnvelope } from '../types/envelope.js'
import { newId } from '../util/ids.js'
import { getInboundTopic } from '../machine/buildTopicBindings.js'
import { getTerminalStates } from '../machine/createMachine.js'
import { InMemoryQueueAdapter } from '../queue/InMemoryQueueAdapter.js'

export interface RuntimeConfig {
  store: IWorkflowStore
  queue?: import('../queue/IQueueAdapter.js').IQueueAdapter
  actions?: Map<string, ActionHandler<any, any, any>>
  guards?: Map<string, GuardHandler<any, any>>
  leaseTtlMs?: number
  outboxPollIntervalMs?: number
  maxRetries?: number
  supervisorIntervalMs?: number
}

export class DfsmRuntime {
  readonly store: IWorkflowStore
  private queue: import('../queue/IQueueAdapter.js').IQueueAdapter
  private actions: Map<string, ActionHandler<any, any, any>>
  private guards: Map<string, GuardHandler<any, any>>
  private registry = new MachineRegistry()
  private consumerManager: StateConsumerManager | null = null
  private actionExecutor: ActionExecutor
  private supervisor: TimeoutSupervisor
  private orchestrator: OrchestratorEngine
  workflowDefinitions: WorkflowDefinitionRecord[] = []
  private started = false
  private leaseTtlMs: number
  private supervisorIntervalMs: number

  constructor(config: RuntimeConfig) {
    this.store = config.store
    this.queue = config.queue ?? new InMemoryQueueAdapter()
    this.actions = config.actions ?? new Map()
    this.guards = config.guards ?? new Map()
    this.leaseTtlMs = config.leaseTtlMs ?? 30_000
    this.supervisorIntervalMs = config.supervisorIntervalMs ?? 30_000

    this.actionExecutor = new ActionExecutor({
      store: this.store,
      actions: this.actions,
      pollIntervalMs: config.outboxPollIntervalMs ?? 500,
      maxRetries: config.maxRetries ?? 5,
      onActionComplete: (workflowId, machineId, machineVersion, state) =>
        this.publishActionComplete(workflowId, machineId, machineVersion, state),
    })

    this.supervisor = new TimeoutSupervisor({
      store: this.store,
      scanIntervalMs: this.supervisorIntervalMs,
      registry: this.registry,
      sendEvent: (wfId, event, machineId, machineVersion) =>
        this.sendEvent(wfId, event, machineId, machineVersion),
    })

    this.orchestrator = new OrchestratorEngine(this.store, this)
  }

  async registerMachine(machine: MachineConfig) {
    const lintResult = lint(machine)
    if (lintResult.errors.length > 0) {
      throw new Error(
        `Machine '${machine.id}' lint failed:\n` +
          lintResult.errors.map((e) => e.message).join('\n'),
      )
    }

    const configJson = canonicalizeConfig(machine)
    const checksum = computeChecksum(configJson)
    const active = await this.store.getActiveMachine(machine.id)

    if (active?.checksum === checksum) {
      this.registry.register(active, machine)
      return {
        machineId: machine.id,
        version: active.version,
        created: false,
        topicsAdded: [],
        topicsUnchanged: [],
      }
    }

    const version = active ? active.version + 1 : 1
    const topicBindings = buildTopicBindings(machine, version)
    const topicDiff = diffTopicBindings(
      active?.topicBindings ?? null,
      topicBindings,
    )

    const record = {
      id: `${machine.id}:${version}`,
      machineId: machine.id,
      version,
      checksum,
      config: configJson,
      transitionTable: serializeTransitionTable(buildTransitionTable(machine)),
      vizGraph: buildVizGraph(machine),
      topicBindings,
      slotSchemas: collectSlotSchemas(machine),
      status: 'active' as const,
      migratedFrom: active?.version ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }

    const result = await this.store.upsertMachineDefinition(record)
    const stored = await this.store.getMachineVersion(
      machine.id,
      result.version,
    )
    if (stored) {
      this.registry.register(stored, machine)
    } else {
      this.registry.register({ ...record, version: result.version, id: `${machine.id}:${result.version}` }, machine)
    }

    const allBindings = this.registry.getAllBindings()
    await this.queue.setup(allBindings)

    if (this.started && this.consumerManager) {
      await this.consumerManager.stop()
      this.consumerManager = new StateConsumerManager(
        this.store,
        this.queue,
        this.registry,
        this.guards,
        (env) => this.orchestrator.onMachineComplete(env),
      )
      await this.consumerManager.start()
    }

    return {
      ...result,
      topicsAdded: topicDiff.added,
      topicsUnchanged: topicDiff.unchanged,
    }
  }

  async registerWorkflow(definition: WorkflowDefinitionJson) {
    const configJson = structuredClone(definition)
    const checksum = computeChecksum(configJson as any)
    const active = await this.store.getActiveWorkflowDefinition(definition.id)

    if (active?.checksum === checksum) {
      return {
        workflowId: definition.id,
        version: active.version,
        created: false,
        topicsAdded: [],
        topicsUnchanged: [],
      }
    }

    const version = active ? active.version + 1 : 1
    const record: WorkflowDefinitionRecord = {
      id: `${definition.id}:${version}`,
      workflowId: definition.id,
      version,
      checksum,
      definition: configJson,
      vizGraph: buildWorkflowVizGraph(definition),
      entryBindings: extractEntryBindings(definition),
      exitBindings: extractExitBindings(definition),
      status: 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }

    const result = await this.store.upsertWorkflowDefinition(record)
    this.workflowDefinitions = this.workflowDefinitions.filter(
      (d) => d.workflowId !== definition.id,
    )
    this.workflowDefinitions.push(record)
    await this.orchestrator.registerWorkflowDefinition(record)

    return {
      machineId: definition.id,
      version,
      created: result.created,
      topicsAdded: record.entryBindings.map((b) => b.ref),
      topicsUnchanged: [],
    }
  }

  async start(): Promise<void> {
    this.consumerManager = new StateConsumerManager(
      this.store,
      this.queue,
      this.registry,
      this.guards,
      (env) => this.orchestrator.onMachineComplete(env),
    )
    await this.consumerManager.start()
    this.actionExecutor.start()
    this.supervisor.start()
    this.started = true
  }

  async stop(): Promise<void> {
    await this.consumerManager?.stop()
    this.actionExecutor.stop()
    this.supervisor.stop()
    this.started = false
  }

  async startWorkflow(params: {
    workflowId: string
    machineId: string
    initialContext: Record<string, unknown>
    orchestrationId?: string
    orchestrationStepId?: string
  }): Promise<void> {
    const active = await this.store.getActiveMachine(params.machineId)
    if (!active) {
      throw new Error(`No active machine version for '${params.machineId}'`)
    }

    const registered = this.registry.get(params.machineId)
    if (!registered) {
      throw new Error(`Machine '${params.machineId}' not registered in runtime`)
    }

    await this.store.createWorkflowInstance({
      workflowId: params.workflowId,
      machineId: params.machineId,
      machineVersion: active.version,
      initialContext: { ...registered.config.context, ...params.initialContext },
      initialState: registered.config.initial,
      orchestrationId: params.orchestrationId ?? null,
      orchestrationStepId: params.orchestrationStepId ?? null,
    })
  }

  async sendEvent(
    workflowId: string,
    event: { type: string; payload?: unknown },
    machineId?: string,
    machineVersion?: number,
  ): Promise<void> {
    const doc = await this.store.getWorkflowInstance(workflowId)
    if (!doc) throw new Error(`Workflow '${workflowId}' not found`)

    const mId = machineId ?? doc.machineId
    const mVer = machineVersion ?? doc.machineVersion
    const registered =
      this.registry.getVersion(mId, mVer) ?? this.registry.get(mId)
    if (!registered) {
      throw new Error(`Machine '${mId}' v${mVer} not registered`)
    }

    const topic = getInboundTopic(registered.topicBindings, doc.currentState)
    const envelope: StateEnvelope = {
      envelopeVersion: 1,
      messageId: newId(),
      correlationId: workflowId,
      machineId: mId,
      machineVersion: mVer,
      state: doc.currentState,
      event: {
        type: event.type,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
      },
      context: doc.context,
      metadata: {
        timestamp: nowIso(),
        ...(doc.orchestrationId ? { orchestrationId: doc.orchestrationId } : {}),
        ...(doc.orchestrationStepId
          ? { orchestrationStepId: doc.orchestrationStepId }
          : {}),
      },
    }

    await this.queue.publish(topic, envelope)
  }

  async ingest(
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<string | null> {
    return this.orchestrator.ingest(topic, payload)
  }

  async publishToTopic(
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const envelope: StateEnvelope = {
      envelopeVersion: 1,
      messageId: newId(),
      correlationId: newId(),
      machineId: '',
      machineVersion: 0,
      state: '',
      event: { type: '__EXTERNAL', payload },
      context: payload,
      metadata: { timestamp: nowIso() },
    }
    await this.queue.publish(topic, envelope)
  }

  async getWorkflow(workflowId: string) {
    return this.store.getWorkflowInstance(workflowId)
  }

  async getHistory(workflowId: string) {
    return this.store.getWorkflowHistory(workflowId)
  }

  async startVizServer(options?: { port?: number }): Promise<void> {
    const { startVizServer } = await import('../viz/startVizServer.js')
    await startVizServer({ store: this.store, port: options?.port ?? 4242 })
  }

  private async publishActionComplete(
    workflowId: string,
    machineId: string,
    machineVersion: number,
    state: string,
  ): Promise<void> {
    const doc = await this.store.getWorkflowInstance(workflowId)
    if (!doc) return

    const registered = this.registry.getVersion(machineId, machineVersion)
    if (!registered) return

    const terminal = getTerminalStates(registered.config)
    if (terminal.includes(doc.currentState)) {
      await this.orchestrator.onMachineComplete({
        envelopeVersion: 1,
        messageId: newId(),
        correlationId: workflowId,
        machineId,
        machineVersion,
        state: doc.currentState,
        event: { type: '__COMPLETE' },
        context: doc.context,
        metadata: {
          timestamp: nowIso(),
          ...(doc.orchestrationId
            ? { orchestrationId: doc.orchestrationId }
            : {}),
          ...(doc.orchestrationStepId
            ? { orchestrationStepId: doc.orchestrationStepId }
            : {}),
        },
      })
    }
  }
}

export async function createRuntime(
  config: RuntimeConfig,
): Promise<DfsmRuntime> {
  const runtime = new DfsmRuntime(config)
  return runtime
}
