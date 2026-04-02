import * as vscode from 'vscode';
import { CodeNodesEditorProvider } from './editorProvider';
import { GraphProvider } from './graphProvider';
import { FileWatcher } from './fileWatcher';
import { NoteGraph } from './noteGraph';

export function activate(context: vscode.ExtensionContext): void {
  const noteGraph = new NoteGraph();
  const graphProvider = new GraphProvider(context, noteGraph);

  // Register the custom markdown editor (also get the provider instance for broadcasting)
  const { provider: editorProvider, disposable: editorDisposable } =
    CodeNodesEditorProvider.register(context, noteGraph, graphProvider);
  context.subscriptions.push(editorDisposable);

  const fileWatcher = new FileWatcher(noteGraph, graphProvider, editorProvider);

  // Command: open graph view beside the editor
  context.subscriptions.push(
    vscode.commands.registerCommand('codeNodes.openGraph', () => {
      graphProvider.toggle();
    })
  );

  // Command: create a new note in the workspace
  context.subscriptions.push(
    vscode.commands.registerCommand('codeNodes.newNote', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage(
          'Code Nodes: No workspace folder open. Please open a folder first.'
        );
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Note name (without .md)',
        placeHolder: 'my-note',
        validateInput: v =>
          v.trim() ? undefined : 'Name cannot be empty',
      });

      if (!name) return;

      const uri = vscode.Uri.joinPath(
        workspaceFolder.uri,
        `${name.trim()}.md`
      );

      try {
        await vscode.workspace.fs.stat(uri);
        // File already exists — just open it
      } catch {
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      }

      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'codeNodes.markdownEditor',
        vscode.ViewColumn.One
      );
    })
  );

  // Kick off initial workspace scan + set up file watching
  fileWatcher.start(context);
}

export function deactivate(): void {}
