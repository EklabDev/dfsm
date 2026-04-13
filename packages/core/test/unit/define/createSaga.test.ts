import { describe, it, expect } from 'vitest'
import { createSaga } from '../../../src/define/createSaga.js'

describe('createSaga', () => {
  it('returns all results when all steps succeed', async () => {
    const results = await createSaga([
      { execute: async () => 'a', compensate: async () => {} },
      { execute: async () => 'b', compensate: async () => {} },
      { execute: async () => 'c', compensate: async () => {} },
    ])
    expect(results).toEqual(['a', 'b', 'c'])
  })

  it('compensates in reverse order when step 2 of 3 fails', async () => {
    const compensated: number[] = []

    await expect(
      createSaga([
        {
          execute: async () => 'ok-0',
          compensate: async () => { compensated.push(0) },
        },
        {
          execute: async () => 'ok-1',
          compensate: async () => { compensated.push(1) },
        },
        {
          execute: async () => { throw new Error('step-2-fail') },
          compensate: async () => { compensated.push(2) },
        },
      ]),
    ).rejects.toThrow('step-2-fail')

    expect(compensated).toEqual([1, 0])
  })

  it('propagates compensation error without swallowing original', async () => {
    await expect(
      createSaga([
        {
          execute: async () => 'ok',
          compensate: async () => { throw new Error('comp-fail') },
        },
        {
          execute: async () => { throw new Error('step-fail') },
          compensate: async () => {},
        },
      ]),
    ).rejects.toThrow('comp-fail')
  })

  it('handles single step saga — success', async () => {
    const results = await createSaga([
      { execute: async () => 42, compensate: async () => {} },
    ])
    expect(results).toEqual([42])
  })

  it('handles single step saga — failure', async () => {
    const compensated: boolean[] = []

    await expect(
      createSaga([
        {
          execute: async () => { throw new Error('only-step') },
          compensate: async () => { compensated.push(true) },
        },
      ]),
    ).rejects.toThrow('only-step')

    expect(compensated).toEqual([])
  })
})
