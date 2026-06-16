import type { MachineConfig, TopicBindings } from '../types/machine.js'
import type { MachineDefinitionRecord } from '../types/store.js'
import type { TransitionTable } from '../types/engine.js'
import { deserializeTransitionTable } from '../machine/buildTransitionTable.js'

export interface RegisteredMachine {
  config: MachineConfig
  definition: MachineDefinitionRecord
  transitionTable: TransitionTable
  topicBindings: TopicBindings
}

export class MachineRegistry {
  private machines = new Map<string, RegisteredMachine>()
  private versionIndex = new Map<string, RegisteredMachine>()

  register(definition: MachineDefinitionRecord, config: MachineConfig): void {
    const transitionTable = deserializeTransitionTable(definition.transitionTable)
    const entry: RegisteredMachine = {
      config,
      definition,
      transitionTable,
      topicBindings: definition.topicBindings,
    }
    this.machines.set(definition.machineId, entry)
    this.versionIndex.set(
      `${definition.machineId}:${definition.version}`,
      entry,
    )
  }

  get(machineId: string): RegisteredMachine | undefined {
    return this.machines.get(machineId)
  }

  getAll(): RegisteredMachine[] {
    return [...this.machines.values()]
  }

  getVersion(machineId: string, version: number): RegisteredMachine | undefined {
    return this.versionIndex.get(`${machineId}:${version}`)
  }

  getAllBindings(): TopicBindings[] {
    const seen = new Set<string>()
    const bindings: TopicBindings[] = []
    for (const entry of this.versionIndex.values()) {
      const key = entry.definition.id
      if (!seen.has(key)) {
        seen.add(key)
        bindings.push(entry.topicBindings)
      }
    }
    return bindings
  }

  getActiveAndDrainingBindings(
    store: { getActiveWorkflowInstances: (id: string) => Promise<{ machineVersion: number }[]> },
  ): Promise<TopicBindings[]> {
    return this.collectDrainingBindings(store)
  }

  private async collectDrainingBindings(
    store: { getActiveWorkflowInstances: (id: string) => Promise<{ machineVersion: number }[]> },
  ): Promise<TopicBindings[]> {
    const bindings: TopicBindings[] = []
    const seen = new Set<string>()

    for (const entry of this.versionIndex.values()) {
      const key = entry.definition.id
      if (seen.has(key)) continue
      seen.add(key)

      if (entry.definition.status === 'active') {
        bindings.push(entry.topicBindings)
        continue
      }

      const active = await store.getActiveWorkflowInstances(entry.definition.machineId)
      const hasPinned = active.some(
        (w) => w.machineVersion === entry.definition.version,
      )
      if (hasPinned) {
        bindings.push(entry.topicBindings)
      }
    }

    return bindings
  }
}
