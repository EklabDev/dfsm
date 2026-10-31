import { describe, expect, it } from 'vitest';
import { analyzeDfsmDocument, findStateAtPosition } from '../src/core';

describe('DFSM YAML AST Parser, Source-Map Line Tracker & Semantic Diagnostics', () => {
  it('rejects untyped `context:` at root with exact YAML line/column range and TContext explanation', () => {
    const yaml = [
      'dfsm: "1.0"',
      'id: ctx-test',
      'initial: idle',
      'context:',
      '  amount: 100',
      'states:',
      '  idle:',
      '    type: final'
    ].join('\n');

    const analysis = analyzeDfsmDocument(yaml);
    const err = analysis.errors.find((e) => e.code === 'dfsm/untyped-context');
    expect(err).toBeDefined();
    expect(err?.message).toContain('TContext');
    // Line 4 (1-based), Line 3 (0-based), columns 1..8 ('context')
    expect(err?.range.line).toBe(4);
    expect(err?.range.column).toBe(1);
    expect(err?.range.endLine).toBe(4);
    expect(err?.range.endColumn).toBe(8);
    expect(err?.range.startLine0).toBe(3);
    expect(err?.range.startColumn0).toBe(0);
    // Ensure duplicate generic AJV additionalProperties error was suppressed
    expect(analysis.errors.filter((e) => e.message.includes('context'))).toHaveLength(1);
  });

  it('reports compound states missing `initial` or referencing a non-existent child state', () => {
    const missingInitialYaml = [
      'dfsm: "1.0"',
      'id: missing-init',
      'initial: parent_box',
      'states:',
      '  parent_box:',
      '    states:',
      '      child_a:',
      '        type: final'
    ].join('\n');

    const res1 = analyzeDfsmDocument(missingInitialYaml);
    const err1 = res1.errors.find((e) => e.code === 'dfsm/compound-missing-initial');
    expect(err1).toBeDefined();
    expect(err1?.range.line).toBe(5); // `  parent_box:`
    expect(err1?.range.column).toBe(3);

    const badInitialYaml = [
      'dfsm: "1.0"',
      'id: bad-init',
      'initial: parent_box',
      'states:',
      '  parent_box:',
      '    initial: ghost_child',
      '    states:',
      '      child_a:',
      '        type: final'
    ].join('\n');

    const res2 = analyzeDfsmDocument(badInitialYaml);
    const err2 = res2.errors.find((e) => e.code === 'dfsm/invalid-initial-target');
    expect(err2).toBeDefined();
    expect(err2?.range.line).toBe(6); // `    initial: ghost_child`
    expect(err2?.range.column).toBe(14); // start of `ghost_child`
  });

  it('reports `parallel` states that illegally define `initial`', () => {
    const yaml = [
      'dfsm: "1.0"',
      'id: parallel-bad',
      'initial: fork',
      'states:',
      '  fork:',
      '    type: parallel',
      '    initial: region_one',
      '    states:',
      '      region_one:',
      '        type: final',
      '      region_two:',
      '        type: final'
    ].join('\n');

    const res = analyzeDfsmDocument(yaml);
    const err = res.errors.find((e) => e.code === 'dfsm/parallel-with-initial');
    expect(err).toBeDefined();
    expect(err?.range.line).toBe(7); // `    initial: region_one`
    expect(err?.range.column).toBe(5);
  });

  it('reports `final` states defining `states`, `initial`, or outgoing `on` transitions', () => {
    const yaml = [
      'dfsm: "1.0"',
      'id: invalid-final',
      'initial: start',
      'states:',
      '  start:',
      '    on:',
      '      FINISH: done',
      '  done:',
      '    type: final',
      '    initial: nested',
      '    on:',
      '      RESTART: start',
      '    states:',
      '      nested:',
      '        type: final'
    ].join('\n');

    const res = analyzeDfsmDocument(yaml);
    const finalErrors = res.errors.filter((e) => e.code === 'dfsm/final-invalid-properties');
    expect(finalErrors).toHaveLength(3);
    const lines = finalErrors.map((e) => e.range.line).sort((a, b) => a - b);
    expect(lines).toEqual([10, 11, 13]);
  });

  it('resolves valid `#machine.path`, `#path`, relative dot-paths, sibling keys, and implicit `error`, while catching broken targets at exact lines', () => {
    const yaml = [
      'dfsm: "1.0"',
      'id: target-resolution',
      'initial: checkout',
      'states:',
      '  checkout:',
      '    initial: cart',
      '    states:',
      '      cart:',
      '        on:',
      '          PAY: payment.authorizing',
      '          ABORT: "#target-resolution.cancelled"',
      '          HARD_ABORT: "#error"',
      '          FAIL_FAST:',
      '            target: missing_sibling',
      '            onFail:',
      '              target: nowhere_state',
      '      payment:',
      '        initial: authorizing',
      '        states:',
      '          authorizing:',
      '            on:',
      '              DONE: "#cancelled"',
      '              ESCALATE: error',
      '  cancelled:',
      '    type: final'
    ].join('\n');

    const res = analyzeDfsmDocument(yaml);
    const targetErrors = res.errors.filter((e) => e.code === 'dfsm/unresolved-target');
    expect(targetErrors).toHaveLength(2);
    expect(targetErrors[0].range.line).toBe(14); // `target: missing_sibling`
    expect(targetErrors[1].range.line).toBe(16); // `target: nowhere_state`
  });

  it('emits unreachable state warnings while excluding implicit/explicit `error` referenced implicitly', () => {
    const yaml = [
      'dfsm: "1.0"',
      'id: reachability-check',
      'initial: active',
      'states:',
      '  active:',
      '    on:',
      '      FINISH:',
      '        target: completed',
      '        transition: completeOrder',
      '  completed:',
      '    type: final',
      '  abandoned_island:',
      '    type: final',
      '  error:',
      '    entry: [notifyOps]',
      '    on:',
      '      RECOVER: recovery_lane',
      '  recovery_lane:',
      '    on:',
      '      RETRY: active'
    ].join('\n');

    const res = analyzeDfsmDocument(yaml);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].code).toBe('dfsm/unreachable-state');
    expect(res.warnings[0].path).toBe('abandoned_island');
    expect(res.warnings[0].range.line).toBe(12);
  });

  it('validates JSON Schema constraints (e.g. retry.maxAttempts >= 1) with exact YAML line mapping', () => {
    const yaml = [
      'dfsm: "1.0"',
      'id: bad-retry',
      'initial: ready',
      'states:',
      '  ready:',
      '    on:',
      '      GO:',
      '        target: done',
      '        retry:',
      '          maxAttempts: 0',
      '  done:',
      '    type: final'
    ].join('\n');

    const res = analyzeDfsmDocument(yaml);
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    const schemaErr = res.errors.find((e) => e.code === 'dfsm/schema');
    expect(schemaErr).toBeDefined();
    expect(schemaErr?.range.line).toBe(10); // `maxAttempts: 0`
  });

  it('maps editor cursor positions to deepest nested state & transition for two-way Webview sync', () => {
    const yaml = [
      'dfsm: "1.0"',
      'id: cursor-sync',
      'initial: outer',
      'states:',
      '  outer:',
      '    initial: inner',
      '    states:',
      '      inner:',
      '        on:',
      '          STEP:',
      '            target: done',
      '            transition: runStep',
      '      done:',
      '        type: final'
    ].join('\n');

    const analysis = analyzeDfsmDocument(yaml);
    expect(findStateAtPosition(analysis.machine, 2, 1).statePath).toBeNull();
    expect(findStateAtPosition(analysis.machine, 6, 5).statePath).toBe('outer');

    const innerHit = findStateAtPosition(analysis.machine, 11, 14);
    expect(innerHit.statePath).toBe('outer.inner');
    expect(innerHit.transitionId).toBe('outer.inner::on::STEP');

    expect(findStateAtPosition(analysis.machine, 14, 10).statePath).toBe('outer.done');
  });

  it('catches root missing initial, root parallel with initial, broken defaults.onFail.target, and nested unreachable states', () => {
    const rootMissingInit = [
      'dfsm: "1.0"',
      'id: no-root-init',
      'states:',
      '  idle:',
      '    type: final'
    ].join('\n');
    const r1 = analyzeDfsmDocument(rootMissingInit);
    expect(r1.errors.some((e) => e.code === 'dfsm/compound-missing-initial')).toBe(true);

    const rootParallelInit = [
      'dfsm: "1.0"',
      'id: parallel-root-init',
      'type: parallel',
      'initial: a',
      'states:',
      '  a:',
      '    type: final',
      '  b:',
      '    type: final'
    ].join('\n');
    const r2 = analyzeDfsmDocument(rootParallelInit);
    const pErr = r2.errors.find((e) => e.code === 'dfsm/parallel-with-initial');
    expect(pErr).toBeDefined();
    expect(pErr?.range.line).toBe(4);

    const brokenDefaultFail = [
      'dfsm: "1.0"',
      'id: bad-default-fail',
      'initial: active',
      'defaults:',
      '  onFail:',
      '    target: missing_dlq',
      'states:',
      '  active:',
      '    initial: step1',
      '    states:',
      '      step1:',
      '        type: final',
      '      nested_orphan:',
      '        type: final'
    ].join('\n');
    const r3 = analyzeDfsmDocument(brokenDefaultFail);
    const defErr = r3.errors.find((e) => e.code === 'dfsm/unresolved-target');
    expect(defErr).toBeDefined();
    expect(defErr?.range.line).toBe(6);

    const unreachableNested = r3.warnings.find((w) => w.code === 'dfsm/unreachable-state');
    expect(unreachableNested).toBeDefined();
    expect(unreachableNested?.path).toBe('active.nested_orphan');
    expect(unreachableNested?.range.line).toBe(13);
  });

  it('surfaces YAML syntax errors with exact line ranges', () => {
    const brokenSyntax = [
      'dfsm: "1.0"',
      'id: broken-yaml',
      'states:',
      '  idle: [unclosed_bracket'
    ].join('\n');
    const res = analyzeDfsmDocument(brokenSyntax);
    expect(res.isValid).toBe(false);
    expect(res.errors[0]?.code).toBe('dfsm/yaml-syntax');
    expect(res.errors[0]?.range.line).toBe(4);
  });
});
