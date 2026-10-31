import {
  Document,
  LineCounter,
  Node,
  Pair,
  YAMLMap,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument
} from 'yaml';
import { mergeTransitionPolicies } from './policy';
import type {
  BackoffStrategy,
  DfsmDiagnostic,
  ErrorStateMode,
  ParsedMachine,
  ParsedStateNode,
  ParsedTransition,
  PartialTransitionPolicy,
  SourceRange,
  StateNodeType
} from './types';

export interface RawParseOutput {
  yamlDoc: Document.Parsed;
  lineCounter: LineCounter;
  source: string;
  rawData: unknown;
  machine: ParsedMachine | null;
  syntaxDiagnostics: DfsmDiagnostic[];
  untypedContextRanges: Array<{ path: string; range: SourceRange }>;
}

/**
 * Converts 0-based [startOffset, endOffset] into a dual 1-based & 0-based SourceRange,
 * trimming any trailing block newlines/indentation so ranges stay tight on the token.
 */
export function rangeFromOffsets(
  source: string,
  lineCounter: LineCounter,
  rawStart: number,
  rawEnd: number
): SourceRange {
  const maxLen = source.length;
  const startOffset = Math.max(0, Math.min(rawStart, maxLen));
  let endOffset = Math.max(startOffset, Math.min(rawEnd, maxLen));

  if (endOffset > startOffset) {
    const slice = source.slice(startOffset, endOffset);
    const trailingNewlines = slice.match(/(?:\r?\n[ \t]*)+$/);
    if (trailingNewlines) {
      endOffset = Math.max(startOffset, endOffset - trailingNewlines[0].length);
    }
  }

  const startPos = lineCounter.linePos(startOffset);
  const endPos = lineCounter.linePos(endOffset);

  return {
    line: startPos.line,
    column: startPos.col,
    endLine: endPos.line,
    endColumn: endPos.col,
    startLine0: startPos.line - 1,
    startColumn0: startPos.col - 1,
    endLine0: endPos.line - 1,
    endColumn0: endPos.col - 1,
    startOffset,
    endOffset
  };
}

export function rangeFromNode(
  source: string,
  lineCounter: LineCounter,
  node: Node | null | undefined,
  fallback?: SourceRange
): SourceRange {
  if (node && node.range) {
    return rangeFromOffsets(source, lineCounter, node.range[0], node.range[1]);
  }
  return fallback ?? rangeFromOffsets(source, lineCounter, 0, Math.min(source.length, 1));
}

export function rangeFromPair(
  source: string,
  lineCounter: LineCounter,
  pair: Pair
): SourceRange {
  const keyNode = isNode(pair.key) ? pair.key : null;
  const valNode = isNode(pair.value) ? pair.value : null;
  const start = keyNode?.range?.[0] ?? valNode?.range?.[0] ?? 0;
  const end = valNode?.range?.[1] ?? keyNode?.range?.[1] ?? start;
  return rangeFromOffsets(source, lineCounter, start, end);
}

function isNode(val: unknown): val is Node {
  return Boolean(val && typeof val === 'object' && ('range' in (val as Record<string, unknown>)));
}

function findPair(map: YAMLMap, keyName: string): Pair | undefined {
  for (const item of map.items) {
    if (isPair(item) && isScalar(item.key) && String(item.key.value) === keyName) {
      return item;
    }
  }
  return undefined;
}

function readStringScalar(node: unknown): string | undefined {
  if (isScalar(node) && typeof node.value === 'string') {
    return node.value;
  }
  return undefined;
}

function readBooleanScalar(node: unknown): boolean | undefined {
  if (isScalar(node) && typeof node.value === 'boolean') {
    return node.value;
  }
  return undefined;
}

function readNumberScalar(node: unknown): number | undefined {
  if (isScalar(node) && typeof node.value === 'number' && Number.isFinite(node.value)) {
    return node.value;
  }
  return undefined;
}

function readStringArray(node: unknown): string[] {
  if (!isSeq(node)) return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (isScalar(item) && typeof item.value === 'string') {
      out.push(item.value);
    }
  }
  return out;
}

function parsePolicyFromMap(
  map: YAMLMap,
  source: string,
  lineCounter: LineCounter
): { policy: PartialTransitionPolicy; onFailTargetRange?: SourceRange } {
  const policy: PartialTransitionPolicy = {};
  let onFailTargetRange: SourceRange | undefined;

  const retryPair = findPair(map, 'retry');
  if (retryPair && isMap(retryPair.value)) {
    const retryMap = retryPair.value;
    policy.retry = {};
    const maxAttempts = readNumberScalar(findPair(retryMap, 'maxAttempts')?.value);
    if (maxAttempts !== undefined) {
      policy.retry.maxAttempts = maxAttempts;
    }
    const backoffPair = findPair(retryMap, 'backoff');
    if (backoffPair && isMap(backoffPair.value)) {
      const bMap = backoffPair.value;
      policy.retry.backoff = {};
      const strategy = readStringScalar(findPair(bMap, 'strategy')?.value);
      if (
        strategy === 'fixed' ||
        strategy === 'linear' ||
        strategy === 'exponential' ||
        strategy === 'exponential_jitter'
      ) {
        policy.retry.backoff.strategy = strategy as BackoffStrategy;
      }
      const initialDelayMs = readNumberScalar(findPair(bMap, 'initialDelayMs')?.value);
      if (initialDelayMs !== undefined) policy.retry.backoff.initialDelayMs = initialDelayMs;
      const maxDelayMs = readNumberScalar(findPair(bMap, 'maxDelayMs')?.value);
      if (maxDelayMs !== undefined) policy.retry.backoff.maxDelayMs = maxDelayMs;
      const multiplier = readNumberScalar(findPair(bMap, 'multiplier')?.value);
      if (multiplier !== undefined) policy.retry.backoff.multiplier = multiplier;
    }
  }

  const cbPair = findPair(map, 'circuitBreaker');
  if (cbPair && isMap(cbPair.value)) {
    const cbMap = cbPair.value;
    policy.circuitBreaker = {};
    const enabled = readBooleanScalar(findPair(cbMap, 'enabled')?.value);
    if (enabled !== undefined) policy.circuitBreaker.enabled = enabled;
    const key = readStringScalar(findPair(cbMap, 'key')?.value);
    if (key !== undefined) policy.circuitBreaker.key = key;
    const failureThreshold = readNumberScalar(findPair(cbMap, 'failureThreshold')?.value);
    if (failureThreshold !== undefined) policy.circuitBreaker.failureThreshold = failureThreshold;
    const slidingWindowSize = readNumberScalar(findPair(cbMap, 'slidingWindowSize')?.value);
    if (slidingWindowSize !== undefined) {
      policy.circuitBreaker.slidingWindowSize = slidingWindowSize;
    }
    const openDurationMs = readNumberScalar(findPair(cbMap, 'openDurationMs')?.value);
    if (openDurationMs !== undefined) policy.circuitBreaker.openDurationMs = openDurationMs;
    const halfOpenMaxCalls = readNumberScalar(findPair(cbMap, 'halfOpenMaxCalls')?.value);
    if (halfOpenMaxCalls !== undefined) policy.circuitBreaker.halfOpenMaxCalls = halfOpenMaxCalls;
  }

  const onFailPair = findPair(map, 'onFail');
  if (onFailPair && isMap(onFailPair.value)) {
    const ofMap = onFailPair.value;
    policy.onFail = {};
    const compensate = readBooleanScalar(findPair(ofMap, 'compensate')?.value);
    if (compensate !== undefined) policy.onFail.compensate = compensate;
    const targetPair = findPair(ofMap, 'target');
    const target = readStringScalar(targetPair?.value);
    if (target !== undefined) {
      policy.onFail.target = target;
      if (isNode(targetPair?.value)) {
        onFailTargetRange = rangeFromNode(source, lineCounter, targetPair.value);
      }
    }
  }

  const benchmarkPair = findPair(map, 'benchmark');
  if (benchmarkPair && isMap(benchmarkPair.value)) {
    const enabled = readBooleanScalar(findPair(benchmarkPair.value, 'enabled')?.value);
    if (enabled !== undefined) {
      policy.benchmark = { enabled };
    }
  }

  return { policy, onFailTargetRange };
}

function parseTransitionPair(
  pair: Pair,
  eventName: string,
  isOnDone: boolean,
  sourceStatePath: string,
  machineDefaults: PartialTransitionPolicy,
  source: string,
  lineCounter: LineCounter
): ParsedTransition {
  const keyRange = isNode(pair.key)
    ? rangeFromNode(source, lineCounter, pair.key)
    : rangeFromOffsets(source, lineCounter, 0, 0);
  const blockRange = rangeFromPair(source, lineCounter, pair);
  const transitionId = isOnDone
    ? `${sourceStatePath}::onDone`
    : `${sourceStatePath}::on::${eventName}`;

  if (isScalar(pair.value) && typeof pair.value.value === 'string') {
    const merged = mergeTransitionPolicies(machineDefaults, undefined);
    return {
      id: transitionId,
      event: eventName,
      isOnDone,
      isShorthand: true,
      sourceStatePath,
      target: pair.value.value,
      targetRange: rangeFromNode(source, lineCounter, pair.value, keyRange),
      effects: [],
      policy: {},
      effectivePolicy: merged.policy,
      policySources: merged.sources,
      keyRange,
      blockRange
    };
  }

  if (isMap(pair.value)) {
    const tMap = pair.value;
    const targetPair = findPair(tMap, 'target');
    const transitionPair = findPair(tMap, 'transition');
    const compensatePair = findPair(tMap, 'compensate');
    const effectsPair = findPair(tMap, 'effects');
    const description = readStringScalar(findPair(tMap, 'description')?.value);

    const { policy, onFailTargetRange } = parsePolicyFromMap(tMap, source, lineCounter);
    const merged = mergeTransitionPolicies(machineDefaults, policy);

    return {
      id: transitionId,
      event: eventName,
      isOnDone,
      isShorthand: false,
      sourceStatePath,
      target: readStringScalar(targetPair?.value),
      targetRange: isNode(targetPair?.value)
        ? rangeFromNode(source, lineCounter, targetPair.value, keyRange)
        : undefined,
      transition: readStringScalar(transitionPair?.value),
      transitionRange: isNode(transitionPair?.value)
        ? rangeFromNode(source, lineCounter, transitionPair.value, keyRange)
        : undefined,
      compensate: readStringScalar(compensatePair?.value),
      compensateRange: isNode(compensatePair?.value)
        ? rangeFromNode(source, lineCounter, compensatePair.value, keyRange)
        : undefined,
      effects: readStringArray(effectsPair?.value),
      effectsRange: isNode(effectsPair?.key)
        ? rangeFromNode(source, lineCounter, effectsPair.key, keyRange)
        : undefined,
      description,
      policy,
      policyRange: rangeFromNode(source, lineCounter, tMap, blockRange),
      onFailTargetRange,
      effectivePolicy: merged.policy,
      policySources: merged.sources,
      keyRange,
      blockRange
    };
  }

  const merged = mergeTransitionPolicies(machineDefaults, undefined);
  return {
    id: transitionId,
    event: eventName,
    isOnDone,
    isShorthand: false,
    sourceStatePath,
    effects: [],
    policy: {},
    effectivePolicy: merged.policy,
    policySources: merged.sources,
    keyRange,
    blockRange
  };
}

function parseStatePair(
  pair: Pair,
  name: string,
  parentPath: string | null,
  machineDefaults: PartialTransitionPolicy,
  allStatesByPath: Map<string, ParsedStateNode>,
  untypedContextRanges: Array<{ path: string; range: SourceRange }>,
  source: string,
  lineCounter: LineCounter
): ParsedStateNode {
  const path = parentPath ? `${parentPath}.${name}` : name;
  const keyRange = isNode(pair.key)
    ? rangeFromNode(source, lineCounter, pair.key)
    : rangeFromOffsets(source, lineCounter, 0, 0);
  const blockRange = rangeFromPair(source, lineCounter, pair);
  const isCustomError = parentPath === null && name === 'error';

  if (!isMap(pair.value)) {
    const emptyState: ParsedStateNode = {
      name,
      path,
      parentPath,
      inferredType: 'atomic',
      entry: [],
      exit: [],
      on: {},
      states: {},
      keyRange,
      blockRange,
      isImplicitError: false,
      isCustomError
    };
    allStatesByPath.set(path, emptyState);
    return emptyState;
  }

  const sMap = pair.value;

  const ctxPair = findPair(sMap, 'context');
  if (ctxPair && isNode(ctxPair.key)) {
    untypedContextRanges.push({
      path: `/states/${path.replace(/\./g, '/states/')}/context`,
      range: rangeFromNode(source, lineCounter, ctxPair.key)
    });
  }

  const typePair = findPair(sMap, 'type');
  const rawType = readStringScalar(typePair?.value);
  const explicitType: StateNodeType | undefined =
    rawType === 'atomic' || rawType === 'compound' || rawType === 'parallel' || rawType === 'final'
      ? rawType
      : undefined;

  const statesPair = findPair(sMap, 'states');
  const childStates: Record<string, ParsedStateNode> = {};
  if (statesPair && isMap(statesPair.value)) {
    for (const childItem of statesPair.value.items) {
      if (isPair(childItem) && isScalar(childItem.key)) {
        const childName = String(childItem.key.value);
        childStates[childName] = parseStatePair(
          childItem,
          childName,
          path,
          machineDefaults,
          allStatesByPath,
          untypedContextRanges,
          source,
          lineCounter
        );
      }
    }
  }

  const hasChildStates = Boolean(statesPair && isMap(statesPair.value) && statesPair.value.items.length > 0);
  const inferredType: StateNodeType = explicitType
    ? explicitType
    : hasChildStates
      ? 'compound'
      : 'atomic';

  const initialPair = findPair(sMap, 'initial');
  const entryPair = findPair(sMap, 'entry');
  const exitPair = findPair(sMap, 'exit');
  const onPair = findPair(sMap, 'on');
  const onDonePair = findPair(sMap, 'onDone');

  const onTransitions: Record<string, ParsedTransition> = {};
  if (onPair && isMap(onPair.value)) {
    for (const tItem of onPair.value.items) {
      if (isPair(tItem) && isScalar(tItem.key)) {
        const eventName = String(tItem.key.value);
        onTransitions[eventName] = parseTransitionPair(
          tItem,
          eventName,
          false,
          path,
          machineDefaults,
          source,
          lineCounter
        );
      }
    }
  }

  const onDoneTransition = onDonePair
    ? parseTransitionPair(
        onDonePair,
        'onDone',
        true,
        path,
        machineDefaults,
        source,
        lineCounter
      )
    : undefined;

  const node: ParsedStateNode = {
    name,
    path,
    parentPath,
    explicitType,
    typeRange: isNode(typePair?.value)
      ? rangeFromNode(source, lineCounter, typePair.value, keyRange)
      : undefined,
    inferredType,
    description: readStringScalar(findPair(sMap, 'description')?.value),
    initial: readStringScalar(initialPair?.value),
    initialKeyRange: isNode(initialPair?.key)
      ? rangeFromNode(source, lineCounter, initialPair.key, keyRange)
      : undefined,
    initialValueRange: isNode(initialPair?.value)
      ? rangeFromNode(source, lineCounter, initialPair.value, keyRange)
      : undefined,
    entry: readStringArray(entryPair?.value),
    entryRange: isNode(entryPair?.key)
      ? rangeFromNode(source, lineCounter, entryPair.key, keyRange)
      : undefined,
    exit: readStringArray(exitPair?.value),
    exitRange: isNode(exitPair?.key)
      ? rangeFromNode(source, lineCounter, exitPair.key, keyRange)
      : undefined,
    on: onTransitions,
    onKeyRange: isNode(onPair?.key)
      ? rangeFromNode(source, lineCounter, onPair.key, keyRange)
      : undefined,
    onDone: onDoneTransition,
    states: childStates,
    statesKeyRange: isNode(statesPair?.key)
      ? rangeFromNode(source, lineCounter, statesPair.key, keyRange)
      : undefined,
    keyRange,
    blockRange,
    isImplicitError: false,
    isCustomError
  };

  allStatesByPath.set(path, node);
  return node;
}

/**
 * Parses a YAML string into a full DFSM AST model with exact 1-based and 0-based
 * line/column SourceRanges for every state, transition, policy, and key.
 */
export function parseDfsmYaml(source: string): RawParseOutput {
  const lineCounter = new LineCounter();
  const yamlDoc = parseDocument(source, {
    lineCounter,
    keepSourceTokens: true,
    prettyErrors: false
  });

  const syntaxDiagnostics: DfsmDiagnostic[] = [];
  for (const err of yamlDoc.errors) {
    const start = err.pos?.[0] ?? 0;
    const end = err.pos?.[1] ?? start + 1;
    syntaxDiagnostics.push({
      code: 'dfsm/yaml-syntax',
      severity: 'error',
      message: err.message,
      range: rangeFromOffsets(source, lineCounter, start, end)
    });
  }

  let rawData: unknown = null;
  if (syntaxDiagnostics.length === 0) {
    try {
      rawData = yamlDoc.toJS();
    } catch (err) {
      syntaxDiagnostics.push({
        code: 'dfsm/yaml-syntax',
        severity: 'error',
        message: err instanceof Error ? err.message : String(err),
        range: rangeFromOffsets(source, lineCounter, 0, Math.min(source.length, 1))
      });
    }
  }

  const untypedContextRanges: Array<{ path: string; range: SourceRange }> = [];
  if (!isMap(yamlDoc.contents)) {
    return {
      yamlDoc,
      lineCounter,
      source,
      rawData,
      machine: null,
      syntaxDiagnostics,
      untypedContextRanges
    };
  }

  const rootMap = yamlDoc.contents;
  const rootRange = rangeFromNode(source, lineCounter, rootMap);

  const rootContextPair = findPair(rootMap, 'context');
  if (rootContextPair && isNode(rootContextPair.key)) {
    untypedContextRanges.push({
      path: '/context',
      range: rangeFromNode(source, lineCounter, rootContextPair.key)
    });
  }

  const dfsmPair = findPair(rootMap, 'dfsm');
  const idPair = findPair(rootMap, 'id');
  const versionPair = findPair(rootMap, 'version');
  const descPair = findPair(rootMap, 'description');
  const typePair = findPair(rootMap, 'type');
  const initialPair = findPair(rootMap, 'initial');
  const registryPair = findPair(rootMap, 'registry');
  const defaultsPair = findPair(rootMap, 'defaults');
  const hooksPair = findPair(rootMap, 'hooks');
  const effectsPair = findPair(rootMap, 'effects');
  const maxEffectChainDepthPair = findPair(rootMap, 'maxEffectChainDepth');
  const statesPair = findPair(rootMap, 'states');

  const readStringOrArray = (node: unknown): string[] => {
    const single = readStringScalar(node);
    if (single !== undefined) return [single];
    return readStringArray(node);
  };

  const hooksMap = hooksPair && isMap(hooksPair.value) ? hooksPair.value : null;
  const hooks = {
    onStart: hooksMap ? readStringOrArray(findPair(hooksMap, 'onStart')?.value) : [],
    beforeTransition: hooksMap
      ? readStringOrArray(findPair(hooksMap, 'beforeTransition')?.value)
      : [],
    afterTransition: hooksMap
      ? readStringOrArray(findPair(hooksMap, 'afterTransition')?.value)
      : [],
    onCompensate: hooksMap ? readStringOrArray(findPair(hooksMap, 'onCompensate')?.value) : [],
    onComplete: hooksMap ? readStringOrArray(findPair(hooksMap, 'onComplete')?.value) : [],
    onTerminal: hooksMap ? readStringOrArray(findPair(hooksMap, 'onTerminal')?.value) : []
  };
  const effects = readStringArray(effectsPair?.value);
  const maxEffectChainDepth = readNumberScalar(maxEffectChainDepthPair?.value);

  const rawRootType = readStringScalar(typePair?.value);
  const explicitRootType: 'compound' | 'parallel' | undefined =
    rawRootType === 'compound' || rawRootType === 'parallel' ? rawRootType : undefined;
  const rootType: 'compound' | 'parallel' = explicitRootType ?? 'compound';

  let defaults: PartialTransitionPolicy = {};
  let defaultsOnFailTargetRange: SourceRange | undefined;
  if (defaultsPair && isMap(defaultsPair.value)) {
    const parsedDefaults = parsePolicyFromMap(defaultsPair.value, source, lineCounter);
    defaults = parsedDefaults.policy;
    defaultsOnFailTargetRange = parsedDefaults.onFailTargetRange;
  }

  let registry: { namespace?: string; strict: boolean } | undefined;
  if (registryPair && isMap(registryPair.value)) {
    registry = {
      namespace: readStringScalar(findPair(registryPair.value, 'namespace')?.value),
      strict: readBooleanScalar(findPair(registryPair.value, 'strict')?.value) ?? true
    };
  }

  const allStatesByPath = new Map<string, ParsedStateNode>();
  const topStates: Record<string, ParsedStateNode> = {};

  if (statesPair && isMap(statesPair.value)) {
    for (const item of statesPair.value.items) {
      if (isPair(item) && isScalar(item.key)) {
        const stateName = String(item.key.value);
        topStates[stateName] = parseStatePair(
          item,
          stateName,
          null,
          defaults,
          allStatesByPath,
          untypedContextRanges,
          source,
          lineCounter
        );
      }
    }
  }

  const explicitStateCount = allStatesByPath.size;
  const hasExplicitError = Object.prototype.hasOwnProperty.call(topStates, 'error');
  const errorStateMode: ErrorStateMode = hasExplicitError ? 'custom' : 'implicit';

  let implicitErrorNode: ParsedStateNode | undefined;
  const statesKeyRange = isNode(statesPair?.key)
    ? rangeFromNode(source, lineCounter, statesPair.key, rootRange)
    : undefined;

  if (!hasExplicitError) {
    const fallbackRange = statesKeyRange ?? rootRange;
    implicitErrorNode = {
      name: 'error',
      path: 'error',
      parentPath: null,
      explicitType: 'final',
      inferredType: 'final',
      description: 'Implicit built-in terminal error state injected by DFSM v1.0',
      entry: [],
      exit: [],
      on: {},
      states: {},
      keyRange: fallbackRange,
      blockRange: fallbackRange,
      isImplicitError: true,
      isCustomError: false
    };
    allStatesByPath.set('error', implicitErrorNode);
  }

  const machine: ParsedMachine = {
    dfsmVersion: isScalar(dfsmPair?.value) ? String(dfsmPair.value.value) : undefined,
    id: readStringScalar(idPair?.value),
    idRange: isNode(idPair?.value)
      ? rangeFromNode(source, lineCounter, idPair.value, rootRange)
      : isNode(idPair?.key)
        ? rangeFromNode(source, lineCounter, idPair.key, rootRange)
        : undefined,
    version: readStringScalar(versionPair?.value) ?? '1.0.0',
    description: readStringScalar(descPair?.value),
    rootType,
    explicitRootType,
    rootTypeRange: isNode(typePair?.value)
      ? rangeFromNode(source, lineCounter, typePair.value, rootRange)
      : undefined,
    initial: readStringScalar(initialPair?.value),
    initialKeyRange: isNode(initialPair?.key)
      ? rangeFromNode(source, lineCounter, initialPair.key, rootRange)
      : undefined,
    initialValueRange: isNode(initialPair?.value)
      ? rangeFromNode(source, lineCounter, initialPair.value, rootRange)
      : undefined,
    registry,
    defaults,
    defaultsRange: isNode(defaultsPair?.key)
      ? rangeFromNode(source, lineCounter, defaultsPair.key, rootRange)
      : undefined,
    defaultsOnFailTargetRange,
    hooks,
    effects,
    maxEffectChainDepth,
    states: topStates,
    statesKeyRange,
    allStatesByPath,
    explicitStateCount,
    errorStateMode,
    implicitErrorNode,
    rootRange
  };

  return {
    yamlDoc,
    lineCounter,
    source,
    rawData,
    machine,
    syntaxDiagnostics,
    untypedContextRanges
  };
}

/**
 * Resolves a JSON Pointer (e.g. `/states/ready/on/CALL_PRIMARY/retry/maxAttempts`)
 * and optional property key to its exact YAML AST SourceRange.
 */
export function resolveJsonPointerRange(
  yamlDoc: Document.Parsed,
  lineCounter: LineCounter,
  source: string,
  instancePath: string,
  extraPropertyKey?: string
): SourceRange {
  const segments = instancePath
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

  let currentNode: unknown = yamlDoc.contents;
  let lastMatchedRange = rangeFromNode(
    source,
    lineCounter,
    isNode(currentNode) ? currentNode : null
  );

  for (const seg of segments) {
    if (isMap(currentNode)) {
      const pair = findPair(currentNode, seg);
      if (!pair) break;
      if (isNode(pair.key)) {
        lastMatchedRange = rangeFromNode(source, lineCounter, pair.key, lastMatchedRange);
      }
      if (isNode(pair.value)) {
        lastMatchedRange = rangeFromNode(source, lineCounter, pair.value, lastMatchedRange);
      }
      currentNode = pair.value;
    } else if (isSeq(currentNode)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= currentNode.items.length) break;
      const item = currentNode.items[idx];
      if (isNode(item)) {
        lastMatchedRange = rangeFromNode(source, lineCounter, item, lastMatchedRange);
      }
      currentNode = item;
    } else {
      break;
    }
  }

  if (extraPropertyKey && isMap(currentNode)) {
    const extraPair = findPair(currentNode, extraPropertyKey);
    if (extraPair && isNode(extraPair.key)) {
      return rangeFromNode(source, lineCounter, extraPair.key, lastMatchedRange);
    }
  }

  return lastMatchedRange;
}

/**
 * Finds the deepest explicit state (and optional transition) containing a 1-based
 * `(line, column)` editor cursor position for live two-way editor <-> Webview sync.
 */
export function findStateAtPosition(
  machine: ParsedMachine | null,
  line1Based: number,
  column1Based?: number
): { statePath: string | null; transitionId: string | null } {
  if (!machine) {
    return { statePath: null, transitionId: null };
  }

  const containsLineCol = (r: SourceRange): boolean => {
    if (line1Based < r.line || line1Based > r.endLine) {
      return false;
    }
    if (r.line === r.endLine && column1Based !== undefined) {
      return column1Based >= r.column && column1Based <= r.endColumn + 1;
    }
    return true;
  };

  let bestState: ParsedStateNode | null = null;
  let bestDepth = -1;

  for (const state of machine.allStatesByPath.values()) {
    if (state.isImplicitError) continue;
    if (containsLineCol(state.blockRange)) {
      const depth = state.path.split('.').length;
      if (depth > bestDepth) {
        bestDepth = depth;
        bestState = state;
      }
    }
  }

  if (!bestState) {
    return { statePath: null, transitionId: null };
  }

  let matchedTransitionId: string | null = null;
  for (const t of Object.values(bestState.on)) {
    if (containsLineCol(t.blockRange)) {
      matchedTransitionId = t.id;
      break;
    }
  }
  if (!matchedTransitionId && bestState.onDone && containsLineCol(bestState.onDone.blockRange)) {
    matchedTransitionId = bestState.onDone.id;
  }

  return {
    statePath: bestState.path,
    transitionId: matchedTransitionId
  };
}
