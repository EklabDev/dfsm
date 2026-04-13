import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineMachine } from '@eklabdev/dfsm'
import type { MachineConfig } from '@eklabdev/dfsm'
import { lintCommand } from '../../src/commands/lint.js'

describe('lintCommand', () => {
  it('returns false when machine id is not in the list', async () => {
    const machine = defineMachine({
      id: 'a',
      initial: 's',
      terminal: [],
      context: {},
      states: {
        s: { on: { E: { target: 's', actions: [] } } },
      },
    })

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = await lintCommand([machine], 'missing')

    expect(ok).toBe(false)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('returns true for a valid machine', async () => {
    const machine = defineMachine({
      id: 'traffic',
      initial: 'red',
      terminal: [],
      context: { currentColour: 'red' },
      states: {
        red: {
          on: {
            NEXT: {
              target: 'green',
              actions: [
                {
                  name: 'log',
                  input: z.object({}),
                  output: z.object({ currentColour: z.string() }),
                },
              ],
            },
          },
        },
        green: {
          on: {
            NEXT: {
              target: 'red',
              actions: [
                {
                  name: 'log',
                  input: z.object({}),
                  output: z.object({ currentColour: z.string() }),
                },
              ],
            },
          },
        },
      },
    })

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ok = await lintCommand([machine])

    expect(ok).toBe(true)
    expect(err).not.toHaveBeenCalled()
    log.mockRestore()
    err.mockRestore()
    warn.mockRestore()
  })

  it('returns false when core lint reports errors', async () => {
    const invalid: MachineConfig = {
      id: 'bad',
      initial: 'ghost',
      terminal: [],
      context: {},
      states: {
        only: {},
      },
    }

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ok = await lintCommand([invalid])

    expect(ok).toBe(false)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
    warn.mockRestore()
  })
})
