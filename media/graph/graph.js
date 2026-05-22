// @ts-nocheck
/* global CodeNodesGraphVendor, acquireVsCodeApi */

const { Sigma, Graph, FA2Layout, EdgeArrowProgram } = CodeNodesGraphVendor;
const vscode = acquireVsCodeApi();

// ─── Constants ────────────────────────────────────────────────────────────────

const COLOR_ACTIVE   = '#8cc641';
const COLOR_EXISTS   = '#bf4e30';
const COLOR_GHOST    = '#555555';
const COLOR_NEIGHBOR = '#e07a52';
const COLOR_SELECTED = '#ffffff';
const EDGE_DEFAULT   = '#555555';
const EDGE_HIGHLIGHT = '#999999';
const EDGE_DIM       = '#2a2a2a';

const GHOST_AUTO_HIDE_THRESHOLD = 500;
const BASE_GRID = 24;

// ─── State ────────────────────────────────────────────────────────────────────

let graph    = null;
let renderer = null;
let layout   = null;

let selectedNode      = null;
let selectedNeighbors = new Set();
let searchActive      = false;
let searchVisibleIds  = null; // Set of node IDs to show (matches + 1-hop neighbors)

let showGhosts        = false;
let hubLabelThreshold = 5;
let isSimRunning      = false;
let rafHandle         = null;

let currentForces = { scalingRatio: 10, gravity: 1, slowDown: 1 };
let viewportSaveTimer = null;
let forceSaveTimer    = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nodeColor(node) {
  if (node.isGhost) return COLOR_GHOST;
  if (node.isActive) return COLOR_ACTIVE;
  return COLOR_EXISTS;
}

function nodeSize(connectionCount) {
  return Math.min(4 + (connectionCount || 0) * 0.8, 20);
}

function positionKey(node) {
  return node.group ? `${node.group}/${node.displayName}` : node.displayName;
}

// ─── Reducers ─────────────────────────────────────────────────────────────────

function nodeReducer(node, data) {
  if (data.isGhost && !showGhosts) return { ...data, hidden: true };

  if (searchActive && searchVisibleIds && !searchVisibleIds.has(node)) {
    return { ...data, hidden: true };
  }

  let color = data.isGhost ? COLOR_GHOST
    : data.isActive ? COLOR_ACTIVE
    : COLOR_EXISTS;

  let highlighted = false;
  let zIndex = 0;
  let forceLabel = false;

  if (node === selectedNode) {
    color = COLOR_SELECTED;
    highlighted = true;
    zIndex = 2;
    forceLabel = true;
  } else if (selectedNeighbors.has(node)) {
    color = COLOR_NEIGHBOR;
    highlighted = true;
    zIndex = 1;
    forceLabel = true;
  }

  return { ...data, color, highlighted, zIndex, forceLabel, hidden: false };
}

function edgeReducer(edge, data) {
  const src     = graph.source(edge);
  const tgt     = graph.target(edge);
  const srcData = graph.getNodeAttributes(src);
  const tgtData = graph.getNodeAttributes(tgt);

  if ((srcData.isGhost || tgtData.isGhost) && !showGhosts) {
    return { ...data, hidden: true };
  }

  if (searchActive && searchVisibleIds) {
    if (!searchVisibleIds.has(src) || !searchVisibleIds.has(tgt)) {
      return { ...data, hidden: true };
    }
  }

  if (selectedNode) {
    if (src === selectedNode || tgt === selectedNode) {
      return { ...data, color: EDGE_HIGHLIGHT, hidden: false };
    }
    return { ...data, color: EDGE_DIM, hidden: false };
  }

  return { ...data, color: EDGE_DEFAULT, hidden: false };
}

// ─── Renderer Init ────────────────────────────────────────────────────────────

function initRenderer() {
  const container = document.getElementById('sigma-container');

  graph = new Graph({ type: 'directed', multi: false });

  renderer = new Sigma(graph, container, {
    minCameraRatio:             0.02,
    maxCameraRatio:             8,
    defaultNodeColor:           COLOR_EXISTS,
    defaultEdgeColor:           EDGE_DEFAULT,
    defaultEdgeType:            'arrow',
    labelFont:                  'system-ui, -apple-system, sans-serif',
    labelSize:                  11,
    labelColor:                 { color: '#dddddd' },
    labelRenderedSizeThreshold: 12,
    zIndex:                     true,
    edgeProgramClasses:         { arrow: EdgeArrowProgram },
    nodeReducer,
    edgeReducer,
    allowInvalidContainer:      true,
    // Suppress the built-in white-background hover box; just render plain label text.
    defaultDrawNodeHover: (ctx, data, settings) => {
      if (!data.label) return;
      const size  = settings.labelSize;
      const color = settings.labelColor.attribute
        ? (data[settings.labelColor.attribute] || settings.labelColor.color || '#dddddd')
        : settings.labelColor.color;
      ctx.font      = `${settings.labelWeight || 400} ${size}px ${settings.labelFont}`;
      ctx.fillStyle = color;
      ctx.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
    },
  });

  // Single click → select + highlight neighbors
  renderer.on('clickNode', ({ node }) => selectNode(node));

  // Double click → open file in editor (or create ghost note in same folder as linking document)
  renderer.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
    preventSigmaDefault();
    const attrs = graph.getNodeAttributes(node);
    if (attrs.isGhost) {
      vscode.postMessage({ type: 'createGhostNote', nodeId: node, displayName: attrs.displayName });
    } else {
      vscode.postMessage({ type: 'openNote', nodeId: node, displayName: attrs.displayName });
    }
  });

  // Click background → deselect
  renderer.on('clickStage', () => clearSelection());

  // Tooltip
  const tooltip = document.getElementById('node-tooltip');
  renderer.on('enterNode', ({ node }) => {
    tooltip.textContent = graph.getNodeAttribute(node, 'displayName');
    tooltip.style.display = 'block';
  });
  renderer.on('leaveNode', () => { tooltip.style.display = 'none'; });
  document.addEventListener('mousemove', e => {
    if (tooltip.style.display === 'none') return;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    const left = e.clientX + 14 + tw > window.innerWidth  ? e.clientX - tw - 6 : e.clientX + 14;
    const top  = e.clientY - 10 + th > window.innerHeight ? e.clientY - th - 6 : e.clientY - 10;
    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;
  });

  renderer.getCamera().on('updated', scheduleViewportSave);
  renderer.getCamera().on('updated', updateGrid);
  updateGrid();

  // Save positions when the webview is hidden (panel close / switch)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) savePositions();
  });

  vscode.postMessage({ type: 'ready' });
}

// ─── Selection ────────────────────────────────────────────────────────────────

function selectNode(node) {
  selectedNode = node;
  selectedNeighbors.clear();
  if (graph.hasNode(node)) {
    graph.neighbors(node).forEach(n => selectedNeighbors.add(n));
  }
  renderer.refresh();
}

function clearSelection() {
  if (!selectedNode) return;
  selectedNode = null;
  selectedNeighbors.clear();
  renderer.refresh();
}

function selectActiveNode() {
  let activeId = null;
  graph.forEachNode((node, attrs) => { if (attrs.isActive) activeId = node; });
  if (activeId) {
    selectNode(activeId);
    softFocusNode(activeId);
  }
}

// ─── Camera ───────────────────────────────────────────────────────────────────

function softFocusNode(nodeId) {
  if (!graph.hasNode(nodeId)) return;
  const attrs = graph.getNodeAttributes(nodeId);
  const { x, y } = renderer.graphToViewport(attrs);
  const el = renderer.getContainer();
  const margin = 100;
  const offScreen = x < margin || x > el.clientWidth - margin
                 || y < margin || y > el.clientHeight - margin;
  if (offScreen) {
    // Camera expects framed (normalized) coordinates, not raw graph coordinates.
    const framed = renderer.normalizationFunction(attrs);
    renderer.getCamera().animate({ x: framed.x, y: framed.y }, { duration: 600 });
  }
}

function fitGraph() {
  if (!graph || graph.order === 0) return;
  // Sigma v3: camera x/y are in normalized framed space (center = 0.5, full range ≈ 1).
  // ratio:1 at (0.5, 0.5) always fits all nodes by design of the normalization function.
  renderer.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 500 });
}

function restoreViewport(viewport) {
  if (!viewport || !renderer) return;
  renderer.getCamera().setState({
    x: viewport.x ?? 0,
    y: viewport.y ?? 0,
    ratio: viewport.ratio ?? 1,
    angle: 0,
  });
}

function scheduleViewportSave() {
  clearTimeout(viewportSaveTimer);
  viewportSaveTimer = setTimeout(() => {
    const cam = renderer.getCamera().getState();
    vscode.postMessage({
      type: 'saveViewport',
      viewport: { ratio: cam.ratio, x: cam.x, y: cam.y },
    });
  }, 800);
}

// ─── Grid Background ──────────────────────────────────────────────────────────

function updateGrid() {
  const container = document.getElementById('sigma-container');
  if (!renderer || !container) return;
  const ratio = renderer.getCamera().getState().ratio;
  const size  = Math.max(8, Math.min(BASE_GRID / ratio, 120));
  // Align grid to graph origin for a stable feel
  const origin = renderer.graphToViewport({ x: 0, y: 0 });
  container.style.backgroundSize     = `${size}px ${size}px`;
  container.style.backgroundPosition = `${origin.x % size}px ${origin.y % size}px`;
}

// ─── Layout (ForceAtlas2 Web Worker) ─────────────────────────────────────────

function fa2Settings() {
  return {
    scalingRatio:                   currentForces.scalingRatio,
    gravity:                        currentForces.gravity,
    slowDown:                       currentForces.slowDown,
    barnesHutOptimize:              true,
    barnesHutTheta:                 0.5,
    adjustSizes:                    false,
    linLogMode:                     false,
    outboundAttractionDistribution: false,
    strongGravityMode:              false,
  };
}

function startLayout() {
  if (!layout) {
    layout = new FA2Layout(graph, { settings: fa2Settings() });
  }
  layout.start();
  isSimRunning = true;
  updateRunButton();
  startRefreshLoop();
}

function stopLayout(saveAfter = true) {
  if (layout && layout.isRunning()) layout.stop();
  isSimRunning = false;
  updateRunButton();
  stopRefreshLoop();
  if (saveAfter) savePositions();
}

function killLayout() {
  if (layout) { layout.kill(); layout = null; }
  isSimRunning = false;
  stopRefreshLoop();
}

function toggleLayout() {
  if (isSimRunning) stopLayout();
  else startLayout();
}

function startRefreshLoop() {
  stopRefreshLoop();
  function loop() {
    if (!isSimRunning) return;
    renderer.refresh({ skipIndexation: true });
    rafHandle = requestAnimationFrame(loop);
  }
  rafHandle = requestAnimationFrame(loop);
}

function stopRefreshLoop() {
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
}

function updateRunButton() {
  const btn = document.getElementById('run-btn');
  if (!btn) return;
  btn.textContent = isSimRunning ? '⏸ Freeze' : '▶ Run';
  btn.classList.toggle('active', isSimRunning);
}

// ─── Graph Data ───────────────────────────────────────────────────────────────

function applyGraphData(data, forces, savedPositions, savedViewport, display) {
  killLayout();
  clearSelection();

  currentForces = { ...forces };
  updateSliderUI(forces);

  if (display) {
    hubLabelThreshold = display.hubLabelThreshold ?? 5;
    showGhosts = display.showGhostNodes ?? false;
    const ghostToggle = document.getElementById('ghost-toggle');
    if (ghostToggle) ghostToggle.checked = showGhosts;
  }

  // Auto-hide ghosts on large graphs
  if (data.nodes.length >= GHOST_AUTO_HIDE_THRESHOLD && !showGhosts) {
    showGhosts = false;
  }

  savedPositions = savedPositions || {};
  const hasSavedPositions = Object.keys(savedPositions).length > 0;

  graph.clear();

  const newNodeIds = [];
  data.nodes.forEach(n => {
    const key   = positionKey(n);
    const saved = savedPositions[key];
    const x     = saved ? saved.x : (Math.random() - 0.5) * 1000;
    const y     = saved ? saved.y : (Math.random() - 0.5) * 1000;

    graph.addNode(n.id, {
      x, y,
      label:           n.displayName,
      displayName:     n.displayName,
      size:            nodeSize(n.connectionCount),
      color:           nodeColor(n),
      isGhost:         n.isGhost  || false,
      isActive:        n.isActive || false,
      connectionCount: n.connectionCount || 0,
      group:           n.group || '',
      positionKey:     key,
    });

    if (!saved) newNodeIds.push(n.id);
  });

  data.edges.forEach(e => {
    if (graph.hasNode(e.source) && graph.hasNode(e.target)
        && !graph.hasEdge(e.source, e.target)) {
      graph.addEdge(e.source, e.target, { size: 1.5 });
    }
  });

  if (hasSavedPositions && newNodeIds.length === 0) {
    // All positions restored — render immediately
    renderer.refresh();
    restoreViewport(savedViewport);
    selectActiveNode();
    hideLoadingOverlay();
  } else if (hasSavedPositions && newNodeIds.length > 0) {
    // Mostly restored — seat new nodes near their neighbors
    newNodeIds.forEach(placeNodeNearNeighbors);
    renderer.refresh();
    restoreViewport(savedViewport);
    selectActiveNode();
    hideLoadingOverlay();
  } else {
    // No saved positions — run layout silently then snap
    showLoadingOverlay();
    layout = new FA2Layout(graph, { settings: fa2Settings() });
    layout.start();
    isSimRunning = true;
    startRefreshLoop();
    setTimeout(() => {
      stopLayout(true);
      renderer.refresh();
      fitGraph();
      // Highlight the active node without a second camera animation that would fight fitGraph
      let activeId = null;
      graph.forEachNode((node, attrs) => { if (attrs.isActive) activeId = node; });
      if (activeId) selectNode(activeId);
      // Keep overlay until fit animation (500ms) has settled
      setTimeout(hideLoadingOverlay, 550);
    }, 5000);
  }
}

function placeNodeNearNeighbors(nodeId) {
  const neighbors = graph.neighbors(nodeId);
  if (neighbors.length === 0) return;
  let cx = 0, cy = 0;
  neighbors.forEach(n => {
    const a = graph.getNodeAttributes(n);
    cx += a.x; cy += a.y;
  });
  cx /= neighbors.length;
  cy /= neighbors.length;
  graph.setNodeAttribute(nodeId, 'x', cx + (Math.random() - 0.5) * 100);
  graph.setNodeAttribute(nodeId, 'y', cy + (Math.random() - 0.5) * 100);
}

function updateNodeVisuals(data) {
  data.nodes.forEach(n => {
    if (!graph.hasNode(n.id)) return;
    graph.mergeNodeAttributes(n.id, {
      color:           nodeColor(n),
      size:            nodeSize(n.connectionCount),
      isActive:        n.isActive  || false,
      isGhost:         n.isGhost   || false,
      connectionCount: n.connectionCount || 0,
    });
  });
  selectActiveNode();
  renderer.refresh();
}

// ─── Positions ────────────────────────────────────────────────────────────────

function savePositions() {
  if (!graph) return;
  const positions = {};
  graph.forEachNode((node, attrs) => {
    positions[attrs.positionKey] = {
      x: +attrs.x.toFixed(2),
      y: +attrs.y.toFixed(2),
    };
  });
  vscode.postMessage({ type: 'savePositions', positions });
}

// ─── Loading Overlay ──────────────────────────────────────────────────────────

function showLoadingOverlay() {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = 'flex';
}

function hideLoadingOverlay() {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = 'none';
}

// ─── Physics Sliders ─────────────────────────────────────────────────────────

const SLIDER_IDS = ['scalingRatio', 'gravity', 'slowDown'];

function updateSliderFill(input) {
  const pct = ((parseFloat(input.value) - parseFloat(input.min)) /
               (parseFloat(input.max)  - parseFloat(input.min))) * 100;
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

    // Recreate layout with new settings (FA2Layout has no updateSettings)
    if (layout) {
      const wasRunning = isSimRunning;
      killLayout();
      layout = new FA2Layout(graph, { settings: fa2Settings() });
      if (wasRunning) startLayout();
    }

    clearTimeout(forceSaveTimer);
    forceSaveTimer = setTimeout(() => {
      vscode.postMessage({ type: 'saveForces', forces: { ...currentForces } });
    }, 500);
  });
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

document.getElementById('fit-btn').addEventListener('click', fitGraph);
document.getElementById('run-btn').addEventListener('click', toggleLayout);

document.getElementById('ghost-toggle').addEventListener('change', e => {
  showGhosts = e.target.checked;
  renderer.refresh();
  vscode.postMessage({
    type: 'saveDisplay',
    display: { hubLabelThreshold, showGhostNodes: showGhosts },
  });
});

const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel  = document.getElementById('settings-panel');

settingsToggle.addEventListener('click', () => {
  const open = settingsPanel.classList.toggle('open');
  settingsToggle.classList.toggle('active', open);
});

document.addEventListener('mousedown', e => {
  if (settingsPanel.classList.contains('open') &&
      !settingsPanel.contains(e.target) &&
      e.target !== settingsToggle) {
    settingsPanel.classList.remove('open');
    settingsToggle.classList.remove('active');
  }
}, true);

// ─── Search ───────────────────────────────────────────────────────────────────

let searchDebounceTimer = null;
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');

function applySearchResults(matchingIds) {
  if (!matchingIds || matchingIds.length === 0) {
    searchActive     = false;
    searchVisibleIds = null;
  } else {
    searchActive     = true;
    searchVisibleIds = new Set(matchingIds);
    // Expand to include 1-hop neighbors
    matchingIds.forEach(id => {
      if (graph.hasNode(id)) {
        graph.neighbors(id).forEach(n => searchVisibleIds.add(n));
      }
    });
    fitToIds(searchVisibleIds);
  }
  clearSelection();
  renderer.refresh();
}

function fitToIds(idSet) {
  if (!idSet || idSet.size === 0) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  idSet.forEach(id => {
    if (!graph.hasNode(id)) return;
    // Must work in framed (normalized) space — same coordinate system as the camera.
    const framed = renderer.normalizationFunction(graph.getNodeAttributes(id));
    minX = Math.min(minX, framed.x); maxX = Math.max(maxX, framed.x);
    minY = Math.min(minY, framed.y); maxY = Math.max(maxY, framed.y);
  });
  if (!isFinite(minX)) return;
  const cx    = (minX + maxX) / 2;
  const cy    = (minY + maxY) / 2;
  const range = Math.max(maxX - minX, maxY - minY);
  const ratio = Math.max(range + 0.15, 0.15);
  renderer.getCamera().animate({ x: cx, y: cy, ratio }, { duration: 400 });
}

function clearSearch() {
  clearTimeout(searchDebounceTimer);
  searchInput.value = '';
  searchClear.style.display = 'none';
  searchInput.classList.remove('searching');
  searchActive     = false;
  searchVisibleIds = null;
  if (renderer) renderer.refresh();
  vscode.postMessage({ type: 'search', term: '' });
}

searchInput.addEventListener('input', () => {
  const term = searchInput.value;
  searchClear.style.display = term ? 'inline-block' : 'none';
  clearTimeout(searchDebounceTimer);
  if (!term) { clearSearch(); return; }
  searchInput.classList.add('searching');
  searchDebounceTimer = setTimeout(() => {
    vscode.postMessage({ type: 'search', term });
  }, 300);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { clearSearch(); searchInput.blur(); }
});
searchClear.addEventListener('click', () => { clearSearch(); searchInput.focus(); });

// ─── Messages ─────────────────────────────────────────────────────────────────

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'graphData') {
    applyGraphData(msg.data, msg.forces, msg.savedPositions, msg.savedViewport, msg.display);
  } else if (msg.type === 'graphUpdate') {
    updateNodeVisuals(msg.data);
  } else if (msg.type === 'searchResults') {
    searchInput.classList.remove('searching');
    applySearchResults(msg.matchingIds);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

initRenderer();
