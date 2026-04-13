import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestEnv, teardownTestEnv, sleep, type TestContext } from './helpers.js'

describe('concurrent-workflows integration', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestEnv()
    await ctx.engine.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('handles 20 concurrent workflow submissions', async () => {
    const count = 20
    const ids = Array.from({ length: count }, (_, i) => `ORD-CONC-${i}`)

    await Promise.all(
      ids.map((id) =>
        ctx.engine.startWorkflow({
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
      ids.map((id) => ctx.engine.sendEvent(id, { type: 'SUBMIT' })),
    )

    await sleep(2000)

    const docs = await ctx.db
      .collection('workflow_state')
      .find({ _id: { $in: ids } })
      .toArray()

    for (const doc of docs) {
      expect((doc as any).currentState).toBe('payment_processing')
    }

    const outboxDocs = await ctx.db
      .collection('action_outbox')
      .find({ workflowId: { $in: ids }, actionName: 'chargePayment' })
      .toArray()

    const keys = outboxDocs.map((d: any) => d.idempotencyKey)
    expect(new Set(keys).size).toBe(count)
  })
})
