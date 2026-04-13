import { z } from 'zod'

export interface ActionSlot<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string
  input: TInput
  output: TOutput
}

export interface GuardSlot<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  input: TInput
}

export interface TransitionConfig {
  target: string
  guard?: GuardSlot<any>
  actions?: ActionSlot<any, any>[]
}

export interface StateConfig {
  on?: Record<string, TransitionConfig>
  after?: Record<number, string>
  entry?: ActionSlot<any, any>[]
  exit?: ActionSlot<any, any>[]
}

export interface MachineConfig<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string
  initial: string
  terminal: string[]
  context: TContext
  states: Record<string, StateConfig>
}
