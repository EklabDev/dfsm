import type { MachineConfig, ActionSlot, GuardSlot, StateConfig } from '../types/machine.js'
import type {
  CompiledMachine,
  TransitionTable,
  TransitionTableEntry,
} from '../types/engine.js'
import { lint } from './lint.js'
import { buildVizGraph } from './vizGraph.js'

export function compile(
  config: MachineConfig,
  version: number,
): CompiledMachine {
  const lintResult = lint(config)
  if (lintResult.errors.length > 0) {
    throw new Error(
      `Machine '${config.id}' lint failed:\n` +
        lintResult.errors.map((e) => e.message).join('\n'),
    )
  }

  const transitionTable: TransitionTable = new Map()

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    const eventMap = new Map<string, TransitionTableEntry>()

    for (const [event, tx] of Object.entries(stateConfig.on ?? {})) {
      eventMap.set(event, {
        nextState: tx.target,
        ...(tx.guard?.name !== undefined ? { guardName: tx.guard.name } : {}),
        actionNames: tx.actions?.map((a) => a.name) ?? [],
      })
    }

    for (const [ttlMs, target] of Object.entries(stateConfig.after ?? {})) {
      eventMap.set(`__AFTER_${ttlMs}`, {
        nextState: target as string,
        actionNames: [],
      })
    }

    transitionTable.set(stateName, eventMap)
  }

  const actionSlotMap = new Map<string, ActionSlot<any, any>>()
  const guardSlotMap = new Map<string, GuardSlot<any>>()

  const collectSlots = (stateConfig: StateConfig) => {
    for (const tx of Object.values(stateConfig.on ?? {})) {
      if (tx.guard) guardSlotMap.set(tx.guard.name, tx.guard)
      for (const a of tx.actions ?? []) actionSlotMap.set(a.name, a)
    }
    for (const a of [...(stateConfig.entry ?? []), ...(stateConfig.exit ?? [])]) {
      actionSlotMap.set(a.name, a)
    }
  }

  for (const stateConfig of Object.values(config.states)) {
    collectSlots(stateConfig)
  }

  const vizGraph = buildVizGraph(config)

  return {
    machineId: config.id,
    version,
    transitionTable,
    vizGraph,
    allActionSlots: [...actionSlotMap.values()],
    allGuardSlots: [...guardSlotMap.values()],
  }
}
