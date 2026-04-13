import type { IStateStore } from '../store/IStateStore.js'

export class ConcurrencyManager {
  constructor(
    private store: IStateStore,
    private leaseTtlMs = 30_000,
  ) {}

  async acquire(workflowId: string): Promise<boolean> {
    return this.store.acquireLease(workflowId, this.leaseTtlMs)
  }

  async release(workflowId: string): Promise<void> {
    return this.store.releaseLease(workflowId)
  }

  async withLease<T>(
    workflowId: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const acquired = await this.acquire(workflowId)
    if (!acquired) return null
    try {
      return await fn()
    } finally {
      await this.release(workflowId)
    }
  }
}
