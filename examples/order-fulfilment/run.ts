import { MongoClient } from 'mongodb'
import {
  MongoStateStore,
  WorkflowEngine,
  compile,
} from '@eklabdev/dfsm'
import type { MachineConfig } from '@eklabdev/dfsm'
import { orderMachine } from './machines/order.machine.js'
import { OrderActions, OrderGuards } from './actions/order.actions.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const client = new MongoClient('mongodb://localhost:27017/order-example')
  await client.connect()
  const db = client.db()

  const store = new MongoStateStore(db)
  await store.setup()

  const compiled = compile(orderMachine as MachineConfig, 1)
  await store.saveMachineVersion(compiled)

  const actionsInstance = new OrderActions()
  const guardsInstance = new OrderGuards()

  const actionMap = new Map<string, any>()
  for (const name of ['chargePayment', 'reserveStock', 'sendShippingNotification', 'processRefund', 'recordCancellation']) {
    actionMap.set(name, (actionsInstance as any)[name].bind(actionsInstance))
  }

  const guardMap = new Map<string, any>()
  guardMap.set('hasStock', guardsInstance.hasStock.bind(guardsInstance))

  const engine = new WorkflowEngine({
    store,
    machines: new Map([['order', orderMachine as MachineConfig]]),
    compiledMachines: new Map([['order', compiled]]),
    actions: actionMap,
    guards: guardMap,
    outboxPollIntervalMs: 200,
  })

  await engine.start()

  console.log('[pending] Starting order ORD-001...')
  await engine.startWorkflow({
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
    await engine.sendEvent('ORD-001', { type: eventType })
    await sleep(500)
    const doc = await engine.getWorkflow('ORD-001')
    console.log(`[${doc!.currentState}] After ${eventType}`)
  }

  const final = await engine.getWorkflow('ORD-001')
  console.log('\nContext:', JSON.stringify(final!.context, null, 2))
  console.log(`History: ${final!.history.length} transitions`)

  await engine.stop()
  await client.close()
  console.log('\nRun: dfsm viz to see the statechart')
}

main().catch(console.error)
