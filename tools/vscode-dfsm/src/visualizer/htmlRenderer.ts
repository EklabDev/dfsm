import { buildVisualizerGraph } from './graphBuilder';
import { computeGraphLayout } from './layoutEngine';
import type {
  EdgeLayout,
  LayoutGraph,
  NodeBoxLayout,
  TransitionBadge,
  VisualizerGraph,
  VisualizerNode
} from './types';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderNodeSvg(box: NodeBoxLayout): string {
  const { node, x, y, width, height, headerHeight } = box;
  const isContainer = node.children.length > 0;
  const rangeAttr = node.range ? `data-line="${node.range.line}"` : '';

  if (isContainer) {
    const kindBadge = node.kind === 'parallel' ? 'parallel' : 'compound';
    const hooksSummary = [
      node.entry.length > 0 ? `entry: ${node.entry.join(', ')}` : '',
      node.exit.length > 0 ? `exit: ${node.exit.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('  ·  ');

    return `
      <g class="dfsm-node dfsm-container kind-${node.kind}" data-state-id="${escapeHtml(node.id)}" ${rangeAttr} transform="translate(${x}, ${y})">
        <rect class="node-outer-rect" x="0" y="0" width="${width}" height="${height}" rx="12" ry="12" />
        <path class="container-header-bg" d="M 0 12 Q 0 0 12 0 L ${width - 12} 0 Q ${width} 0 ${width} 12 L ${width} ${headerHeight} L 0 ${headerHeight} Z" />
        <line class="container-header-line" x1="0" y1="${headerHeight}" x2="${width}" y2="${headerHeight}" />
        <text class="node-title" x="14" y="25">${escapeHtml(node.label)}</text>
        <g transform="translate(${width - 82}, 10)">
          <rect class="kind-pill pill-${node.kind}" x="0" y="0" width="68" height="20" rx="10" />
          <text class="kind-pill-text" x="34" y="14" text-anchor="middle">${kindBadge}</text>
        </g>
        ${
          hooksSummary
            ? `<text class="node-hooks" x="14" y="47">${escapeHtml(hooksSummary)}</text>`
            : ''
        }
      </g>
    `;
  }

  // Leaf state card (`atomic`, `final`, `error`)
  const isFinalShape = node.kind === 'final' || (node.kind === 'error' && node.stateType === 'final');
  const innerDoubleRect = isFinalShape
    ? `<rect class="final-inner-rect" x="5" y="5" width="${width - 10}" height="${height - 10}" rx="7" ry="7" />`
    : '';

  const bullseyeIcon = isFinalShape
    ? `
      <g class="bullseye-badge" transform="translate(${width - 24}, 22)">
        <circle class="bullseye-outer" cx="0" cy="0" r="8" />
        <circle class="bullseye-inner" cx="0" cy="0" r="3.8" />
      </g>
    `
    : '';

  const errorModeAttr = node.errorMode ? `data-error-mode="${node.errorMode}"` : '';

  let hookLinesSvg = '';
  let hookY = 48;
  if (node.entry.length > 0) {
    hookLinesSvg += `<text class="node-hooks" x="14" y="${hookY}">entry: ${escapeHtml(node.entry.join(', '))}</text>`;
    hookY += 18;
  }
  if (node.exit.length > 0) {
    hookLinesSvg += `<text class="node-hooks" x="14" y="${hookY}">exit: ${escapeHtml(node.exit.join(', '))}</text>`;
  }

  return `
    <g class="dfsm-node dfsm-leaf kind-${node.kind}" data-state-id="${escapeHtml(node.id)}" ${errorModeAttr} ${rangeAttr} transform="translate(${x}, ${y})">
      <rect class="node-outer-rect" x="0" y="0" width="${width}" height="${height}" rx="10" ry="10" />
      ${innerDoubleRect}
      <text class="node-title" x="14" y="27">${escapeHtml(node.label)}</text>
      ${bullseyeIcon}
      ${hookLinesSvg}
    </g>
  `;
}

function badgeWidth(badge: TransitionBadge): number {
  return Math.max(38, Math.ceil(badge.label.length * 6.4) + 16);
}

function renderEdgeSvg(routed: EdgeLayout): string {
  const { edge, pathD, labelX, labelY } = routed;
  const markerId =
    edge.edgeKind === 'onFail'
      ? 'arrow-onFail'
      : edge.edgeKind === 'onDone'
        ? 'arrow-onDone'
        : 'arrow-event';

  const dashAttr = edge.dashed ? 'stroke-dasharray="6 4"' : '';

  const mainLabelW = Math.max(68, Math.ceil(edge.label.length * 6.9) + 22);
  const badgesTotalW =
    edge.badges.length > 0
      ? edge.badges.reduce((acc, b) => acc + badgeWidth(b), 0) + (edge.badges.length - 1) * 5
      : 0;

  const boxW = Math.max(mainLabelW, badgesTotalW + 16);
  const boxH = edge.badges.length > 0 ? 44 : 24;
  const boxX = Math.round(labelX - boxW / 2);
  const boxY = Math.round(labelY - boxH / 2);

  let badgesSvg = '';
  if (edge.badges.length > 0) {
    let bx = Math.round(labelX - badgesTotalW / 2);
    const by = boxY + 23;
    for (const b of edge.badges) {
      const bw = badgeWidth(b);
      badgesSvg += `
        <g class="transition-badge badge-${b.kind}" transform="translate(${bx}, ${by})">
          <rect x="0" y="0" width="${bw}" height="16" rx="8" />
          <text x="${Math.round(bw / 2)}" y="11.5" text-anchor="middle">${escapeHtml(b.label)}</text>
        </g>
      `;
      bx += bw + 5;
    }
  }

  return `
    <g class="dfsm-edge edge-${edge.edgeKind}" data-edge-id="${escapeHtml(edge.id)}" data-source="${escapeHtml(edge.source)}" data-target="${escapeHtml(edge.target)}">
      <path class="edge-hit-area" d="${pathD}" />
      <path class="edge-path" d="${pathD}" ${dashAttr} marker-end="url(#${markerId})" />
      <g class="edge-label-card" transform="translate(${boxX}, ${boxY})">
        <rect class="edge-label-bg" x="0" y="0" width="${boxW}" height="${boxH}" rx="7" />
        <text class="edge-label-text" x="${Math.round(boxW / 2)}" y="15.5" text-anchor="middle">${escapeHtml(edge.label)}</text>
      </g>
      ${badgesSvg}
    </g>
  `;
}

/**
 * Renders the pure SVG diagram markup for a `LayoutGraph`.
 */
export function renderStatechartSvg(layout: LayoutGraph): string {
  const nodesSvg = layout.nodes.map(renderNodeSvg).join('\n');

  const dividersSvg = layout.parallelDividers
    .map(
      (d) =>
        `<line class="parallel-region-divider" data-parallel-id="${escapeHtml(d.parallelNodeId)}" x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}" stroke-dasharray="6 4" />`
    )
    .join('\n');

  const initialMarkersSvg = layout.initialMarkers
    .map(
      (m) => `
      <g class="initial-marker" data-owner="${escapeHtml(m.ownerId)}" data-initial-target="${escapeHtml(m.targetNodeId)}">
        <circle class="initial-dot" cx="${m.dotX}" cy="${m.dotY}" r="5.5" />
        <path class="initial-arrow" d="${m.pathD}" marker-end="url(#arrow-initial)" />
      </g>
    `
    )
    .join('\n');

  const edgesSvg = layout.edges.map(renderEdgeSvg).join('\n');

  return `
    <svg id="dfsm-svg" class="dfsm-svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arrow-event" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 0 1.5 L 9 5 L 0 8.5 z" class="marker-event" />
        </marker>
        <marker id="arrow-onDone" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 0 1.5 L 9 5 L 0 8.5 z" class="marker-onDone" />
        </marker>
        <marker id="arrow-onFail" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 0 1.5 L 9 5 L 0 8.5 z" class="marker-onFail" />
        </marker>
        <marker id="arrow-initial" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto">
          <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" class="marker-initial" />
        </marker>
      </defs>
      <g class="layer-nodes">${nodesSvg}</g>
      <g class="layer-dividers">${dividersSvg}</g>
      <g class="layer-initial-markers">${initialMarkersSvg}</g>
      <g class="layer-edges">${edgesSvg}</g>
    </svg>
  `;
}

export function renderHeaderMetaHtml(graph: VisualizerGraph): string {
  const errCount = graph.diagnostics.filter((d) => d.severity === 'error').length;
  const warnCount = graph.diagnostics.filter((d) => d.severity === 'warning').length;

  const statusPill =
    errCount > 0
      ? `<span class="meta-pill status-error">${errCount} error${errCount === 1 ? '' : 's'}</span>`
      : warnCount > 0
        ? `<span class="meta-pill status-warn">${warnCount} warning${warnCount === 1 ? '' : 's'}</span>`
        : `<span class="meta-pill status-valid">Valid DFSM v1.0</span>`;

  const errorModePill =
    graph.errorStateMode === 'custom'
      ? `<span class="meta-pill error-mode-custom" title="YAML defines custom states.error">error: custom override</span>`
      : `<span class="meta-pill error-mode-default" title="Compiler injects built-in final error state">error: default (implicit final)</span>`;

  const nsPill = graph.namespace
    ? `<span class="meta-pill meta-ns">ns: ${escapeHtml(graph.namespace)}</span>`
    : '';

  const totalHookHandlers =
    graph.hooks.onStart.length +
    graph.hooks.beforeTransition.length +
    graph.hooks.afterTransition.length +
    graph.hooks.onCompensate.length +
    graph.hooks.onComplete.length +
    graph.hooks.onTerminal.length;

  const hooksPill =
    totalHookHandlers > 0
      ? `<span class="meta-pill meta-hooks" title="YAML lifecycle hooks registered on machine creation">${totalHookHandlers} hook${totalHookHandlers === 1 ? '' : 's'}</span>`
      : '';

  return `
    <div class="studio-title-group">
      <span class="studio-machine-id">${escapeHtml(graph.machineId)}</span>
      <span class="meta-pill meta-version">v${escapeHtml(graph.version)}</span>
      <span class="meta-pill meta-states">${graph.explicitStateCount} state${graph.explicitStateCount === 1 ? '' : 's'}</span>
      ${nsPill}
      ${hooksPill}
      ${errorModePill}
      ${statusPill}
    </div>
  `;
}

export interface VisualizerUpdatePayload {
  machineId: string;
  svgHtml: string;
  headerHtml: string;
  canvasWidth: number;
  canvasHeight: number;
  nodesById: Record<string, VisualizerNode>;
  edgesById: Record<string, EdgeLayout['edge']>;
  hooks: VisualizerGraph['hooks'];
  effects: string[];
  maxEffectChainDepth?: number;
  diagnostics: VisualizerGraph['diagnostics'];
  initialStateId?: string;
}

export function buildVisualizerUpdatePayload(
  input: LayoutGraph | VisualizerGraph
): VisualizerUpdatePayload {
  const layout = 'nodes' in input ? input : computeGraphLayout(input);
  const { graph } = layout;

  const nodesById: Record<string, VisualizerNode> = {};
  for (const n of graph.allNodes) {
    nodesById[n.id] = n;
  }

  const edgesById: Record<string, EdgeLayout['edge']> = {};
  for (const e of graph.edges) {
    edgesById[e.id] = e;
  }

  return {
    machineId: graph.machineId,
    svgHtml: renderStatechartSvg(layout),
    headerHtml: renderHeaderMetaHtml(graph),
    canvasWidth: layout.width,
    canvasHeight: layout.height,
    nodesById,
    edgesById,
    hooks: graph.hooks,
    effects: graph.effects,
    maxEffectChainDepth: graph.maxEffectChainDepth,
    diagnostics: graph.diagnostics,
    initialStateId: graph.rootInitialId ?? graph.rootNodes[0]?.id
  };
}

export interface RenderHtmlOptions {
  nonce?: string;
}

/**
 * Renders the complete interactive VS Code Webview HTML document (HTML + SVG + CSS + JS)
 * supporting pan/zoom, theme adaptation, State & Effective Policy Inspector, and live two-way sync.
 */
export function renderVisualizerHtml(
  input: LayoutGraph | VisualizerGraph | string,
  options?: RenderHtmlOptions
): string {
  const graph = typeof input === 'string' ? buildVisualizerGraph(input) : 'nodes' in input ? input.graph : input;
  const layout = typeof input !== 'string' && 'nodes' in input ? input : computeGraphLayout(graph);
  const payload = buildVisualizerUpdatePayload(layout);
  const nonceAttr = options?.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  const serializedPayload = JSON.stringify(payload).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DFSM Statechart Studio — ${escapeHtml(graph.machineId)}</title>
  <style>
    :root {
      --bg-canvas: var(--vscode-editor-background, #0f172a);
      --fg-primary: var(--vscode-editor-foreground, #e2e8f0);
      --fg-muted: var(--vscode-descriptionForeground, #94a3b8);
      --panel-bg: var(--vscode-sideBar-background, #1e293b);
      --border-subtle: var(--vscode-panel-border, rgba(148, 163, 184, 0.24));
      --card-bg: color-mix(in srgb, var(--vscode-editor-background, #0f172a) 84%, var(--vscode-editor-foreground, #ffffff) 16%);
      --container-bg: color-mix(in srgb, var(--vscode-editor-background, #0f172a) 93%, var(--vscode-editor-foreground, #ffffff) 7%);
      --accent-blue: #38bdf8;
      --accent-indigo: #818cf8;
      --accent-emerald: #10b981;
      --accent-amber: #f59e0b;
      --accent-red: #ef4444;
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--bg-canvas);
      color: var(--fg-primary);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: 12.5px;
    }

    .studio-shell {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }

    .studio-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 14px;
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border-subtle);
      z-index: 10;
    }

    .studio-title-group {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .studio-machine-id {
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.2px;
    }

    .meta-pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid var(--border-subtle);
      background: rgba(148, 163, 184, 0.12);
    }

    .status-valid { color: #10b981; border-color: rgba(16, 185, 129, 0.4); background: rgba(16, 185, 129, 0.12); }
    .status-warn { color: #f59e0b; border-color: rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.12); }
    .status-error { color: #ef4444; border-color: rgba(239, 68, 68, 0.45); background: rgba(239, 68, 68, 0.14); }
    .error-mode-default { color: #f87171; border-color: rgba(248, 113, 113, 0.35); background: rgba(239, 68, 68, 0.1); }
    .error-mode-custom { color: #fbbf24; border-color: rgba(251, 191, 36, 0.45); background: rgba(245, 158, 11, 0.14); }

    .toolbar-controls {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tool-btn {
      background: rgba(148, 163, 184, 0.14);
      color: var(--fg-primary);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 4px 9px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .tool-btn:hover { background: rgba(148, 163, 184, 0.25); }

    .studio-body {
      display: flex;
      flex: 1;
      min-height: 0;
      position: relative;
    }

    .canvas-stage {
      flex: 1;
      position: relative;
      overflow: hidden;
      cursor: grab;
      background-image: radial-gradient(rgba(148, 163, 184, 0.16) 1px, transparent 1px);
      background-size: 20px 20px;
    }
    .canvas-stage.dragging { cursor: grabbing; }

    .canvas-transform {
      transform-origin: 0 0;
      will-change: transform;
    }

    /* SVG Statechart Styling */
    .dfsm-svg {
      display: block;
      overflow: visible;
      user-select: none;
    }

    .dfsm-node { cursor: pointer; }
    .node-outer-rect {
      fill: var(--card-bg);
      stroke: rgba(148, 163, 184, 0.55);
      stroke-width: 1.6;
      transition: stroke 0.15s ease, filter 0.15s ease;
    }
    .dfsm-container > .node-outer-rect {
      fill: var(--container-bg);
      stroke: rgba(129, 140, 248, 0.6);
      stroke-width: 1.8;
    }
    .dfsm-node.kind-parallel > .node-outer-rect {
      stroke: rgba(56, 189, 248, 0.7);
    }
    .dfsm-node.kind-final > .node-outer-rect {
      stroke: var(--accent-emerald);
      stroke-width: 2;
    }
    .final-inner-rect {
      fill: none;
      stroke: var(--accent-emerald);
      stroke-width: 1.2;
      opacity: 0.85;
    }
    .dfsm-node.kind-error[data-error-mode="default"] > .node-outer-rect {
      fill: rgba(239, 68, 68, 0.10);
      stroke: #ef4444;
      stroke-width: 2;
    }
    .dfsm-node.kind-error[data-error-mode="default"] > .final-inner-rect {
      stroke: #ef4444;
    }
    .dfsm-node.kind-error[data-error-mode="custom"] > .node-outer-rect {
      fill: rgba(245, 158, 11, 0.12);
      stroke: #f59e0b;
      stroke-width: 2.2;
    }

    .dfsm-node:hover > .node-outer-rect {
      stroke: var(--accent-blue);
    }
    .dfsm-node.is-selected > .node-outer-rect,
    .dfsm-node.is-editor-active > .node-outer-rect {
      stroke: #38bdf8;
      stroke-width: 2.8;
      filter: drop-shadow(0 0 8px rgba(56, 189, 248, 0.45));
    }

    .container-header-bg {
      fill: rgba(129, 140, 248, 0.10);
    }
    .dfsm-node.kind-parallel > .container-header-bg {
      fill: rgba(56, 189, 248, 0.10);
    }
    .container-header-line {
      stroke: var(--border-subtle);
      stroke-width: 1;
    }

    .node-title {
      fill: var(--fg-primary);
      font-weight: 700;
      font-size: 13px;
    }
    .node-hooks {
      fill: var(--fg-muted);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .kind-pill { fill: rgba(129, 140, 248, 0.2); stroke: rgba(129, 140, 248, 0.45); stroke-width: 1; }
    .pill-parallel { fill: rgba(56, 189, 248, 0.2); stroke: rgba(56, 189, 248, 0.5); }
    .kind-pill-text { fill: var(--fg-primary); font-size: 10.5px; font-weight: 600; }

    .bullseye-outer { fill: none; stroke: var(--accent-emerald); stroke-width: 1.6; }
    .bullseye-inner { fill: var(--accent-emerald); }
    .dfsm-node.kind-error .bullseye-outer { stroke: #ef4444; }
    .dfsm-node.kind-error .bullseye-inner { fill: #ef4444; }

    .parallel-region-divider {
      stroke: rgba(56, 189, 248, 0.65);
      stroke-width: 1.6;
    }

    .initial-dot { fill: var(--accent-blue); }
    .initial-arrow { stroke: var(--accent-blue); stroke-width: 1.8; fill: none; }
    .marker-initial { fill: var(--accent-blue); }

    /* Edges */
    .dfsm-edge { cursor: pointer; }
    .edge-hit-area {
      fill: none;
      stroke: transparent;
      stroke-width: 14;
    }
    .edge-path {
      fill: none;
      stroke: rgba(148, 163, 184, 0.85);
      stroke-width: 1.8;
    }
    .edge-onDone .edge-path { stroke: var(--accent-emerald); stroke-width: 2; }
    .edge-onFail .edge-path { stroke: #f97316; stroke-width: 1.8; }

    .dfsm-edge.is-selected .edge-path {
      stroke: #38bdf8;
      stroke-width: 2.6;
    }

    .marker-event { fill: rgba(148, 163, 184, 0.92); }
    .marker-onDone { fill: var(--accent-emerald); }
    .marker-onFail { fill: #f97316; }

    .edge-label-bg {
      fill: var(--panel-bg);
      stroke: rgba(148, 163, 184, 0.45);
      stroke-width: 1.2;
    }
    .edge-onDone .edge-label-bg { stroke: rgba(16, 185, 129, 0.6); }
    .edge-onFail .edge-label-bg { stroke: rgba(249, 115, 22, 0.65); }

    .edge-label-text {
      fill: var(--fg-primary);
      font-size: 11px;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .transition-badge rect { stroke-width: 1; }
    .transition-badge text { font-size: 9.8px; font-weight: 700; fill: var(--fg-primary); }
    .badge-retry rect { fill: rgba(56, 189, 248, 0.2); stroke: rgba(56, 189, 248, 0.6); }
    .badge-circuitBreaker rect { fill: rgba(245, 158, 11, 0.22); stroke: rgba(245, 158, 11, 0.7); }
    .badge-compensate rect { fill: rgba(168, 85, 247, 0.22); stroke: rgba(168, 85, 247, 0.65); }
    .badge-effects rect { fill: rgba(16, 185, 129, 0.2); stroke: rgba(16, 185, 129, 0.6); }

    /* Inspector Sidebar */
    .inspector-sidebar {
      width: 340px;
      background: var(--panel-bg);
      border-left: 1px solid var(--border-subtle);
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .inspector-sidebar.hidden { display: none; }

    .inspector-section {
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 10px 12px;
      background: rgba(148, 163, 184, 0.05);
    }
    .inspector-heading {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--fg-muted);
      font-weight: 700;
      margin: 0 0 8px 0;
    }
    .kv-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 3px 0;
      font-size: 11.5px;
    }
    .kv-key { color: var(--fg-muted); }
    .kv-val { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; text-align: right; }

    .transition-card {
      border: 1px solid var(--border-subtle);
      border-radius: 7px;
      padding: 8px 10px;
      margin-top: 8px;
      cursor: pointer;
      background: rgba(15, 23, 42, 0.25);
    }
    .transition-card:hover { border-color: var(--accent-blue); }
    .transition-card-title {
      font-weight: 700;
      font-family: var(--vscode-editor-font-family, monospace);
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .src-tag {
      font-size: 9.5px;
      padding: 1px 5px;
      border-radius: 4px;
      margin-left: 4px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .src-transition { background: rgba(56, 189, 248, 0.22); color: #38bdf8; }
    .src-defaults { background: rgba(245, 158, 11, 0.22); color: #fbbf24; }
    .src-sdk { background: rgba(148, 163, 184, 0.18); color: var(--fg-muted); }

    .diag-item {
      padding: 6px 8px;
      border-radius: 6px;
      margin-bottom: 6px;
      font-size: 11.5px;
      cursor: pointer;
      border-left: 3px solid var(--fg-muted);
      background: rgba(148, 163, 184, 0.08);
    }
    .diag-error { border-left-color: #ef4444; }
    .diag-warning { border-left-color: #f59e0b; }
    .diag-info { border-left-color: #38bdf8; }
  </style>
</head>
<body>
  <div class="studio-shell">
    <header class="studio-header">
      <div id="header-meta">${payload.headerHtml}</div>
      <div class="toolbar-controls">
        <button class="tool-btn" id="btn-zoom-out" title="Zoom Out">−</button>
        <span id="zoom-readout" style="min-width:44px;text-align:center;font-weight:600;">100%</span>
        <button class="tool-btn" id="btn-zoom-in" title="Zoom In">+</button>
        <button class="tool-btn" id="btn-fit" title="Fit Statechart to View">Fit</button>
        <button class="tool-btn" id="btn-inspector" title="Toggle State & Policy Inspector">Inspector</button>
      </div>
    </header>
    <div class="studio-body">
      <div class="canvas-stage" id="canvas-stage">
        <div class="canvas-transform" id="canvas-transform">${payload.svgHtml}</div>
      </div>
      <aside class="inspector-sidebar" id="inspector-sidebar"></aside>
    </div>
  </div>

  <script${nonceAttr}>
    (function () {
      const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
      let state = ${serializedPayload};
      let selectedStateId = state.initialStateId || Object.keys(state.nodesById)[0] || null;
      let selectedEdgeId = null;

      let scale = 1;
      let panX = 24;
      let panY = 20;
      let isDragging = false;
      let dragStartX = 0;
      let dragStartY = 0;

      const stageEl = document.getElementById('canvas-stage');
      const transformEl = document.getElementById('canvas-transform');
      const headerMetaEl = document.getElementById('header-meta');
      const zoomReadoutEl = document.getElementById('zoom-readout');
      const inspectorEl = document.getElementById('inspector-sidebar');

      function esc(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function applyTransform() {
        transformEl.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
        zoomReadoutEl.textContent = Math.round(scale * 100) + '%';
      }

      function fitToView() {
        const rect = stageEl.getBoundingClientRect();
        if (!rect.width || !rect.height || !state.canvasWidth || !state.canvasHeight) return;
        const pad = 32;
        const sx = (rect.width - pad * 2) / state.canvasWidth;
        const sy = (rect.height - pad * 2) / state.canvasHeight;
        scale = Math.max(0.25, Math.min(1.25, Math.min(sx, sy)));
        panX = Math.round((rect.width - state.canvasWidth * scale) / 2);
        panY = Math.round((rect.height - state.canvasHeight * scale) / 2);
        applyTransform();
      }

      function updateSelectionClasses() {
        document.querySelectorAll('.dfsm-node').forEach((el) => {
          const id = el.getAttribute('data-state-id');
          el.classList.toggle('is-selected', id === selectedStateId);
        });
        document.querySelectorAll('.dfsm-edge').forEach((el) => {
          const id = el.getAttribute('data-edge-id');
          el.classList.toggle('is-selected', id === selectedEdgeId);
        });
      }

      function srcBadge(src) {
        const label = src || 'sdk';
        return '<span class="src-tag src-' + esc(label) + '">' + esc(label) + '</span>';
      }

      function renderPolicyPreview(t) {
        const p = t.effectivePolicy;
        const s = t.policySources || {};
        return (
          '<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border-subtle);">' +
            '<div style="font-size:10.5px;color:var(--fg-muted);font-weight:700;margin-bottom:4px;">Effective Merged Policy</div>' +
            '<div class="kv-row"><span class="kv-key">retry.maxAttempts</span><span class="kv-val">' + p.retry.maxAttempts + srcBadge(s['retry.maxAttempts']) + '</span></div>' +
            '<div class="kv-row"><span class="kv-key">backoff</span><span class="kv-val">' + esc(p.retry.backoff.strategy) + ' (' + p.retry.backoff.initialDelayMs + 'ms)' + srcBadge(s['retry.backoff.strategy']) + '</span></div>' +
            '<div class="kv-row"><span class="kv-key">circuitBreaker</span><span class="kv-val">' + (p.circuitBreaker.enabled ? 'ON (thr=' + p.circuitBreaker.failureThreshold + ')' : 'off') + srcBadge(s['circuitBreaker.enabled']) + '</span></div>' +
            '<div class="kv-row"><span class="kv-key">onFail.target</span><span class="kv-val">' + esc(p.onFail.target) + srcBadge(s['onFail.target']) + '</span></div>' +
            '<div class="kv-row"><span class="kv-key">onFail.compensate</span><span class="kv-val">' + String(p.onFail.compensate) + srcBadge(s['onFail.compensate']) + '</span></div>' +
            '<div class="kv-row"><span class="kv-key">benchmark</span><span class="kv-val">' + (p.benchmark.enabled ? 'enabled' : 'disabled') + srcBadge(s['benchmark.enabled']) + '</span></div>' +
          '</div>'
        );
      }

      function renderInspector() {
        const node = selectedStateId ? state.nodesById[selectedStateId] : null;
        let html = '';

        if (node) {
          html += '<div class="inspector-section">';
          html += '<h3 class="inspector-heading">State Inspector</h3>';
          html += '<div class="kv-row"><span class="kv-key">Path</span><span class="kv-val">' + esc(node.id) + '</span></div>';
          html += '<div class="kv-row"><span class="kv-key">Classification</span><span class="kv-val">' + esc(node.kind) + (node.errorMode ? ' (' + esc(node.errorMode) + ')' : '') + '</span></div>';
          if (node.initialChildId) {
            html += '<div class="kv-row"><span class="kv-key">Initial Child</span><span class="kv-val">' + esc(node.initialChildId) + '</span></div>';
          }
          if (node.entry && node.entry.length) {
            html += '<div class="kv-row"><span class="kv-key">Entry Effects</span><span class="kv-val">' + esc(node.entry.join(', ')) + '</span></div>';
          }
          if (node.exit && node.exit.length) {
            html += '<div class="kv-row"><span class="kv-key">Exit Effects</span><span class="kv-val">' + esc(node.exit.join(', ')) + '</span></div>';
          }
          if (node.range) {
            html += '<div class="kv-row"><span class="kv-key">YAML Line</span><span class="kv-val">L' + node.range.line + ':' + node.range.column + '</span></div>';
          }
          html += '</div>';

          html += '<div class="inspector-section">';
          html += '<h3 class="inspector-heading">Transitions & Effective Policies (' + node.transitions.length + ')</h3>';
          if (node.transitions.length === 0) {
            html += '<div style="color:var(--fg-muted);font-size:11.5px;">No outgoing transitions declared on this state.</div>';
          } else {
            node.transitions.forEach((t, idx) => {
              html += '<div class="transition-card" data-jump-transition="' + idx + '">';
              html += '<div class="transition-card-title"><span>' + esc(t.event) + ' → ' + esc(t.resolvedTarget || t.target || '(self)') + '</span></div>';
              if (t.handler) {
                html += '<div class="kv-row"><span class="kv-key">Handler</span><span class="kv-val">' + esc(t.handler) + '</span></div>';
              }
              if (t.compensate) {
                html += '<div class="kv-row"><span class="kv-key">Saga Compensate</span><span class="kv-val">' + esc(t.compensate) + '</span></div>';
              }
              if (t.effects && t.effects.length) {
                html += '<div class="kv-row"><span class="kv-key">Effects</span><span class="kv-val">' + esc(t.effects.join(', ')) + '</span></div>';
              }
              html += renderPolicyPreview(t);
              html += '</div>';
            });
          }
          html += '</div>';
        }

        const hookOrder = ['onStart', 'beforeTransition', 'afterTransition', 'onCompensate', 'onComplete', 'onTerminal'];
        const activeHookEntries = hookOrder.filter((k) => state.hooks && state.hooks[k] && state.hooks[k].length > 0);
        if (activeHookEntries.length > 0 || (state.effects && state.effects.length > 0) || state.maxEffectChainDepth !== undefined) {
          html += '<div class="inspector-section">';
          html += '<h3 class="inspector-heading">Machine Hooks &amp; Routed Effects</h3>';
          activeHookEntries.forEach((slot) => {
            html += '<div class="kv-row"><span class="kv-key">hooks.' + esc(slot) + '</span><span class="kv-val">' + esc(state.hooks[slot].join(', ')) + '</span></div>';
          });
          if (state.effects && state.effects.length > 0) {
            html += '<div class="kv-row"><span class="kv-key">effects (routed)</span><span class="kv-val">' + esc(state.effects.join(', ')) + '</span></div>';
          }
          if (state.maxEffectChainDepth !== undefined) {
            html += '<div class="kv-row"><span class="kv-key">maxEffectChainDepth</span><span class="kv-val">' + esc(state.maxEffectChainDepth) + '</span></div>';
          }
          html += '</div>';
        }

        html += '<div class="inspector-section">';
        html += '<h3 class="inspector-heading">Diagnostics (' + state.diagnostics.length + ')</h3>';
        if (state.diagnostics.length === 0) {
          html += '<div style="color:var(--fg-muted);">No issues detected.</div>';
        } else {
          state.diagnostics.forEach((d, idx) => {
            html += '<div class="diag-item diag-' + esc(d.severity) + '" data-diag-idx="' + idx + '">';
            html += '<div style="font-weight:700;">[' + esc(d.severity.toUpperCase()) + '] L' + d.range.line + ' · ' + esc(d.code) + '</div>';
            html += '<div>' + esc(d.message) + '</div>';
            html += '</div>';
          });
        }
        html += '</div>';

        inspectorEl.innerHTML = html;

        inspectorEl.querySelectorAll('[data-jump-transition]').forEach((card) => {
          card.addEventListener('click', () => {
            const idx = Number(card.getAttribute('data-jump-transition'));
            const t = node && node.transitions[idx];
            if (t) {
              selectedEdgeId = t.id;
              updateSelectionClasses();
              if (vscode && t.range) {
                vscode.postMessage({ type: 'revealRange', range: t.range, stateId: node.id, edgeId: t.id });
              }
            }
          });
        });

        inspectorEl.querySelectorAll('[data-diag-idx]').forEach((item) => {
          item.addEventListener('click', () => {
            const idx = Number(item.getAttribute('data-diag-idx'));
            const d = state.diagnostics[idx];
            if (vscode && d && d.range) {
              vscode.postMessage({ type: 'revealRange', range: d.range });
            }
          });
        });
      }

      function bindSvgEvents() {
        transformEl.querySelectorAll('.dfsm-node').forEach((nodeEl) => {
          nodeEl.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const stateId = nodeEl.getAttribute('data-state-id');
            if (!stateId) return;
            selectedStateId = stateId;
            selectedEdgeId = null;
            updateSelectionClasses();
            renderInspector();
            const nodeObj = state.nodesById[stateId];
            if (vscode && nodeObj && nodeObj.range) {
              vscode.postMessage({ type: 'revealRange', range: nodeObj.range, stateId });
            }
          });
        });

        transformEl.querySelectorAll('.dfsm-edge').forEach((edgeEl) => {
          edgeEl.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const edgeId = edgeEl.getAttribute('data-edge-id');
            if (!edgeId) return;
            selectedEdgeId = edgeId;
            const edgeObj = state.edgesById[edgeId];
            if (edgeObj) {
              selectedStateId = edgeObj.source;
            }
            updateSelectionClasses();
            renderInspector();
            if (vscode && edgeObj && edgeObj.range) {
              vscode.postMessage({
                type: 'revealRange',
                range: edgeObj.range,
                stateId: edgeObj.source,
                edgeId
              });
            }
          });
        });
      }

      // Pan & Zoom handlers
      stageEl.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        isDragging = true;
        dragStartX = ev.clientX - panX;
        dragStartY = ev.clientY - panY;
        stageEl.classList.add('dragging');
      });

      window.addEventListener('mousemove', (ev) => {
        if (!isDragging) return;
        panX = ev.clientX - dragStartX;
        panY = ev.clientY - dragStartY;
        applyTransform();
      });

      window.addEventListener('mouseup', () => {
        isDragging = false;
        stageEl.classList.remove('dragging');
      });

      stageEl.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const factor = ev.deltaY < 0 ? 1.1 : 0.9;
        const nextScale = Math.max(0.2, Math.min(2.5, scale * factor));
        const rect = stageEl.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        panX = mx - ((mx - panX) / scale) * nextScale;
        panY = my - ((my - panY) / scale) * nextScale;
        scale = nextScale;
        applyTransform();
      }, { passive: false });

      document.getElementById('btn-zoom-in').addEventListener('click', () => {
        scale = Math.min(2.5, scale * 1.15);
        applyTransform();
      });
      document.getElementById('btn-zoom-out').addEventListener('click', () => {
        scale = Math.max(0.2, scale / 1.15);
        applyTransform();
      });
      document.getElementById('btn-fit').addEventListener('click', fitToView);
      document.getElementById('btn-inspector').addEventListener('click', () => {
        inspectorEl.classList.toggle('hidden');
      });

      // Receive live updates & cursor highlights from Extension Host
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === 'updateGraph' && msg.payload) {
          const prevMachine = state.machineId;
          state = msg.payload;
          headerMetaEl.innerHTML = state.headerHtml;
          transformEl.innerHTML = state.svgHtml;
          if (!selectedStateId || !state.nodesById[selectedStateId]) {
            selectedStateId = state.initialStateId || Object.keys(state.nodesById)[0] || null;
          }
          bindSvgEvents();
          updateSelectionClasses();
          renderInspector();
          if (prevMachine !== state.machineId) {
            fitToView();
          }
        } else if (msg.type === 'highlightState') {
          document.querySelectorAll('.dfsm-node.is-editor-active').forEach((el) => {
            el.classList.remove('is-editor-active');
          });
          if (msg.stateId && state.nodesById[msg.stateId]) {
            selectedStateId = msg.stateId;
            selectedEdgeId = msg.transitionId || null;
            const activeNodeEl = transformEl.querySelector('[data-state-id="' + CSS.escape(msg.stateId) + '"]');
            if (activeNodeEl) {
              activeNodeEl.classList.add('is-editor-active');
            }
            updateSelectionClasses();
            renderInspector();
          }
        }
      });

      bindSvgEvents();
      updateSelectionClasses();
      renderInspector();
      requestAnimationFrame(fitToView);
    })();
  </script>
</body>
</html>`;
}
