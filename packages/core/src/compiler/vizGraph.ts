import type { MachineConfig } from '../types/machine.js'
import type { VizGraph, VizNode, VizEdge } from '../types/engine.js'

export function buildVizGraph(config: MachineConfig): VizGraph {
  const nodes: VizNode[] = []
  const edges: VizEdge[] = []

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    let type: VizNode['type'] = 'state'
    if (stateName === config.initial) type = 'initial'
    if (config.terminal.includes(stateName)) type = 'terminal'

    const afterEntries = Object.entries(stateConfig.after ?? {})
    const ttlMs = afterEntries.length > 0 ? Number(afterEntries[0][0]) : undefined

    nodes.push({
      id: stateName,
      label: stateName,
      type,
      meta: {
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(stateConfig.entry !== undefined
          ? { entryActions: stateConfig.entry.map((a) => a.name) }
          : {}),
        ...(stateConfig.exit !== undefined
          ? { exitActions: stateConfig.exit.map((a) => a.name) }
          : {}),
      },
    })

    for (const [event, tx] of Object.entries(stateConfig.on ?? {})) {
      edges.push({
        from: stateName,
        to: tx.target,
        event,
        ...(tx.guard?.name !== undefined ? { guard: tx.guard.name } : {}),
        actions: tx.actions?.map((a) => a.name) ?? [],
      })
    }

    for (const [ttl, target] of Object.entries(stateConfig.after ?? {})) {
      edges.push({
        from: stateName,
        to: target as string,
        event: `__AFTER_${ttl}`,
        actions: [],
      })
    }
  }

  return { nodes, edges }
}
