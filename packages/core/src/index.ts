export * from './types/index.js'

export { createMachine, getTerminalStates, isTerminalState } from './machine/createMachine.js'
export { lint, type LintResult, type LintError, type LintWarning } from './machine/lint.js'
export { buildTransitionTable, serializeTransitionTable } from './machine/buildTransitionTable.js'
export { buildVizGraph } from './machine/buildVizGraph.js'
export { buildTopicBindings } from './machine/buildTopicBindings.js'

export { createWorkflow, buildWorkflowVizGraph } from './workflow/createWorkflow.js'

export type { IWorkflowStore } from './store/IWorkflowStore.js'
export {
  ConcurrentModificationError,
} from './store/IWorkflowStore.js'
export { SQLiteWorkflowStore } from './store/SQLiteWorkflowStore.js'
export { PostgresWorkflowStore } from './store/PostgresWorkflowStore.js'
export { MongoWorkflowStore } from './store/MongoWorkflowStore.js'
export { createStore, type StoreConfig } from './store/createStore.js'

export type { IQueueAdapter, Subscription, MessageHandler } from './queue/IQueueAdapter.js'
export { InMemoryQueueAdapter } from './queue/InMemoryQueueAdapter.js'
export { RabbitMQQueueAdapter } from './queue/RabbitMQQueueAdapter.js'
export { KafkaQueueAdapter } from './queue/KafkaQueueAdapter.js'
export { createQueue, type QueueConfig } from './queue/createQueue.js'

export { DfsmRuntime, createRuntime, type RuntimeConfig } from './runtime/DfsmRuntime.js'
export { MachineRegistry } from './runtime/MachineRegistry.js'
export { StateConsumer } from './runtime/StateConsumer.js'

export { OrchestratorEngine } from './orchestrator/OrchestratorEngine.js'

export { ConcurrencyManager } from './engine/ConcurrencyManager.js'
export { executeTransition, GuardRejectedError, NoTransitionError } from './engine/TransitionExecutor.js'
export { ActionExecutor } from './engine/ActionExecutor.js'
export { TimeoutSupervisor } from './engine/TimeoutSupervisor.js'

export { startVizServer } from './viz/startVizServer.js'

// Legacy alias for migration period
export { createMachine as defineMachine } from './machine/createMachine.js'

export { createSaga, type SagaStep } from './define/createSaga.js'
