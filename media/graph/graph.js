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

// How strongly connected nodes follow the dragged node (0 = none, 1 = perfectly track)
const SPRING_FACTOR = 0.28;

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

  // On release: pin the dragged node and run a brief settle pass
  cy.on('dragfree', 'node', evt => {
    dragLastPos = null;
    const node = evt.target;
    node.lock();

    const settle = cy.layout({
      name: 'fcose',
      quality: 'proof',
      animate: true,
      animationDuration: 900,
      animationEasing: 'ease-in-out',
      fit: false,
      randomize: false,
      nodeRepulsion: () => currentForces.repulsion,
      idealEdgeLength: () => currentForces.edgeLength,
      gravity: currentForces.gravity,
      gravityRange: 6,
      initialEnergyOnIncremental: currentForces.damping,
      nodeOverlap: 40,
      nodeSeparation: 150,
      numIter: 3000,
      uniformNodeDimensions: false,
      tile: false,
    });

    settle.on('layoutstop', () => {
      node.unlock();
      resolveOverlaps();
    });
    activeLayout = settle;
    settle.run();
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

// ─── Graph Data ───────────────────────────────────────────────────────────────

function nodeColor(node) {
  if (node.isGhost) return '#555555';
  if (node.isActive) return '#8cc641';
  return '#bf4e30';
}

function nodeSize(connectionCount) {
  return Math.min(20 + connectionCount * 5, 64);
}

function applyGraphData(data, forces) {
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

  const prevPositions = {};
  if (cy) {
    cy.nodes().forEach(n => { prevPositions[n.id()] = { ...n.position() }; });
  }

  cy.elements().remove();
  cy.add(elements);

  cy.nodes().forEach(n => {
    if (prevPositions[n.id()]) n.position(prevPositions[n.id()]);
  });

  runLayout();
}

function runLayout() {
  if (activeLayout) {
    activeLayout.stop();
    activeLayout = null;
  }

  const isRandom = firstRender;

  const layout = cy.layout({
    name: 'fcose',
    quality: 'proof',
    animate: true,
    animationDuration: isRandom ? 2500 : 1600,
    animationEasing: 'ease-in-out',
    fit: isRandom,
    padding: 60,
    randomize: isRandom,
    nodeRepulsion: () => currentForces.repulsion,
    idealEdgeLength: () => currentForces.edgeLength,
    gravity: currentForces.gravity,
    gravityRange: 6,
    initialEnergyOnIncremental: isRandom ? 1.0 : currentForces.damping,
    nodeOverlap: 40,
    nodeSeparation: 150,
    numIter: 5000,
    uniformNodeDimensions: false,
    tile: isRandom,
    tilingPaddingVertical: 50,
    tilingPaddingHorizontal: 50,
  });

  activeLayout = layout;
  layout.on('layoutstop', () => {
    if (activeLayout === layout) activeLayout = null;
    resolveOverlaps();
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
    }
  });
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'graphData') {
    applyGraphData(msg.data, msg.forces);
  } else if (msg.type === 'graphUpdate') {
    updateNodeVisuals(msg.data);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

initCytoscape();
vscode.postMessage({ type: 'ready' });
