import type {
  EdgeLayout,
  InitialMarkerLayout,
  LayoutGraph,
  NodeBoxLayout,
  ParallelDividerLayout,
  VisualizerEdge,
  VisualizerGraph,
  VisualizerNode
} from './types';

interface MeasuredTree {
  node: VisualizerNode;
  relX: number;
  relY: number;
  width: number;
  height: number;
  headerHeight: number;
  children: MeasuredTree[];
  dividers: Array<{ relX1: number; relY1: number; relX2: number; relY2: number }>;
  initialMarker?: {
    targetNodeId: string;
    relDotX: number;
    relDotY: number;
    relTargetX: number;
    relTargetY: number;
  };
}

const H_GAP = 64;
const V_GAP = 86;
const CONTAINER_PAD_X = 28;
const CONTAINER_PAD_BOTTOM = 28;
const INITIAL_MARKER_SPACE = 24;
const PARALLEL_REGION_GAP = 40;

function estimateLeafSize(node: VisualizerNode): { width: number; height: number; headerHeight: number } {
  const charWidth = 8.2;
  const labelWidth = Math.ceil(node.label.length * charWidth) + 68;
  const hooksTextLen = Math.max(
    node.entry.length > 0 ? `entry: ${node.entry.join(', ')}`.length : 0,
    node.exit.length > 0 ? `exit: ${node.exit.join(', ')}`.length : 0
  );
  const hooksWidth = hooksTextLen > 0 ? Math.ceil(hooksTextLen * 6.8) + 36 : 0;
  const width = Math.max(180, Math.min(310, Math.max(labelWidth, hooksWidth)));

  let height = 62;
  if (node.entry.length > 0) height += 20;
  if (node.exit.length > 0) height += 20;
  if (node.kind === 'error') height = Math.max(height, 68);

  return { width, height, headerHeight: height };
}

function topSiblingAncestor(nodeId: string, parentId: string | null): string | null {
  if (parentId === null) {
    const dot = nodeId.indexOf('.');
    return dot === -1 ? nodeId : nodeId.slice(0, dot);
  }
  const prefix = `${parentId}.`;
  if (!nodeId.startsWith(prefix)) {
    return null;
  }
  const rest = nodeId.slice(prefix.length);
  const dot = rest.indexOf('.');
  const childKey = dot === -1 ? rest : rest.slice(0, dot);
  return `${parentId}.${childKey}`;
}

/**
 * Assigns vertical Sugiyama ranks to sibling nodes inside a compound container (or root)
 * based on intra-container transition flow starting from `initialId`.
 */
function arrangeCompoundSiblings(
  measuredChildren: MeasuredTree[],
  parentId: string | null,
  initialChildId: string | undefined,
  allEdges: VisualizerEdge[]
): {
  totalWidth: number;
  totalHeight: number;
} {
  if (measuredChildren.length === 0) {
    return { totalWidth: 200, totalHeight: 80 };
  }

  const byId = new Map<string, MeasuredTree>();
  for (const m of measuredChildren) {
    byId.set(m.node.id, m);
  }

  // Separate normal states from root `error` node so `error` sits cleanly to the side/bottom
  const mainNodes = measuredChildren.filter((m) => m.node.kind !== 'error');
  const errorNodes = measuredChildren.filter((m) => m.node.kind === 'error');

  const adj = new Map<string, Set<string>>();
  for (const m of mainNodes) {
    adj.set(m.node.id, new Set());
  }

  for (const e of allEdges) {
    if (e.edgeKind === 'onFail') continue;
    const u = topSiblingAncestor(e.source, parentId);
    const v = topSiblingAncestor(e.target, parentId);
    if (u && v && u !== v && adj.has(u) && adj.has(v)) {
      adj.get(u)!.add(v);
    }
  }
  // Include onFail targets to non-error siblings (e.g. `fallback_queue`)
  for (const e of allEdges) {
    if (e.edgeKind !== 'onFail') continue;
    const u = topSiblingAncestor(e.source, parentId);
    const v = topSiblingAncestor(e.target, parentId);
    if (u && v && u !== v && adj.has(u) && adj.has(v)) {
      adj.get(u)!.add(v);
    }
  }

  const ranks = new Map<string, number>();
  const queue: string[] = [];

  if (initialChildId && adj.has(initialChildId)) {
    ranks.set(initialChildId, 0);
    queue.push(initialChildId);
  } else if (mainNodes.length > 0) {
    ranks.set(mainNodes[0].node.id, 0);
    queue.push(mainNodes[0].node.id);
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const r = ranks.get(curr)!;
    for (const nxt of adj.get(curr) ?? []) {
      if (!ranks.has(nxt)) {
        ranks.set(nxt, r + 1);
        queue.push(nxt);
      }
    }
  }

  let maxRank = 0;
  for (const r of ranks.values()) {
    if (r > maxRank) maxRank = r;
  }
  for (const m of mainNodes) {
    if (!ranks.has(m.node.id)) {
      maxRank += 1;
      ranks.set(m.node.id, maxRank);
    }
  }

  const layers = new Map<number, MeasuredTree[]>();
  for (const m of mainNodes) {
    const r = ranks.get(m.node.id) ?? 0;
    if (!layers.has(r)) layers.set(r, []);
    layers.get(r)!.push(m);
  }

  const sortedRanks = [...layers.keys()].sort((a, b) => a - b);

  let maxLayerWidth = 0;
  const layerWidths = new Map<number, number>();
  const layerHeights = new Map<number, number>();

  for (const r of sortedRanks) {
    const row = layers.get(r)!;
    const rowWidth = row.reduce((acc, item) => acc + item.width, 0) + H_GAP * (row.length - 1);
    const rowHeight = row.reduce((acc, item) => Math.max(acc, item.height), 0);
    layerWidths.set(r, rowWidth);
    layerHeights.set(r, rowHeight);
    if (rowWidth > maxLayerWidth) {
      maxLayerWidth = rowWidth;
    }
  }

  let cursorY = 0;
  for (const r of sortedRanks) {
    const row = layers.get(r)!;
    const rowWidth = layerWidths.get(r)!;
    const rowHeight = layerHeights.get(r)!;
    let cursorX = Math.round((maxLayerWidth - rowWidth) / 2);

    for (const item of row) {
      item.relX = cursorX;
      item.relY = cursorY + Math.round((rowHeight - item.height) / 2);
      cursorX += item.width + H_GAP;
    }
    cursorY += rowHeight + V_GAP;
  }

  let mainHeight = cursorY > 0 ? cursorY - V_GAP : 0;
  let totalWidth = maxLayerWidth;

  // Place `error` node(s) in a dedicated right-hand fault lane (or centered if no main nodes)
  if (errorNodes.length > 0) {
    const faultX = mainNodes.length > 0 ? maxLayerWidth + H_GAP + 28 : 0;
    let faultY = mainNodes.length > 0 ? Math.max(0, Math.round(mainHeight * 0.35)) : 0;
    let maxErrWidth = 0;

    for (const errItem of errorNodes) {
      errItem.relX = faultX;
      errItem.relY = faultY;
      faultY += errItem.height + V_GAP;
      maxErrWidth = Math.max(maxErrWidth, errItem.width);
    }

    const errBottom = faultY - V_GAP;
    totalWidth = faultX + maxErrWidth;
    mainHeight = Math.max(mainHeight, errBottom);
  }

  return {
    totalWidth: Math.max(totalWidth, 180),
    totalHeight: Math.max(mainHeight, 64)
  };
}

function measureNodeRecursive(node: VisualizerNode, allEdges: VisualizerEdge[]): MeasuredTree {
  if (node.children.length === 0) {
    const leaf = estimateLeafSize(node);
    return {
      node,
      relX: 0,
      relY: 0,
      width: leaf.width,
      height: leaf.height,
      headerHeight: leaf.headerHeight,
      children: [],
      dividers: []
    };
  }

  const measuredChildren = node.children.map((c) => measureNodeRecursive(c, allEdges));
  const hasHooks = node.entry.length > 0 || node.exit.length > 0;
  const headerHeight = hasHooks ? 58 : 42;

  if (node.kind === 'parallel') {
    // Orthogonal regions arranged side-by-side separated by dashed vertical dividers
    let cursorX = CONTAINER_PAD_X;
    const contentTop = headerHeight + 20;
    let maxRegionHeight = 0;

    for (const region of measuredChildren) {
      if (region.height > maxRegionHeight) {
        maxRegionHeight = region.height;
      }
    }

    const dividers: Array<{ relX1: number; relY1: number; relX2: number; relY2: number }> = [];
    measuredChildren.forEach((region, idx) => {
      region.relX = cursorX;
      region.relY = contentTop;
      // Equalize orthogonal region heights for crisp parallel lane appearance
      region.height = Math.max(region.height, maxRegionHeight);
      cursorX += region.width;

      if (idx < measuredChildren.length - 1) {
        const divX = Math.round(cursorX + PARALLEL_REGION_GAP / 2);
        dividers.push({
          relX1: divX,
          relY1: headerHeight + 8,
          relX2: divX,
          relY2: contentTop + maxRegionHeight + 12
        });
        cursorX += PARALLEL_REGION_GAP;
      }
    });

    const totalWidth = Math.max(cursorX + CONTAINER_PAD_X, node.label.length * 9 + 110);
    const totalHeight = contentTop + maxRegionHeight + CONTAINER_PAD_BOTTOM;

    return {
      node,
      relX: 0,
      relY: 0,
      width: totalWidth,
      height: totalHeight,
      headerHeight,
      children: measuredChildren,
      dividers
    };
  }

  // Compound container
  const subBox = arrangeCompoundSiblings(
    measuredChildren,
    node.id,
    node.initialChildId,
    allEdges
  );

  const markerOffset = node.initialChildId ? INITIAL_MARKER_SPACE : 0;
  const contentTop = headerHeight + 18 + markerOffset;
  const minHeaderWidth = node.label.length * 9 + 120;
  const innerWidth = Math.max(subBox.totalWidth, minHeaderWidth - CONTAINER_PAD_X * 2);
  const shiftX = CONTAINER_PAD_X + Math.round((innerWidth - subBox.totalWidth) / 2);

  for (const child of measuredChildren) {
    child.relX += shiftX;
    child.relY += contentTop;
  }

  let initialMarker: MeasuredTree['initialMarker'];
  if (node.initialChildId) {
    const targetChild = measuredChildren.find((c) => c.node.id === node.initialChildId);
    if (targetChild) {
      const targetX = targetChild.relX + Math.round(targetChild.width / 2);
      const targetY = targetChild.relY;
      initialMarker = {
        targetNodeId: targetChild.node.id,
        relDotX: targetX,
        relDotY: targetY - 18,
        relTargetX: targetX,
        relTargetY: targetY
      };
    }
  }

  return {
    node,
    relX: 0,
    relY: 0,
    width: innerWidth + CONTAINER_PAD_X * 2,
    height: contentTop + subBox.totalHeight + CONTAINER_PAD_BOTTOM,
    headerHeight,
    children: measuredChildren,
    dividers: [],
    initialMarker
  };
}

function flattenMeasuredTree(
  tree: MeasuredTree,
  absX: number,
  absY: number,
  depth: number,
  boxes: NodeBoxLayout[],
  dividers: ParallelDividerLayout[],
  initialMarkers: InitialMarkerLayout[]
): void {
  const x = absX + tree.relX;
  const y = absY + tree.relY;

  boxes.push({
    node: tree.node,
    x,
    y,
    width: tree.width,
    height: tree.height,
    headerHeight: tree.headerHeight,
    depth
  });

  for (const d of tree.dividers) {
    dividers.push({
      parallelNodeId: tree.node.id,
      x1: x + d.relX1,
      y1: y + d.relY1,
      x2: x + d.relX2,
      y2: y + d.relY2
    });
  }

  if (tree.initialMarker) {
    const dotX = x + tree.initialMarker.relDotX;
    const dotY = y + tree.initialMarker.relDotY;
    const tx = x + tree.initialMarker.relTargetX;
    const ty = y + tree.initialMarker.relTargetY - 2;
    initialMarkers.push({
      ownerId: tree.node.id,
      targetNodeId: tree.initialMarker.targetNodeId,
      dotX,
      dotY,
      pathD: `M ${dotX} ${dotY + 4} L ${tx} ${ty}`
    });
  }

  for (const child of tree.children) {
    flattenMeasuredTree(child, x, y, depth + 1, boxes, dividers, initialMarkers);
  }
}

function cubicMidpoint(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number
): { x: number; y: number } {
  return {
    x: Math.round(0.125 * x0 + 0.375 * x1 + 0.375 * x2 + 0.125 * x3),
    y: Math.round(0.125 * y0 + 0.375 * y1 + 0.375 * y2 + 0.125 * y3)
  };
}

function routeEdges(edges: VisualizerEdge[], boxMap: Map<string, NodeBoxLayout>): EdgeLayout[] {
  const pairGroups = new Map<string, VisualizerEdge[]>();
  for (const e of edges) {
    const key = e.source < e.target ? `${e.source}__${e.target}` : `${e.target}__${e.source}`;
    if (!pairGroups.has(key)) pairGroups.set(key, []);
    pairGroups.get(key)!.push(e);
  }

  const routed: EdgeLayout[] = [];

  for (const e of edges) {
    const src = boxMap.get(e.source);
    const dst = boxMap.get(e.target);
    if (!src || !dst) continue;

    // Self-transition loop
    if (e.source === e.target) {
      const sx = src.x + src.width;
      const sy = src.y + Math.round(src.height * 0.35);
      const ex = src.x + src.width;
      const ey = src.y + Math.round(src.height * 0.7);
      const loopW = 54;
      const pathD = `M ${sx} ${sy} C ${sx + loopW} ${sy - 24}, ${ex + loopW} ${ey + 24}, ${ex} ${ey}`;
      routed.push({
        edge: e,
        pathD,
        labelX: sx + loopW + 8,
        labelY: Math.round((sy + ey) / 2)
      });
      continue;
    }

    const pairKey = e.source < e.target ? `${e.source}__${e.target}` : `${e.target}__${e.source}`;
    const siblings = pairGroups.get(pairKey) ?? [e];
    const idx = siblings.indexOf(e);
    const offset = Math.round((idx - (siblings.length - 1) / 2) * 48);

    const srcCx = src.x + src.width / 2;
    const srcCy = src.y + src.height / 2;
    const dstCx = dst.x + dst.width / 2;
    const dstCy = dst.y + dst.height / 2;

    const dx = dstCx - srcCx;

    // Downward flow
    if (dst.y >= src.y + src.height - 10) {
      const sx = Math.round(srcCx + offset * 0.45);
      const sy = src.y + src.height;
      const tx = Math.round(dstCx + offset * 0.45);
      const ty = dst.y;
      const ctrlY = Math.max(32, Math.round((ty - sy) * 0.5));
      const c1x = sx + offset * 0.6;
      const c1y = sy + ctrlY;
      const c2x = tx + offset * 0.6;
      const c2y = ty - ctrlY;
      const mid = cubicMidpoint(sx, sy, c1x, c1y, c2x, c2y, tx, ty);
      routed.push({
        edge: e,
        pathD: `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`,
        labelX: mid.x,
        labelY: mid.y
      });
      continue;
    }

    // Upward back-edge (e.g. `yellow -> red` or `RECOVER: error -> ready`)
    if (src.y >= dst.y + dst.height - 10 && Math.abs(dx) < Math.max(src.width, dst.width)) {
      const useLeftArc = idx % 2 === 0;
      const sx = useLeftArc ? src.x : src.x + src.width;
      const sy = Math.round(srcCy);
      const tx = useLeftArc ? dst.x : dst.x + dst.width;
      const ty = Math.round(dstCy);
      const arcOut = (useLeftArc ? -1 : 1) * (68 + Math.abs(offset));
      const c1x = sx + arcOut;
      const c1y = sy;
      const c2x = tx + arcOut;
      const c2y = ty;
      const mid = cubicMidpoint(sx, sy, c1x, c1y, c2x, c2y, tx, ty);
      routed.push({
        edge: e,
        pathD: `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`,
        labelX: mid.x,
        labelY: mid.y
      });
      continue;
    }

    // Horizontal / diagonal flow (e.g. to `error` or `fallback_queue` fault lane)
    const goRight = dx >= 0;
    const sx = goRight ? src.x + src.width : src.x;
    const sy = Math.round(srcCy + offset * 0.35);
    const tx = goRight ? dst.x : dst.x + dst.width;
    const ty = Math.round(dstCy + offset * 0.35);
    const spanX = Math.max(44, Math.round(Math.abs(tx - sx) * 0.45));
    const c1x = sx + (goRight ? spanX : -spanX);
    const c1y = sy + offset * 0.5;
    const c2x = tx - (goRight ? spanX : -spanX);
    const c2y = ty + offset * 0.5;
    const mid = cubicMidpoint(sx, sy, c1x, c1y, c2x, c2y, tx, ty);
    routed.push({
      edge: e,
      pathD: `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`,
      labelX: mid.x,
      labelY: mid.y
    });
  }

  return routed;
}

/**
 * Deterministic hierarchical & parallel statechart layout engine in pure TypeScript.
 */
export function computeGraphLayout(graph: VisualizerGraph): LayoutGraph {
  const PAD_CANVAS = 48;

  if (graph.rootNodes.length === 0) {
    return {
      graph,
      width: 480,
      height: 240,
      nodes: [],
      parallelDividers: [],
      initialMarkers: [],
      edges: []
    };
  }

  const measuredRoots = graph.rootNodes.map((n) => measureNodeRecursive(n, graph.edges));
  let canvasContentW = 0;
  let canvasContentH = 0;
  const rootDividers: ParallelDividerLayout[] = [];
  const initialMarkers: InitialMarkerLayout[] = [];

  if (graph.rootType === 'parallel') {
    let cursorX = 0;
    let maxH = 0;
    for (const r of measuredRoots) {
      if (r.height > maxH) maxH = r.height;
    }
    measuredRoots.forEach((r, idx) => {
      r.relX = cursorX;
      r.relY = 0;
      r.height = Math.max(r.height, maxH);
      cursorX += r.width;
      if (idx < measuredRoots.length - 1) {
        const divX = PAD_CANVAS + Math.round(cursorX + PARALLEL_REGION_GAP / 2);
        rootDividers.push({
          parallelNodeId: '__root__',
          x1: divX,
          y1: PAD_CANVAS,
          x2: divX,
          y2: PAD_CANVAS + maxH
        });
        cursorX += PARALLEL_REGION_GAP;
      }
    });
    canvasContentW = cursorX;
    canvasContentH = maxH;
  } else {
    const arranged = arrangeCompoundSiblings(
      measuredRoots,
      null,
      graph.rootInitialId,
      graph.edges
    );
    const rootMarkerSpace = graph.rootInitialId ? INITIAL_MARKER_SPACE : 0;
    for (const r of measuredRoots) {
      r.relY += rootMarkerSpace;
    }
    canvasContentW = arranged.totalWidth;
    canvasContentH = arranged.totalHeight + rootMarkerSpace;

    if (graph.rootInitialId) {
      const targetRoot = measuredRoots.find((r) => r.node.id === graph.rootInitialId);
      if (targetRoot) {
        const dotX = PAD_CANVAS + targetRoot.relX + Math.round(targetRoot.width / 2);
        const ty = PAD_CANVAS + targetRoot.relY;
        const dotY = ty - 18;
        initialMarkers.push({
          ownerId: '__root__',
          targetNodeId: targetRoot.node.id,
          dotX,
          dotY,
          pathD: `M ${dotX} ${dotY + 4} L ${dotX} ${ty - 2}`
        });
      }
    }
  }

  const boxes: NodeBoxLayout[] = [];
  const dividers: ParallelDividerLayout[] = [...rootDividers];

  for (const r of measuredRoots) {
    flattenMeasuredTree(r, PAD_CANVAS, PAD_CANVAS, 0, boxes, dividers, initialMarkers);
  }

  // Sort containers outer-to-inner so SVG renders parent containers behind child cards
  boxes.sort((a, b) => a.depth - b.depth);

  const boxMap = new Map<string, NodeBoxLayout>();
  let maxRight = canvasContentW + PAD_CANVAS * 2;
  let maxBottom = canvasContentH + PAD_CANVAS * 2;

  for (const b of boxes) {
    boxMap.set(b.node.id, b);
    maxRight = Math.max(maxRight, b.x + b.width + PAD_CANVAS);
    maxBottom = Math.max(maxBottom, b.y + b.height + PAD_CANVAS);
  }

  const routedEdges = routeEdges(graph.edges, boxMap);
  for (const e of routedEdges) {
    maxRight = Math.max(maxRight, e.labelX + 120);
    maxBottom = Math.max(maxBottom, e.labelY + 60);
  }

  return {
    graph,
    width: Math.max(640, maxRight),
    height: Math.max(400, maxBottom),
    nodes: boxes,
    parallelDividers: dividers,
    initialMarkers,
    edges: routedEdges
  };
}
