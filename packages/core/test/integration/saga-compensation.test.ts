import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestEnv, teardownTestEnv, sleep, type TestContext } from './helpers.js'
import { createSaga } from '../../src/define/createSaga.js'

describe('saga-compensation integration', () => {
  let ctx: TestContext
  let compensationRan: boolean

  beforeAll(async () => {
    compensationRan = false

    const sagaActions = new Map<string, (input: any) => Promise<any>>([
      [
        'chargePayment',
        async () => {
          return createSaga([
            {
              execute: async () => ({ chargeId: 'ch_saga' }),
              compensate: async () => { compensationRan = true },
            },
            {
              execute: async () => { throw new Error('inventory-fail') },
              compensate: async () => {},
            },
          ])
        },
      ],
      ['reserveStock', async () => ({ reservationId: 'rsv' })],
      ['sendShippingNotification', async () => ({ trackingNumber: 'TRK' })],
      ['processRefund', async () => ({ refundId: 'ref' })],
      ['recordCancellation', async () => ({ cancelReason: 'test' })],
    ])

    ctx = await setupTestEnv({ outboxPollIntervalMs: 100, actions: sagaActions })
    await ctx.engine.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('runs compensation when saga step fails inside an action', async () => {
    await ctx.engine.startWorkflow({
      workflowId: 'ORD-SAGA-1',
      machineId: 'order',
      initialContext: {
        orderId: 'ORD-SAGA-1',
        customerId: 'C1',
        amount: 50,
        sku: 'SKU-A',
      },
    })

    await ctx.engine.sendEvent('ORD-SAGA-1', { type: 'SUBMIT' })
    await sleep(3000)

    expect(compensationRan).toBe(true)

    const doc = await ctx.engine.getWorkflow('ORD-SAGA-1')
    // Workflow should be in payment_processing still (transition happened, action failed in outbox)
    expect(doc!.currentState).toBe('payment_processing')

    const outbox = await ctx.db
      .collection('action_outbox')
      .find({ workflowId: 'ORD-SAGA-1', actionName: 'chargePayment' })
      .toArray()
    expect(outbox.length).toBe(1)
    expect((outbox[0] as any).status).toBe('failed')
  })
})
