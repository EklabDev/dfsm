import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createMachine } from '../../src/machine/createMachine.js'
import { SQLiteWorkflowStore } from '../../src/store/SQLiteWorkflowStore.js'
import { DfsmRuntime } from '../../src/runtime/DfsmRuntime.js'
import { InMemoryQueueAdapter } from '../../src/queue/InMemoryQueueAdapter.js'
import { sleep } from './helpers.js'

describe('timeout-stuck integration', () => {
  let runtime: DfsmRuntime
  let store: SQLiteWorkflowStore

  beforeAll(async () => {
    const timeoutMachine = createMachine({
      id: 'timeout-test',
      initial: 'waiting',
      context: {},
      states: {
        waiting: {
          after: { 200: 'cancelled' },
        },
        cancelled: { type: 'final' },
      },
    })

    store = new SQLiteWorkflowStore(':memory:')
    await store.setup()

    runtime = new DfsmRuntime({
      store,
      queue: new InMemoryQueueAdapter(),
      actions: new Map(),
      guards: new Map(),
      leaseTtlMs: 5_000,
      outboxPollIntervalMs: 50,
      supervisorIntervalMs: 100,
    })

    await runtime.registerMachine(timeoutMachine)
  })

  afterAll(async () => {
    await runtime.stop()
    store.close()
  })

  it('supervisor triggers timeout transition after TTL breach', async () => {
    await runtime.start()

    await runtime.startWorkflow({
      workflowId: 'WF-TIMEOUT-1',
      machineId: 'timeout-test',
      initialContext: {},
    })

    const backdated = new Date(Date.now() - 500).toISOString()
    ;(store as any).db
      .prepare(`UPDATE workflow_instances SET updated_at = ? WHERE id = ?`)
      .run(backdated, 'WF-TIMEOUT-1')

    await sleep(600)

    const doc = await runtime.getWorkflow('WF-TIMEOUT-1')
    expect(doc!.currentState).toBe('cancelled')

    const history = await runtime.getHistory('WF-TIMEOUT-1')
    expect(history.length).toBeGreaterThanOrEqual(1)
    expect(history[0]!.event).toBe('__AFTER_200')
  })
})
