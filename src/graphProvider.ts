import * as vscode from 'vscode';
import { NoteGraph } from './noteGraph';
import { openNoteById } from './noteNavigator';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GraphForces {
  scalingRatio: number;
  gravity:      number;
  slowDown:     number;
}

interface GraphDisplay {
  hubLabelThreshold: number;
  showGhostNodes:    boolean;
}

/** Sigma v2 camera state — ratio < 1 means zoomed in. */
interface GraphViewport {
  ratio: number;
  x:     number;
  y:     number;
}

interface GraphConfig {
  forces:   GraphForces;
  display:  GraphDisplay;
  viewport: GraphViewport;
}

/** Keyed by positionKey: "group/displayName" or "displayName". */
type GraphPositions = Record<string, { x: number; y: number }>;

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_FORCES: GraphForces = { scalingRatio: 10, gravity: 1, slowDown: 1 };
const DEFAULT_DISPLAY: GraphDisplay = { hubLabelThreshold: 5, showGhostNodes: false };
const DEFAULT_VIEWPORT: GraphViewport = { ratio: 1.0, x: 0, y: 0 };
const DEFAULT_CONFIG: GraphConfig = {
  forces:   DEFAULT_FORCES,
  display:  DEFAULT_DISPLAY,
  viewport: DEFAULT_VIEWPORT,
};

// ─── File helpers ─────────────────────────────────────────────────────────────

const SETTINGS_FILE  = 'graph_settings.jsonc';
const POSITIONS_FILE = 'graph_positions.json';

function workspaceUri(filename: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, filename) : undefined;
}

function stripJsonc(text: string): string {
  return text
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

async function readConfig(): Promise<GraphConfig> {
  const uri = workspaceUri(SETTINGS_FILE);
  if (!uri) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(stripJsonc(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8')));
    return {
      forces:   { ...DEFAULT_FORCES,   ...(raw.forces   ?? {}) },
      display:  { ...DEFAULT_DISPLAY,  ...(raw.display  ?? {}) },
      viewport: { ...DEFAULT_VIEWPORT, ...(raw.viewport ?? {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(config: GraphConfig): Promise<void> {
  const uri = workspaceUri(SETTINGS_FILE);
  if (!uri) return;
  const f = config.forces;
  const d = config.display;
  const v = config.viewport;
  const content = [
    '// Code Nodes — Graph Settings',
    '// ─────────────────────────────────────────────────────────────────────────────',
    '// Auto-generated. Safe to edit by hand. Delete to reset to defaults.',
    '{',
    '',
    '  // ── Physics (ForceAtlas2) ────────────────────────────────────────────────',
    '  //   scalingRatio — node repulsion strength (higher = more spread)',
    '  //   gravity      — pull toward graph centre',
    '  //   slowDown     — simulation speed (higher = slower / more stable)',
    '  "forces": {',
    `    "scalingRatio": ${f.scalingRatio},`,
    `    "gravity":      ${f.gravity},`,
    `    "slowDown":     ${f.slowDown}`,
    '  },',
    '',
    '  // ── Display ──────────────────────────────────────────────────────────────',
    '  //   hubLabelThreshold — min connections for a node to always show its label',
    '  //   showGhostNodes    — show wiki-link targets that have no file yet',
    '  "display": {',
    `    "hubLabelThreshold": ${d.hubLabelThreshold},`,
    `    "showGhostNodes":    ${d.showGhostNodes}`,
    '  },',
    '',
    '  // ── Viewport ─────────────────────────────────────────────────────────────',
    '  // Sigma camera state. Delete to reset view.',
    '  //   ratio — zoom level (lower = more zoomed in; 1.0 = default)',
    '  //   x / y — graph-space coordinates of the viewport centre',
    '  "viewport": {',
    `    "ratio": ${+v.ratio.toFixed(4)},`,
    `    "x":     ${+v.x.toFixed(2)},`,
    `    "y":     ${+v.y.toFixed(2)}`,
    '  }',
    '',
    '}',
    '',
  ].join('\n');
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

async function readPositions(): Promise<GraphPositions> {
  const uri = workspaceUri(POSITIONS_FILE);
  if (!uri) return {};
  try {
    return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8'));
  } catch {
    return {};
  }
}

async function writePositions(positions: GraphPositions): Promise<void> {
  const uri = workspaceUri(POSITIONS_FILE);
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(positions), 'utf-8'));
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class GraphProvider {
  private panel:             vscode.WebviewPanel | undefined;
  private lastTopologyHash = '';
  private webviewReady     = false;
  private config:    GraphConfig    = { ...DEFAULT_CONFIG };
  private positions: GraphPositions = {};

  private configSaveTimer:    ReturnType<typeof setTimeout> | undefined;
  private positionsSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private searchCts:          vscode.CancellationTokenSource | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly noteGraph: NoteGraph,
  ) {}

  toggle(): void {
    if (this.panel) { this.panel.dispose(); return; }
    this.show();
  }

  show(): void {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside, true); return; }

    this.context.workspaceState.update('graphOpen', true);

    this.panel = vscode.window.createWebviewPanel(
      'codeNodes.graph',
      'Code Nodes Graph',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media'),
        ],
      },
    );

    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {

        case 'ready':
          [this.config, this.positions] = await Promise.all([readConfig(), readPositions()]);
          this.webviewReady = true;
          this.sendGraphData();
          break;

        case 'openNote':
          await openNoteById(msg.nodeId as string, this.noteGraph);
          break;

        case 'createGhostNote': {
          const graphData = this.noteGraph.getGraphData();
          const edge = graphData.edges.find(e => e.target === (msg.nodeId as string));
          let folderUri: vscode.Uri | undefined;
          if (edge) {
            const sourceNode = graphData.nodes.find(n => n.id === edge.source);
            if (sourceNode?.uri) {
              folderUri = vscode.Uri.joinPath(vscode.Uri.parse(sourceNode.uri), '..');
            }
          }
          await openNoteById(msg.nodeId as string, this.noteGraph, folderUri);
          break;
        }

        case 'saveForces':
          this.config.forces = msg.forces as GraphForces;
          this.scheduleConfigSave();
          break;

        case 'saveViewport':
          this.config.viewport = msg.viewport as GraphViewport;
          this.scheduleConfigSave();
          break;

        case 'saveDisplay':
          this.config.display = msg.display as GraphDisplay;
          this.scheduleConfigSave();
          break;

        case 'savePositions':
          this.positions = msg.positions as GraphPositions;
          this.schedulePositionsSave();
          break;

        case 'search': {
          const term = (msg.term as string).trim();
          this.searchCts?.cancel();
          this.searchCts?.dispose();
          this.searchCts = undefined;

          if (!term) {
            this.panel?.webview.postMessage({ type: 'searchResults', matchingIds: null });
            break;
          }

          this.searchCts = new vscode.CancellationTokenSource();
          const token    = this.searchCts.token;
          const data     = this.noteGraph.getGraphData();
          const lower    = term.toLowerCase();

          const matchingIds = new Set<string>(
            data.nodes.filter(n => n.displayName.toLowerCase().includes(lower)).map(n => n.id),
          );

          await Promise.all(data.nodes.filter(n => !n.isGhost && n.uri).map(async n => {
            if (token.isCancellationRequested) return;
            try {
              const text = Buffer.from(
                await vscode.workspace.fs.readFile(vscode.Uri.parse(n.uri)),
              ).toString('utf-8').toLowerCase();
              if (text.includes(lower)) matchingIds.add(n.id);
            } catch { /* skip unreadable */ }
          }));

          if (!token.isCancellationRequested) {
            this.panel?.webview.postMessage({
              type: 'searchResults',
              matchingIds: Array.from(matchingIds),
            });
          }
          break;
        }
      }
    });

    this.panel.onDidDispose(() => {
      this.searchCts?.cancel();
      this.searchCts?.dispose();
      this.searchCts   = undefined;
      this.panel       = undefined;
      this.webviewReady        = false;
      this.lastTopologyHash    = '';
      void this.context.workspaceState.update('graphOpen', false);
    });
  }

  refresh(): void {
    if (!this.panel || !this.webviewReady) return;
    const data = this.noteGraph.getGraphData();
    const hash = this.noteGraph.getTopologyHash();

    if (hash !== this.lastTopologyHash) {
      this.lastTopologyHash = hash;
      this.pruneStalePositions(
        data.nodes.map(n => n.group ? `${n.group}/${n.displayName}` : n.displayName),
      );
      this.panel.webview.postMessage({
        type:           'graphData',
        data,
        forces:         this.config.forces,
        display:        this.config.display,
        savedPositions: this.positions,
        savedViewport:  this.config.viewport,
      });
    } else {
      this.panel.webview.postMessage({ type: 'graphUpdate', data });
    }
  }

  private sendGraphData(): void {
    if (!this.panel) return;
    const data = this.noteGraph.getGraphData();
    this.lastTopologyHash = this.noteGraph.getTopologyHash();
    this.panel.webview.postMessage({
      type:           'graphData',
      data,
      forces:         this.config.forces,
      display:        this.config.display,
      savedPositions: this.positions,
      savedViewport:  this.config.viewport,
    });
  }

  private pruneStalePositions(activeKeys: string[]): void {
    const existing = new Set(activeKeys);
    const stale    = Object.keys(this.positions).filter(k => !existing.has(k));
    if (stale.length === 0) return;
    for (const k of stale) delete this.positions[k];
    this.schedulePositionsSave();
  }

  private scheduleConfigSave(): void {
    if (this.configSaveTimer) clearTimeout(this.configSaveTimer);
    this.configSaveTimer = setTimeout(() => {
      writeConfig(this.config).catch(err =>
        console.error('[Code Nodes] Failed to write graph_settings.jsonc:', err),
      );
    }, 1500);
  }

  private schedulePositionsSave(): void {
    if (this.positionsSaveTimer) clearTimeout(this.positionsSaveTimer);
    this.positionsSaveTimer = setTimeout(() => {
      writePositions(this.positions).catch(err =>
        console.error('[Code Nodes] Failed to write graph_positions.json:', err),
      );
    }, 1500);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    const vendorUri  = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'graph', 'vendor.js'),
    );
    const graphJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph', 'graph.js'),
    );
    const graphCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph', 'graph.css'),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'nonce-${nonce}' blob:;
                 worker-src blob:;
                 style-src ${webview.cspSource} 'unsafe-inline';">
  <link rel="stylesheet" href="${graphCssUri}">
  <title>Code Nodes Graph</title>
</head>
<body>
  <div id="search-bar">
    <input id="search-input" type="text" placeholder="Search notes…" autocomplete="off" spellcheck="false">
    <button id="search-clear" title="Clear search (Esc)">✕</button>
  </div>

  <div id="graph-area">
    <div id="loading-overlay">
      <div class="spinner"></div>
      <p>Computing layout…</p>
    </div>

    <div id="sigma-container"></div>

    <div id="toolbar">
      <button id="fit-btn"  title="Fit graph to window">⊞ Fit</button>
      <button id="run-btn"  title="Start / freeze physics simulation">▶ Run</button>
      <label class="ghost-label" title="Show ghost nodes (wiki links without a file)">
        <input type="checkbox" id="ghost-toggle"> Ghosts
      </label>
      <button id="settings-toggle" title="Graph settings">⚙</button>
    </div>

    <div id="settings-panel">
      <div id="settings-panel-header">Graph Settings</div>
      <label>Repulsion
        <input type="range" id="scalingRatio" min="1" max="200" step="1">
        <span class="val" id="scalingRatio-val"></span>
      </label>
      <label>Gravity
        <input type="range" id="gravity" min="0.001" max="5" step="0.001">
        <span class="val" id="gravity-val"></span>
      </label>
      <label title="Higher = slower, more stable simulation">Speed
        <input type="range" id="slowDown" min="0.1" max="50" step="0.1">
        <span class="val" id="slowDown-val"></span>
      </label>
    </div>
  </div>

  <div id="legend">
    <span class="dot active"></span>Open
    <span class="dot exists"></span>Exists
    <span class="dot ghost"></span>Ghost
  </div>

  <div id="node-tooltip"></div>

  <script nonce="${nonce}" src="${vendorUri}"></script>
  <script nonce="${nonce}" src="${graphJsUri}"></script>
</body>
</html>`;
  }
}
