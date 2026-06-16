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

    ctx = await setupTestEnv('sqlite', { outboxPollIntervalMs: 100, actions: sagaActions })
    await ctx.runtime.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('runs compensation when saga step fails inside an action', async () => {
    await ctx.runtime.startWorkflow({
      workflowId: 'ORD-SAGA-1',
      machineId: 'order',
      initialContext: {
        orderId: 'ORD-SAGA-1',
        customerId: 'C1',
        amount: 50,
        sku: 'SKU-A',
      },
    })

    await ctx.runtime.sendEvent('ORD-SAGA-1', { type: 'SUBMIT' })
    await sleep(3000)

    expect(compensationRan).toBe(true)

    const doc = await ctx.runtime.getWorkflow('ORD-SAGA-1')
    expect(doc!.currentState).toBe('payment_processing')

    const pending = await ctx.store.claimPendingActions(10)
    const chargeAction = pending.find(
      (p) => p.workflowId === 'ORD-SAGA-1' && p.actionName === 'chargePayment',
    )
    if (chargeAction) {
      expect(chargeAction.status).toBe('pending')
    }
  })
})
