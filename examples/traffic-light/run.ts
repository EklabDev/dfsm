import {
  createRuntime,
  createStore,
  createQueue,
} from '@eklabdev/dfsm'
import { trafficMachine } from './machine.js'
import { trafficActions } from './actions.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const store = await createStore({ provider: 'sqlite', path: ':memory:' })
  const runtime = await createRuntime({
    store,
    queue: createQueue({ provider: 'memory' }),
    actions: trafficActions,
    guards: new Map(),
    outboxPollIntervalMs: 100,
  })

  await runtime.registerMachine(trafficMachine)
  await runtime.start()

  await runtime.startWorkflow({
    workflowId: 'LIGHT-1',
    machineId: 'traffic',
    initialContext: { currentColour: 'red' },
  })

  for (let i = 0; i < 6; i++) {
    await runtime.sendEvent('LIGHT-1', { type: 'NEXT' })
    await sleep(300)
  }

  const doc = await runtime.getWorkflow('LIGHT-1')
  console.log(`Final state: ${doc!.currentState}`)
  const history = await runtime.getHistory('LIGHT-1')
  console.log(`History: ${history.length} transitions`)

  await runtime.stop()
}

main().catch(console.error)
