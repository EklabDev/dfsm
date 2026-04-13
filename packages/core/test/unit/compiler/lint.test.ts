import { describe, it, expect } from 'vitest'
import { lint } from '../../../src/compiler/lint.js'
import type { MachineConfig } from '../../../src/types/machine.js'

const valid: MachineConfig = {
  id: 'test',
  initial: 'idle',
  terminal: ['done'],
  context: {},
  states: {
    idle: { on: { GO: { target: 'done' } } },
    done: {},
  },
}

describe('lint', () => {
  it('returns no errors/warnings for a valid machine', () => {
    const r = lint(valid)
    expect(r.errors).toHaveLength(0)
    expect(r.warnings).toHaveLength(0)
  })

  it('reports INVALID_INITIAL for unreachable initial state', () => {
    const r = lint({ ...valid, initial: 'ghost' })
    expect(r.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_INITIAL' }),
    )
  })

  it('reports INVALID_TERMINAL for terminal not in states', () => {
    const r = lint({ ...valid, terminal: ['missing'] })
    expect(r.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_TERMINAL' }),
    )
  })

  it('reports INVALID_TARGET for transition target not in states', () => {
    const r = lint({
      ...valid,
      states: {
        idle: { on: { GO: { target: 'nowhere' } } },
        done: {},
      },
    })
    expect(r.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_TARGET' }),
    )
  })

  it('reports INVALID_AFTER_TARGET for after target not in states', () => {
    const r = lint({
      ...valid,
      states: {
        idle: { after: { 5000: 'nowhere' } },
        done: {},
      },
    })
    expect(r.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_AFTER_TARGET' }),
    )
  })

  it('warns DEAD_STATE for non-terminal with no transitions', () => {
    const r = lint({
      ...valid,
      states: {
        idle: { on: { GO: { target: 'done' } } },
        limbo: {},
        done: {},
      },
    })
    expect(r.warnings).toContainEqual(
      expect.objectContaining({ code: 'DEAD_STATE' }),
    )
  })
})
