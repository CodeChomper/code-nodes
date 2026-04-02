import * as vscode from 'vscode';
import { NoteGraph } from './noteGraph';
import { GraphProvider } from './graphProvider';
import { CodeNodesEditorProvider } from './editorProvider';

export class FileWatcher {
  constructor(
    private readonly noteGraph: NoteGraph,
    private readonly graphProvider: GraphProvider,
    private readonly editorProvider: CodeNodesEditorProvider
  ) {}

  async start(context: vscode.ExtensionContext): Promise<void> {
    await this.scanAll();

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');

    watcher.onDidCreate(uri => this.onFileChange(uri));
    watcher.onDidChange(uri => this.onFileChange(uri));
    watcher.onDidDelete(uri => {
      this.noteGraph.removeFile(uri);
      this.graphProvider.refresh();
      this.editorProvider.broadcastNotesList();
    });

    context.subscriptions.push(watcher);
  }

  private async scanAll(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*.md',
      '**/node_modules/**'
    );
    await Promise.all(uris.map(uri => this.readAndUpdate(uri)));
    this.graphProvider.refresh();
    this.editorProvider.broadcastNotesList();
  }

  private async onFileChange(uri: vscode.Uri): Promise<void> {
    await this.readAndUpdate(uri);
    this.graphProvider.refresh();
    this.editorProvider.broadcastNotesList();
  }

  private async readAndUpdate(uri: vscode.Uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder().decode(bytes);
      this.noteGraph.updateFile(uri, content);
    } catch {
      // File may have been deleted between the event and the read
    }
  }
}
