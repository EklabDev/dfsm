import type { JsonObject } from './store.js'

export interface StateEnvelope<TPayload = unknown> {
  envelopeVersion: 1
  messageId: string
  correlationId: string
  machineId: string
  machineVersion: number
  state: string
  event: { type: string; payload?: TPayload }
  context: JsonObject
  metadata: {
    orchestrationId?: string
    orchestrationStepId?: string
    causationId?: string
    timestamp: string
  }
}
