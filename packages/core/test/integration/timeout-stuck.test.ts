import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { MongoStateStore } from '../../src/store/MongoStateStore.js'
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js'
import { compile } from '../../src/compiler/compile.js'
import { defineMachine, clearMachineRegistry } from '../../src/define/defineMachine.js'
import { z } from 'zod'
import { sleep } from './helpers.js'

describe('timeout-stuck integration', () => {
  let replSet: MongoMemoryReplSet
  let client: MongoClient
  let engine: WorkflowEngine

  beforeAll(async () => {
    clearMachineRegistry()

    const timeoutMachine = defineMachine({
      id: 'timeout-test',
      initial: 'waiting',
      terminal: ['cancelled'],
      context: {},
      states: {
        waiting: {
          after: { 200: 'cancelled' },
          on: {},
        },
        cancelled: {},
      },
    })

    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    client = new MongoClient(replSet.getUri())
    await client.connect()
    const db = client.db('dfsm_timeout_test')

    const store = new MongoStateStore(db)
    await store.setup()

    const compiled = compile(timeoutMachine as any, 1)
    await store.saveMachineVersion(compiled)

    engine = new WorkflowEngine({
      store,
      machines: new Map([['timeout-test', timeoutMachine as any]]),
      compiledMachines: new Map([['timeout-test', compiled]]),
      actions: new Map(),
      guards: new Map(),
      leaseTtlMs: 5_000,
      outboxPollIntervalMs: 50,
      supervisorIntervalMs: 100,
    })
  })

  afterAll(async () => {
    await engine.stop()
    await client.close()
    await replSet.stop()
  })

  it('supervisor triggers timeout transition after TTL breach', async () => {
    await engine.start()

    await engine.startWorkflow({
      workflowId: 'WF-TIMEOUT-1',
      machineId: 'timeout-test',
      initialContext: {},
    })

    // Backdate updatedAt to ensure TTL is breached
    const db = client.db('dfsm_timeout_test')
    await db.collection('workflow_state').updateOne(
      { _id: 'WF-TIMEOUT-1' },
      { $set: { updatedAt: new Date(Date.now() - 500) } },
    )

    await sleep(600)

    const doc = await engine.getWorkflow('WF-TIMEOUT-1')
    expect(doc!.currentState).toBe('cancelled')

    const history = await engine.getHistory('WF-TIMEOUT-1')
    expect(history.length).toBeGreaterThanOrEqual(1)
    expect(history[0].event).toBe('__AFTER_200')
  })
})
