import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { NoteGraph } from './noteGraph';
import { GraphProvider } from './graphProvider';

// ─── Spell checker (module-level singleton, shared across all editor instances)

type SpellChecker = { correct(word: string): boolean; suggest(word: string): string[] };
let spellChecker: SpellChecker | null = null;

function loadSpellChecker(extensionPath: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nspell = require('nspell');
    const aff = fs.readFileSync(path.join(extensionPath, 'dist', 'en_US.aff'));
    const dic = fs.readFileSync(path.join(extensionPath, 'dist', 'en_US.dic'));
    spellChecker = nspell({ aff, dic }) as SpellChecker;
  } catch {
    // Dictionary files not present (e.g. first run before build) — spell check disabled
  }
}

const WORD_RE = /\b[A-Za-z]+\b/g;

function checkSpelling(text: string): Array<{ start: number; end: number }> {
  if (!spellChecker) return [];
  const results: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((match = WORD_RE.exec(text)) !== null) {
    const word = match[0];
    // Skip ALL-CAPS (abbreviations: API, URL, etc.)
    if (word.length > 1 && word === word.toUpperCase()) continue;
    if (!spellChecker.correct(word)) {
      results.push({ start: match.index, end: match.index + word.length });
    }
  }
  return results;
}

function getNonce(): string {
  let text = '';
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class CodeNodesEditorProvider implements vscode.CustomTextEditorProvider {
  /** All currently open editor webview panels. */
  private readonly panels = new Set<vscode.WebviewPanel>();

  public static register(
    context: vscode.ExtensionContext,
    noteGraph: NoteGraph,
    graphProvider: GraphProvider
  ): { provider: CodeNodesEditorProvider; disposable: vscode.Disposable } {
    const provider = new CodeNodesEditorProvider(context, noteGraph, graphProvider);
    const disposable = vscode.window.registerCustomEditorProvider(
      'codeNodes.markdownEditor',
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
    return { provider, disposable };
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly noteGraph: NoteGraph,
    private readonly graphProvider: GraphProvider
  ) {
    loadSpellChecker(context.extensionPath);
  }

  /** Send the current list of real (non-ghost) note names to every open editor. */
  broadcastNotesList(): void {
    if (this.panels.size === 0) return;
    const notes = this.noteGraph
      .getGraphData()
      .nodes.filter(n => !n.isGhost)
      .map(n => n.displayName)
      .sort((a, b) => a.localeCompare(b));
    const msg = { type: 'notesList', notes };
    for (const panel of this.panels) {
      panel.webview.postMessage(msg);
    }
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media'),
      ],
    };

    webviewPanel.webview.html = this.buildHtml(
      webviewPanel.webview,
      document
    );

    this.panels.add(webviewPanel);

    // Webview → Extension
    webviewPanel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':
          webviewPanel.webview.postMessage({
            type: 'init',
            content: document.getText(),
          });
          this.noteGraph.setActiveNote(document.uri);
          this.graphProvider.refresh();
          // Send the initial notes list for autocomplete
          this.broadcastNotesList();
          break;

        case 'edit':
          await this.applyEdit(document, msg.blocks as string[]);
          break;

        case 'getSuggestions': {
          const suggestions = spellChecker
            ? spellChecker.suggest(msg.word as string).slice(0, 6)
            : [];
          webviewPanel.webview.postMessage({ type: 'suggestions', word: msg.word, suggestions });
          break;
        }

        case 'spellCheck': {
          const text = msg.text as string;
          const blockIndex = msg.blockIndex as number;
          // Don't spell-check code blocks
          const misspelled = text.trimStart().startsWith('```')
            ? []
            : checkSpelling(text);
          webviewPanel.webview.postMessage({
            type: 'spellCheckResult',
            blockIndex,
            text,
            misspelled,
          });
          break;
        }
      }
    });

    // Document → Webview (external changes, e.g. git checkout)
    const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        e.contentChanges.length > 0
      ) {
        webviewPanel.webview.postMessage({
          type: 'update',
          content: e.document.getText(),
        });
      }
    });

    // When the panel is brought into focus (including when already-open files are
    // revealed by clicking a graph node), mark this note as active and refresh.
    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        this.noteGraph.setActiveNote(document.uri);
        this.graphProvider.refresh();
      }
    });

    webviewPanel.onDidDispose(() => {
      this.panels.delete(webviewPanel);
      changeSubscription.dispose();
      this.noteGraph.setActiveNote(null);
      this.graphProvider.refresh();
    });
  }

  private async applyEdit(
    document: vscode.TextDocument,
    blocks: string[]
  ): Promise<void> {
    const newContent = blocks.join('\n\n');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      newContent
    );
    await vscode.workspace.applyEdit(edit);
  }

  private buildHtml(
    webview: vscode.Webview,
    _document: vscode.TextDocument
  ): string {
    const nonce = getNonce();

    const vendorUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'media',
        'editor',
        'vendor.js'
      )
    );
    const editorJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'media',
        'editor',
        'editor.js'
      )
    );
    const editorCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'media',
        'editor',
        'editor.css'
      )
    );
    const hljsCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'media',
        'editor',
        'hljs-theme.css'
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
  <link rel="stylesheet" href="${editorCssUri}">
  <link rel="stylesheet" href="${hljsCssUri}">
  <title>Code Nodes Editor</title>
</head>
<body>
  <div id="blocks-container"></div>
  <button id="add-block-btn" title="Add new block">+ Add Block</button>
  <script nonce="${nonce}" src="${vendorUri}"></script>
  <script nonce="${nonce}" src="${editorJsUri}"></script>
</body>
</html>`;
  }
}
