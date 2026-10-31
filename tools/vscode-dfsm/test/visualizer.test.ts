import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeTransitionPolicies } from '../src/core';
import {
  buildVisualizerGraph,
  computeGraphLayout,
  renderVisualizerHtml
} from '../src/visualizer';

const CONFORMANCE_DIR = resolve(__dirname, '../../../spec/conformance');

describe('Interactive Statechart Visualizer Graph, Layout & HTML/SVG Renderer', () => {
  it('merges SDK defaults, machine defaults, and transition policies leaf-by-leaf with provenance', () => {
    const merged = mergeTransitionPolicies(
      {
        retry: {
          maxAttempts: 2,
          backoff: { strategy: 'fixed', initialDelayMs: 50 }
        },
        onFail: { compensate: true, target: 'error' }
      },
      {
        retry: { maxAttempts: 4 },
        circuitBreaker: { enabled: true, failureThreshold: 3 }
      }
    );

    expect(merged.policy.retry).toEqual({
      maxAttempts: 4,
      backoff: {
        strategy: 'fixed',
        initialDelayMs: 50,
        maxDelayMs: 5000,
        multiplier: 2.0
      }
    });
    expect(merged.policy.circuitBreaker.enabled).toBe(true);
    expect(merged.policy.circuitBreaker.failureThreshold).toBe(3);
    expect(merged.policy.circuitBreaker.openDurationMs).toBe(30000);
    expect(merged.policy.onFail).toEqual({ compensate: true, target: 'error' });

    expect(merged.sources['retry.maxAttempts']).toBe('transition');
    expect(merged.sources['retry.backoff.strategy']).toBe('defaults');
    expect(merged.sources['retry.backoff.maxDelayMs']).toBe('sdk');
    expect(merged.sources['circuitBreaker.enabled']).toBe('transition');
    expect(merged.sources['onFail.compensate']).toBe('defaults');
  });

  it('builds nested compound & orthogonal parallel containers with dashed dividers and onDone edges', () => {
    const parallelYaml = readFileSync(
      resolve(CONFORMANCE_DIR, '03-parallel-regions.dfsm.yaml'),
      'utf-8'
    );
    const graph = buildVisualizerGraph(parallelYaml);

    expect(graph.machineId).toBe('order-parallel');
    expect(graph.errorStateMode).toBe('implicit');

    const fulfilling = graph.allNodes.find((n) => n.id === 'fulfilling');
    expect(fulfilling?.kind).toBe('parallel');
    expect(fulfilling?.children.map((c) => c.id)).toEqual([
      'fulfilling.billing',
      'fulfilling.warehouse'
    ]);

    const billing = fulfilling?.children[0];
    expect(billing?.kind).toBe('compound');
    expect(billing?.initialChildId).toBe('fulfilling.billing.pending_charge');

    // Implicit `error (default)` node is injected
    const errNode = graph.allNodes.find((n) => n.id === 'error');
    expect(errNode?.kind).toBe('error');
    expect(errNode?.label).toBe('error (default)');
    expect(errNode?.errorMode).toBe('default');

    // `onDone` edge on `fulfilling` carries `effects` badge
    const onDoneEdge = graph.edges.find((e) => e.edgeKind === 'onDone' && e.source === 'fulfilling');
    expect(onDoneEdge).toBeDefined();
    expect(onDoneEdge?.target).toBe('shipped');
    expect(onDoneEdge?.badges.some((b) => b.kind === 'effects' && b.label.includes('effects'))).toBe(
      true
    );

    // Deterministic hierarchical bounding-box layout check
    const layout = computeGraphLayout(graph);
    const fulfillingBox = layout.nodes.find((b) => b.node.id === 'fulfilling')!;
    const billingBox = layout.nodes.find((b) => b.node.id === 'fulfilling.billing')!;
    const pendingBox = layout.nodes.find((b) => b.node.id === 'fulfilling.billing.pending_charge')!;

    // Verify child boxes are strictly enclosed within parent container boxes
    expect(billingBox.x).toBeGreaterThan(fulfillingBox.x);
    expect(billingBox.y).toBeGreaterThan(fulfillingBox.y);
    expect(billingBox.x + billingBox.width).toBeLessThan(fulfillingBox.x + fulfillingBox.width);
    expect(billingBox.y + billingBox.height).toBeLessThan(fulfillingBox.y + fulfillingBox.height);

    expect(pendingBox.x).toBeGreaterThan(billingBox.x);
    expect(pendingBox.y).toBeGreaterThan(billingBox.y);
    expect(pendingBox.x + pendingBox.width).toBeLessThan(billingBox.x + billingBox.width);
    expect(pendingBox.y + pendingBox.height).toBeLessThan(billingBox.y + billingBox.height);

    // Verify orthogonal region divider exists inside `fulfilling`
    expect(layout.parallelDividers.some((d) => d.parallelNodeId === 'fulfilling')).toBe(true);
    // Verify initial child markers exist for root, billing, and warehouse
    expect(layout.initialMarkers.map((m) => m.ownerId)).toEqual(
      expect.arrayContaining(['__root__', 'fulfilling.billing', 'fulfilling.warehouse'])
    );

    const html = renderVisualizerHtml(layout, { nonce: 'testnonce123' });
    expect(html).toContain('parallel-region-divider');
    expect(html).toContain('stroke-dasharray="6 4"');
    expect(html).toContain('error (default)');
    expect(html).toContain('bullseye-badge');
    expect(html).toContain('revealRange');
    expect(html).toContain('highlightState');
  });

  it('renders custom overridden `error (custom)` state, retry/CB/compensate badges, and dashed onFail edges', () => {
    const overrideYaml = readFileSync(
      resolve(CONFORMANCE_DIR, '04-error-override-and-fallback.dfsm.yaml'),
      'utf-8'
    );
    const overrideGraph = buildVisualizerGraph(overrideYaml);
    expect(overrideGraph.errorStateMode).toBe('custom');

    const customErr = overrideGraph.allNodes.find((n) => n.id === 'error');
    expect(customErr?.kind).toBe('error');
    expect(customErr?.label).toBe('error (custom)');
    expect(customErr?.errorMode).toBe('custom');

    const callPrimaryEdge = overrideGraph.edges.find(
      (e) => e.id === 'ready::on::CALL_PRIMARY'
    );
    expect(callPrimaryEdge?.badges.map((b) => b.label)).toEqual(['retry: 3', 'CB']);

    const failToQueueEdge = overrideGraph.edges.find(
      (e) => e.edgeKind === 'onFail' && e.target === 'fallback_queue'
    );
    expect(failToQueueEdge).toBeDefined();
    expect(failToQueueEdge?.dashed).toBe(true);

    const failToErrorEdge = overrideGraph.edges.find(
      (e) => e.edgeKind === 'onFail' && e.target === 'error'
    );
    expect(failToErrorEdge).toBeDefined();
    expect(failToErrorEdge?.dashed).toBe(true);

    const html04 = renderVisualizerHtml(overrideGraph);
    expect(html04).toContain('error (custom)');
    expect(html04).toContain('error: custom override');
    expect(html04).toContain('retry: 3');
    expect(html04).toContain('>CB<');

    // Also verify Saga `compensate: <fn>` badges on 05-saga-compensation-lifo.dfsm.yaml
    const sagaYaml = readFileSync(
      resolve(CONFORMANCE_DIR, '05-saga-compensation-lifo.dfsm.yaml'),
      'utf-8'
    );
    const sagaGraph = buildVisualizerGraph(sagaYaml);
    const flightEdge = sagaGraph.edges.find((e) => e.id === 'step_flight::on::BOOK_FLIGHT');
    expect(flightEdge?.badges.some((b) => b.label === 'compensate: cancelFlight')).toBe(true);
  });
});
