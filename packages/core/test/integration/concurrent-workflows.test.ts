import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestEnv, teardownTestEnv, sleep, type TestContext } from './helpers.js'

describe('concurrent-workflows integration', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestEnv('sqlite')
    await ctx.runtime.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('handles 20 concurrent workflow submissions', async () => {
    const count = 20
    const ids = Array.from({ length: count }, (_, i) => `ORD-CONC-${i}`)

    await Promise.all(
      ids.map((id) =>
        ctx.runtime.startWorkflow({
          workflowId: id,
          machineId: 'order',
          initialContext: {
            orderId: id,
            customerId: 'CUST-X',
            amount: 10,
            sku: 'SKU-C',
          },
        }),
      ),
    )

    await Promise.all(
      ids.map((id) => ctx.runtime.sendEvent(id, { type: 'SUBMIT' })),
    )

    await sleep(2000)

    const docs = await Promise.all(
      ids.map((id) => ctx.store.getWorkflowInstance(id)),
    )

    for (const doc of docs) {
      expect(doc!.currentState).toBe('payment_processing')
      const history = await ctx.store.getWorkflowHistory(doc!.id)
      expect(history.length).toBeGreaterThanOrEqual(1)
    }
  })
})
