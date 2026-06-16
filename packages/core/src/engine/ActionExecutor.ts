import type { IWorkflowStore } from '../store/IWorkflowStore.js'
import type { ActionHandler } from '../types/context.js'

export interface ActionExecutorConfig {
  store: IWorkflowStore
  actions: Map<string, ActionHandler<any, any, any>>
  pollIntervalMs: number
  maxRetries: number
  onActionComplete?: (
    workflowId: string,
    machineId: string,
    machineVersion: number,
    state: string,
  ) => Promise<void>
}

export class ActionExecutor {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private config: ActionExecutorConfig) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async poll(): Promise<void> {
    const items = await this.config.store.claimPendingActions(10)

    for (const item of items) {
      try {
        await this.config.store.markActionExecuting(item.id)

        const actionFn = this.config.actions.get(item.actionName)
        if (!actionFn) {
          await this.config.store.markActionFailed(
            item.id,
            `Action '${item.actionName}' not registered`,
          )
          continue
        }

        const doc = await this.config.store.getWorkflowInstance(item.workflowId)
        if (!doc) {
          await this.config.store.markActionFailed(
            item.id,
            `Workflow '${item.workflowId}' not found`,
          )
          continue
        }

        const history = await this.config.store.getWorkflowHistory(item.workflowId)
        const historyForHandler = history.map((h) => ({
          transitionedAt: new Date(h.createdAt),
          fromState: h.fromState,
          toState: h.toState,
          event: h.event,
          eventPayload: h.eventPayload,
          contextSnapshot: h.contextSnapshot,
          actionsDispatched: h.dispatchedActions,
        }))

        const actionInput = {
          workflowId: item.workflowId,
          context: doc.context,
          history: historyForHandler,
          event: { type: 'outbox', payload: item.payload },
        }

        const result = await actionFn(actionInput)

        if (result && typeof result === 'object') {
          await this.config.store.mergeContext(item.workflowId, result)
        }

        await this.config.store.markActionDone(item.id)

        if (this.config.onActionComplete) {
          await this.config.onActionComplete(
            item.workflowId,
            doc.machineId,
            doc.machineVersion,
            doc.currentState,
          )
        }
      } catch (err) {
        await this.config.store.incrementActionAttempts(item.id)
        const attempts = item.attempts + 1
        if (attempts >= this.config.maxRetries) {
          await this.config.store.markActionFailed(
            item.id,
            err instanceof Error ? err.message : String(err),
          )
        } else {
          await this.config.store.resetActionPending(item.id)
        }
      }
    }
  }
}
