import {
  createRuntime,
  createStore,
  createQueue,
} from '@eklabdev/dfsm'
import { orderMachine } from './machines/order.machine.js'
import { orderActions, orderGuards } from './actions/order.actions.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const store = await createStore({
    provider: 'sqlite',
    path: './order-fulfilment.db',
  })

  const runtime = await createRuntime({
    store,
    queue: createQueue({ provider: 'memory' }),
    actions: orderActions,
    guards: orderGuards,
    outboxPollIntervalMs: 200,
  })

  await runtime.registerMachine(orderMachine)
  await runtime.start()

  console.log('[pending] Starting order ORD-001...')
  await runtime.startWorkflow({
    workflowId: 'ORD-001',
    machineId: 'order',
    initialContext: {
      orderId: 'ORD-001',
      customerId: 'CUST-42',
      amount: 4999,
      sku: 'WIDGET-A',
    },
  })

  const events = ['SUBMIT', 'PAYMENT_CAPTURED', 'SHIPPED', 'DELIVERED']
  for (const eventType of events) {
    await runtime.sendEvent('ORD-001', { type: eventType })
    await sleep(500)
    const doc = await runtime.getWorkflow('ORD-001')
    console.log(`[${doc!.currentState}] After ${eventType}`)
  }

  const final = await runtime.getWorkflow('ORD-001')
  console.log('\nContext:', JSON.stringify(final!.context, null, 2))
  const history = await runtime.getHistory('ORD-001')
  console.log(`History: ${history.length} transitions`)

  await runtime.stop()
  console.log('\nRun: runtime.startVizServer() to see the statechart')
}

main().catch(console.error)
