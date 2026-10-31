import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeDfsmDocument, detectDfsmDocument } from '../src/core';
import { DFSM_TEMPLATES } from '../src/templates';
import { buildVisualizerGraph, renderVisualizerHtml } from '../src/visualizer';

const CONFORMANCE_DIR = resolve(__dirname, '../../../spec/conformance');
const EXPRESS_YAML_PATH = resolve(
  __dirname,
  '../../../sdks/typescript/examples/06-express-api-server/order-fulfillment.dfsm.yaml'
);

describe('Canonical DFSM v1.0 Conformance Suite & Templates', () => {
  const yamlFiles = readdirSync(CONFORMANCE_DIR)
    .filter((f) => f.endsWith('.dfsm.yaml'))
    .sort();

  it('discovers all 5 canonical conformance YAML files', () => {
    expect(yamlFiles).toEqual([
      '01-atomic-transitions.dfsm.yaml',
      '02-hierarchical-bubbling.dfsm.yaml',
      '03-parallel-regions.dfsm.yaml',
      '04-error-override-and-fallback.dfsm.yaml',
      '05-saga-compensation-lifo.dfsm.yaml'
    ]);
  });

  for (const file of yamlFiles) {
    it(`parses and validates ${file} with zero errors and zero warnings`, () => {
      const fullPath = resolve(CONFORMANCE_DIR, file);
      const raw = readFileSync(fullPath, 'utf-8');

      const detection = detectDfsmDocument({ fileName: fullPath, content: raw });
      expect(detection.isDfsm).toBe(true);

      const analysis = analyzeDfsmDocument(raw);
      expect(analysis.errors).toEqual([]);
      expect(analysis.warnings).toEqual([]);
      expect(analysis.isValid).toBe(true);
      expect(analysis.machine).not.toBeNull();
    });
  }

  it('correctly distinguishes implicit vs custom error state across conformance files', () => {
    const f01 = analyzeDfsmDocument(
      readFileSync(resolve(CONFORMANCE_DIR, '01-atomic-transitions.dfsm.yaml'), 'utf-8')
    );
    expect(f01.machine?.errorStateMode).toBe('implicit');
    expect(f01.infos.some((i) => i.code === 'dfsm/error-state-implicit')).toBe(true);

    const f04 = analyzeDfsmDocument(
      readFileSync(resolve(CONFORMANCE_DIR, '04-error-override-and-fallback.dfsm.yaml'), 'utf-8')
    );
    expect(f04.machine?.errorStateMode).toBe('custom');
    expect(f04.infos.some((i) => i.code === 'dfsm/error-state-custom')).toBe(true);
    expect(f04.machine?.states.error.keyRange.line).toBe(52);
  });

  for (const tpl of DFSM_TEMPLATES) {
    it(`validates starter template '${tpl.id}' with zero errors and zero warnings`, () => {
      const analysis = analyzeDfsmDocument(tpl.content);
      expect(analysis.errors).toEqual([]);
      expect(analysis.warnings).toEqual([]);
      expect(analysis.isValid).toBe(true);
    });
  }

  it('parses, validates, and visualizes YAML-defined hooks, routed effects, and maxEffectChainDepth in order-fulfillment.dfsm.yaml', () => {
    const raw = readFileSync(EXPRESS_YAML_PATH, 'utf-8');
    const analysis = analyzeDfsmDocument(raw);

    expect(analysis.errors).toEqual([]);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.isValid).toBe(true);
    expect(analysis.machine?.maxEffectChainDepth).toBe(25);
    expect(analysis.machine?.effects).toEqual([
      'autoAuthorizeWalletEffect',
      'awaitManualPaymentEffect'
    ]);
    expect(analysis.machine?.hooks).toEqual({
      onStart: ['onOrderStarted'],
      beforeTransition: ['onBeforeOrderStep'],
      afterTransition: ['onAfterOrderStep'],
      onCompensate: ['onOrderCompensated'],
      onComplete: ['onOrderCompleted'],
      onTerminal: ['onOrderTerminal']
    });

    const graph = buildVisualizerGraph(analysis);
    expect(graph.hooks.onStart).toEqual(['onOrderStarted']);
    expect(graph.effects).toEqual(['autoAuthorizeWalletEffect', 'awaitManualPaymentEffect']);
    expect(graph.maxEffectChainDepth).toBe(25);

    const html = renderVisualizerHtml(graph);
    expect(html).toContain('6 hooks');
    expect(html).toContain('onOrderStarted');
    expect(html).toContain('autoAuthorizeWalletEffect');
  });
});
