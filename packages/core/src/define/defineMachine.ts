import type { MachineConfig } from '../types/machine.js'

const registry = new Map<string, MachineConfig>()

export function defineMachine<TContext extends Record<string, unknown>>(
  config: MachineConfig<TContext>,
): MachineConfig<TContext> {
  const stateNames = new Set(Object.keys(config.states))

  if (!stateNames.has(config.initial)) {
    throw new Error(
      `Initial state '${config.initial}' is not defined in states [${[...stateNames].join(', ')}]`,
    )
  }

  for (const t of config.terminal) {
    if (!stateNames.has(t)) {
      throw new Error(
        `Terminal state '${t}' is not defined in states [${[...stateNames].join(', ')}]`,
      )
    }
  }

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    for (const [event, tx] of Object.entries(stateConfig.on ?? {})) {
      if (!stateNames.has(tx.target)) {
        throw new Error(
          `State '${stateName}' event '${event}' has target '${tx.target}' which is not defined in states`,
        )
      }
    }
    for (const [ttl, target] of Object.entries(stateConfig.after ?? {})) {
      if (!stateNames.has(target as string)) {
        throw new Error(
          `State '${stateName}' after ${ttl}ms has target '${target}' which is not defined in states`,
        )
      }
    }
  }

  registry.set(config.id, config as MachineConfig)
  return config
}

export function getMachineRegistry(): Map<string, MachineConfig> {
  return registry
}

export function clearMachineRegistry(): void {
  registry.clear()
}
