import type { z } from 'zod'

export interface DfsmMeta {
  guard?: Record<string, { input: z.ZodTypeAny }>
  actions?: Record<string, { input: z.ZodTypeAny; output: z.ZodTypeAny }>
}

export interface TransitionConfig {
  target: string
  guard?: string
  actions?: string[]
  meta?: { dfsm?: DfsmMeta }
}

export type TransitionDef = string | TransitionConfig

export interface StateNodeConfig {
  type?: 'final'
  on?: Record<string, TransitionDef>
  after?: Record<number, string>
  entry?: string[]
  exit?: string[]
  meta?: { dfsm?: DfsmMeta }
}

export interface MachineTypes<TContext = unknown, TEvents = unknown> {
  context?: TContext
  events?: TEvents
}

export interface MachineConfig<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  _TEvents = unknown,
> {
  id: string
  initial: string
  context: TContext
  types?: MachineTypes<TContext, _TEvents>
  states: Record<string, StateNodeConfig>
}

/** Serialisable machine config stored in DB (no functions). */
export type MachineConfigJson = Omit<MachineConfig, 'types'> & {
  types?: undefined
}

export interface TopicBindings {
  prefix: string
  states: Record<
    string,
    {
      subscribe: string
      publish: string
      events: string[]
    }
  >
}

export interface ResolvedMachine extends MachineConfig {
  terminalStates: string[]
}
