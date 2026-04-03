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
| Open graph | `Ctrl + Alt + G`, or Click the graph icon in the editor toolbar, or run `Code Nodes: Open Graph View` |
| Open a note | Click its node |
| Create a linked note | Click a ghost node (grey) |
| Rearrange nodes | Drag any node |
| Adjust layout physics | Use the sliders in the bottom panel |
| Zoom | Scroll wheel |
| Pan | Click and drag the background |

### Commands

| Command | Description |
|---|---|
| `Code Nodes: Open Graph View` | Opens the wiki-link graph beside the editor |
| `Code Nodes: New Note` | Creates a new `.md` file and opens it |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension host | TypeScript, VS Code API |
| Editor webview | Vanilla JS, [marked.js](https://marked.js.org/), [highlight.js](https://highlightjs.org/) |
| Graph webview | [Cytoscape.js](https://js.cytoscape.org/) + [fCoSE layout](https://github.com/iVis-at-Bilkent/cytoscape.js-fcose) |
| Bundler | [esbuild](https://esbuild.github.io/) |