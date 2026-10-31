import type {
  DfsmDiagnostic,
  ErrorStateMode,
  NormalizedTransitionPolicy,
  ParsedMachineHooks,
  PolicyFieldSources,
  SourceRange,
  StateNodeType
} from '../core/types';

export type VisualizerNodeKind = 'atomic' | 'compound' | 'parallel' | 'final' | 'error';

export type BadgeKind = 'retry' | 'circuitBreaker' | 'compensate' | 'effects';

export interface TransitionBadge {
  kind: BadgeKind;
  label: string;
}

export interface InspectorTransitionDetail {
  id: string;
  event: string;
  isOnDone: boolean;
  target?: string;
  resolvedTarget?: string;
  handler?: string;
  compensate?: string;
  effects: string[];
  badges: TransitionBadge[];
  effectivePolicy: NormalizedTransitionPolicy;
  policySources: PolicyFieldSources;
  range: SourceRange | null;
}

export interface VisualizerNode {
  id: string;
  name: string;
  label: string;
  kind: VisualizerNodeKind;
  stateType: StateNodeType;
  errorMode?: 'default' | 'custom';
  parentId: string | null;
  isInitial: boolean;
  initialChildId?: string;
  description?: string;
  entry: string[];
  exit: string[];
  children: VisualizerNode[];
  transitions: InspectorTransitionDetail[];
  range: SourceRange | null;
  blockRange: SourceRange | null;
}

export type VisualizerEdgeKind = 'event' | 'onDone' | 'onFail';

export interface VisualizerEdge {
  id: string;
  source: string;
  target: string;
  edgeKind: VisualizerEdgeKind;
  event: string;
  handler?: string;
  label: string;
  dashed: boolean;
  badges: TransitionBadge[];
  effectivePolicy: NormalizedTransitionPolicy;
  policySources: PolicyFieldSources;
  range: SourceRange | null;
}

export interface VisualizerGraph {
  machineId: string;
  version: string;
  description?: string;
  rootType: 'compound' | 'parallel';
  rootInitialId?: string;
  namespace?: string;
  errorStateMode: ErrorStateMode;
  explicitStateCount: number;
  hooks: ParsedMachineHooks;
  effects: string[];
  maxEffectChainDepth?: number;
  rootNodes: VisualizerNode[];
  allNodes: VisualizerNode[];
  edges: VisualizerEdge[];
  diagnostics: DfsmDiagnostic[];
}

export interface NodeBoxLayout {
  node: VisualizerNode;
  x: number;
  y: number;
  width: number;
  height: number;
  headerHeight: number;
  depth: number;
}

export interface ParallelDividerLayout {
  parallelNodeId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface InitialMarkerLayout {
  ownerId: string;
  targetNodeId: string;
  dotX: number;
  dotY: number;
  pathD: string;
}

export interface EdgeLayout {
  edge: VisualizerEdge;
  pathD: string;
  labelX: number;
  labelY: number;
}

export interface LayoutGraph {
  graph: VisualizerGraph;
  width: number;
  height: number;
  nodes: NodeBoxLayout[];
  parallelDividers: ParallelDividerLayout[];
  initialMarkers: InitialMarkerLayout[];
  edges: EdgeLayout[];
}
