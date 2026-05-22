import * as vscode from 'vscode';
import * as os from 'os';
import { execSync } from 'child_process';
import { NoteGraph } from './noteGraph';

function buildFrontmatter(displayName: string): string {
  let author = os.userInfo().username;
  try {
    author =
      execSync('git config user.name', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || author;
  } catch { /* git not available or not configured — use OS username */ }

  const date = new Date().toISOString().slice(0, 10);
  return `---\nFile Name: ${displayName}\nAuthor: ${author}\nCreate Date: ${date}\n---\n\n# ${displayName}\n`;
}

async function openNote(
  nodeId: string,
  noteGraph: NoteGraph,
  fallbackDisplayName?: string,
  folderUri?: vscode.Uri
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage(
      'Code Nodes: No workspace folder open. Please open a folder first.'
    );
    return;
  }

  const graphData = noteGraph.getGraphData();
  const node = graphData.nodes.find(n => n.id === nodeId);

  let uri: vscode.Uri;
  if (node?.uri) {
    uri = vscode.Uri.parse(node.uri);
  } else {
    const displayName = node?.displayName ?? fallbackDisplayName ?? nodeId;
    const baseFolder = folderUri ?? workspaceFolder.uri;
    uri = vscode.Uri.joinPath(baseFolder, `${displayName}.md`);
  }

  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const displayName = node?.displayName ?? nodeId;
    const frontmatter = buildFrontmatter(displayName);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(frontmatter, 'utf-8'));
  }

  await vscode.commands.executeCommand(
    'vscode.openWith',
    uri,
    'codeNodes.markdownEditor',
    vscode.ViewColumn.One
  );
}

/** Open a note by its display name (wikilink target text). Creates the file if it doesn't exist. */
export async function openNoteByDisplayName(
  displayName: string,
  noteGraph: NoteGraph
): Promise<void> {
  const nodeId = displayName.replace(/\.md$/i, '').toLowerCase().trim();
  await openNote(nodeId, noteGraph, displayName);
}

/** Open a note by its graph node ID. Creates the file if it doesn't exist. */
export async function openNoteById(
  nodeId: string,
  noteGraph: NoteGraph,
  folderUri?: vscode.Uri
): Promise<void> {
  await openNote(nodeId, noteGraph, undefined, folderUri);
}
