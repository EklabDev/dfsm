import type { TopicBindings } from '../types/machine.js'
import type { StateEnvelope } from '../types/envelope.js'
import type {
  IQueueAdapter,
  MessageHandler,
  Subscription,
} from './IQueueAdapter.js'
import { newId } from '../util/ids.js'

export interface KafkaConfig {
  brokers: string[]
  clientId?: string
}

export class KafkaQueueAdapter implements IQueueAdapter {
  private kafka: any = null
  private producer: any = null
  private consumers = new Map<string, any>()
  private runningConsumers = new Map<string, { stop: () => Promise<void> }>()

  constructor(private config: KafkaConfig) {}

  async setup(bindings: TopicBindings[]): Promise<void> {
    const { Kafka } = await import('kafkajs')
    this.kafka = new Kafka({
      clientId: this.config.clientId ?? 'dfsm',
      brokers: this.config.brokers,
    })
    this.producer = this.kafka.producer()
    await this.producer.connect()

    const admin = this.kafka.admin()
    await admin.connect()
    const topics = new Set<string>()
    for (const binding of bindings) {
      for (const state of Object.values(binding.states)) {
        topics.add(state.subscribe)
        topics.add(state.publish)
      }
    }
    if (topics.size > 0) {
      await admin.createTopics({
        topics: [...topics].map((topic) => ({ topic, numPartitions: 1 })),
      })
    }
    await admin.disconnect()
  }

  async publish(topic: string, envelope: StateEnvelope): Promise<void> {
    if (!this.producer) throw new Error('Kafka not connected')
    await this.producer.send({
      topic,
      messages: [{ value: JSON.stringify(envelope) }],
    })
  }

  async subscribe(
    topic: string,
    handler: MessageHandler,
  ): Promise<Subscription> {
    if (!this.kafka) throw new Error('Kafka not connected')
    const consumer = this.kafka.consumer({
      groupId: `dfsm-${topic}`,
    })
    await consumer.connect()
    await consumer.subscribe({ topic, fromBeginning: false })
    await consumer.run({
      eachMessage: async ({ message }: { message: { value: Buffer | null } }) => {
        if (!message.value) return
        const envelope = JSON.parse(message.value.toString()) as StateEnvelope
        await handler(envelope)
      },
    })
    const id = newId()
    this.consumers.set(id, consumer)
    this.runningConsumers.set(id, {
      stop: async () => {
        await consumer.disconnect()
      },
    })
    return { id, topic }
  }

  async unsubscribe(subscription: Subscription): Promise<void> {
    const runner = this.runningConsumers.get(subscription.id)
    if (runner) {
      await runner.stop()
      this.runningConsumers.delete(subscription.id)
      this.consumers.delete(subscription.id)
    }
  }
}
