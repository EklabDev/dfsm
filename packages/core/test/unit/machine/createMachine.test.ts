import { describe, it, expect } from 'vitest'
import { createMachine } from '../../../src/machine/createMachine.js'

describe('createMachine', () => {
  const validConfig = {
    id: 'test',
    initial: 'idle',
    context: {},
    states: {
      idle: { on: { GO: 'done' } },
      done: { type: 'final' as const },
    },
  }

  it('throws when initial state is missing from states', () => {
    expect(() =>
      createMachine({ ...validConfig, initial: 'nonexistent' }),
    ).toThrow("Initial state 'nonexistent'")
  })

  it('throws when transition target is not in states', () => {
    expect(() =>
      createMachine({
        ...validConfig,
        states: {
          idle: { on: { GO: 'nowhere' } },
          done: { type: 'final' },
        },
      }),
    ).toThrow("target 'nowhere'")
  })

  it('throws when after target is not in states', () => {
    expect(() =>
      createMachine({
        ...validConfig,
        states: {
          idle: { after: { 5000: 'nowhere' } },
          done: { type: 'final' },
        },
      }),
    ).toThrow("target 'nowhere'")
  })

  it('returns valid config', () => {
    const result = createMachine(validConfig)
    expect(result).toBe(validConfig)
  })
})
