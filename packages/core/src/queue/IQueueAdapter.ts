import type { TopicBindings } from '../types/machine.js'
import type { StateEnvelope } from '../types/envelope.js'

export interface Subscription {
  id: string
  topic: string
}

export type MessageHandler = (envelope: StateEnvelope) => Promise<void>

export interface IQueueAdapter {
  setup(bindings: TopicBindings[]): Promise<void>
  publish(topic: string, envelope: StateEnvelope): Promise<void>
  subscribe(topic: string, handler: MessageHandler): Promise<Subscription>
  unsubscribe(subscription: Subscription): Promise<void>
}
