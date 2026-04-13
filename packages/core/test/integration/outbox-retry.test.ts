import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestEnv, teardownTestEnv, sleep, type TestContext } from './helpers.js'

describe('outbox-retry integration', () => {
  let ctx: TestContext
  let callCount: number

  beforeAll(async () => {
    callCount = 0

    const retryActions = new Map<string, (input: any) => Promise<any>>([
      [
        'chargePayment',
        async () => {
          callCount++
          if (callCount < 3) throw new Error(`Attempt ${callCount} failed`)
          return { chargeId: `ch_retry_${Date.now()}` }
        },
      ],
      ['reserveStock', async () => ({ reservationId: 'rsv' })],
      ['sendShippingNotification', async () => ({ trackingNumber: 'TRK' })],
      ['processRefund', async () => ({ refundId: 'ref' })],
      ['recordCancellation', async () => ({ cancelReason: 'test' })],
    ])

    ctx = await setupTestEnv({ outboxPollIntervalMs: 100, actions: retryActions })
    await ctx.engine.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('retries failed actions and eventually succeeds', async () => {
    await ctx.engine.startWorkflow({
      workflowId: 'ORD-RETRY-1',
      machineId: 'order',
      initialContext: {
        orderId: 'ORD-RETRY-1',
        customerId: 'C1',
        amount: 50,
        sku: 'SKU-A',
      },
    })

    await ctx.engine.sendEvent('ORD-RETRY-1', { type: 'SUBMIT' })
    await sleep(3000)

    const doc = await ctx.engine.getWorkflow('ORD-RETRY-1')
    expect(doc!.context.chargeId).toBeDefined()
    expect(callCount).toBeGreaterThanOrEqual(3)
  })
})
