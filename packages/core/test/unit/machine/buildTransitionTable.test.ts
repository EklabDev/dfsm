import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildTransitionTable } from '../../../src/machine/buildTransitionTable.js'
import { lint } from '../../../src/machine/lint.js'
import type { MachineConfig } from '../../../src/types/machine.js'

const config: MachineConfig = {
  id: 'order',
  initial: 'pending',
  context: {},
  states: {
    pending: {
      on: {
        SUBMIT: {
          target: 'processing',
          guard: 'hasStock',
          actions: ['chargePayment'],
          meta: {
            dfsm: {
              guard: { hasStock: { input: z.object({ sku: z.string() }) } },
              actions: {
                chargePayment: {
                  input: z.object({ amount: z.number() }),
                  output: z.object({ chargeId: z.string() }),
                },
              },
            },
          },
        },
      },
    },
    processing: {
      after: { 300000: 'done' },
      on: { COMPLETE: 'done' },
    },
    done: { type: 'final' },
  },
}

describe('buildTransitionTable', () => {
  it('produces correct TransitionTable entries', () => {
    const table = buildTransitionTable(config)
    const pending = table.get('pending')
    expect(pending?.get('SUBMIT')).toEqual({
      nextState: 'processing',
      guardName: 'hasStock',
      actionNames: ['chargePayment'],
    })
  })

  it('creates __AFTER_ synthetic events for after TTL', () => {
    const table = buildTransitionTable(config)
    const processing = table.get('processing')
    expect(processing?.has('__AFTER_300000')).toBe(true)
    expect(processing?.get('__AFTER_300000')?.nextState).toBe('done')
  })

  it('lint fails on invalid initial state', () => {
    const bad: MachineConfig = { ...config, initial: 'ghost' }
    expect(lint(bad).errors.length).toBeGreaterThan(0)
  })
})
