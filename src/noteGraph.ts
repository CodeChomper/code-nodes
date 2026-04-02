import * as vscode from 'vscode';
import * as path from 'path';
import { extractWikiLinks, normalizeNoteName } from './wikiLinkParser';

export interface NoteNode {
  id: string;
  displayName: string;
  uri: string;
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

  updateFile(uri: vscode.Uri, content: string): void {
    const displayName = path.basename(uri.fsPath, '.md');
    const id = normalizeNoteName(displayName);

    // Upsert the real node
    this.nodes.set(id, {
      id,
      displayName,
      uri: uri.toString(),
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
          isGhost: true,
          isActive: false,
          connectionCount: 0,
        });
      }
      // Avoid duplicate edges from the same source to the same target
      const alreadyExists = this.edges.some(
        e => e.source === id && e.target === targetId
      );
      if (!alreadyExists) {
        this.edges.push({ source: id, target: targetId });
      }
    }

    this.pruneOrphanedGhosts();
    this.recalcConnectionCounts();
  }

  removeFile(uri: vscode.Uri): void {
    const displayName = path.basename(uri.fsPath, '.md');
    const id = normalizeNoteName(displayName);

    this.nodes.delete(id);
    this.edges = this.edges.filter(e => e.source !== id && e.target !== id);

    this.pruneOrphanedGhosts();
    this.recalcConnectionCounts();
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
  }

  getGraphData(): GraphData {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
    };
  }

  /**
   * A stable string that changes only when nodes or edges are added/removed.
   * Changes to isActive, connectionCount, or displayName do NOT affect this hash.
   * Used by GraphProvider to decide whether a full re-layout is needed.
   */
  getTopologyHash(): string {
    const nodeIds = Array.from(this.nodes.keys()).sort().join(',');
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
