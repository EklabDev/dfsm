export interface VizNode {
  id: string
  label: string
  type: 'initial' | 'state' | 'terminal'
  meta: {
    ttlMs?: number
    entryActions?: string[]
    exitActions?: string[]
  }
}

export interface VizEdge {
  from: string
  to: string
  event: string
  guard?: string
  actions: string[]
}

export interface VizGraph {
  nodes: VizNode[]
  edges: VizEdge[]
}

export interface TransitionTableEntry {
  nextState: string
  guardName?: string
  actionNames: string[]
}

export type TransitionTable = Map<string, Map<string, TransitionTableEntry>>
