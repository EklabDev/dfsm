import { describe, it, expect } from 'vitest'
import { lint } from '../../../src/machine/lint.js'
import type { MachineConfig } from '../../../src/types/machine.js'

const base: MachineConfig = {
  id: 'test',
  initial: 'idle',
  context: {},
  states: {
    idle: { on: { GO: 'done' } },
    done: { type: 'final' },
  },
}

describe('lint', () => {
  it('passes valid config', () => {
    const result = lint(base)
    expect(result.errors).toHaveLength(0)
  })

  it('errors on invalid initial', () => {
    const result = lint({ ...base, initial: 'missing' })
    expect(result.errors.some((e) => e.code === 'INVALID_INITIAL')).toBe(true)
  })

  it('errors on invalid target', () => {
    const result = lint({
      ...base,
      states: { idle: { on: { GO: 'missing' } }, done: { type: 'final' } },
    })
    expect(result.errors.some((e) => e.code === 'INVALID_TARGET')).toBe(true)
  })

  it('warns on dead state', () => {
    const result = lint({
      ...base,
      states: {
        idle: { on: { GO: 'done' } },
        stuck: {},
        done: { type: 'final' },
      },
    })
    expect(result.warnings.some((w) => w.code === 'DEAD_STATE')).toBe(true)
  })
})
