import * as vscode from 'vscode';
import { NoteGraph } from './noteGraph';

export class FileWatcher {
  constructor(private readonly noteGraph: NoteGraph) {}

  async start(context: vscode.ExtensionContext): Promise<void> {
    await this.scanAll();

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');

    watcher.onDidCreate(uri => this.onFileChange(uri));
    watcher.onDidChange(uri => this.onFileChange(uri));
    watcher.onDidDelete(uri => this.noteGraph.removeFile(uri));

    context.subscriptions.push(watcher);
  }

  private async scanAll(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*.md',
      '**/node_modules/**'
    );
    await Promise.all(uris.map(uri => this.readAndUpdate(uri)));
  }

  private async onFileChange(uri: vscode.Uri): Promise<void> {
    await this.readAndUpdate(uri);
  }

  private async readAndUpdate(uri: vscode.Uri): Promise<void> {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder().decode(bytes);
      this.noteGraph.updateFile(uri, content, workspaceRoot);
    } catch {
      // File may have been deleted between the event and the read
    }
  }
}
