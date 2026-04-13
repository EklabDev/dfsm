import type { TransitionTable } from '../types/engine.js'
import type { GuardHandler, HistoryEntry } from '../types/context.js'

export interface TransitionInput {
  currentState: string
  event: { type: string; payload: unknown }
  transitionTable: TransitionTable
  guards: Map<string, GuardHandler<any, any>>
  context: Record<string, unknown>
  history: HistoryEntry<any>[]
}

export interface TransitionResult {
  nextState: string
  actionNames: string[]
  guardEvaluated: boolean
}

export class GuardRejectedError extends Error {
  constructor(guardName: string) {
    super(`Guard '${guardName}' rejected transition`)
    this.name = 'GuardRejectedError'
  }
}

export class NoTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoTransitionError'
  }
}

export async function executeTransition(
  input: TransitionInput,
): Promise<TransitionResult> {
  const stateMap = input.transitionTable.get(input.currentState)
  if (!stateMap) {
    throw new NoTransitionError(
      `No transitions from state '${input.currentState}'`,
    )
  }

  const entry = stateMap.get(input.event.type)
  if (!entry) {
    throw new NoTransitionError(
      `No transition from '${input.currentState}' on event '${input.event.type}'`,
    )
  }

  if (entry.guardName) {
    const guardFn = input.guards.get(entry.guardName)
    if (!guardFn) {
      throw new Error(`Guard '${entry.guardName}' not registered`)
    }
    const actionInput = {
      workflowId: '',
      context: input.context,
      history: input.history,
      event: input.event,
    }
    const passed = await guardFn(actionInput as any)
    if (!passed) {
      throw new GuardRejectedError(entry.guardName)
    }
  }

  return {
    nextState: entry.nextState,
    actionNames: entry.actionNames,
    guardEvaluated: !!entry.guardName,
  }
}
