import { MongoClient } from 'mongodb'
import { MongoStateStore, WorkflowEngine, compile } from '@eklabdev/dfsm'
import type { MachineConfig } from '@eklabdev/dfsm'
import { trafficMachine } from './machine.js'
import { trafficActions } from './actions.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const client = new MongoClient('mongodb://localhost:27017/traffic-example')
  await client.connect()
  const db = client.db()

  const store = new MongoStateStore(db)
  await store.setup()

  const compiled = compile(trafficMachine as MachineConfig, 1)
  await store.saveMachineVersion(compiled)

  const engine = new WorkflowEngine({
    store,
    machines: new Map([['traffic', trafficMachine as MachineConfig]]),
    compiledMachines: new Map([['traffic', compiled]]),
    actions: trafficActions,
    guards: new Map(),
    outboxPollIntervalMs: 100,
  })

  await engine.start()

  await engine.startWorkflow({
    workflowId: 'LIGHT-1',
    machineId: 'traffic',
    initialContext: { currentColour: 'red' },
  })

  for (let i = 0; i < 6; i++) {
    await engine.sendEvent('LIGHT-1', { type: 'NEXT' })
    await sleep(1000)
  }

  const doc = await engine.getWorkflow('LIGHT-1')
  console.log(`Final state: ${doc!.currentState}`)
  console.log(`History: ${doc!.history.length} transitions`)

  await engine.stop()
  await client.close()
}

main().catch(console.error)
