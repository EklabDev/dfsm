import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  setupTestEnv,
  teardownTestEnv,
  sleep,
  type TestContext,
  type StoreProvider,
} from './helpers.js'

const providers: StoreProvider[] = ['sqlite', 'mongo']

describe.each(providers)('cross-provider happy-path [%s]', (provider) => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestEnv(provider)
    await ctx.runtime.start()
  })

  afterAll(async () => {
    await teardownTestEnv(ctx)
  })

  it('processes order through full lifecycle', async () => {
    const workflowId = `ORD-${provider}`
    await ctx.runtime.startWorkflow({
      workflowId,
      machineId: 'order',
      initialContext: {
        orderId: workflowId,
        customerId: 'CUST-1',
        amount: 100,
        sku: 'SKU-A',
      },
    })

    for (const event of ['SUBMIT', 'PAYMENT_CAPTURED', 'SHIPPED', 'DELIVERED']) {
      await ctx.runtime.sendEvent(workflowId, { type: event })
      await sleep(300)
    }

    const doc = await ctx.runtime.getWorkflow(workflowId)
    expect(doc!.currentState).toBe('delivered')
    expect(doc!.status).toBe('completed')
  })
})
