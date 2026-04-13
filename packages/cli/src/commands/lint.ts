import { lint as coreLint } from '@eklabdev/dfsm'
import type { MachineConfig } from '@eklabdev/dfsm'
import chalk from 'chalk'

export async function lintCommand(machines: MachineConfig[], machineId?: string): Promise<boolean> {
  const targets = machineId
    ? machines.filter((m) => m.id === machineId)
    : machines

  if (targets.length === 0) {
    console.error(chalk.red(`Machine '${machineId}' not found`))
    return false
  }

  let hasErrors = false

  for (const machine of targets) {
    const result = coreLint(machine)

    for (const err of result.errors) {
      console.error(chalk.red(`[${err.code}] ${machine.id}: ${err.message}`))
      hasErrors = true
    }

    for (const warn of result.warnings) {
      console.warn(chalk.yellow(`[${warn.code}] ${machine.id}: ${warn.message}`))
    }

    if (result.errors.length === 0 && result.warnings.length === 0) {
      console.log(chalk.green(`✓ ${machine.id}: no issues`))
    }
  }

  return !hasErrors
}
