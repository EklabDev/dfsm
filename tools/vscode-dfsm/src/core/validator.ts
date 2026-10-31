import Ajv, { type ErrorObject } from 'ajv';
import { isMap, isPair, isScalar } from 'yaml';
import dfsmSchema from '../../schemas/dfsm-v1.schema.json';
import { parseDfsmYaml, resolveJsonPointerRange, type RawParseOutput } from './parser';
import { resolveStateTarget } from './resolver';
import type {
  DfsmDiagnostic,
  DfsmDocumentAnalysis,
  ParsedMachine,
  ParsedStateNode,
  ParsedTransition
} from './types';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateSchema: false
});

const validateSchemaFn = ajv.compile(dfsmSchema);

function shouldSkipAjvError(err: ErrorObject, parsed: RawParseOutput): boolean {
  // 1. Suppress generic `additionalProperties: "context"` when our dedicated `dfsm/untyped-context` rule handles it
  if (
    err.keyword === 'additionalProperties' &&
    (err.params as { additionalProperty?: string })?.additionalProperty === 'context'
  ) {
    return true;
  }

  // 2. Suppress root `if/else` wrapper and root `required: initial` when semantic `dfsm/compound-missing-initial` handles it
  if (err.instancePath === '' && err.keyword === 'if') {
    return true;
  }
  if (
    err.instancePath === '' &&
    err.keyword === 'required' &&
    (err.params as { missingProperty?: string })?.missingProperty === 'initial'
  ) {
    return true;
  }

  // 3. When TransitionDefinition `oneOf` fails on a Map transition (e.g. `retry.maxAttempts: 0`),
  //    suppress the irrelevant string-branch `type: string` and `oneOf` wrapper noise.
  if (err.keyword === 'oneOf' && err.schemaPath.endsWith('/oneOf')) {
    return true;
  }
  if (err.schemaPath.endsWith('/oneOf/0/type') && err.keyword === 'type') {
    const segments = err.instancePath.split('/').filter(Boolean);
    let cursor: unknown = parsed.yamlDoc.contents;
    for (const seg of segments) {
      if (isMap(cursor)) {
        const matchedPair = cursor.items.find(
          (item) => isPair(item) && isScalar(item.key) && String(item.key.value) === seg
        );
        cursor = matchedPair?.value ?? null;
      } else {
        cursor = null;
        break;
      }
    }
    if (isMap(cursor)) {
      return true;
    }
  }

  return false;
}

function collectAjvDiagnostics(parsed: RawParseOutput): DfsmDiagnostic[] {
  if (parsed.syntaxDiagnostics.length > 0 || parsed.rawData === null) {
    return [];
  }

  const valid = validateSchemaFn(parsed.rawData);
  if (valid || !validateSchemaFn.errors) {
    return [];
  }

  const diagnostics: DfsmDiagnostic[] = [];
  const seenKeys = new Set<string>();

  for (const err of validateSchemaFn.errors) {
    if (shouldSkipAjvError(err, parsed)) {
      continue;
    }

    const extraProp =
      err.keyword === 'additionalProperties'
        ? (err.params as { additionalProperty?: string })?.additionalProperty
        : undefined;

    const range = resolveJsonPointerRange(
      parsed.yamlDoc,
      parsed.lineCounter,
      parsed.source,
      err.instancePath,
      extraProp
    );

    let message = err.message ?? 'Schema validation error';
    if (err.keyword === 'additionalProperties' && extraProp) {
      message = `Unknown property '${extraProp}' is not permitted by DFSM v1.0 schema.`;
    } else if (err.keyword === 'required') {
      const missing = (err.params as { missingProperty?: string })?.missingProperty;
      if (missing) {
        message = `Missing required property '${missing}'.`;
      }
    } else if (err.instancePath) {
      message = `${err.instancePath}: ${message}`;
    }

    const dedupeKey = `${range.startOffset}:${range.endOffset}:${message}`;
    if (!seenKeys.has(dedupeKey)) {
      seenKeys.add(dedupeKey);
      diagnostics.push({
        code: 'dfsm/schema',
        severity: 'error',
        message,
        range,
        path: err.instancePath || '/'
      });
    }
  }

  return diagnostics;
}

function validateTransitionTargets(
  machine: ParsedMachine,
  transition: ParsedTransition,
  diagnostics: DfsmDiagnostic[]
): void {
  if (transition.target !== undefined) {
    const res = resolveStateTarget(machine, transition.sourceStatePath, transition.target);
    if (!res.resolved) {
      diagnostics.push({
        code: 'dfsm/unresolved-target',
        severity: 'error',
        message:
          res.reason ??
          `Unresolved transition target '${transition.target}' on '${transition.sourceStatePath}' (${transition.event}).`,
        range: transition.targetRange ?? transition.keyRange,
        path: transition.sourceStatePath
      });
    }
  }

  if (transition.policy.onFail?.target !== undefined) {
    const failTarget = transition.policy.onFail.target;
    const res = resolveStateTarget(machine, transition.sourceStatePath, failTarget);
    if (!res.resolved) {
      diagnostics.push({
        code: 'dfsm/unresolved-target',
        severity: 'error',
        message:
          res.reason ??
          `Unresolved onFail.target '${failTarget}' on '${transition.sourceStatePath}' (${transition.event}).`,
        range: transition.onFailTargetRange ?? transition.keyRange,
        path: transition.sourceStatePath
      });
    }
  }
}

function validateStateSemanticsRecursive(
  machine: ParsedMachine,
  state: ParsedStateNode,
  diagnostics: DfsmDiagnostic[]
): void {
  if (state.isImplicitError) {
    return;
  }

  const childNames = Object.keys(state.states);

  // 1. Compound state rules
  if (state.inferredType === 'compound') {
    if (childNames.length === 0) {
      diagnostics.push({
        code: 'dfsm/compound-empty-states',
        severity: 'error',
        message: `Compound state '${state.path}' must define at least one child state in 'states'.`,
        range: state.statesKeyRange ?? state.keyRange,
        path: state.path
      });
    }
    if (!state.initial) {
      diagnostics.push({
        code: 'dfsm/compound-missing-initial',
        severity: 'error',
        message: `Compound state '${state.path}' must specify an 'initial' child state.`,
        range: state.keyRange,
        path: state.path
      });
    } else if (!Object.prototype.hasOwnProperty.call(state.states, state.initial)) {
      diagnostics.push({
        code: 'dfsm/invalid-initial-target',
        severity: 'error',
        message: `Initial state '${state.initial}' does not exist in compound state '${state.path}.states'.`,
        range: state.initialValueRange ?? state.initialKeyRange ?? state.keyRange,
        path: state.path
      });
    }
  }

  // 2. Parallel state rules
  if (state.inferredType === 'parallel') {
    if (state.initial !== undefined) {
      diagnostics.push({
        code: 'dfsm/parallel-with-initial',
        severity: 'error',
        message: `Parallel state '${state.path}' must not define 'initial' because parallel states activate all child regions simultaneously.`,
        range: state.initialKeyRange ?? state.initialValueRange ?? state.keyRange,
        path: state.path
      });
    }
    if (childNames.length === 0) {
      diagnostics.push({
        code: 'dfsm/parallel-missing-states',
        severity: 'error',
        message: `Parallel state '${state.path}' must define orthogonal child region 'states'.`,
        range: state.keyRange,
        path: state.path
      });
    }
  }

  // 3. Final state rules
  if (state.inferredType === 'final') {
    if (childNames.length > 0 || state.statesKeyRange) {
      diagnostics.push({
        code: 'dfsm/final-invalid-properties',
        severity: 'error',
        message: `Final state '${state.path}' cannot define child 'states'.`,
        range: state.statesKeyRange ?? state.keyRange,
        path: state.path
      });
    }
    if (state.initial !== undefined || state.initialKeyRange) {
      diagnostics.push({
        code: 'dfsm/final-invalid-properties',
        severity: 'error',
        message: `Final state '${state.path}' cannot define 'initial'.`,
        range: state.initialKeyRange ?? state.keyRange,
        path: state.path
      });
    }
    if (Object.keys(state.on).length > 0 || state.onKeyRange) {
      diagnostics.push({
        code: 'dfsm/final-invalid-properties',
        severity: 'error',
        message: `Final state '${state.path}' cannot define outgoing 'on' transitions.`,
        range: state.onKeyRange ?? state.keyRange,
        path: state.path
      });
    }
    if (state.onDone) {
      diagnostics.push({
        code: 'dfsm/final-invalid-properties',
        severity: 'error',
        message: `Final state '${state.path}' cannot define 'onDone'.`,
        range: state.onDone.keyRange,
        path: state.path
      });
    }
  }

  // 4. Atomic state with initial key
  if (state.inferredType === 'atomic' && state.initial !== undefined) {
    diagnostics.push({
      code: 'dfsm/atomic-with-initial',
      severity: 'error',
      message: `Atomic state '${state.path}' defines 'initial' without child 'states'.`,
      range: state.initialKeyRange ?? state.keyRange,
      path: state.path
    });
  }

  // 5. Validate transitions (`on` and `onDone`)
  for (const t of Object.values(state.on)) {
    validateTransitionTargets(machine, t, diagnostics);
  }
  if (state.onDone) {
    validateTransitionTargets(machine, state.onDone, diagnostics);
  }

  for (const child of Object.values(state.states)) {
    validateStateSemanticsRecursive(machine, child, diagnostics);
  }
}

function collectUnreachableStateDiagnostics(
  machine: ParsedMachine,
  diagnostics: DfsmDiagnostic[]
): void {
  if (machine.explicitStateCount === 0) {
    return;
  }

  const reachable = new Set<string>();
  const queue: ParsedStateNode[] = [];

  const enterState = (node: ParsedStateNode | undefined) => {
    if (!node) return;

    // Ensure all ancestors of a deeply targeted node are marked reachable as well
    let ancestorPath = node.parentPath;
    while (ancestorPath) {
      if (!reachable.has(ancestorPath)) {
        reachable.add(ancestorPath);
        const anc = machine.allStatesByPath.get(ancestorPath);
        if (anc) {
          queue.push(anc);
        }
      }
      ancestorPath = ancestorPath.includes('.')
        ? ancestorPath.slice(0, ancestorPath.lastIndexOf('.'))
        : null;
    }

    if (reachable.has(node.path)) {
      return;
    }
    reachable.add(node.path);
    queue.push(node);

    if (node.inferredType === 'compound' && node.initial) {
      const initialChild = node.states[node.initial];
      if (initialChild) {
        enterState(initialChild);
      }
    } else if (node.inferredType === 'parallel') {
      for (const region of Object.values(node.states)) {
        enterState(region);
      }
    }
  };

  // Seed initial active states from root
  if (machine.rootType === 'parallel') {
    for (const [key, rootState] of Object.entries(machine.states)) {
      if (key === 'error' && rootState.isCustomError) {
        // Explicit root `error` in a parallel machine is only a region if not exclusively an error boundary,
        // entering it keeps parallel semantics consistent.
        enterState(rootState);
      } else {
        enterState(rootState);
      }
    }
  } else if (machine.initial) {
    const initialRoot = machine.allStatesByPath.get(machine.initial);
    if (initialRoot) {
      enterState(initialRoot);
    }
  }

  // Also check machine-level defaults.onFail.target
  const defaultFailTarget = machine.defaults.onFail?.target ?? 'error';
  let errorReferencedImplicitlyOrExplicitly = defaultFailTarget === 'error';

  // Fixed-point graph traversal across reachable states
  while (queue.length > 0) {
    const current = queue.shift()!;

    const transitions: ParsedTransition[] = [...Object.values(current.on)];
    if (current.onDone) {
      transitions.push(current.onDone);
    }

    for (const t of transitions) {
      if (t.target) {
        const res = resolveStateTarget(machine, current.path, t.target);
        if (res.resolved && res.targetNode) {
          enterState(res.targetNode);
        }
      }

      const failTarget = t.effectivePolicy.onFail.target;
      if (failTarget) {
        const failRes = resolveStateTarget(machine, current.path, failTarget);
        if (failRes.resolved && failRes.targetNode) {
          if (failRes.targetPath === 'error') {
            errorReferencedImplicitlyOrExplicitly = true;
          }
          enterState(failRes.targetNode);
        }
      }
    }
  }

  // If explicit `states.error` is present and referenced implicitly (via SDK default `onFail.target = "error"`),
  // enter it and propagate its outgoing recovery transitions (`RECOVER -> ...`).
  if (errorReferencedImplicitlyOrExplicitly && machine.states.error && !reachable.has('error')) {
    enterState(machine.states.error);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const transitions: ParsedTransition[] = [...Object.values(current.on)];
      if (current.onDone) transitions.push(current.onDone);
      for (const t of transitions) {
        if (t.target) {
          const res = resolveStateTarget(machine, current.path, t.target);
          if (res.resolved && res.targetNode) {
            enterState(res.targetNode);
          }
        }
      }
    }
  }

  for (const state of machine.allStatesByPath.values()) {
    if (state.isImplicitError) {
      continue;
    }
    if (state.isCustomError && errorReferencedImplicitlyOrExplicitly) {
      continue;
    }
    if (!reachable.has(state.path)) {
      diagnostics.push({
        code: 'dfsm/unreachable-state',
        severity: 'warning',
        message: `State '${state.path}' is unreachable from 'initial', 'parallel' entry, 'on', 'onDone', or 'onFail.target'.`,
        range: state.keyRange,
        path: state.path
      });
    }
  }
}

/**
 * Full DFSM v1.0 document analyzer: runs CST/AST YAML parsing, JSON Schema validation,
 * and semantic DFSM statechart validation.
 */
export function analyzeDfsmDocument(source: string): DfsmDocumentAnalysis {
  const parsed = parseDfsmYaml(source);
  const diagnostics: DfsmDiagnostic[] = [...parsed.syntaxDiagnostics];

  // 1. Untyped `context:` rejection rule (highest-clarity semantic diagnostic)
  for (const untypedCtx of parsed.untypedContextRanges) {
    diagnostics.push({
      code: 'dfsm/untyped-context',
      severity: 'error',
      message:
        "Untyped 'context' is not allowed in DFSM YAML. DFSM defines strongly typed generic TContext and runtime validators in host source code rather than YAML.",
      range: untypedCtx.range,
      path: untypedCtx.path
    });
  }

  // 2. JSON Schema validation against `schemas/dfsm-v1.schema.json`
  diagnostics.push(...collectAjvDiagnostics(parsed));

  // 3. Semantic AST rules when root map is present
  const machine = parsed.machine;
  if (machine && parsed.syntaxDiagnostics.length === 0) {
    const topStateNames = Object.keys(machine.states);

    // Root compound vs parallel checks
    if (machine.rootType === 'compound') {
      if (!machine.initial) {
        diagnostics.push({
          code: 'dfsm/compound-missing-initial',
          severity: 'error',
          message: "Compound root machine must define an 'initial' child state.",
          range: machine.idRange ?? machine.rootRange,
          path: '/'
        });
      } else if (
        topStateNames.length > 0 &&
        !Object.prototype.hasOwnProperty.call(machine.states, machine.initial)
      ) {
        diagnostics.push({
          code: 'dfsm/invalid-initial-target',
          severity: 'error',
          message: `Root initial state '${machine.initial}' does not exist in 'states'.`,
          range: machine.initialValueRange ?? machine.initialKeyRange ?? machine.rootRange,
          path: '/initial'
        });
      }
    } else if (machine.rootType === 'parallel') {
      if (machine.initial !== undefined) {
        diagnostics.push({
          code: 'dfsm/parallel-with-initial',
          severity: 'error',
          message:
            "Parallel root machine must not define 'initial' because parallel machines activate all child regions simultaneously.",
          range: machine.initialKeyRange ?? machine.initialValueRange ?? machine.rootRange,
          path: '/initial'
        });
      }
    }

    // Machine-level defaults.onFail.target resolution
    if (machine.defaults.onFail?.target !== undefined) {
      const defTarget = machine.defaults.onFail.target;
      const res = resolveStateTarget(machine, null, defTarget);
      if (!res.resolved) {
        diagnostics.push({
          code: 'dfsm/unresolved-target',
          severity: 'error',
          message:
            res.reason ?? `Unresolved defaults.onFail.target '${defTarget}' in machine '${machine.id ?? 'unnamed'}'.`,
          range: machine.defaultsOnFailTargetRange ?? machine.defaultsRange ?? machine.rootRange,
          path: '/defaults/onFail/target'
        });
      }
    }

    // Recursive state & transition checks
    for (const rootState of Object.values(machine.states)) {
      validateStateSemanticsRecursive(machine, rootState, diagnostics);
    }

    // Unreachable state checks
    if (topStateNames.length > 0) {
      collectUnreachableStateDiagnostics(machine, diagnostics);
    }

    // Informational hint / badge diagnostic indicating implicit vs overridden `error` state
    if (topStateNames.length > 0) {
      if (machine.errorStateMode === 'implicit') {
        diagnostics.push({
          code: 'dfsm/error-state-implicit',
          severity: 'info',
          message:
            "Error state: using built-in implicit final 'error' state (define 'states.error' to override with custom recovery or entry effects).",
          range: machine.statesKeyRange ?? machine.idRange ?? machine.rootRange,
          path: '/states'
        });
      } else {
        const customError = machine.states.error;
        diagnostics.push({
          code: 'dfsm/error-state-custom',
          severity: 'info',
          message: `Error state: custom 'states.error' (${customError.inferredType}) overrides the built-in implicit final error state.`,
          range: customError.keyRange,
          path: 'error'
        });
      }
    }
  }

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const infos = diagnostics.filter((d) => d.severity === 'info' || d.severity === 'hint');

  return {
    rawText: source,
    rawData: parsed.rawData,
    machine,
    diagnostics,
    errors,
    warnings,
    infos,
    isValid: errors.length === 0 && machine !== null
  };
}
