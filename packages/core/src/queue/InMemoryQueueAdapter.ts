import type { TopicBindings } from '../types/machine.js'
import type { StateEnvelope } from '../types/envelope.js'
import type {
  IQueueAdapter,
  MessageHandler,
  Subscription,
} from './IQueueAdapter.js'
import { newId } from '../util/ids.js'

interface TopicState {
  handlers: Map<string, MessageHandler>
}

export class InMemoryQueueAdapter implements IQueueAdapter {
  private topics = new Map<string, TopicState>()
  private declared = new Set<string>()

  async setup(bindings: TopicBindings[]): Promise<void> {
    for (const binding of bindings) {
      for (const state of Object.values(binding.states)) {
        this.declared.add(state.subscribe)
        this.declared.add(state.publish)
        if (!this.topics.has(state.subscribe)) {
          this.topics.set(state.subscribe, { handlers: new Map() })
        }
        if (!this.topics.has(state.publish)) {
          this.topics.set(state.publish, { handlers: new Map() })
        }
      }
      this.declared.add(`${binding.prefix}.__actions`)
    }
  }

  async publish(topic: string, envelope: StateEnvelope): Promise<void> {
    const state = this.topics.get(topic)
    if (!state) return
    for (const handler of state.handlers.values()) {
      await handler(envelope)
    }
  }

  async subscribe(
    topic: string,
    handler: MessageHandler,
  ): Promise<Subscription> {
    if (!this.topics.has(topic)) {
      this.topics.set(topic, { handlers: new Map() })
    }
    const id = newId()
    this.topics.get(topic)!.handlers.set(id, handler)
    return { id, topic }
  }

  async unsubscribe(subscription: Subscription): Promise<void> {
    this.topics.get(subscription.topic)?.handlers.delete(subscription.id)
  }
}
