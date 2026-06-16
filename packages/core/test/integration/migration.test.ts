import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { MongoWorkflowStore } from '../../src/store/MongoWorkflowStore.js'
import { DfsmRuntime } from '../../src/runtime/DfsmRuntime.js'
import { InMemoryQueueAdapter } from '../../src/queue/InMemoryQueueAdapter.js'
import { orderMachine } from '../fixtures/orderMachine.js'
import { orderActions, orderGuards } from '../fixtures/orderActions.js'
import { sleep } from './helpers.js'

describe('migration integration', () => {
  let replSet: MongoMemoryReplSet
  let client: MongoClient
  let runtime: DfsmRuntime

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    client = new MongoClient(replSet.getUri())
    await client.connect()
    const db = client.db('dfsm_migration_test')
    const store = new MongoWorkflowStore(db)
    await store.setup()

    runtime = new DfsmRuntime({
      store,
      queue: new InMemoryQueueAdapter(),
      actions: orderActions,
      guards: orderGuards as any,
      leaseTtlMs: 5_000,
      outboxPollIntervalMs: 100,
    })

    await runtime.registerMachine(orderMachine)
    await runtime.start()
  }, 60_000)

  afterAll(async () => {
    await runtime?.stop()
    await client?.close()
    await replSet?.stop()
  })

  it('in-flight workflows keep version while new ones get latest', async () => {
    await runtime.startWorkflow({
      workflowId: 'V1-WF-1',
      machineId: 'order',
      initialContext: { orderId: 'V1-1', customerId: 'C', amount: 10, sku: 'A' },
    })

    await runtime.sendEvent('V1-WF-1', { type: 'SUBMIT' })
    await sleep(500)

    const reg = await runtime.registerMachine({
      ...orderMachine,
      states: {
        ...orderMachine.states,
        pending: {
          ...orderMachine.states.pending,
          on: {
            ...orderMachine.states.pending.on,
            NOOP: 'pending',
          },
        },
      },
    })
    expect(reg.created).toBe(true)
    expect(reg.version).toBe(2)

    const active = await runtime.store.getActiveMachine('order')
    expect(active!.version).toBe(2)

    const v1Doc = await runtime.getWorkflow('V1-WF-1')
    expect(v1Doc!.machineVersion).toBe(1)

    await runtime.startWorkflow({
      workflowId: 'V2-WF-1',
      machineId: 'order',
      initialContext: { orderId: 'V2-1', customerId: 'C', amount: 10, sku: 'A' },
    })

    const v2Doc = await runtime.getWorkflow('V2-WF-1')
    expect(v2Doc!.machineVersion).toBe(2)

    await runtime.sendEvent('V1-WF-1', { type: 'PAYMENT_CAPTURED' })
    await sleep(500)
    const v1After = await runtime.getWorkflow('V1-WF-1')
    expect(v1After!.currentState).toBe('fulfilling')
  })
})
