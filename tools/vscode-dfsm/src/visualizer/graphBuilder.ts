import { resolveStateTarget } from '../core/resolver';
import type {
  DfsmDocumentAnalysis,
  ParsedMachine,
  ParsedStateNode,
  ParsedTransition
} from '../core/types';
import { analyzeDfsmDocument } from '../core/validator';
import type {
  InspectorTransitionDetail,
  TransitionBadge,
  VisualizerEdge,
  VisualizerGraph,
  VisualizerNode,
  VisualizerNodeKind
} from './types';

function computeTransitionBadges(t: ParsedTransition): TransitionBadge[] {
  const badges: TransitionBadge[] = [];

  if (
    t.effectivePolicy.retry.maxAttempts > 1 ||
    t.policy.retry?.maxAttempts !== undefined
  ) {
    badges.push({
      kind: 'retry',
      label: `retry: ${t.effectivePolicy.retry.maxAttempts}`
    });
  }

  if (t.effectivePolicy.circuitBreaker.enabled) {
    badges.push({
      kind: 'circuitBreaker',
      label: 'CB'
    });
  }

  if (t.compensate) {
    badges.push({
      kind: 'compensate',
      label: `compensate: ${t.compensate}`
    });
  }

  if (t.effects.length > 0) {
    badges.push({
      kind: 'effects',
      label: t.effects.length === 1 ? `effects: ${t.effects[0]}` : `effects (${t.effects.length})`
    });
  }

  return badges;
}

function buildNodeRecursive(
  machine: ParsedMachine,
  state: ParsedStateNode,
  isInitial: boolean,
  allNodes: VisualizerNode[],
  edges: VisualizerEdge[]
): VisualizerNode {
  const isErrorState = state.isImplicitError || state.isCustomError;
  const kind: VisualizerNodeKind = isErrorState ? 'error' : state.inferredType;
  const errorMode: 'default' | 'custom' | undefined = state.isImplicitError
    ? 'default'
    : state.isCustomError
      ? 'custom'
      : undefined;

  const label = state.isImplicitError
    ? 'error (default)'
    : state.isCustomError
      ? 'error (custom)'
      : state.name;

  const initialChildId =
    state.inferredType === 'compound' &&
    state.initial &&
    Object.prototype.hasOwnProperty.call(state.states, state.initial)
      ? `${state.path}.${state.initial}`
      : undefined;

  const children: VisualizerNode[] = [];
  for (const [childKey, childState] of Object.entries(state.states)) {
    const childIsInitial = state.inferredType === 'compound' && state.initial === childKey;
    children.push(buildNodeRecursive(machine, childState, childIsInitial, allNodes, edges));
  }

  const transitions: InspectorTransitionDetail[] = [];
  const rawTransitions: ParsedTransition[] = [...Object.values(state.on)];
  if (state.onDone) {
    rawTransitions.push(state.onDone);
  }

  const emittedFailTargets = new Set<string>();

  for (const t of rawTransitions) {
    const badges = computeTransitionBadges(t);
    let resolvedTarget: string | undefined;
    if (t.target) {
      const targetRes = resolveStateTarget(machine, state.path, t.target);
      if (targetRes.resolved && targetRes.targetPath) {
        resolvedTarget = targetRes.targetPath;
      }
    }

    transitions.push({
      id: t.id,
      event: t.event,
      isOnDone: t.isOnDone,
      target: t.target,
      resolvedTarget,
      handler: t.transition,
      compensate: t.compensate,
      effects: t.effects,
      badges,
      effectivePolicy: t.effectivePolicy,
      policySources: t.policySources,
      range: state.isImplicitError ? null : t.keyRange
    });

    if (resolvedTarget) {
      const edgeKind = t.isOnDone ? 'onDone' : 'event';
      const labelText = t.isOnDone
        ? t.transition
          ? `onDone · ${t.transition}`
          : 'onDone'
        : t.transition
          ? `${t.event} · ${t.transition}`
          : t.event;

      edges.push({
        id: t.id,
        source: state.path,
        target: resolvedTarget,
        edgeKind,
        event: t.event,
        handler: t.transition,
        label: labelText,
        dashed: false,
        badges,
        effectivePolicy: t.effectivePolicy,
        policySources: t.policySources,
        range: t.keyRange
      });
    }

    // Emit dashed `onFail` fallback edge when explicitly configured on the transition,
    // or when machine `defaults.onFail` / resilience / compensation is active on a handler transition.
    const hasExplicitTransitionFail = t.policy.onFail !== undefined;
    const hasMachineDefaultFail = machine.defaults.onFail !== undefined;
    const hasResilienceOrSaga =
      Boolean(t.compensate) ||
      t.effectivePolicy.retry.maxAttempts > 1 ||
      t.effectivePolicy.circuitBreaker.enabled ||
      machine.errorStateMode === 'custom';

    const shouldShowFailEdge =
      hasExplicitTransitionFail ||
      (Boolean(t.transition) && (hasMachineDefaultFail || hasResilienceOrSaga));

    if (shouldShowFailEdge) {
      const failTargetRef = t.effectivePolicy.onFail.target;
      const failRes = resolveStateTarget(machine, state.path, failTargetRef);
      if (failRes.resolved && failRes.targetPath) {
        const dedupeFailKey = hasExplicitTransitionFail
          ? `${t.id}::onFail::${failRes.targetPath}`
          : `${state.path}::defaultOnFail::${failRes.targetPath}::${t.effectivePolicy.onFail.compensate}`;

        if (!emittedFailTargets.has(dedupeFailKey)) {
          emittedFailTargets.add(dedupeFailKey);
          const failBadges: TransitionBadge[] = [];
          if (t.effectivePolicy.onFail.compensate) {
            failBadges.push({
              kind: 'compensate',
              label: t.compensate ? `compensate: ${t.compensate}` : 'compensate: LIFO'
            });
          }

          const failLabel = hasExplicitTransitionFail
            ? `onFail (${t.event})`
            : 'onFail';

          edges.push({
            id: `${t.id}::onFail`,
            source: state.path,
            target: failRes.targetPath,
            edgeKind: 'onFail',
            event: `${t.event}:onFail`,
            label: failLabel,
            dashed: true,
            badges: failBadges,
            effectivePolicy: t.effectivePolicy,
            policySources: t.policySources,
            range: t.onFailTargetRange ?? t.keyRange
          });
        }
      }
    }
  }

  const vNode: VisualizerNode = {
    id: state.path,
    name: state.name,
    label,
    kind,
    stateType: state.inferredType,
    errorMode,
    parentId: state.parentPath,
    isInitial,
    initialChildId,
    description: state.description,
    entry: state.entry,
    exit: state.exit,
    children,
    transitions,
    range: state.isImplicitError ? null : state.keyRange,
    blockRange: state.isImplicitError ? null : state.blockRange
  };

  allNodes.push(vNode);
  return vNode;
}

/**
 * Builds the hierarchical DFSM statechart graph model (`VisualizerGraph`) from either
 * a `DfsmDocumentAnalysis` result or a raw YAML string.
 */
export function buildVisualizerGraph(input: DfsmDocumentAnalysis | string): VisualizerGraph {
  const analysis = typeof input === 'string' ? analyzeDfsmDocument(input) : input;
  const machine = analysis.machine;

  if (!machine) {
    return {
      machineId: 'invalid-machine',
      version: '1.0.0',
      rootType: 'compound',
      errorStateMode: 'implicit',
      explicitStateCount: 0,
      hooks: {
        onStart: [],
        beforeTransition: [],
        afterTransition: [],
        onCompensate: [],
        onComplete: [],
        onTerminal: []
      },
      effects: [],
      rootNodes: [],
      allNodes: [],
      edges: [],
      diagnostics: analysis.diagnostics
    };
  }

  const allNodes: VisualizerNode[] = [];
  const edges: VisualizerEdge[] = [];
  const rootNodes: VisualizerNode[] = [];

  const rootInitialId =
    machine.rootType === 'compound' &&
    machine.initial &&
    Object.prototype.hasOwnProperty.call(machine.states, machine.initial)
      ? machine.initial
      : undefined;

  for (const [key, rootState] of Object.entries(machine.states)) {
    const isInitial = machine.rootType === 'compound' && machine.initial === key;
    rootNodes.push(buildNodeRecursive(machine, rootState, isInitial, allNodes, edges));
  }

  // Always include the implicit `error (default)` node when `states.error` is not overridden in YAML
  if (machine.errorStateMode === 'implicit' && machine.implicitErrorNode) {
    rootNodes.push(
      buildNodeRecursive(machine, machine.implicitErrorNode, false, allNodes, edges)
    );
  }

  return {
    machineId: machine.id ?? 'unnamed-machine',
    version: machine.version,
    description: machine.description,
    rootType: machine.rootType,
    rootInitialId,
    namespace: machine.registry?.namespace,
    errorStateMode: machine.errorStateMode,
    explicitStateCount: machine.explicitStateCount,
    hooks: machine.hooks,
    effects: machine.effects,
    maxEffectChainDepth: machine.maxEffectChainDepth,
    rootNodes,
    allNodes,
    edges,
    diagnostics: analysis.diagnostics
  };
}
