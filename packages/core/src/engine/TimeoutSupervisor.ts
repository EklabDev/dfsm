import type { IStateStore } from '../store/IStateStore.js'
import type { TransitionTable } from '../types/engine.js'

export interface TimeoutSupervisorConfig {
  store: IStateStore
  scanIntervalMs: number
  machines: Map<string, { transitionTable: TransitionTable; terminal: string[] }>
  sendEvent: (
    workflowId: string,
    event: { type: string; payload?: unknown },
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
    for (const [machineId, machine] of this.config.machines) {
      const workflows = await this.config.store.getActiveWorkflows(machineId)

      for (const doc of workflows) {
        const stateMap = machine.transitionTable.get(doc.currentState)
        if (!stateMap) continue

        for (const [eventKey] of stateMap) {
          const match = eventKey.match(/^__AFTER_(\d+)$/)
          if (!match) continue

          const ttlMs = Number(match[1])
          const elapsed = Date.now() - doc.updatedAt.getTime()

          if (elapsed >= ttlMs) {
            try {
              await this.config.sendEvent(doc._id, { type: eventKey })
            } catch {
              // Guard rejection or concurrent modification — skip
            }
          }
        }
      }
    }
  }
}
