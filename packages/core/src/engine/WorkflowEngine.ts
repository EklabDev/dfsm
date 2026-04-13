import type { IStateStore, WorkflowDoc } from '../store/IStateStore.js'
import type { MachineConfig } from '../types/machine.js'
import type { CompiledMachine, TransitionTable } from '../types/engine.js'
import type { ActionHandler, GuardHandler, HistoryEntry } from '../types/context.js'
import { ConcurrencyManager } from './ConcurrencyManager.js'
import { ActionExecutor } from './ActionExecutor.js'
import { TimeoutSupervisor } from './TimeoutSupervisor.js'
import { executeTransition } from './TransitionExecutor.js'

export interface EngineConfig {
  store: IStateStore
  machines: Map<string, MachineConfig>
  compiledMachines: Map<string, CompiledMachine>
  actions: Map<string, ActionHandler<any, any, any>>
  guards: Map<string, GuardHandler<any, any>>
  leaseTtlMs?: number
  outboxPollIntervalMs?: number
  maxRetries?: number
  supervisorIntervalMs?: number
}

export class WorkflowEngine {
  private concurrency: ConcurrencyManager
  private actionExecutor: ActionExecutor
  private supervisor: TimeoutSupervisor
  private store: IStateStore
  private machines: Map<string, MachineConfig>
  private compiledMachines: Map<string, CompiledMachine>
  private guards: Map<string, GuardHandler<any, any>>

  constructor(config: EngineConfig) {
    this.store = config.store
    this.machines = config.machines
    this.compiledMachines = config.compiledMachines
    this.guards = config.guards
    this.concurrency = new ConcurrencyManager(
      config.store,
      config.leaseTtlMs ?? 30_000,
    )

    this.actionExecutor = new ActionExecutor({
      store: config.store,
      actions: config.actions,
      pollIntervalMs: config.outboxPollIntervalMs ?? 500,
      maxRetries: config.maxRetries ?? 5,
    })

    const machineMap = new Map<
      string,
      { transitionTable: TransitionTable; terminal: string[] }
    >()
    for (const [id, compiled] of config.compiledMachines) {
      const machineConfig = config.machines.get(id)
      if (machineConfig) {
        machineMap.set(id, {
          transitionTable: compiled.transitionTable,
          terminal: machineConfig.terminal,
        })
      }
    }

    this.supervisor = new TimeoutSupervisor({
      store: config.store,
      scanIntervalMs: config.supervisorIntervalMs ?? 30_000,
      machines: machineMap,
      sendEvent: (wfId, event) => this.sendEvent(wfId, event),
    })
  }

  async start(): Promise<void> {
    this.actionExecutor.start()
    this.supervisor.start()
  }

  async stop(): Promise<void> {
    this.actionExecutor.stop()
    this.supervisor.stop()
  }

  async startWorkflow(params: {
    workflowId: string
    machineId: string
    initialContext: Record<string, unknown>
  }): Promise<void> {
    const active = await this.store.getActiveMachine(params.machineId)
    if (!active) {
      throw new Error(`No active machine version for '${params.machineId}'`)
    }

    const machine = this.machines.get(params.machineId)
    if (!machine) {
      throw new Error(`Machine config '${params.machineId}' not loaded`)
    }

    await this.store.createWorkflow({
      workflowId: params.workflowId,
      machineId: params.machineId,
      machineVersion: active.version,
      initialContext: { ...machine.context, ...params.initialContext },
      initialState: machine.initial,
    })
  }

  async sendEvent(
    workflowId: string,
    event: { type: string; payload?: unknown },
  ): Promise<void> {
    const fullEvent = { type: event.type, payload: event.payload ?? null }

    await this.concurrency.withLease(workflowId, async () => {
      const doc = await this.store.getWorkflow(workflowId)
      if (!doc) throw new Error(`Workflow '${workflowId}' not found`)

      const compiled = this.getCompiled(doc.machineId, doc.machineVersion)
      const machine = this.machines.get(doc.machineId)
      if (!machine) throw new Error(`Machine config '${doc.machineId}' not loaded`)

      const result = await executeTransition({
        currentState: doc.currentState,
        event: fullEvent,
        transitionTable: compiled.transitionTable,
        guards: this.guards,
        context: doc.context,
        history: doc.history,
      })

      const historyEntry: HistoryEntry<any> = {
        transitionedAt: new Date(),
        fromState: doc.currentState,
        toState: result.nextState,
        event: fullEvent.type,
        eventPayload: fullEvent.payload,
        contextSnapshot: structuredClone(doc.context),
        actionsDispatched: result.actionNames,
      }

      const outboxItems = result.actionNames.map((name) => ({
        workflowId,
        actionName: name,
        idempotencyKey: `${workflowId}:${doc.currentState}:${name}:${doc.version}`,
        payload: doc.context,
      }))

      const isTerminal = machine.terminal.includes(result.nextState)

      await this.store.transitionWithOutbox({
        workflowId,
        nextState: result.nextState,
        contextUpdate: {},
        historyEntry,
        outboxItems,
        expectedVersion: doc.version,
        isTerminal,
      })
    })
  }

  async getWorkflow(workflowId: string): Promise<WorkflowDoc | null> {
    return this.store.getWorkflow(workflowId)
  }

  async getHistory(workflowId: string): Promise<HistoryEntry<any>[]> {
    const doc = await this.store.getWorkflow(workflowId)
    return doc?.history ?? []
  }

  private getCompiled(machineId: string, version: number): CompiledMachine {
    const key = machineId
    const compiled = this.compiledMachines.get(key)
    if (compiled && compiled.version === version) return compiled
    // TODO: fall back to loading from store for version-pinned workflows
    if (compiled) return compiled
    throw new Error(
      `Compiled machine '${machineId}' version ${version} not available`,
    )
  }
}
