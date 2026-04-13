import type { IStateStore } from '../store/IStateStore.js'
import type { ActionHandler } from '../types/context.js'

export interface ActionExecutorConfig {
  store: IStateStore
  actions: Map<string, ActionHandler<any, any, any>>
  pollIntervalMs: number
  maxRetries: number
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
    const items = await this.config.store.getPendingOutboxItems(10)

    for (const item of items) {
      try {
        await this.config.store.markOutboxExecuting(item._id)

        const actionFn = this.config.actions.get(item.actionName)
        if (!actionFn) {
          await this.config.store.markOutboxFailed(
            item._id,
            `Action '${item.actionName}' not registered`,
          )
          continue
        }

        const doc = await this.config.store.getWorkflow(item.workflowId)
        if (!doc) {
          await this.config.store.markOutboxFailed(
            item._id,
            `Workflow '${item.workflowId}' not found`,
          )
          continue
        }

        const actionInput = {
          workflowId: item.workflowId,
          context: doc.context,
          history: doc.history,
          event: { type: 'outbox', payload: item.payload },
        }

        const result = await actionFn(actionInput)

        if (result && typeof result === 'object') {
          await this.config.store.mergeContext(item.workflowId, result)
        }

        await this.config.store.markOutboxDone(item._id)
      } catch (err) {
        await this.config.store.incrementOutboxAttempts(item._id)
        const attempts = item.attempts + 1
        if (attempts >= this.config.maxRetries) {
          await this.config.store.markOutboxFailed(
            item._id,
            err instanceof Error ? err.message : String(err),
          )
        } else {
          await this.config.store
            .markOutboxExecuting(item._id)
            .catch(() => {})
          // Reset to pending for retry by updating status
          await (this.config.store as any).outbox?.updateOne?.(
            { _id: item._id },
            { $set: { status: 'pending' } },
          ).catch(() => {
            // Fallback: store doesn't expose raw collection; handled by next poll
          })
        }
      }
    }
  }
}
