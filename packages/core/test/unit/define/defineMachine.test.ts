import { describe, it, expect, beforeEach } from 'vitest'
import {
  defineMachine,
  getMachineRegistry,
  clearMachineRegistry,
} from '../../../src/define/defineMachine.js'

describe('defineMachine', () => {
  beforeEach(() => clearMachineRegistry())

  const validConfig = {
    id: 'test',
    initial: 'idle',
    terminal: ['done'],
    context: {},
    states: {
      idle: { on: { GO: { target: 'done' } } },
      done: {},
    },
  }

  it('throws when initial state is missing from states', () => {
    expect(() =>
      defineMachine({ ...validConfig, initial: 'nonexistent' }),
    ).toThrow("Initial state 'nonexistent'")
  })

  it('throws when terminal state is not in states', () => {
    expect(() =>
      defineMachine({ ...validConfig, terminal: ['missing'] }),
    ).toThrow("Terminal state 'missing'")
  })

  it('throws when transition target is not in states', () => {
    expect(() =>
      defineMachine({
        ...validConfig,
        states: {
          idle: { on: { GO: { target: 'nowhere' } } },
          done: {},
        },
      }),
    ).toThrow("target 'nowhere'")
  })

  it('throws when after target is not in states', () => {
    expect(() =>
      defineMachine({
        ...validConfig,
        states: {
          idle: { after: { 5000: 'nowhere' } },
          done: {},
        },
      }),
    ).toThrow("target 'nowhere'")
  })

  it('registers and returns valid config', () => {
    const result = defineMachine(validConfig)
    expect(result).toBe(validConfig)
    expect(getMachineRegistry().get('test')).toBe(validConfig)
  })

  it('overwrites previous registration with same id', () => {
    defineMachine(validConfig)
    const updated = { ...validConfig, context: { updated: true } }
    defineMachine(updated)
    expect(getMachineRegistry().get('test')).toBe(updated)
  })
})
