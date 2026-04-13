import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestEnv, teardownTestEnv, sleep, type TestContext } from './helpers.js'

describe('crash-recovery integration', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestEnv({ leaseTtlMs: 500 })
    await ctx.engine.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('recovers when lease expires and second engine takes over', async () => {
    const workflowId = 'ORD-CRASH-1'
    await ctx.engine.startWorkflow({
      workflowId,
      machineId: 'order',
      initialContext: {
        orderId: 'ORD-CRASH-1',
        customerId: 'CUST-1',
        amount: 50,
        sku: 'SKU-B',
      },
    })

    await ctx.engine.sendEvent(workflowId, { type: 'SUBMIT' })
    await sleep(300)

    // Simulate expired lease
    await ctx.db.collection('workflow_state').updateOne(
      { _id: workflowId },
      { $set: { lockedUntil: new Date(Date.now() - 10_000) } },
    )

    await sleep(600)

    // Second engine can now acquire lease and advance
    await ctx.engine.sendEvent(workflowId, { type: 'PAYMENT_CAPTURED' })
    await sleep(300)

    const doc = await ctx.engine.getWorkflow(workflowId)
    expect(doc!.currentState).toBe('fulfilling')

    const history = await ctx.engine.getHistory(workflowId)
    const toStates = history.map((h) => h.toState)
    expect(toStates).toContain('payment_processing')
    expect(toStates).toContain('fulfilling')
  })
})
