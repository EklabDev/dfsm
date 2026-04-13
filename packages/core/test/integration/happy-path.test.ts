import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestEnv, teardownTestEnv, sleep, type TestContext } from './helpers.js'

describe('happy-path integration', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestEnv()
    await ctx.engine.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('processes an order through SUBMIT → PAYMENT_CAPTURED → SHIPPED → DELIVERED', async () => {
    const workflowId = 'ORD-1'
    await ctx.engine.startWorkflow({
      workflowId,
      machineId: 'order',
      initialContext: {
        orderId: 'ORD-1',
        customerId: 'CUST-1',
        amount: 100,
        sku: 'SKU-A',
      },
    })

    await ctx.engine.sendEvent(workflowId, { type: 'SUBMIT' })
    await sleep(500)

    await ctx.engine.sendEvent(workflowId, { type: 'PAYMENT_CAPTURED' })
    await sleep(500)

    await ctx.engine.sendEvent(workflowId, { type: 'SHIPPED' })
    await sleep(500)

    await ctx.engine.sendEvent(workflowId, { type: 'DELIVERED' })
    await sleep(500)

    const doc = await ctx.engine.getWorkflow(workflowId)
    expect(doc).not.toBeNull()
    expect(doc!.currentState).toBe('delivered')
    expect(doc!.status).toBe('completed')

    const history = await ctx.engine.getHistory(workflowId)
    expect(history).toHaveLength(4)

    const transitions = history.map((h) => [h.fromState, h.toState])
    expect(transitions).toEqual([
      ['pending', 'payment_processing'],
      ['payment_processing', 'fulfilling'],
      ['fulfilling', 'shipped'],
      ['shipped', 'delivered'],
    ])

    expect(doc!.context.chargeId).toBeDefined()
    expect(doc!.context.reservationId).toBeDefined()
    expect(doc!.context.trackingNumber).toBeDefined()
    expect(doc!.context.orderId).toBe('ORD-1')

    const outboxDocs = await ctx.db
      .collection('action_outbox')
      .find({ workflowId })
      .toArray()
    const allDone = outboxDocs.every((d: any) => d.status === 'done')
    expect(allDone).toBe(true)
  })
})
