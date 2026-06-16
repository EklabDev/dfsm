import type { IWorkflowStore } from '../store/IWorkflowStore.js'

export class ConcurrencyManager {
  constructor(
    private store: IWorkflowStore,
    private leaseTtlMs: number,
  ) {}

  async withLease<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
    const acquired = await this.store.acquireLease(workflowId, this.leaseTtlMs)
    if (!acquired) {
      throw new Error(`Could not acquire lease for workflow '${workflowId}'`)
    }
    try {
      return await fn()
    } finally {
      await this.store.releaseLease(workflowId)
    }
  }
}
