import { describe, it, expect } from 'vitest'
import {
  executeTransition,
  GuardRejectedError,
  NoTransitionError,
} from '../../../src/engine/TransitionExecutor.js'
import type { TransitionTable } from '../../../src/types/engine.js'

const table: TransitionTable = new Map([
  [
    'idle',
    new Map([
      [
        'GO',
        { nextState: 'running', guardName: 'canGo', actionNames: ['doStart'] },
      ],
    ]),
  ],
  ['running', new Map([['STOP', { nextState: 'idle', actionNames: [] }]])],
])

describe('executeTransition', () => {
  it('resolves transition without guard', async () => {
    const result = await executeTransition({
      currentState: 'running',
      event: { type: 'STOP', payload: null },
      transitionTable: table,
      guards: new Map(),
      context: {},
      history: [],
    })
    expect(result.nextState).toBe('idle')
    expect(result.guardEvaluated).toBe(false)
  })

  it('resolves transition with passing guard', async () => {
    const guards = new Map([['canGo', async () => true]])
    const result = await executeTransition({
      currentState: 'idle',
      event: { type: 'GO', payload: null },
      transitionTable: table,
      guards,
      context: {},
      history: [],
    })
    expect(result.nextState).toBe('running')
    expect(result.actionNames).toEqual(['doStart'])
    expect(result.guardEvaluated).toBe(true)
  })

  it('throws GuardRejectedError when guard fails', async () => {
    const guards = new Map([['canGo', async () => false]])
    await expect(
      executeTransition({
        currentState: 'idle',
        event: { type: 'GO', payload: null },
        transitionTable: table,
        guards,
        context: {},
        history: [],
      }),
    ).rejects.toThrow(GuardRejectedError)
  })

  it('throws NoTransitionError for unknown state', async () => {
    await expect(
      executeTransition({
        currentState: 'unknown',
        event: { type: 'GO', payload: null },
        transitionTable: table,
        guards: new Map(),
        context: {},
        history: [],
      }),
    ).rejects.toThrow(NoTransitionError)
  })

  it('throws NoTransitionError for unknown event', async () => {
    await expect(
      executeTransition({
        currentState: 'idle',
        event: { type: 'INVALID', payload: null },
        transitionTable: table,
        guards: new Map(),
        context: {},
        history: [],
      }),
    ).rejects.toThrow(NoTransitionError)
  })

  it('throws when guard is not registered', async () => {
    await expect(
      executeTransition({
        currentState: 'idle',
        event: { type: 'GO', payload: null },
        transitionTable: table,
        guards: new Map(),
        context: {},
        history: [],
      }),
    ).rejects.toThrow("Guard 'canGo' not registered")
  })
})
