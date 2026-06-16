import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoClient, type Db } from 'mongodb'
import { MongoWorkflowStore } from '../../src/store/MongoWorkflowStore.js'
import { SQLiteWorkflowStore } from '../../src/store/SQLiteWorkflowStore.js'
import { PostgresWorkflowStore } from '../../src/store/PostgresWorkflowStore.js'
import type { IWorkflowStore } from '../../src/store/IWorkflowStore.js'
import { DfsmRuntime } from '../../src/runtime/DfsmRuntime.js'
import { InMemoryQueueAdapter } from '../../src/queue/InMemoryQueueAdapter.js'
import { orderMachine } from '../fixtures/orderMachine.js'
import { orderActions, orderGuards } from '../fixtures/orderActions.js'

export type StoreProvider = 'sqlite' | 'mongo' | 'postgres'

export interface TestContext {
  replSet?: MongoMemoryReplSet
  client?: MongoClient
  db?: Db
  store: IWorkflowStore
  runtime: DfsmRuntime
  provider: StoreProvider
  cleanup?: () => Promise<void>
}

export async function setupTestEnv(
  provider: StoreProvider = 'sqlite',
  overrides?: {
    outboxPollIntervalMs?: number
    supervisorIntervalMs?: number
    actions?: Map<string, any>
    leaseTtlMs?: number
  },
): Promise<TestContext> {
  let store: IWorkflowStore
  let replSet: MongoMemoryReplSet | undefined
  let client: MongoClient | undefined
  let db: Db | undefined
  let cleanup: (() => Promise<void>) | undefined

  if (provider === 'sqlite') {
    const sqlite = new SQLiteWorkflowStore(':memory:')
    await sqlite.setup()
    store = sqlite
    cleanup = async () => sqlite.close()
  } else if (provider === 'mongo') {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    const uri = replSet.getUri()
    client = new MongoClient(uri)
    await client.connect()
    db = client.db('dfsm_test')
    store = new MongoWorkflowStore(db)
    await store.setup()
  } else {
    const connectionString =
      process.env.DATABASE_URL ?? 'postgresql://localhost:5432/dfsm_test'
    const pgStore = new PostgresWorkflowStore(connectionString)
    try {
      await pgStore.setup()
      store = pgStore
      cleanup = async () => pgStore.close()
    } catch {
      // Fall back to sqlite when postgres unavailable
      const sqlite = new SQLiteWorkflowStore(':memory:')
      await sqlite.setup()
      store = sqlite
      provider = 'sqlite'
      cleanup = async () => sqlite.close()
    }
  }

  const runtime = new DfsmRuntime({
    store,
    queue: new InMemoryQueueAdapter(),
    actions: overrides?.actions ?? orderActions,
    guards: orderGuards as any,
    leaseTtlMs: overrides?.leaseTtlMs ?? 5_000,
    outboxPollIntervalMs: overrides?.outboxPollIntervalMs ?? 100,
    maxRetries: 5,
    supervisorIntervalMs: overrides?.supervisorIntervalMs ?? 60_000,
  })

  await runtime.registerMachine(orderMachine)

  return { replSet, client, db, store, runtime, provider, cleanup }
}

export async function teardownTestEnv(ctx: TestContext): Promise<void> {
  await ctx.runtime.stop()
  await ctx.client?.close()
  await ctx.replSet?.stop()
  await ctx.cleanup?.()
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
