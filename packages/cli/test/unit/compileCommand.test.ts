import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineMachine } from '@eklabdev/dfsm'
import type { MachineConfig } from '@eklabdev/dfsm'
import { compileCommand } from '../../src/commands/compile.js'

describe('compileCommand', () => {
  let dir: string

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  it('writes generated interface and JSON artifact for a valid machine', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dfsm-cli-test-'))
    const generatedDir = 'generated'

    const machine = defineMachine({
      id: 'demo',
      initial: 's',
      terminal: [],
      context: {},
      states: {
        s: {
          on: {
            GO: {
              target: 's',
              actions: [
                {
                  name: 'noop',
                  input: z.object({}),
                  output: z.object({ ok: z.boolean() }),
                },
              ],
            },
          },
        },
      },
    })

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const results = await compileCommand([machine], generatedDir, dir)

    expect(results).toHaveLength(1)
    expect(results[0].machineId).toBe('demo')

    const ifacePath = join(dir, generatedDir, 'IDemoActions.ts')
    const artifactPath = join(dir, '.dfsm', 'demo.json')

    expect(existsSync(ifacePath)).toBe(true)
    expect(existsSync(artifactPath)).toBe(true)

    const iface = readFileSync(ifacePath, 'utf8')
    expect(iface).toContain("import type { ActionInput } from '@eklabdev/dfsm'")
    expect(iface).toContain('export interface IDemoActions')

    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
    expect(artifact.machineId).toBe('demo')
    expect(artifact.version).toBe(1)
    expect(artifact.transitionTable).toBeDefined()
    expect(artifact.vizGraph).toBeDefined()

    log.mockRestore()
  })

  it('calls process.exit(1) when lint fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dfsm-cli-test-'))

    const invalid: MachineConfig = {
      id: 'bad',
      initial: 'missing',
      terminal: [],
      context: {},
      states: { x: {} },
    }

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number) => {
      throw new Error(`exit:${code}`)
    })

    await expect(
      compileCommand([invalid], 'generated', dir),
    ).rejects.toThrow('exit:1')

    err.mockRestore()
    warn.mockRestore()
    exit.mockRestore()
  })
})
