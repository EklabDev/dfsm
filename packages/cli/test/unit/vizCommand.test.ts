import { beforeEach, describe, expect, it, vi } from 'vitest'

const startServer = vi.fn().mockResolvedValue(undefined)

vi.mock('dfsm-viz', () => ({
  startServer,
}))

describe('vizCommand', () => {
  beforeEach(() => {
    startServer.mockClear()
  })

  it('delegates to dfsm-viz startServer with the given port', async () => {
    const { vizCommand } = await import('../../src/commands/viz.js')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await vizCommand(5050)

    expect(startServer).toHaveBeenCalledOnce()
    expect(startServer).toHaveBeenCalledWith(5050)
    expect(log).toHaveBeenCalled()

    log.mockRestore()
  })
})
