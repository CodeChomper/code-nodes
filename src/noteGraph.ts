import * as vscode from 'vscode';
import * as path from 'path';
import { extractWikiLinks, normalizeNoteName } from './wikiLinkParser';

export interface NoteNode {
  id: string;
  displayName: string;
  uri: string;
  group: string;
  isGhost: boolean;
  isActive: boolean;
  connectionCount: number;
}

export interface NoteEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: NoteNode[];
  edges: NoteEdge[];
}

export class NoteGraph {
  private nodes = new Map<string, NoteNode>();
  private edges: NoteEdge[] = [];
  private activeNoteId: string | null = null;

  /** Fires whenever nodes, edges, or the active note change. */
  readonly onDidChange = new vscode.EventEmitter<void>();

  updateFile(uri: vscode.Uri, content: string, workspaceRoot?: vscode.Uri): void {
    const displayName = path.basename(uri.fsPath, '.md');
    const id = normalizeNoteName(displayName);

    let group = '';
    if (workspaceRoot) {
      const rel = path.relative(workspaceRoot.fsPath, path.dirname(uri.fsPath));
      group = rel === '.' ? '' : rel.split(path.sep).join('/');
    }

    // Warn if a different file with the same name already exists in the workspace.
    // Duplicate note names are unsupported — the graph uses the display name as
    // the unique identifier, so two files named Notes.md in different folders
    // would collide on the same graph node.
    const existing = this.nodes.get(id);
    if (existing && !existing.isGhost && existing.uri !== uri.toString()) {
      vscode.window.showWarningMessage(
        `Code Nodes: "${displayName}.md" already exists elsewhere in your workspace. ` +
        `Duplicate note names are not supported — rename one of the files to avoid conflicts.`
      );
    }

    // Upsert the real node
    this.nodes.set(id, {
      id,
      displayName,
      uri: uri.toString(),
      group,
      isGhost: false,
      isActive: id === this.activeNoteId,
      connectionCount: 0,
    });

    // Remove stale edges originating from this file
    this.edges = this.edges.filter(e => e.source !== id);

    // Add new edges from wiki links found in content
    const links = extractWikiLinks(content);
    for (const link of links) {
      const targetId = normalizeNoteName(link.target);
      if (!this.nodes.has(targetId)) {
        this.nodes.set(targetId, {
          id: targetId,
          displayName: link.target,
          uri: '',
          group: '',
          isGhost: true,
          isActive: false,
          connectionCount: 0,
        });
      }
      const alreadyExists = this.edges.some(
        e => e.source === id && e.target === targetId
      );
      if (!alreadyExists) {
        this.edges.push({ source: id, target: targetId });
      }
    }

    this.pruneOrphanedGhosts();
    this.recalcConnectionCounts();
    this.onDidChange.fire();
  }

  removeFile(uri: vscode.Uri): void {
    const displayName = path.basename(uri.fsPath, '.md');
    const id = normalizeNoteName(displayName);

    // Demote to ghost so nodes that other notes still link to remain visible.
    // pruneOrphanedGhosts will remove it if nothing links to it.
    const existing = this.nodes.get(id);
    if (existing) {
      this.nodes.set(id, { ...existing, uri: '', isGhost: true, isActive: false });
    }

    // Remove outgoing edges — this file's wiki-links no longer exist
    this.edges = this.edges.filter(e => e.source !== id);

    this.pruneOrphanedGhosts();
    this.recalcConnectionCounts();
    this.onDidChange.fire();
  }

  setActiveNote(uri: vscode.Uri | null): void {
    if (this.activeNoteId) {
      const prev = this.nodes.get(this.activeNoteId);
      if (prev) {
        this.nodes.set(this.activeNoteId, { ...prev, isActive: false });
      }
    }

    if (uri) {
      const displayName = path.basename(uri.fsPath, '.md');
      const id = normalizeNoteName(displayName);
      this.activeNoteId = id;
      const node = this.nodes.get(id);
      if (node) {
        this.nodes.set(id, { ...node, isActive: true });
      }
    } else {
      this.activeNoteId = null;
    }
    this.onDidChange.fire();
  }

  getGraphData(): GraphData {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
    };
  }

  /**
   * A stable string that changes only when nodes or edges are added/removed,
   * or when a file moves between folders (group change).
   * Used by GraphProvider to decide whether a full re-layout is needed.
   */
  getTopologyHash(): string {
    const nodeIds = Array.from(this.nodes.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, n]) => `${id}:${n.group}`)
      .join(',');
    const edgeKeys = this.edges
      .map(e => `${e.source}->${e.target}`)
      .sort()
      .join(',');
    return `${nodeIds}|${edgeKeys}`;
  }

  private pruneOrphanedGhosts(): void {
    for (const [id, node] of this.nodes) {
      if (node.isGhost) {
        const hasEdge = this.edges.some(
          e => e.source === id || e.target === id
        );
        if (!hasEdge) {
          this.nodes.delete(id);
        }
      }
    }
  }

  private recalcConnectionCounts(): void {
    // Reset all to zero
    for (const [id, node] of this.nodes) {
      this.nodes.set(id, { ...node, connectionCount: 0 });
    }
    // Count in-degree + out-degree
    for (const edge of this.edges) {
      const src = this.nodes.get(edge.source);
      if (src) {
        this.nodes.set(edge.source, {
          ...src,
          connectionCount: src.connectionCount + 1,
        });
      }
      const tgt = this.nodes.get(edge.target);
      if (tgt) {
        this.nodes.set(edge.target, {
          ...tgt,
          connectionCount: tgt.connectionCount + 1,
        });
      }
    }
  }
}
