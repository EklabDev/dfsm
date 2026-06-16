import type { IWorkflowStore } from '../store/IWorkflowStore.js'
import type { IQueueAdapter } from '../queue/IQueueAdapter.js'
import type { StateEnvelope } from '../types/envelope.js'
import type { RegisteredMachine } from './MachineRegistry.js'
import type { ActionHandler, GuardHandler } from '../types/context.js'
import { ConcurrencyManager } from '../engine/ConcurrencyManager.js'
import { executeTransition } from '../engine/TransitionExecutor.js'
import { getTerminalStates } from '../machine/createMachine.js'
import { getInboundTopic } from '../machine/buildTopicBindings.js'
import { newId, nowIso } from '../util/ids.js'

export interface StateConsumerConfig {
  store: IWorkflowStore
  queue: IQueueAdapter
  registry: { getVersion: (id: string, v: number) => RegisteredMachine | undefined }
  guards: Map<string, GuardHandler<any, any>>
  onTransitionComplete?: (envelope: StateEnvelope) => Promise<void>
  leaseTtlMs?: number
}

export class StateConsumer {
  private concurrency: ConcurrencyManager

  constructor(private config: StateConsumerConfig) {
    this.concurrency = new ConcurrencyManager(
      config.store,
      config.leaseTtlMs ?? 30_000,
    )
  }

  async handle(envelope: StateEnvelope): Promise<void> {
    const workflowId = envelope.correlationId
    await this.concurrency.withLease(workflowId, async () => {
      const doc = await this.config.store.getWorkflowInstance(workflowId)
      if (!doc || doc.status !== 'active') return

      const registered = this.config.registry.getVersion(
        envelope.machineId,
        envelope.machineVersion,
      )
      if (!registered) {
        throw new Error(
          `Machine '${envelope.machineId}' v${envelope.machineVersion} not registered`,
        )
      }

      const history = await this.config.store.getWorkflowHistory(workflowId)
      const fullEvent = {
        type: envelope.event.type,
        payload: envelope.event.payload ?? null,
      }

      const historyForExecutor = history.map((h) => ({
        transitionedAt: new Date(h.createdAt),
        fromState: h.fromState,
        toState: h.toState,
        event: h.event,
        eventPayload: h.eventPayload,
        contextSnapshot: h.contextSnapshot,
        actionsDispatched: h.dispatchedActions,
      }))

      const result = await executeTransition({
        currentState: doc.currentState,
        event: fullEvent,
        transitionTable: registered.transitionTable,
        guards: this.config.guards,
        context: doc.context,
        history: historyForExecutor,
      })

      const terminal = getTerminalStates(registered.config)
      const isTerminal = terminal.includes(result.nextState)

      const outboxItems = result.actionNames.map((name) => ({
        actionName: name,
        idempotencyKey: `${workflowId}:${doc.currentState}:${name}:${doc.version}`,
        payload: doc.context,
      }))

      await this.config.store.transitionWithOutbox({
        workflowId,
        nextState: result.nextState,
        contextUpdate: {},
        historyEntry: {
          seq: history.length,
          fromState: doc.currentState,
          toState: result.nextState,
          event: fullEvent.type,
          eventPayload: fullEvent.payload as Record<string, unknown>,
          contextSnapshot: structuredClone(doc.context),
          dispatchedActions: result.actionNames,
        },
        outboxItems,
        expectedVersion: doc.version,
        isTerminal,
      })

      if (!isTerminal) {
        const inTopic = getInboundTopic(
          registered.topicBindings,
          result.nextState,
        )
        const nextEnvelope: StateEnvelope = {
          envelopeVersion: 1,
          messageId: newId(),
          correlationId: workflowId,
          machineId: envelope.machineId,
          machineVersion: envelope.machineVersion,
          state: result.nextState,
          event: { type: '__ENTERED', payload: {} },
          context: doc.context,
          metadata: {
            causationId: envelope.messageId,
            timestamp: nowIso(),
            ...(envelope.metadata.orchestrationId
              ? { orchestrationId: envelope.metadata.orchestrationId }
              : {}),
            ...(envelope.metadata.orchestrationStepId
              ? { orchestrationStepId: envelope.metadata.orchestrationStepId }
              : {}),
          },
        }
        await this.config.queue.publish(inTopic, nextEnvelope)
      }

      if (this.config.onTransitionComplete) {
        await this.config.onTransitionComplete(envelope)
      }
    })
  }
}
