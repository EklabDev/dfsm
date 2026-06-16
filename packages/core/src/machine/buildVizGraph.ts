import type { MachineConfig } from '../types/machine.js'
import type { VizGraph, VizNode, VizEdge } from '../types/engine.js'
import { getTerminalStates, resolveTransition } from './createMachine.js'

export function buildVizGraph(config: MachineConfig): VizGraph {
  const nodes: VizNode[] = []
  const edges: VizEdge[] = []
  const terminal = getTerminalStates(config)

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    let type: VizNode['type'] = 'state'
    if (stateName === config.initial) type = 'initial'
    if (stateConfig.type === 'final' || terminal.includes(stateName)) {
      type = 'terminal'
    }

    const afterEntries = Object.entries(stateConfig.after ?? {})
    const ttlMs =
      afterEntries.length > 0 ? Number(afterEntries[0]![0]) : undefined

    nodes.push({
      id: stateName,
      label: stateName,
      type,
      meta: {
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(stateConfig.entry !== undefined
          ? { entryActions: stateConfig.entry }
          : {}),
        ...(stateConfig.exit !== undefined
          ? { exitActions: stateConfig.exit }
          : {}),
      },
    })

    for (const [event, tx] of Object.entries(stateConfig.on ?? {})) {
      const resolved = resolveTransition(tx)
      edges.push({
        from: stateName,
        to: resolved.target,
        event,
        ...(resolved.guard !== undefined ? { guard: resolved.guard } : {}),
        actions: resolved.actions ?? [],
      })
    }

    for (const [ttl, target] of Object.entries(stateConfig.after ?? {})) {
      edges.push({
        from: stateName,
        to: target,
        event: `__AFTER_${ttl}`,
        actions: [],
      })
    }
  }

  return { nodes, edges }
}
