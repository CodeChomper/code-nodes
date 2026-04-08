import * as vscode from 'vscode';
import { CodeNodesEditorProvider } from './editorProvider';
import { GraphProvider } from './graphProvider';
import { FileWatcher } from './fileWatcher';
import { NoteGraph } from './noteGraph';

export function activate(context: vscode.ExtensionContext): void {
  const noteGraph = new NoteGraph();
  const graphProvider = new GraphProvider(context, noteGraph);

  const { provider: editorProvider, disposable: editorDisposable } =
    CodeNodesEditorProvider.register(context, noteGraph);
  context.subscriptions.push(editorDisposable);

  // Single reactive subscription: any graph/active-note change refreshes the graph
  // and updates the autocomplete list in all open editors.
  context.subscriptions.push(
    noteGraph.onDidChange.event(() => {
      graphProvider.refresh();
      editorProvider.broadcastNotesList();
    }),
    noteGraph.onDidChange
  );

  const fileWatcher = new FileWatcher(noteGraph);

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

  // Command: open or create today's daily note
  context.subscriptions.push(
    vscode.commands.registerCommand('codeNodes.dailyNote', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage(
          'Code Nodes: No workspace folder open. Please open a folder first.'
        );
        return;
      }

      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const fileName = `${yyyy}-${mm}-${dd}.md`;

      const dailyDir = vscode.Uri.joinPath(workspaceFolder.uri, 'daily');
      const uri = vscode.Uri.joinPath(dailyDir, fileName);

      try {
        await vscode.workspace.fs.stat(uri);
        // File already exists — just open it
      } catch {
        await vscode.workspace.fs.createDirectory(dailyDir);
        const heading = now.toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric',
        });
        const content = `# ${heading}\n\n`;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
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
