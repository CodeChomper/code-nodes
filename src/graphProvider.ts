import * as vscode from 'vscode';
import { NoteGraph } from './noteGraph';

interface GraphForces {
  repulsion: number;
  gravity: number;
  edgeLength: number;
  damping: number;
}

const DEFAULT_FORCES: GraphForces = {
  repulsion: 8000,
  gravity: 0.15,
  edgeLength: 150,
  damping: 0.5,
};

const FORCES_KEY = 'codeNodes.graphForces';

function getNonce(): string {
  let text = '';
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class GraphProvider {
  private panel: vscode.WebviewPanel | undefined;
  /** Last topology hash sent to the webview. Empty string forces a full layout on first send. */
  private lastTopologyHash = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly noteGraph: NoteGraph
  ) {}

  toggle(): void {
    if (this.panel) {
      this.panel.dispose();
      return;
    }
    this.show();
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

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
      }
    );

    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':
          this.sendGraphData();
          break;
        case 'openNote':
          await this.openNote(msg.displayName as string);
          break;
        case 'saveForces':
          await this.context.globalState.update(FORCES_KEY, msg.forces);
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.lastTopologyHash = ''; // reset so next open always does a full layout
    });
  }

  refresh(): void {
    if (!this.panel) return;
    const data = this.noteGraph.getGraphData();
    const hash = this.noteGraph.getTopologyHash();

    if (hash !== this.lastTopologyHash) {
      // Nodes or edges changed → send full data and re-run the layout
      this.lastTopologyHash = hash;
      const forces = this.context.globalState.get<GraphForces>(FORCES_KEY, DEFAULT_FORCES);
      this.panel.webview.postMessage({ type: 'graphData', data, forces });
    } else {
      // Only visual properties changed (e.g. isActive colour) → update in-place, no layout
      this.panel.webview.postMessage({ type: 'graphUpdate', data });
    }
  }

  private sendGraphData(): void {
    if (!this.panel) return;
    const data = this.noteGraph.getGraphData();
    const forces = this.context.globalState.get<GraphForces>(FORCES_KEY, DEFAULT_FORCES);
    this.lastTopologyHash = this.noteGraph.getTopologyHash();
    this.panel.webview.postMessage({ type: 'graphData', data, forces });
  }

  private async openNote(displayName: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage(
        'Code Nodes: No workspace folder open. Please open a folder first.'
      );
      return;
    }

    const uri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      `${displayName}.md`
    );

    // Create file if it doesn't exist (ghost node clicked)
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    }

    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'codeNodes.markdownEditor',
      vscode.ViewColumn.One
    );
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    const vendorUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'media',
        'graph',
        'vendor.js'
      )
    );
    const graphJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'media',
        'graph',
        'graph.js'
      )
    );
    const graphCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'media',
        'graph',
        'graph.css'
      )
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'nonce-${nonce}';
                 style-src ${webview.cspSource} 'unsafe-inline';">
  <link rel="stylesheet" href="${graphCssUri}">
  <title>Code Nodes Graph</title>
</head>
<body>
  <div id="cy-container"></div>
  <div id="legend">
    <span class="dot active"></span>Open
    <span class="dot exists"></span>Exists
    <span class="dot ghost"></span>Ghost
  </div>
  <div id="controls">
    <label>Repulsion
      <input type="range" id="repulsion" min="100" max="20000" step="100">
      <span class="val" id="repulsion-val"></span>
    </label>
    <label>Gravity
      <input type="range" id="gravity" min="0.01" max="1.0" step="0.01">
      <span class="val" id="gravity-val"></span>
    </label>
    <label>Edge Length
      <input type="range" id="edgeLength" min="30" max="600" step="10">
      <span class="val" id="edgeLength-val"></span>
    </label>
    <label title="How much nodes move when re-settling (0 = frozen, 1 = full recompute)">Energy
      <input type="range" id="damping" min="0.1" max="1.0" step="0.05">
      <span class="val" id="damping-val"></span>
    </label>
  </div>
  <script nonce="${nonce}" src="${vendorUri}"></script>
  <script nonce="${nonce}" src="${graphJsUri}"></script>
</body>
</html>`;
  }
}
