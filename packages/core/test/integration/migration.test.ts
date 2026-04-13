import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoClient, type Db } from 'mongodb'
import { z } from 'zod'
import { MongoStateStore } from '../../src/store/MongoStateStore.js'
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js'
import { compile } from '../../src/compiler/compile.js'
import { orderMachine } from '../fixtures/orderMachine.js'
import { orderActions, orderGuards } from '../fixtures/orderActions.js'
import type { MachineConfig } from '../../src/types/machine.js'
import { sleep } from './helpers.js'

describe('migration integration', () => {
  let replSet: MongoMemoryReplSet
  let client: MongoClient
  let db: Db
  let store: MongoStateStore

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    client = new MongoClient(replSet.getUri())
    await client.connect()
    db = client.db('dfsm_migration_test')
    store = new MongoStateStore(db)
    await store.setup()
  })

  afterAll(async () => {
    await client.close()
    await replSet.stop()
  })

  it('in-flight workflows keep version while new ones get latest', async () => {
    const v1Compiled = compile(orderMachine as MachineConfig, 1)
    await store.saveMachineVersion(v1Compiled)

    const machines = new Map([['order', orderMachine as MachineConfig]])
    const compiledMachines = new Map([['order', v1Compiled]])

    const engine = new WorkflowEngine({
      store,
      machines,
      compiledMachines,
      actions: orderActions,
      guards: orderGuards as any,
      leaseTtlMs: 5_000,
      outboxPollIntervalMs: 100,
    })

    await engine.start()

    await engine.startWorkflow({
      workflowId: 'V1-WF-1',
      machineId: 'order',
      initialContext: { orderId: 'V1-1', customerId: 'C', amount: 10, sku: 'A' },
    })

    await engine.sendEvent('V1-WF-1', { type: 'SUBMIT' })
    await sleep(300)

    const v2Compiled = compile(orderMachine as MachineConfig, 2)
    await store.saveMachineVersion(v2Compiled)

    const v1Doc = await store.getWorkflow('V1-WF-1')
    expect(v1Doc!.machineVersion).toBe(1)

    // New workflow on v2
    compiledMachines.set('order', v2Compiled)
    await engine.startWorkflow({
      workflowId: 'V2-WF-1',
      machineId: 'order',
      initialContext: { orderId: 'V2-1', customerId: 'C', amount: 10, sku: 'A' },
    })

    const v2Doc = await store.getWorkflow('V2-WF-1')
    expect(v2Doc!.machineVersion).toBe(2)

    // V1 workflow still works
    await engine.sendEvent('V1-WF-1', { type: 'PAYMENT_CAPTURED' })
    const v1After = await store.getWorkflow('V1-WF-1')
    expect(v1After!.currentState).toBe('fulfilling')

    await engine.stop()
  })
})
