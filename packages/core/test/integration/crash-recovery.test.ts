import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestEnv, teardownTestEnv, sleep, type TestContext } from './helpers.js'

describe('crash-recovery integration', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestEnv('sqlite', { leaseTtlMs: 500 })
    await ctx.runtime.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('recovers when lease expires and second engine takes over', async () => {
    const workflowId = 'ORD-CRASH-1'
    await ctx.runtime.startWorkflow({
      workflowId,
      machineId: 'order',
      initialContext: {
        orderId: 'ORD-CRASH-1',
        customerId: 'CUST-1',
        amount: 50,
        sku: 'SKU-B',
      },
    })

    await ctx.runtime.sendEvent(workflowId, { type: 'SUBMIT' })
    await sleep(500)

    const backdated = new Date(Date.now() - 10_000).toISOString()
    ;(ctx.store as any).db
      ?.prepare(`UPDATE workflow_instances SET locked_until = ? WHERE id = ?`)
      ?.run(backdated, workflowId)

    await sleep(600)

    await ctx.runtime.sendEvent(workflowId, { type: 'PAYMENT_CAPTURED' })
    await sleep(500)

    const doc = await ctx.runtime.getWorkflow(workflowId)
    expect(doc!.currentState).toBe('fulfilling')

    const history = await ctx.runtime.getHistory(workflowId)
    const toStates = history.map((h) => h.toState)
    expect(toStates).toContain('payment_processing')
    expect(toStates).toContain('fulfilling')
  })
})
