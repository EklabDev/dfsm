import type { MachineConfig } from '../types/machine.js'

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

  if (!stateNames.has(config.initial)) {
    errors.push({
      code: 'INVALID_INITIAL',
      message: `Initial state '${config.initial}' not in states`,
    })
  }

  for (const t of config.terminal) {
    if (!stateNames.has(t)) {
      errors.push({
        code: 'INVALID_TERMINAL',
        message: `Terminal state '${t}' not in states`,
      })
    }
  }

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    for (const [event, tx] of Object.entries(stateConfig.on ?? {})) {
      if (!stateNames.has(tx.target)) {
        errors.push({
          code: 'INVALID_TARGET',
          message: `State '${stateName}' event '${event}' target '${tx.target}' not in states`,
        })
      }
    }

    for (const [ttl, target] of Object.entries(stateConfig.after ?? {})) {
      if (!stateNames.has(target as string)) {
        errors.push({
          code: 'INVALID_AFTER_TARGET',
          message: `State '${stateName}' after ${ttl}ms target '${target}' not in states`,
        })
      }
    }

    if (
      !config.terminal.includes(stateName) &&
      !stateConfig.on &&
      !stateConfig.after
    ) {
      warnings.push({
        code: 'DEAD_STATE',
        message: `State '${stateName}' has no outgoing transitions and is not terminal`,
      })
    }
  }

  return { errors, warnings }
}
