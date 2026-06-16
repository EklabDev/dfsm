import type { MachineConfig } from '../types/machine.js'
import { getTerminalStates, resolveTransition } from './createMachine.js'

export interface LintError {
  code: string
  message: string
}

export interface LintWarning {
  code: string
  message: string
}

export interface LintResult {
  errors: LintError[]
  warnings: LintWarning[]
}

export function lint(config: MachineConfig): LintResult {
  const errors: LintError[] = []
  const warnings: LintWarning[] = []
  const stateNames = new Set(Object.keys(config.states))
  const terminal = getTerminalStates(config)

  if (!stateNames.has(config.initial)) {
    errors.push({
      code: 'INVALID_INITIAL',
      message: `Initial state '${config.initial}' not in states`,
    })
  }

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    for (const [event, tx] of Object.entries(stateConfig.on ?? {})) {
      const target = resolveTransition(tx).target
      if (!stateNames.has(target)) {
        errors.push({
          code: 'INVALID_TARGET',
          message: `State '${stateName}' event '${event}' target '${target}' not in states`,
        })
      }
    }

    for (const [ttl, target] of Object.entries(stateConfig.after ?? {})) {
      if (!stateNames.has(target)) {
        errors.push({
          code: 'INVALID_AFTER_TARGET',
          message: `State '${stateName}' after ${ttl}ms target '${target}' not in states`,
        })
      }
    }

    const isFinal = stateConfig.type === 'final'
    if (
      !isFinal &&
      !terminal.includes(stateName) &&
      !stateConfig.on &&
      !stateConfig.after
    ) {
      warnings.push({
        code: 'DEAD_STATE',
        message: `State '${stateName}' has no outgoing transitions and is not final`,
      })
    }
  }

  return { errors, warnings }
}
