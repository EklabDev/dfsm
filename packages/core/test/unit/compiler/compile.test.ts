import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { compile } from '../../../src/compiler/compile.js'
import type { MachineConfig } from '../../../src/types/machine.js'

const config: MachineConfig = {
  id: 'order',
  initial: 'pending',
  terminal: ['done'],
  context: {},
  states: {
    pending: {
      on: {
        SUBMIT: {
          target: 'processing',
          guard: { name: 'hasStock', input: z.object({ sku: z.string() }) },
          actions: [
            {
              name: 'chargePayment',
              input: z.object({ amount: z.number() }),
              output: z.object({ chargeId: z.string() }),
            },
          ],
        },
      },
    },
    processing: {
      after: { 300000: 'done' },
      on: { COMPLETE: { target: 'done' } },
    },
    done: {},
  },
}

describe('compile', () => {
  it('produces correct TransitionTable entries', () => {
    const compiled = compile(config, 1)
    const pending = compiled.transitionTable.get('pending')
    expect(pending?.get('SUBMIT')).toEqual({
      nextState: 'processing',
      guardName: 'hasStock',
      actionNames: ['chargePayment'],
    })
  })

  it('creates __AFTER_ synthetic events for after TTL', () => {
    const compiled = compile(config, 1)
    const processing = compiled.transitionTable.get('processing')
    expect(processing?.has('__AFTER_300000')).toBe(true)
    expect(processing?.get('__AFTER_300000')?.nextState).toBe('done')
  })

  it('deduplicates action slots by name', () => {
    const compiled = compile(config, 1)
    const names = compiled.allActionSlots.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('collects guard slots', () => {
    const compiled = compile(config, 1)
    expect(compiled.allGuardSlots).toHaveLength(1)
    expect(compiled.allGuardSlots[0].name).toBe('hasStock')
  })

  it('throws on lint errors', () => {
    const bad: MachineConfig = {
      ...config,
      initial: 'ghost',
    }
    expect(() => compile(bad, 1)).toThrow('lint failed')
  })

  it('sets machineId and version', () => {
    const compiled = compile(config, 3)
    expect(compiled.machineId).toBe('order')
    expect(compiled.version).toBe(3)
  })
})
