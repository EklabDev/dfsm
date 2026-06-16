import type { MachineConfig } from '../types/machine.js'
import type { TransitionTable, TransitionTableEntry } from '../types/engine.js'
import { resolveTransition } from './createMachine.js'

export function buildTransitionTable(config: MachineConfig): TransitionTable {
  const transitionTable: TransitionTable = new Map()

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    const eventMap = new Map<string, TransitionTableEntry>()

    for (const [event, tx] of Object.entries(stateConfig.on ?? {})) {
      const resolved = resolveTransition(tx)
      eventMap.set(event, {
        nextState: resolved.target,
        ...(resolved.guard !== undefined
          ? { guardName: resolved.guard }
          : {}),
        actionNames: resolved.actions ?? [],
      })
    }

    for (const [ttlMs, target] of Object.entries(stateConfig.after ?? {})) {
      eventMap.set(`__AFTER_${ttlMs}`, {
        nextState: target,
        actionNames: [],
      })
    }

    transitionTable.set(stateName, eventMap)
  }

  return transitionTable
}

export function serializeTransitionTable(
  table: TransitionTable,
): Record<string, Record<string, TransitionTableEntry>> {
  const result: Record<string, Record<string, TransitionTableEntry>> = {}
  for (const [state, events] of table) {
    result[state] = Object.fromEntries(events)
  }
  return result
}

export function deserializeTransitionTable(
  serialized: Record<string, Record<string, TransitionTableEntry>>,
): TransitionTable {
  const table: TransitionTable = new Map()
  for (const [state, events] of Object.entries(serialized)) {
    table.set(state, new Map(Object.entries(events)))
  }
  return table
}
