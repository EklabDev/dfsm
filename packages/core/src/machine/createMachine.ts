import type {
  MachineConfig,
  ResolvedMachine,
  StateNodeConfig,
  TransitionConfig,
  TransitionDef,
} from '../types/machine.js'

export function createMachine<
  TContext extends Record<string, unknown>,
  TEvents = unknown,
>(config: MachineConfig<TContext, TEvents>): MachineConfig<TContext, TEvents> {
  validateMachine(config)
  return config
}

export function resolveMachine(config: MachineConfig): ResolvedMachine {
  const terminalStates = Object.entries(config.states)
    .filter(([, s]) => s.type === 'final')
    .map(([name]) => name)

  return { ...config, terminalStates }
}

export function validateMachine(config: MachineConfig): void {
  const stateNames = new Set(Object.keys(config.states))

  if (!stateNames.has(config.initial)) {
    throw new Error(
      `Initial state '${config.initial}' is not defined in states [${[...stateNames].join(', ')}]`,
    )
  }

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    for (const [event, tx] of Object.entries(stateConfig.on ?? {})) {
      const target = resolveTarget(tx)
      if (!stateNames.has(target)) {
        throw new Error(
          `State '${stateName}' event '${event}' has target '${target}' which is not defined`,
        )
      }
    }
    for (const [ttl, target] of Object.entries(stateConfig.after ?? {})) {
      if (!stateNames.has(target)) {
        throw new Error(
          `State '${stateName}' after ${ttl}ms has target '${target}' which is not defined`,
        )
      }
    }
  }
}

export function resolveTarget(tx: TransitionDef): string {
  return typeof tx === 'string' ? tx : tx.target
}

export function resolveTransition(tx: TransitionDef): TransitionConfig {
  if (typeof tx === 'string') {
    return { target: tx, actions: [] }
  }
  return {
    target: tx.target,
    ...(tx.guard !== undefined ? { guard: tx.guard } : {}),
    actions: tx.actions ?? [],
    ...(tx.meta !== undefined ? { meta: tx.meta } : {}),
  }
}

export function getTerminalStates(config: MachineConfig): string[] {
  return Object.entries(config.states)
    .filter(([, s]) => s.type === 'final')
    .map(([name]) => name)
}

export function isTerminalState(
  config: MachineConfig,
  stateName: string,
): boolean {
  return config.states[stateName]?.type === 'final'
}

export function collectSlotSchemas(config: MachineConfig): {
  guards: Record<string, unknown>
  actions: Record<string, { input: unknown; output: unknown }>
} {
  const guards: Record<string, unknown> = {}
  const actions: Record<string, { input: unknown; output: unknown }> = {}

  const collectFromMeta = (meta?: StateNodeConfig['meta']) => {
    if (!meta?.dfsm) return
    for (const [name, schema] of Object.entries(meta.dfsm.guard ?? {})) {
      guards[name] = schema.input
    }
    for (const [name, schema] of Object.entries(meta.dfsm.actions ?? {})) {
      actions[name] = { input: schema.input, output: schema.output }
    }
  }

  for (const stateConfig of Object.values(config.states)) {
    collectFromMeta(stateConfig.meta)
    for (const tx of Object.values(stateConfig.on ?? {})) {
      const resolved = resolveTransition(tx)
      collectFromMeta(resolved.meta)
      if (resolved.guard && stateConfig.meta?.dfsm?.guard?.[resolved.guard]) {
        guards[resolved.guard] =
          stateConfig.meta.dfsm.guard[resolved.guard].input
      }
      for (const actionName of resolved.actions ?? []) {
        const actionSchema =
          resolved.meta?.dfsm?.actions?.[actionName] ??
          stateConfig.meta?.dfsm?.actions?.[actionName]
        if (actionSchema) {
          actions[actionName] = {
            input: actionSchema.input,
            output: actionSchema.output,
          }
        }
      }
    }
  }

  return { guards, actions }
}
