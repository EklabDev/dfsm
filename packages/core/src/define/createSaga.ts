export interface SagaStep<T> {
  execute: () => Promise<T>
  compensate: () => Promise<void>
}

export async function createSaga<T>(steps: SagaStep<T>[]): Promise<T[]> {
  const results: T[] = []
  const executed: number[] = []

  for (let i = 0; i < steps.length; i++) {
    try {
      results.push(await steps[i].execute())
      executed.push(i)
    } catch (err) {
      for (const j of [...executed].reverse()) {
        await steps[j].compensate()
      }
      throw err
    }
  }

  return results
}
