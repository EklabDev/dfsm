import type { IWorkflowStore } from '../store/IWorkflowStore.js'
import type { MachineRegistry } from '../runtime/MachineRegistry.js'

export interface TimeoutSupervisorConfig {
  store: IWorkflowStore
  scanIntervalMs: number
  registry: MachineRegistry
  sendEvent: (
    workflowId: string,
    event: { type: string; payload?: unknown },
    machineId: string,
    machineVersion: number,
  ) => Promise<void>
}

export class TimeoutSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private config: TimeoutSupervisorConfig) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => this.scan(), this.config.scanIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async scan(): Promise<void> {
    for (const [machineId, registered] of this.getAllMachines()) {
      const workflows = await this.config.store.getActiveWorkflowInstances(machineId)

      for (const doc of workflows) {
        const stateMap = registered.transitionTable.get(doc.currentState)
        if (!stateMap) continue

        for (const [eventKey] of stateMap) {
          const match = eventKey.match(/^__AFTER_(\d+)$/)
          if (!match) continue

          const ttlMs = Number(match[1])
          const elapsed = Date.now() - new Date(doc.updatedAt).getTime()

          if (elapsed >= ttlMs) {
            try {
              await this.config.sendEvent(
                doc.id,
                { type: eventKey },
                doc.machineId,
                doc.machineVersion,
              )
            } catch {
              // Guard rejection or concurrent modification — skip
            }
          }
        }
      }
    }
  }

  private getAllMachines(): Array<[string, import('../runtime/MachineRegistry.js').RegisteredMachine]> {
    return this.config.registry.getAll().map((m) => [m.definition.machineId, m])
  }
}
