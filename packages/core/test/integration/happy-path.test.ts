import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestEnv, teardownTestEnv, sleep, type TestContext } from './helpers.js'

describe('happy-path integration', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestEnv()
    await ctx.runtime.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('processes an order through SUBMIT → PAYMENT_CAPTURED → SHIPPED → DELIVERED', async () => {
    const workflowId = 'ORD-1'
    await ctx.runtime.startWorkflow({
      workflowId,
      machineId: 'order',
      initialContext: {
        orderId: 'ORD-1',
        customerId: 'CUST-1',
        amount: 100,
        sku: 'SKU-A',
      },
    })

    await ctx.runtime.sendEvent(workflowId, { type: 'SUBMIT' })
    await sleep(500)

    await ctx.runtime.sendEvent(workflowId, { type: 'PAYMENT_CAPTURED' })
    await sleep(500)

    await ctx.runtime.sendEvent(workflowId, { type: 'SHIPPED' })
    await sleep(500)

    await ctx.runtime.sendEvent(workflowId, { type: 'DELIVERED' })
    await sleep(500)

    const doc = await ctx.runtime.getWorkflow(workflowId)
    expect(doc).not.toBeNull()
    expect(doc!.currentState).toBe('delivered')
    expect(doc!.status).toBe('completed')

    const history = await ctx.runtime.getHistory(workflowId)
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

    const pending = await ctx.store.claimPendingActions(100)
    expect(pending.filter((p) => p.workflowId === workflowId)).toHaveLength(0)
  })
})
