// @ts-nocheck
/* global CodeNodesGraphVendor, acquireVsCodeApi */

const { cytoscape, fcose } = CodeNodesGraphVendor;
cytoscape.use(fcose);

const vscode = acquireVsCodeApi();

// ─── State ────────────────────────────────────────────────────────────────────

let cy = null;
let currentForces = {};
let firstRender = true;
let layoutTimer = null;
let activeLayout = null;
let dragLastPos = null;
let pendingViewport = null;   // viewport to restore after the next layout/overlap pass
let viewportSaveTimer = null; // debounce handle for saveViewport messages

// How strongly connected nodes follow the dragged node (0 = none, 1 = perfectly track)
const SPRING_FACTOR = 0.28;

// Zoom level below which node labels are hidden (keeps the overview uncluttered)
const LABEL_HIDE_ZOOM = 0.5;

// ─── Cytoscape Init ───────────────────────────────────────────────────────────

function initCytoscape() {
  cy = cytoscape({
    container: document.getElementById('cy-container'),
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

  // ── Viewport persistence ──────────────────────────────────────────────────
  cy.on('zoom pan', scheduleViewportSave);

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

function savePositions() {
  const positions = {};
  cy.nodes().forEach(n => {
    const pos = n.position();
    positions[n.data('displayName')] = {
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
      const saved = savedPositions[n.data('displayName')];
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
  });
  layout.run();
  firstRender = false;
}

// ─── Sliders ──────────────────────────────────────────────────────────────────

const SLIDER_IDS = ['repulsion', 'gravity', 'edgeLength', 'damping'];

function updateSliderUI(forces) {
  for (const id of SLIDER_IDS) {
    const input = document.getElementById(id);
    const valEl = document.getElementById(`${id}-val`);
    if (input) input.value = forces[id];
    if (valEl) valEl.textContent = forces[id];
  }
}

for (const id of SLIDER_IDS) {
  const input = document.getElementById(id);
  if (!input) continue;
  input.addEventListener('input', () => {
    const raw = parseFloat(input.value);
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
  } else if (msg.type === 'graphUpdate') {
    updateNodeVisuals(msg.data);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

initCytoscape();
vscode.postMessage({ type: 'ready' });
