import type { IWorkflowStore } from '../store/IWorkflowStore.js'
import type { IQueueAdapter } from '../queue/IQueueAdapter.js'
import { InMemoryQueueAdapter } from '../queue/InMemoryQueueAdapter.js'
import { RabbitMQQueueAdapter } from '../queue/RabbitMQQueueAdapter.js'
import { KafkaQueueAdapter } from '../queue/KafkaQueueAdapter.js'

export type QueueConfig =
  | { provider: 'memory' }
  | { provider: 'rabbitmq'; url: string }
  | { provider: 'kafka'; brokers: string[]; clientId?: string }

export function createQueue(config: QueueConfig): IQueueAdapter {
  switch (config.provider) {
    case 'memory':
      return new InMemoryQueueAdapter()
    case 'rabbitmq':
      return new RabbitMQQueueAdapter({ url: config.url })
    case 'kafka':
      return new KafkaQueueAdapter({
        brokers: config.brokers,
        ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
      })
  }
}
