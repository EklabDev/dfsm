import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoClient, type Db } from 'mongodb'
import { MongoStateStore } from '../../src/store/MongoStateStore.js'
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js'
import { compile } from '../../src/compiler/compile.js'
import { orderMachine } from '../fixtures/orderMachine.js'
import { orderActions, orderGuards } from '../fixtures/orderActions.js'
import type { MachineConfig } from '../../src/types/machine.js'

export interface TestContext {
  replSet: MongoMemoryReplSet
  client: MongoClient
  db: Db
  store: MongoStateStore
  engine: WorkflowEngine
}

export async function setupTestEnv(
  overrides?: {
    outboxPollIntervalMs?: number
    supervisorIntervalMs?: number
    actions?: Map<string, any>
    leaseTtlMs?: number
  },
): Promise<TestContext> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  const uri = replSet.getUri()
  const client = new MongoClient(uri)
  await client.connect()
  const db = client.db('dfsm_test')

  const store = new MongoStateStore(db)
  await store.setup()

  const compiled = compile(orderMachine as MachineConfig, 1)
  await store.saveMachineVersion(compiled)

  const machines = new Map([['order', orderMachine as MachineConfig]])
  const compiledMachines = new Map([['order', compiled]])

  const engine = new WorkflowEngine({
    store,
    machines,
    compiledMachines,
    actions: overrides?.actions ?? orderActions,
    guards: orderGuards as any,
    leaseTtlMs: overrides?.leaseTtlMs ?? 5_000,
    outboxPollIntervalMs: overrides?.outboxPollIntervalMs ?? 100,
    maxRetries: 5,
    supervisorIntervalMs: overrides?.supervisorIntervalMs ?? 60_000,
  })

  return { replSet, client, db, store, engine }
}

export async function teardownTestEnv(ctx: TestContext): Promise<void> {
  await ctx.engine.stop()
  await ctx.client.close()
  await ctx.replSet.stop()
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
