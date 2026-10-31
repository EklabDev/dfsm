import { describe, expect, it } from 'vitest';
import { detectDfsmDocument, formatStatusBarText } from '../src/core';

describe('DFSM Automatic Document Recognition', () => {
  it('recognizes *.dfsm.yaml and *.dfsm.yml files regardless of path', () => {
    const validYaml = `
dfsm: "1.0"
id: order-flow
initial: idle
states:
  idle:
    type: final
`;
    const resYaml = detectDfsmDocument({
      fileName: '/workspace/workflows/order.dfsm.yaml',
      content: validYaml,
      languageId: 'yaml'
    });
    expect(resYaml.isDfsm).toBe(true);
    expect(resYaml.reason).toBe('file-extension');
    expect(resYaml.machineId).toBe('order-flow');

    const resYml = detectDfsmDocument({
      fileName: 'checkout.DFSM.YML',
      content: 'dfsm: "1.0"\n# still editing...',
      languageId: 'yaml'
    });
    expect(resYml.isDfsm).toBe(true);
    expect(resYml.reason).toBe('file-extension');
  });

  it('recognizes generic .yaml / .yml files whose root declares dfsm: "1.0", id, and states', () => {
    const content = `
# Regular .yaml file containing a DFSM definition
dfsm: "1.0"
id: billing-saga
initial: start
states:
  start:
    on:
      FINISH: done
  done:
    type: final
`;
    const res1 = detectDfsmDocument({
      fileName: '/app/machines/billing.yaml',
      content,
      languageId: 'yaml'
    });
    expect(res1.isDfsm).toBe(true);
    expect(res1.reason).toBe('yaml-header');
    expect(res1.machineId).toBe('billing-saga');

    const res2 = detectDfsmDocument({
      fileName: 'Untitled-1',
      content,
      languageId: 'yaml'
    });
    expect(res2.isDfsm).toBe(true);
    expect(res2.reason).toBe('yaml-header');
    expect(res2.machineId).toBe('billing-saga');
  });

  it('ignores non-DFSM .yaml files (Docker Compose, Kubernetes, GitHub Actions, wrong version)', () => {
    const dockerCompose = `
version: "3.9"
services:
  postgres:
    image: postgres:16
`;
    expect(
      detectDfsmDocument({
        fileName: 'docker-compose.yaml',
        content: dockerCompose,
        languageId: 'yaml'
      }).isDfsm
    ).toBe(false);

    const k8sDeployment = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
`;
    expect(
      detectDfsmDocument({
        fileName: 'deployment.yml',
        content: k8sDeployment,
        languageId: 'yaml'
      }).isDfsm
    ).toBe(false);

    const wrongVersion = `
dfsm: "2.0"
id: future-machine
states:
  idle: {}
`;
    expect(
      detectDfsmDocument({
        fileName: 'future.yaml',
        content: wrongVersion,
        languageId: 'yaml'
      }).isDfsm
    ).toBe(false);

    expect(
      detectDfsmDocument({
        fileName: 'README.md',
        content: 'dfsm: "1.0"',
        languageId: 'markdown'
      }).isDfsm
    ).toBe(false);
  });

  it('formats the VS Code Status Bar item text accurately', () => {
    expect(formatStatusBarText('traffic-light', 4)).toBe(
      '$(type-hierarchy-sub) DFSM: traffic-light (4 states)'
    );
    expect(formatStatusBarText('single-node', 1)).toBe(
      '$(type-hierarchy-sub) DFSM: single-node (1 state)'
    );
    expect(formatStatusBarText(undefined, 0)).toBe(
      '$(type-hierarchy-sub) DFSM: unnamed (0 states)'
    );
  });
});
