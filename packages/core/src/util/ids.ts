import { createHash } from 'node:crypto'
import type { MachineConfig, MachineConfigJson } from '../types/machine.js'

export function canonicalizeConfig(config: MachineConfig): MachineConfigJson {
  const { types: _types, ...rest } = config
  return JSON.parse(JSON.stringify(rest)) as MachineConfigJson
}

export function computeChecksum(config: MachineConfigJson): string {
  const canonical = JSON.stringify(config)
  return createHash('sha256').update(canonical).digest('hex')
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(): string {
  return crypto.randomUUID()
}
