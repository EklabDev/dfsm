import type { TopicBindings } from '../types/machine.js'
import type { StateEnvelope } from '../types/envelope.js'
import type {
  IQueueAdapter,
  MessageHandler,
  Subscription,
} from './IQueueAdapter.js'
import { newId } from '../util/ids.js'

export interface RabbitMQConfig {
  url: string
}

export class RabbitMQQueueAdapter implements IQueueAdapter {
  private connection: any = null
  private channel: any = null
  private subscriptions = new Map<string, { consumerTag: string }>()

  constructor(private config: RabbitMQConfig) {}

  async setup(bindings: TopicBindings[]): Promise<void> {
    const amqp = await import('amqplib')
    this.connection = await amqp.connect(this.config.url)
    this.channel = await this.connection.createChannel()

    for (const binding of bindings) {
      for (const state of Object.values(binding.states)) {
        await this.channel.assertExchange(state.subscribe, 'topic', {
          durable: true,
        })
        await this.channel.assertExchange(state.publish, 'topic', {
          durable: true,
        })
        await this.channel.assertQueue(state.subscribe, { durable: true })
        await this.channel.assertQueue(state.publish, { durable: true })
      }
    }
  }

  async publish(topic: string, envelope: StateEnvelope): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ not connected')
    await this.channel.assertQueue(topic, { durable: true })
    this.channel.sendToQueue(topic, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
    })
  }

  async subscribe(
    topic: string,
    handler: MessageHandler,
  ): Promise<Subscription> {
    if (!this.channel) throw new Error('RabbitMQ not connected')
    await this.channel.assertQueue(topic, { durable: true })
    const { consumerTag } = await this.channel.consume(
      topic,
      async (msg: { content: Buffer } | null) => {
        if (!msg) return
        const envelope = JSON.parse(msg.content.toString()) as StateEnvelope
        await handler(envelope)
        this.channel.ack(msg)
      },
    )
    const id = newId()
    this.subscriptions.set(id, { consumerTag })
    return { id, topic }
  }

  async unsubscribe(subscription: Subscription): Promise<void> {
    const sub = this.subscriptions.get(subscription.id)
    if (sub && this.channel) {
      await this.channel.cancel(sub.consumerTag)
      this.subscriptions.delete(subscription.id)
    }
  }
}
