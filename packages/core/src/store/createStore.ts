import type { IWorkflowStore } from '../store/IWorkflowStore.js'
import { SQLiteWorkflowStore } from '../store/SQLiteWorkflowStore.js'
import { PostgresWorkflowStore } from '../store/PostgresWorkflowStore.js'
import { MongoWorkflowStore } from '../store/MongoWorkflowStore.js'
import type { Db } from 'mongodb'

export type StoreConfig =
  | { provider: 'sqlite'; path?: string }
  | { provider: 'postgres'; connectionString: string }
  | { provider: 'mongo'; db: Db }

export async function createStore(config: StoreConfig): Promise<IWorkflowStore> {
  let store: IWorkflowStore
  switch (config.provider) {
    case 'sqlite':
      store = new SQLiteWorkflowStore(config.path ?? ':memory:')
      break
    case 'postgres':
      store = new PostgresWorkflowStore(config.connectionString)
      break
    case 'mongo':
      store = new MongoWorkflowStore(config.db)
      break
  }
  await store.setup()
  return store
}
