// @ts-nocheck
/* global CodeNodesGraphVendor, acquireVsCodeApi */

const { cytoscape, fcose } = CodeNodesGraphVendor;
cytoscape.use(fcose);

const vscode = acquireVsCodeApi();

// ─── State ────────────────────────────────────────────────────────────────────

let cy = null;
let hullSvg = null;
let currentForces = {};
let firstRender = true;
let layoutTimer = null;
let activeLayout = null;
let dragLastPos = null;
let pendingViewport = null;   // viewport to restore after the next layout/overlap pass
let viewportSaveTimer = null; // debounce handle for saveViewport messages
let hullPolygons = {};        // { groupName: { pts: [...screen pts], padding } } — for group drag hit-testing
let groupingEnabled = true;   // controlled by the "Show Groups" toggle in the settings panel

// How strongly connected nodes follow the dragged node (0 = none, 1 = perfectly track)
const SPRING_FACTOR = 0.28;

// Zoom level below which node labels are hidden (keeps the overview uncluttered)
const LABEL_HIDE_ZOOM = 0.5;

// ─── Cytoscape Init ───────────────────────────────────────────────────────────

function initCytoscape() {
  // SVG layer for group hull blobs — sits behind the Cytoscape canvas
  const svgNS = 'http://www.w3.org/2000/svg';
  hullSvg = document.createElementNS(svgNS, 'svg');
  hullSvg.id = 'hull-svg';
  hullSvg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;transition:opacity 0.5s ease-in;';
  const cyContainer = document.getElementById('cy-container');
  cyContainer.insertBefore(hullSvg, cyContainer.firstChild);

  cy = cytoscape({
    container: cyContainer,
    style: [
      {
        selector: 'node',
        style: {
          'label': 'data(displayName)',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': '6px',
          'font-size': '11px',
          'color': '#dddddd',
          // Label background makes text readable even when near other nodes/edges
          'text-background-color': '#1a1a1a',
          'text-background-opacity': 0.85,
          'text-background-padding': '3px',
          'text-background-shape': 'roundrectangle',
          'text-max-width': '150px',
          'text-wrap': 'ellipsis',
          'background-color': 'data(color)',
          'width': 'data(size)',
          'height': 'data(size)',
          'border-width': 0,
          'cursor': 'pointer',
        },
      },
      {
        selector: 'node:selected',
        style: {
          'border-width': 2,
          'border-color': '#ffffff',
        },
      },
      {
        selector: 'edge',
        style: {
          'width': 1.5,
          'line-color': '#555555',
          'target-arrow-color': '#555555',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'arrow-scale': 0.7,
        },
      },
      {
        selector: 'edge:selected',
        style: {
          'line-color': '#888888',
          'target-arrow-color': '#888888',
        },
      },
      {
        // First-level neighbours of the selected node (real notes)
        selector: 'node[!isGhost].neighbor-highlight',
        style: {
          'background-color': '#e07a52',
          'border-width': 2.5,
          'border-color': '#f4a47a',
          'border-style': 'dashed',
        },
      },
      {
        // First-level neighbours of the selected node (ghost / unwritten notes)
        selector: 'node[?isGhost].neighbor-highlight',
        style: {
          'background-color': '#888888',
          'border-width': 2.5,
          'border-color': '#aaaaaa',
          'border-style': 'dashed',
        },
      },
      {
        // Applied when zoomed out past LABEL_HIDE_ZOOM — hides text to reduce clutter
        selector: 'node.labels-hidden',
        style: { 'label': '' },
      },
      {
        selector: 'node.search-dim',
        style: { 'opacity': 0.12 },
      },
      {
        selector: 'edge.search-dim',
        style: { 'opacity': 0.06 },
      },
    ],
    wheelSensitivity: 0.3,
    minZoom: 0.1,
    maxZoom: 5,
  });

  // Click node → open note
  cy.on('tap', 'node', evt => {
    const node = evt.target;
    vscode.postMessage({
      type: 'openNote',
      nodeId: node.id(),
      displayName: node.data('displayName'),
    });
  });

  // ── Drag physics ──────────────────────────────────────────────────────────

  cy.on('grabon', 'node', evt => {
    if (activeLayout) {
      activeLayout.stop();
      activeLayout = null;
    }
    dragLastPos = { ...evt.target.position() };
  });

  // While dragging: pull connected nodes by a spring fraction of the delta
  cy.on('drag', 'node', evt => {
    const node = evt.target;
    const pos = node.position();
    if (!dragLastPos) { dragLastPos = { ...pos }; return; }

    const dx = pos.x - dragLastPos.x;
    const dy = pos.y - dragLastPos.y;
    dragLastPos = { ...pos };

    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

    node.connectedEdges().connectedNodes().not(node).forEach(neighbor => {
      neighbor.shift({ x: dx * SPRING_FACTOR, y: dy * SPRING_FACTOR });
    });
  });

  // On release: just resolve any overlaps caused by the drag.
  // A fCoSE settle pass was here previously but its gravity force caused the
  // entire graph to drift down-left with each drag operation.
  cy.on('dragfree', 'node', evt => {
    dragLastPos = null;
    resolveOverlaps();
    // Persist updated positions after the user manually moves a node
    savePositions();
  });

  // ── Neighbour highlighting ────────────────────────────────────────────────
  function refreshNeighborHighlight() {
    cy.nodes().removeClass('neighbor-highlight');
    const selected = cy.nodes(':selected');
    if (selected.length > 0) {
      // Highlight direct neighbours that are not themselves selected
      selected.neighborhood('node').not(':selected').addClass('neighbor-highlight');
    }
  }

  cy.on('select unselect', 'node', refreshNeighborHighlight);

  // Clicking the background deselects everything and clears highlights
  cy.on('tap', evt => {
    if (evt.target === cy) refreshNeighborHighlight();
  });

  // ── Zoom-dependent label visibility ──────────────────────────────────────
  // Re-evaluate on every zoom change and apply to any newly added nodes too.
  function updateLabelVisibility() {
    cy.nodes().toggleClass('labels-hidden', cy.zoom() < LABEL_HIDE_ZOOM);
  }
  cy.on('zoom', updateLabelVisibility);

  // ── Dot grid background — tracks pan & zoom so the grid feels infinite ───
  const BASE_GRID = 24; // px at zoom level 1
  function updateGrid() {
    const zoom = cy.zoom();
    const pan  = cy.pan();
    const size = BASE_GRID * zoom;
    cyContainer.style.backgroundSize     = `${size}px ${size}px`;
    cyContainer.style.backgroundPosition = `${pan.x % size}px ${pan.y % size}px`;
  }
  cy.on('zoom pan', updateGrid);
  updateGrid(); // set initial state

  // ── Viewport persistence ──────────────────────────────────────────────────
  cy.on('zoom pan', scheduleViewportSave);

  // ── Hull blob redraws ─────────────────────────────────────────────────────
  cy.on('drag', 'node', redrawHulls);
  cy.on('dragfree', 'node', redrawHulls);
  cy.on('pan zoom', redrawHulls);
  cy.on('layoutstop', redrawHulls);

  // ── Hover tooltip (shows full title at any zoom level) ───────────────────
  const tooltip = document.createElement('div');
  tooltip.id = 'node-tooltip';
  document.body.appendChild(tooltip);

  cy.on('mouseover', 'node', evt => {
    tooltip.textContent = evt.target.data('displayName');
    tooltip.style.display = 'block';
  });

  // Track the cursor via document mousemove so the tooltip follows smoothly
  document.addEventListener('mousemove', e => {
    if (tooltip.style.display !== 'none') {
      // Keep tooltip inside the window on the right/bottom edges
      const pad = 16;
      const tw  = tooltip.offsetWidth;
      const th  = tooltip.offsetHeight;
      const left = e.clientX + 14 + tw > window.innerWidth
        ? e.clientX - tw - 6
        : e.clientX + 14;
      const top = e.clientY - 10 + th > window.innerHeight
        ? e.clientY - th - 6
        : e.clientY - 10;
      tooltip.style.left = `${left}px`;
      tooltip.style.top  = `${top}px`;
    }
  });

  cy.on('mouseout', 'node', () => {
    tooltip.style.display = 'none';
  });

  // Hide tooltip while dragging so it doesn't get in the way
  cy.on('grabon', () => { tooltip.style.display = 'none'; });

  // ── Group drag ────────────────────────────────────────────────────────────
  // Clicking empty space inside a group hull drags all nodes in that group.
  // Clicking outside any group reverts to normal cytoscape panning.

  let groupDragState = null;

  /** True if there is a cytoscape node whose circle contains (graphX, graphY). */
  function nodeAtGraphPoint(graphX, graphY) {
    return cy.nodes().some(n => {
      const pos = n.position();
      const r = (n.data('size') || 20) / 2;
      return (graphX - pos.x) ** 2 + (graphY - pos.y) ** 2 <= r * r;
    });
  }

  // Capture phase so this fires before cytoscape's own listeners on the canvas.
  cyContainer.addEventListener('mousedown', e => {
    if (e.button !== 0) return; // left button only

    const rect = cyContainer.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Pass through if a node is under the cursor (let cytoscape handle node drag)
    const pan = cy.pan(), zoom = cy.zoom();
    const graphX = (sx - pan.x) / zoom;
    const graphY = (sy - pan.y) / zoom;
    if (nodeAtGraphPoint(graphX, graphY)) return;
    if (!groupingEnabled) return;

    const group = groupAtScreenPoint(sx, sy);
    if (!group) return; // empty canvas area — normal pan

    // Intercept: stop the event reaching cytoscape so it never starts a pan
    e.stopPropagation();

    groupDragState = { groupName: group, lastX: e.clientX, lastY: e.clientY };
    cyContainer.classList.remove('group-hoverable');
    cyContainer.classList.add('group-dragging');
    tooltip.style.display = 'none';

    const onMove = me => {
      if (!groupDragState) return;
      const z = cy.zoom();
      const dx = (me.clientX - groupDragState.lastX) / z;
      const dy = (me.clientY - groupDragState.lastY) / z;
      groupDragState.lastX = me.clientX;
      groupDragState.lastY = me.clientY;

      cy.nodes()
        .filter(n => n.data('group') === groupDragState.groupName && !n.data('isGhost'))
        .forEach(n => {
          const pos = n.position();
          n.position({ x: pos.x + dx, y: pos.y + dy });
        });
      redrawHulls();
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      groupDragState = null;
      cyContainer.classList.remove('group-dragging');
      resolveOverlaps();
      savePositions();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, true); // true = capture phase

  // Show grab cursor when hovering inside a group but not over a node
  cyContainer.addEventListener('mousemove', e => {
    if (groupDragState) return; // already dragging — cursor handled above
    if (!groupingEnabled) { cyContainer.classList.remove('group-hoverable'); return; }
    const rect = cyContainer.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const pan = cy.pan(), zoom = cy.zoom();
    const graphX = (sx - pan.x) / zoom;
    const graphY = (sy - pan.y) / zoom;

    if (!nodeAtGraphPoint(graphX, graphY) && groupAtScreenPoint(sx, sy)) {
      cyContainer.classList.add('group-hoverable');
    } else {
      cyContainer.classList.remove('group-hoverable');
    }
  });
}

// ─── Collision Avoidance ─────────────────────────────────────────────────────

/**
 * After a layout run, iteratively push apart any nodes whose bounding circles
 * still overlap. Each pass resolves every overlapping pair by equal and opposite
 * displacement until no overlaps remain or MAX_PASSES is reached.
 */
function resolveOverlaps() {
  const nodes = cy.nodes();
  if (nodes.length < 2) return;

  const GAP = 14;
  const MAX_PASSES = 40;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let anyOverlap = false;

    for (let i = 0; i < nodes.length; i++) {
      const a  = nodes[i];
      const pa = a.position();
      const ra = a.data('size') / 2;

      for (let j = i + 1; j < nodes.length; j++) {
        const b       = nodes[j];
        const pb      = b.position();
        const rb      = b.data('size') / 2;
        const minDist = ra + rb + GAP;

        const dx   = pb.x - pa.x;
        const dy   = pb.y - pa.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < minDist) {
          anyOverlap = true;

          const nx = dist > 0.01 ? dx / dist : (Math.random() - 0.5);
          const ny = dist > 0.01 ? dy / dist : (Math.random() - 0.5);

          const push = (minDist - dist) / 2 + 0.5;
          a.position({ x: pa.x - nx * push, y: pa.y - ny * push });
          b.position({ x: pb.x + nx * push, y: pb.y + ny * push });

          pa.x = pa.x - nx * push;
          pa.y = pa.y - ny * push;
        }
      }
    }

    if (!anyOverlap) break;
  }
}

// ─── Hull Blobs ───────────────────────────────────────────────────────────────

/** Gift-wrapping convex hull. Returns a subset of pts in CCW order. */
function convexHull(pts) {
  if (pts.length < 2) return pts;
  const start = pts.reduce((a, b) => (b.x < a.x || (b.x === a.x && b.y < a.y) ? b : a));
  const hull = [];
  let cur = start;
  do {
    hull.push(cur);
    let next = pts[0];
    for (const p of pts) {
      const cross = (next.x - cur.x) * (p.y - cur.y) - (next.y - cur.y) * (p.x - cur.x);
      if (next === cur || cross < 0 || (cross === 0 && hullDist2(cur, p) > hullDist2(cur, next))) {
        next = p;
      }
    }
    cur = next;
  } while (cur !== start && hull.length <= pts.length);
  return hull;
}

function hullDist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/** Ray-casting point-in-polygon test (works for any simple polygon). */
function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Returns the group name if the screen-space point (sx, sy) is inside any
 * group hull blob, otherwise returns null.
 */
function groupAtScreenPoint(sx, sy) {
  for (const [groupName, { pts, padding }] of Object.entries(hullPolygons)) {
    if (pts.length === 1) {
      const dx = sx - pts[0].x, dy = sy - pts[0].y;
      if (dx * dx + dy * dy <= padding * padding) return groupName;
    } else if (pts.length >= 2 && pointInPolygon(sx, sy, pts)) {
      return groupName;
    }
  }
  return null;
}

const svgNS = 'http://www.w3.org/2000/svg';

/**
 * Draw a guaranteed-convex rounded hull using the Minkowski sum of the convex
 * polygon with a disk of radius `padding`.
 *
 * Each edge is offset outward by `padding`; adjacent offset edges are joined
 * by a circular arc at each original vertex. The result is always convex —
 * no catmull-rom spline pulling inward at sharp corners.
 */
function drawBlob(svgEl, pts, padding, fillColor, strokeColor, label) {
  if (pts.length === 0) return;

  const applyStyle = el => {
    el.setAttribute('fill', fillColor);
    el.setAttribute('stroke', strokeColor);
    el.setAttribute('stroke-width', '1.5');
    el.setAttribute('stroke-dasharray', '5,4');
    svgEl.appendChild(el);
  };

  if (pts.length === 1) {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', pts[0].x);
    c.setAttribute('cy', pts[0].y);
    c.setAttribute('r', padding);
    applyStyle(c);
    appendBlobLabel(svgEl, pts[0].x, pts[0].y - padding - 6, label);
    return;
  }

  const n = pts.length;

  // Centroid — used to orient outward normals
  const centX = pts.reduce((s, p) => s + p.x, 0) / n;
  const centY = pts.reduce((s, p) => s + p.y, 0) / n;

  // For each edge A→B, compute the outward-facing offset endpoints.
  const offsets = pts.map((A, i) => {
    const B = pts[(i + 1) % n];
    const edx = B.x - A.x, edy = B.y - A.y;
    const elen = Math.sqrt(edx * edx + edy * edy) || 1;
    // Perpendicular candidate (rotated 90° CW in screen coords)
    let nx = edy / elen, ny = -edx / elen;
    // Flip if it points toward the centroid instead of away from it
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    if (nx * (mx - centX) + ny * (my - centY) < 0) { nx = -nx; ny = -ny; }
    return {
      sx: A.x + nx * padding, sy: A.y + ny * padding, // offset start (at vertex A)
      ex: B.x + nx * padding, ey: B.y + ny * padding, // offset end   (at vertex B)
    };
  });

  // Build the path: for each edge, draw the offset line, then a circular arc
  // at the next vertex connecting this edge's end to the next edge's start.
  // sweep-flag=1 keeps arcs on the outside of each corner.
  let topY = Infinity, topX = centX;
  const d = [`M ${offsets[0].sx} ${offsets[0].sy}`];

  for (let i = 0; i < n; i++) {
    const o    = offsets[i];
    const next = offsets[(i + 1) % n];
    d.push(`L ${o.ex} ${o.ey}`);
    d.push(`A ${padding} ${padding} 0 0 1 ${next.sx} ${next.sy}`);
    if (o.sy < topY) { topY = o.sy; topX = o.sx; }
    if (o.ey < topY) { topY = o.ey; topX = o.ex; }
  }
  d.push('Z');

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', d.join(' '));
  applyStyle(path);
  appendBlobLabel(svgEl, topX, topY - 8, label);
}

function appendBlobLabel(svgEl, x, y, label) {
  const text = document.createElementNS(svgNS, 'text');
  text.setAttribute('x', x);
  text.setAttribute('y', y);
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('fill', '#6aab4a');
  text.setAttribute('font-size', '10');
  text.setAttribute('font-family', 'sans-serif');
  text.textContent = label;
  svgEl.appendChild(text);
}

const GROUP_COLORS = [
  { fill: 'rgba(74,124,58,0.10)',  stroke: '#4a7c3a' },
  { fill: 'rgba(58,90,124,0.10)',  stroke: '#3a5a7c' },
  { fill: 'rgba(124,90,58,0.10)',  stroke: '#7c5a3a' },
  { fill: 'rgba(110,58,124,0.10)', stroke: '#6e3a7c' },
  { fill: 'rgba(58,124,110,0.10)', stroke: '#3a7c6e' },
];
const groupColorMap = {};
let groupColorCounter = 0;

function groupColor(groupName) {
  if (!(groupName in groupColorMap)) {
    groupColorMap[groupName] = groupColorCounter++ % GROUP_COLORS.length;
  }
  return GROUP_COLORS[groupColorMap[groupName]];
}

function redrawHulls() {
  if (!hullSvg || !cy) return;
  // Don't redraw during layout animation — hulls are hidden until layoutstop
  if (activeLayout) return;
  if (!groupingEnabled) return;

  // Clear previous hulls and stored polygons
  hullPolygons = {};
  while (hullSvg.lastChild) hullSvg.removeChild(hullSvg.lastChild);

  // Collect screen-space bounding box corners for each folder group
  const byGroup = {};
  cy.nodes().forEach(n => {
    const g = n.data('group');
    if (!g || n.data('isGhost')) return;
    if (!byGroup[g]) byGroup[g] = [];
    const pan  = cy.pan();
    const zoom = cy.zoom();
    const mp   = n.position();
    const r    = (n.data('size') || 20) / 2;
    // Include node centre + all four corners so the hull wraps the full circle
    byGroup[g].push(
      { x: mp.x * zoom + pan.x,       y: mp.y * zoom + pan.y       },
      { x: (mp.x - r) * zoom + pan.x, y: (mp.y - r) * zoom + pan.y },
      { x: (mp.x + r) * zoom + pan.x, y: (mp.y - r) * zoom + pan.y },
      { x: (mp.x - r) * zoom + pan.x, y: (mp.y + r) * zoom + pan.y },
      { x: (mp.x + r) * zoom + pan.x, y: (mp.y + r) * zoom + pan.y },
    );
  });

  for (const [groupName, pts] of Object.entries(byGroup)) {
    const hull = convexHull(pts);
    const { fill, stroke } = groupColor(groupName);
    const PADDING = Math.max(14, 18 * cy.zoom());
    // Store screen-space hull for group drag hit-testing
    hullPolygons[groupName] = { pts: hull, padding: PADDING };
    drawBlob(hullSvg, hull, PADDING, fill, stroke, groupName);
  }
}

// ─── Graph Data ───────────────────────────────────────────────────────────────

function nodeColor(node) {
  if (node.isGhost) return '#555555';
  if (node.isActive) return '#8cc641';
  return '#bf4e30';
}

function nodeSize(connectionCount) {
  return Math.min(20 + connectionCount * 5, 64);
}

/** Apply pendingViewport to cytoscape (if set) and clear it. */
function applyPendingViewport() {
  if (!pendingViewport) return;
  cy.zoom(pendingViewport.zoom);
  cy.pan({ x: pendingViewport.panX, y: pendingViewport.panY });
  pendingViewport = null;
}

/**
 * Debounced save of the current zoom + pan.
 * Skips silently while a layout is still animating so we don't capture
 * intermediate camera positions.
 */
function scheduleViewportSave() {
  clearTimeout(viewportSaveTimer);
  viewportSaveTimer = setTimeout(() => {
    if (activeLayout) return; // layout still running — wait for it to finish
    vscode.postMessage({
      type: 'saveViewport',
      viewport: { zoom: cy.zoom(), panX: cy.pan().x, panY: cy.pan().y },
    });
  }, 800);
}

function positionKey(node) {
  const g = node.data('group') || '';
  const d = node.data('displayName');
  return g ? `${g}/${d}` : d;
}

function savePositions() {
  const positions = {};
  cy.nodes().forEach(n => {
    const pos = n.position();
    positions[positionKey(n)] = {
      x: +pos.x.toFixed(2),
      y: +pos.y.toFixed(2),
    };
  });
  vscode.postMessage({ type: 'savePositions', positions });
}

/**
 * Select the currently active (open) node so its neighbours are highlighted
 * automatically. Deselects everything first so stale selections don't linger.
 */
function selectActiveNode() {
  cy.nodes().unselect();
  const active = cy.nodes('[?isActive]');
  if (active.length) active.select();
}

function applyGraphData(data, forces, savedPositions, savedViewport) {
  savedPositions = savedPositions || {};
  // Store viewport for restoration after layout/overlap pass.
  // Clear it for full fresh layouts (fit:true will handle the camera itself).
  pendingViewport = savedViewport || null;
  currentForces = { ...forces };
  updateSliderUI(forces);

  const elements = [
    ...data.nodes.map(n => ({
      group: 'nodes',
      data: {
        id: n.id,
        displayName: n.displayName,
        group: n.group || '',
        color: nodeColor(n),
        size: nodeSize(n.connectionCount),
        isGhost:  n.isGhost  || false,
        isActive: n.isActive || false,
      },
    })),
    ...data.edges.map(e => ({
      group: 'edges',
      data: {
        id: `${e.source}__${e.target}`,
        source: e.source,
        target: e.target,
      },
    })),
  ];

  // Snapshot in-memory positions before wiping elements
  const prevPositions = {};
  if (cy) {
    cy.nodes().forEach(n => { prevPositions[n.id()] = { ...n.position() }; });
  }

  cy.elements().remove();
  cy.add(elements);

  const hasSaved = Object.keys(savedPositions).length > 0;

  if (hasSaved) {
    // Restore positions from file; scatter any brand-new nodes near centre
    const pan  = cy.pan();
    const zoom = cy.zoom();
    const cx   = (cy.width()  / 2 - pan.x) / zoom;
    const cy_  = (cy.height() / 2 - pan.y) / zoom;

    let newNodeCount = 0;
    cy.nodes().forEach(n => {
      const saved = savedPositions[positionKey(n)];
      if (saved) {
        n.position({ x: saved.x, y: saved.y });
      } else {
        // New note with no saved position — seed it near the viewport centre
        n.position({
          x: cx + (Math.random() - 0.5) * 90,
          y: cy_ + (Math.random() - 0.5) * 90,
        });
        newNodeCount++;
      }
    });

    firstRender = false; // keep positions; don't scatter everything again

    if (newNodeCount > 0) {
      // Integrate the new nodes alongside the existing layout;
      // layoutstop will call applyPendingViewport() to restore the camera.
      runLayout();
    } else {
      // All positions restored — just tidy up any overlap, then restore camera.
      resolveOverlaps();
      cy.nodes().toggleClass('labels-hidden', cy.zoom() < LABEL_HIDE_ZOOM);
      applyPendingViewport();
      selectActiveNode();
      if (hullSvg) hullSvg.style.opacity = '0';
      redrawHulls();
      // Small delay lets the browser register the opacity:0 before transitioning to 1
      requestAnimationFrame(() => { if (hullSvg) hullSvg.style.opacity = '1'; });
    }
  } else {
    // No settings file yet — fall back to in-memory positions and run layout.
    // A full fresh layout uses fit:true, so don't override the camera.
    pendingViewport = null;
    cy.nodes().forEach(n => {
      if (prevPositions[n.id()]) n.position(prevPositions[n.id()]);
    });
    runLayout();
  }
}

function runLayout() {
  if (activeLayout) {
    activeLayout.stop();
    activeLayout = null;
  }

  // Hide hulls for the duration of the animation
  if (hullSvg) {
    hullSvg.style.opacity = '0';
    while (hullSvg.lastChild) hullSvg.removeChild(hullSvg.lastChild);
  }

  const isRandom = firstRender;

  if (isRandom) {
    // Full fresh layout — fCoSE will fit the graph to the viewport itself,
    // so any saved viewport would just be overridden; discard it.
    pendingViewport = null;

    // Cytoscape's default pan puts graph-origin (0,0) at the top-left of the
    // container, so unpositioned nodes all appear to start there before the
    // layout runs. Instead, scatter every node in a small cluster around the
    // viewport centre so fCoSE spreads them outward from the middle.
    const pan  = cy.pan();
    const zoom = cy.zoom();
    const cx   = (cy.width()  / 2 - pan.x) / zoom;
    const cy_  = (cy.height() / 2 - pan.y) / zoom;
    cy.nodes().forEach(n => {
      n.position({
        x: cx + (Math.random() - 0.5) * 90,
        y: cy_ + (Math.random() - 0.5) * 90,
      });
    });
  }

  const layout = cy.layout({
    name: 'fcose',
    quality: 'proof',
    animate: true,
    animationDuration: isRandom ? 2500 : 1600,
    animationEasing: 'ease-in-out',
    fit: isRandom,
    padding: 60,
    randomize: true,   // initial positions set manually above; fCoSE spreads from there
    nodeRepulsion: () => currentForces.repulsion,
    idealEdgeLength: () => currentForces.edgeLength,
    gravity: currentForces.gravity,
    gravityRange: 6,
    initialEnergyOnIncremental: isRandom ? 1.0 : currentForces.damping,
    nodeOverlap: 40,
    nodeSeparation: 150,
    numIter: 5000,
    uniformNodeDimensions: false,
    tile: false,
  });

  activeLayout = layout;
  layout.on('layoutstop', () => {
    if (activeLayout === layout) activeLayout = null;
    resolveOverlaps();
    // Re-apply label visibility after layout adds/repositions nodes
    cy.nodes().toggleClass('labels-hidden', cy.zoom() < LABEL_HIDE_ZOOM);
    // Restore saved camera position (no-op if pendingViewport was cleared)
    applyPendingViewport();
    // Select the active node so neighbours are highlighted from the start
    selectActiveNode();
    // Persist final positions to graph_settings.jsonc
    savePositions();
    // Draw hulls then fade them in (activeLayout is now null so redrawHulls will run)
    redrawHulls();
    if (hullSvg) hullSvg.style.opacity = '1';
  });
  layout.run();
  firstRender = false;
}

// ─── Sliders ──────────────────────────────────────────────────────────────────

const SLIDER_IDS = ['repulsion', 'gravity', 'edgeLength', 'damping'];

/** Sync the orange fill on a range input to its current value. */
function updateSliderFill(input) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const val = parseFloat(input.value);
  const pct = ((val - min) / (max - min)) * 100;
  input.style.setProperty('--slider-fill', pct.toFixed(1) + '%');
}

function updateSliderUI(forces) {
  for (const id of SLIDER_IDS) {
    const input = document.getElementById(id);
    const valEl = document.getElementById(`${id}-val`);
    if (input) { input.value = forces[id]; updateSliderFill(input); }
    if (valEl) valEl.textContent = forces[id];
  }
}

for (const id of SLIDER_IDS) {
  const input = document.getElementById(id);
  if (!input) continue;
  input.addEventListener('input', () => {
    const raw = parseFloat(input.value);
    updateSliderFill(input);
    currentForces[id] = raw;
    const valEl = document.getElementById(`${id}-val`);
    if (valEl) valEl.textContent = raw;

    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      if (cy && cy.nodes().length > 0) {
        firstRender = true;
        runLayout();
        vscode.postMessage({ type: 'saveForces', forces: { ...currentForces } });
      }
    }, 300);
  });
}

// ─── Fit button ───────────────────────────────────────────────────────────────

document.getElementById('fit-btn').addEventListener('click', () => {
  if (cy) {
    cy.fit(undefined, 60); // 60 px padding, same as the layout
    scheduleViewportSave();
  }
});

// ─── Messages ─────────────────────────────────────────────────────────────────

/**
 * Lightweight update: topology unchanged, just patch colour and size without
 * disturbing positions or running a layout.
 */
function updateNodeVisuals(data) {
  data.nodes.forEach(n => {
    const node = cy.getElementById(n.id);
    if (node.length) {
      node.data('color', nodeColor(n));
      node.data('size', nodeSize(n.connectionCount));
      node.data('isGhost',  n.isGhost  || false);
      node.data('isActive', n.isActive || false);
    }
  });
  // Re-evaluate selection in case the active file changed
  selectActiveNode();
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'graphData') {
    applyGraphData(msg.data, msg.forces, msg.savedPositions, msg.savedViewport);
    applySearch();
  } else if (msg.type === 'graphUpdate') {
    updateNodeVisuals(msg.data);
    applySearch();
  } else if (msg.type === 'searchResults') {
    searchInput.classList.remove('searching');
    searchMatchingIds = msg.matchingIds ? new Set(msg.matchingIds) : null;
    applySearch();
  }
});

// ─── Search ───────────────────────────────────────────────────────────────────

// null  → no active search (all nodes visible)
// Set   → only these node IDs matched; everything else is dimmed
let searchMatchingIds = null;
let searchDebounceTimer = null;

function applySearch() {
  if (!cy) return;
  if (searchMatchingIds === null) {
    cy.elements().removeClass('search-dim');
    return;
  }
  cy.nodes().forEach(n => {
    n.toggleClass('search-dim', !searchMatchingIds.has(n.id()));
  });
  cy.edges().forEach(e => {
    e.toggleClass(
      'search-dim',
      e.source().hasClass('search-dim') && e.target().hasClass('search-dim')
    );
  });
}

function clearSearch() {
  clearTimeout(searchDebounceTimer);
  searchInput.value = '';
  searchClear.style.display = 'none';
  searchInput.classList.remove('searching');
  searchMatchingIds = null;
  applySearch();
  // Cancel any in-flight search on the extension side
  vscode.postMessage({ type: 'search', term: '' });
}

const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');

searchInput.addEventListener('input', () => {
  const term = searchInput.value;
  searchClear.style.display = term ? 'inline-block' : 'none';

  clearTimeout(searchDebounceTimer);

  if (!term) {
    clearSearch();
    return;
  }

  // Show pulsing border while waiting for results
  searchInput.classList.add('searching');

  searchDebounceTimer = setTimeout(() => {
    vscode.postMessage({ type: 'search', term });
  }, 300);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    clearSearch();
    searchInput.blur();
  }
});

searchClear.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});

// ─── Settings panel toggle ────────────────────────────────────────────────────

const settingsToggle  = document.getElementById('settings-toggle');
const settingsPanel   = document.getElementById('settings-panel');
const groupingToggle  = document.getElementById('grouping-toggle');
const cyContainerEl   = document.getElementById('cy-container');

settingsToggle.addEventListener('click', () => {
  const isOpen = settingsPanel.classList.toggle('open');
  settingsToggle.classList.toggle('active', isOpen);
});

groupingToggle.addEventListener('change', () => {
  groupingEnabled = groupingToggle.checked;
  if (!groupingEnabled) {
    // Clear hulls and reset any group cursor / drag state
    hullPolygons = {};
    if (hullSvg) while (hullSvg.lastChild) hullSvg.removeChild(hullSvg.lastChild);
    cyContainerEl.classList.remove('group-hoverable', 'group-dragging');
  } else {
    redrawHulls();
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

initCytoscape();
vscode.postMessage({ type: 'ready' });
