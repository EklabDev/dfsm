import type { MachineConfig, TopicBindings } from '../types/machine.js'
import { resolveTransition } from './createMachine.js'

export function buildTopicBindings(
  config: MachineConfig,
  version: number,
): TopicBindings {
  const prefix = `dfsm.${config.id}.v${version}`
  const states: TopicBindings['states'] = {}

  for (const [stateName, stateConfig] of Object.entries(config.states)) {
    const events = Object.keys(stateConfig.on ?? {})
    states[stateName] = {
      subscribe: `${prefix}.${stateName}.in`,
      publish: `${prefix}.${stateName}.out`,
      events,
    }
  }

  return { prefix, states }
}

export function collectAllTopics(bindings: TopicBindings): string[] {
  const topics = new Set<string>()
  for (const state of Object.values(bindings.states)) {
    topics.add(state.subscribe)
    topics.add(state.publish)
  }
  topics.add(`${bindings.prefix}.__actions`)
  return [...topics]
}

export function diffTopicBindings(
  existing: TopicBindings | null,
  next: TopicBindings,
): { added: string[]; unchanged: string[] } {
  const existingTopics = new Set(
    existing ? collectAllTopics(existing) : [],
  )
  const nextTopics = collectAllTopics(next)
  const added: string[] = []
  const unchanged: string[] = []

  for (const topic of nextTopics) {
    if (existingTopics.has(topic)) {
      unchanged.push(topic)
    } else {
      added.push(topic)
    }
  }

  return { added, unchanged }
}

export function getInboundTopic(
  bindings: TopicBindings,
  state: string,
): string {
  return bindings.states[state]!.subscribe
}

export function getOutboundTopic(
  bindings: TopicBindings,
  state: string,
): string {
  return bindings.states[state]!.publish
}

export function getEventsForState(
  config: MachineConfig,
  state: string,
): string[] {
  return Object.keys(config.states[state]?.on ?? {})
}
