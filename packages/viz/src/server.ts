import type { IWorkflowStore } from '@eklabdev/dfsm'

export interface VizServerOptions {
  store: IWorkflowStore
  port?: number
}

export async function startServer(
  portOrOptions: number | VizServerOptions = 4242,
  legacyStore?: IWorkflowStore,
): Promise<void> {
  const options: VizServerOptions =
    typeof portOrOptions === 'number'
      ? { port: portOrOptions, store: legacyStore! }
      : portOrOptions

  const { startVizServer } = await import('@eklabdev/dfsm')
  await startVizServer({
    store: options.store,
    port: options.port ?? 4242,
  })
}
