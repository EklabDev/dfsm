import type { IWorkflowStore } from '../store/IWorkflowStore.js'
import type { IQueueAdapter, Subscription } from '../queue/IQueueAdapter.js'
import type { MachineRegistry } from './MachineRegistry.js'
import { StateConsumer } from './StateConsumer.js'
import type { GuardHandler } from '../types/context.js'
import type { StateEnvelope } from '../types/envelope.js'

export class StateConsumerManager {
  private subscriptions: Subscription[] = []
  private consumer: StateConsumer

  constructor(
    private store: IWorkflowStore,
    private queue: IQueueAdapter,
    private registry: MachineRegistry,
    private guards: Map<string, GuardHandler<any, any>>,
    private onTransitionComplete?: (envelope: StateEnvelope) => Promise<void>,
  ) {
    this.consumer = new StateConsumer({
      store,
      queue,
      registry,
      guards,
      ...(onTransitionComplete ? { onTransitionComplete } : {}),
    })
  }

  async start(): Promise<void> {
    const bindings = this.registry.getAllBindings()
    await this.queue.setup(bindings)

    for (const binding of bindings) {
      for (const state of Object.values(binding.states)) {
        const sub = await this.queue.subscribe(
          state.subscribe,
          async (envelope) => {
            if (envelope.event.type === '__ENTERED') return
            await this.consumer.handle(envelope)
          },
        )
        this.subscriptions.push(sub)
      }
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      await this.queue.unsubscribe(sub)
    }
    this.subscriptions = []
  }
}
