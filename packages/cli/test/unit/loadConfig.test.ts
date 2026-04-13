import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig, type DfsmConfig } from '../../src/config/loadConfig.js'

describe('loadConfig', () => {
  it('resolves dfsm.config.ts under cwd and returns injected config', async () => {
    const cwd = '/tmp/dfsm-project'
    const loader = vi.fn(async (): Promise<{ default: DfsmConfig }> => ({
      default: {
        mongoUri: 'mongodb://localhost:27017/app',
        machines: [],
        actions: {},
        guards: {},
        generatedDir: './generated',
      },
    }))

    const config = await loadConfig(cwd, loader)

    expect(loader).toHaveBeenCalledOnce()
    expect(loader).toHaveBeenCalledWith(resolve(cwd, 'dfsm.config.ts'))
    expect(config.mongoUri).toBe('mongodb://localhost:27017/app')
    expect(config.generatedDir).toBe('./generated')
  })

  it('accepts a namespace export when default is absent', async () => {
    const inline: DfsmConfig = {
      mongoUri: 'mongodb://localhost:27017/ns',
      machines: [],
      actions: {},
      guards: {},
      generatedDir: './out',
    }

    const config = await loadConfig('/any', async () => inline as Record<string, unknown>)

    expect(config.mongoUri).toBe('mongodb://localhost:27017/ns')
    expect(config.generatedDir).toBe('./out')
  })
})
