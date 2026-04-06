# Code Nodes

A VS Code extension that combines a block-based Markdown editor with a live wiki-link graph — write notes in structured blocks, visualize how they connect.

---

## Features

### Block-Based Markdown Editor

Code Nodes is the default editor for `.md` files. Each document is split into blocks separated by blank lines. Blocks are edited individually and rendered as formatted Markdown.

- **Click any block** to edit it in-place
- **Escape** or click away to render it
- **Syntax-highlighted code blocks** — fenced code with a language tag (` ```python `, ` ```typescript `, etc.) renders with full syntax highlighting
- **YAML frontmatter** rendered as a clean key-value table
- **[[Wiki links]]** rendered as highlighted spans; autocomplete suggests existing notes as you type
- **Drag handles** to reorder blocks
- **Add Block** button or Down arrow on the last line to create a new block below

### Wiki-Link Graph

Open the graph with the toolbar button or the command palette.

- **Force-directed layout** using fCoSE — nodes spread organically based on connections
- **Node size** reflects connection count — highly linked notes appear larger
- **Click any node** to open that note
- **Drag nodes** to rearrange; connected neighbors follow with spring physics
- **Ghost nodes** shown for wiki links that reference files that don't exist yet — click to create them
- **Active note** highlighted in green
- **Adjustable physics** — Repulsion, Gravity, Edge Length, and Energy sliders persist across sessions

### Folder Groups

Organise notes into subfolders inside your workspace. Code Nodes automatically groups them in the graph with a labelled hull outline around each folder's nodes.

- **Any subfolder depth is supported** — `projects/Notes.md`, `projects/api/Reference.md`, etc.
- **Groups fade in** after the graph finishes its layout animation
- **Hulls update live** as you drag nodes around
- **Drag an entire group** by clicking and dragging inside the hull (but outside any individual node) — all nodes in the group move together

### Full-Text Graph Search

A search bar sits at the top of the graph panel and searches across both note names and note content.

- **Type any term** to dim all nodes whose name and content don't contain a match
- **Edges dim** automatically when both of their endpoints are dimmed
- Matches **note names and file content** — useful when you know the topic but not which note covers it
- **Pulsing border** on the input indicates a search is in progress
- **Clear** with the ✕ button or press **Escape**

### Daily Notes

Quickly capture today's thoughts without interrupting your flow.

- Opens (or creates) a note named after today's date in a `daily/` subfolder
- Notes are pre-filled with a heading formatted as the full date (e.g. `# April 5, 2026`)
- Each day gets its own file — previous daily notes are preserved

---

## Usage

### Editor

| Action | How |
|---|---|
| Edit a block | Click it |
| Confirm / exit edit | Escape or click away |
| Navigate between blocks | Up / Down arrow at first / last line |
| Reorder block | Alt + Up / Down |
| Split block at cursor | Enter (when text exists on both sides) |
| Delete block | Ctrl + Shift + K |
| Create block below | Down arrow on last line of last block |
| Wiki-link autocomplete | Type `[[` then start typing a note name |

### Graph

| Action | How |
|---|---|
| Open graph | `Ctrl + Alt + G`, or click the graph icon in the editor toolbar, or run `Code Nodes: Open Graph View` |
| Open a note | Click its node |
| Create a linked note | Click a ghost node (grey) |
| Rearrange nodes | Drag any node |
| Move a whole group | Click and drag inside a group hull (not on a node) |
| Search notes | Type in the search bar at the top of the graph panel |
| Clear search | Click ✕ or press Escape |
| Adjust layout physics | Use the sliders in the bottom panel |
| Zoom | Scroll wheel |
| Pan | Click and drag the background |

### Commands

| Command | Shortcut | Description |
|---|---|---|
| `Code Nodes: Open Graph View` | `Ctrl + Alt + G` | Opens the wiki-link graph beside the editor |
| `Code Nodes: New Note` | — | Creates a new `.md` file and opens it |
| `Code Nodes: Open Daily Note` | `Ctrl + Alt + T` | Opens or creates today's daily note |

---

## Wiki-Links

`[[Note Name]]` links are resolved by filename across the entire workspace, regardless of which folder the file lives in. Moving a note into a subfolder never breaks existing links.

> **Note name uniqueness** — each note name must be unique across your whole workspace, even across folders. If two files share the same name (e.g. `games/Notes.md` and `projects/Notes.md`), Code Nodes will warn you and only one will appear in the graph. Rename one of the files to resolve the conflict.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension host | TypeScript, VS Code API |
| Editor webview | Vanilla JS, [marked.js](https://marked.js.org/), [highlight.js](https://highlightjs.org/) |
| Graph webview | [Cytoscape.js](https://js.cytoscape.org/) + [fCoSE layout](https://github.com/iVis-at-Bilkent/cytoscape.js-fcose) |
| Bundler | [esbuild](https://esbuild.github.io/) |