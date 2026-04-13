export interface HistoryEntry<TContext> {
  transitionedAt: Date
  fromState: string
  toState: string
  event: string
  eventPayload: unknown
  contextSnapshot: TContext
  actionsDispatched: string[]
}

export interface ActionInput<TContext> {
  workflowId: string
  context: TContext
  history: Readonly<HistoryEntry<TContext>[]>
  event: { type: string; payload: unknown }
}

export type ActionHandler<
  TContext,
  TIn,
  TOut extends Partial<TContext>,
> = (input: ActionInput<TContext> & TIn) => Promise<TOut>

export type GuardHandler<TContext, TIn> = (
  input: ActionInput<TContext> & TIn,
) => boolean | Promise<boolean>
