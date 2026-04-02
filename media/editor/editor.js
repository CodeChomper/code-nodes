// @ts-nocheck
/* global CodeNodesEditorVendor, acquireVsCodeApi */

const vscode = acquireVsCodeApi();
const { marked } = CodeNodesEditorVendor;

// Configure marked: no automatic <p> wrapping for single-line blocks
marked.setOptions({ breaks: true, gfm: true });

// ─── State ────────────────────────────────────────────────────────────────────

let blocks = [];          // string[] — raw markdown per block
let editingIndex = null;  // index of block currently in edit mode
let ignoreNextUpdate = false; // suppress echo from our own edits

const container = document.getElementById('blocks-container');
const addBtn    = document.getElementById('add-block-btn');

// ─── Autocomplete State ───────────────────────────────────────────────────────

let notesList = [];  // string[] — display names of all real notes in workspace
let acState = null;  // { textarea, blockIndex, insertStart } | null

const acDropdown = document.createElement('div');
acDropdown.id = 'ac-dropdown';
acDropdown.setAttribute('role', 'listbox');
document.body.appendChild(acDropdown);

// ─── Parsing ──────────────────────────────────────────────────────────────────

// Matches YAML frontmatter at the very start of the document.
// Uses a lazy [\s\S]*? so it stops at the FIRST closing ---.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

function isFrontmatterBlock(md) {
  return FRONTMATTER_RE.test(md.trimEnd() + '\n');
}

/**
 * Split document text into blocks on blank lines.
 * Handles two special cases before normal splitting:
 *   1. YAML frontmatter (--- delimited) → always becomes block 0, never split
 *   2. Fenced code blocks (``` delimited) → blank lines inside are preserved
 */
function parseBlocks(content) {
  if (!content.trim()) return [''];

  let rest = content;
  const leading = [];

  // Pull out frontmatter before anything else so blank lines inside it
  // don't get treated as block separators.
  const fmMatch = content.match(FRONTMATTER_RE);
  if (fmMatch) {
    leading.push(fmMatch[0].trimEnd());
    rest = content.slice(fmMatch[0].length);
  }

  // Normal blank-line splitting on the body, still respecting code fences.
  const body = [];
  const lines = rest.split('\n');
  let current = [];
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;

    if (!inFence && line.trim() === '' && current.length > 0) {
      body.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0 && current.join('\n').trim()) {
    body.push(current.join('\n'));
  }

  const all = [...leading, ...body];
  return all.length > 0 ? all : [''];
}

function serializeBlocks() {
  return blocks.join('\n\n');
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a YAML frontmatter block as a styled key-value table.
 * Falls back to a <pre> for multi-level / list values.
 */
function renderFrontmatter(md) {
  const inner = md
    .replace(/^---\r?\n/, '')
    .replace(/\r?\n---\s*$/, '');

  const rows = inner.split('\n').map(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      return `<tr><td class="fm-key" colspan="2">${escapeHtml(line)}</td></tr>`;
    }
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    return `<tr>
      <td class="fm-key">${escapeHtml(key)}</td>
      <td class="fm-val">${escapeHtml(val)}</td>
    </tr>`;
  }).join('');

  return `<div class="frontmatter">
    <div class="fm-label">frontmatter</div>
    <table>${rows}</table>
  </div>`;
}

/**
 * Render markdown → HTML, and annotate [[wiki links]] with spans.
 * Detects frontmatter blocks and routes them to renderFrontmatter instead.
 */
function renderMarkdown(md) {
  if (isFrontmatterBlock(md)) return renderFrontmatter(md);

  const html = marked.parse(md || '');
  // Highlight [[wiki links]] in rendered output
  return html.replace(/\[\[([^\[\]]+)\]\]/g, (_, target) => {
    const escaped = target.replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<span class="wiki-link" data-target="${escaped}">[[${escaped}]]</span>`;
  });
}

// ─── Block DOM ────────────────────────────────────────────────────────────────

function createBlockElement(index) {
  const isFrontmatter = index === 0 && isFrontmatterBlock(blocks[0]);

  const blockEl = document.createElement('div');
  blockEl.className = 'block' + (isFrontmatter ? ' block-frontmatter' : '');
  blockEl.dataset.index = String(index);
  if (isFrontmatter) blockEl.dataset.frontmatter = 'true';

  const handle = document.createElement('div');
  handle.className = 'block-drag-handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder';

  const rendered = document.createElement('div');
  rendered.className = 'block-rendered';
  rendered.innerHTML = renderMarkdown(blocks[index]);

  const textarea = document.createElement('textarea');
  textarea.className = 'block-editor';
  textarea.value = blocks[index];
  textarea.rows = 1;

  blockEl.appendChild(handle);
  blockEl.appendChild(rendered);
  blockEl.appendChild(textarea);

  // Click rendered view → enter edit mode
  rendered.addEventListener('click', () => enterEditMode(index));

  // Auto-resize + trigger autocomplete on every input
  textarea.addEventListener('input', () => {
    autoResize(textarea);
    const query = getWikiQuery(textarea);
    if (query !== null) {
      acShow(textarea, index, query);
    } else {
      acHide();
    }
  });

  // Keyboard shortcuts inside textarea
  textarea.addEventListener('keydown', e => handleTextareaKeydown(e, index));

  // Exit edit mode on blur (autocomplete mousedown uses preventDefault so blur
  // doesn't fire during a suggestion click)
  textarea.addEventListener('blur', () => {
    // Small timeout: allow button clicks to fire first
    setTimeout(() => {
      if (editingIndex === index) {
        acHide();
        exitEditMode(index);
      }
    }, 100);
  });

  // Drag-and-drop (frontmatter block is locked in place)
  if (isFrontmatter) {
    handle.style.display = 'none';
    return blockEl;
  }

  blockEl.setAttribute('draggable', 'true');
  handle.addEventListener('mousedown', () => { blockEl.draggable = true; });

  blockEl.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', String(index));
    e.dataTransfer.effectAllowed = 'move';
    blockEl.classList.add('dragging');
  });
  blockEl.addEventListener('dragend', () => {
    blockEl.classList.remove('dragging');
    document.querySelectorAll('.block').forEach(b => b.classList.remove('drag-over'));
  });
  blockEl.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.block').forEach(b => b.classList.remove('drag-over'));
    blockEl.classList.add('drag-over');
  });
  blockEl.addEventListener('dragleave', () => {
    blockEl.classList.remove('drag-over');
  });
  blockEl.addEventListener('drop', e => {
    e.preventDefault();
    blockEl.classList.remove('drag-over');
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const toIndex = index;
    if (fromIndex !== toIndex) reorderBlock(fromIndex, toIndex);
  });

  return blockEl;
}

function renderAll() {
  container.innerHTML = '';
  blocks.forEach((_, i) => {
    container.appendChild(createBlockElement(i));
  });
  // Re-enter edit mode on same index after re-render if needed
  if (editingIndex !== null && editingIndex < blocks.length) {
    enterEditMode(editingIndex);
  }
}

// ─── Edit Mode ────────────────────────────────────────────────────────────────

/**
 * Enter edit mode on a block, with optional explicit cursor position.
 * cursorPos = 'end' (default) | 'start' | number (character offset)
 */
function enterEditMode(index, cursorPos = 'end') {
  // Exit current edit first
  if (editingIndex !== null && editingIndex !== index) {
    exitEditModeNoSend(editingIndex);
  }

  editingIndex = index;
  const blockEl = getBlockEl(index);
  if (!blockEl) return;

  const rendered = blockEl.querySelector('.block-rendered');
  const textarea = blockEl.querySelector('.block-editor');
  rendered.style.display = 'none';
  textarea.style.display = 'block';
  textarea.value = blocks[index];
  autoResize(textarea);
  textarea.focus();

  const len = textarea.value.length;
  const pos =
    cursorPos === 'end'   ? len :
    cursorPos === 'start' ? 0   :
    Math.min(cursorPos, len);
  textarea.selectionStart = textarea.selectionEnd = pos;
  blockEl.classList.add('active');
}

/**
 * Saves the textarea content for `index` into blocks[], clears editingIndex,
 * and removes the block if it is empty (and there are other blocks to fall back to).
 * Returns true if the block was spliced out, false if it was kept.
 * Does NOT call renderAll or sendEdit — callers must do that.
 */
function saveBlock(index) {
  const blockEl = getBlockEl(index);
  if (blockEl) {
    const textarea = blockEl.querySelector('.block-editor');
    if (textarea) blocks[index] = textarea.value;
  }
  if (editingIndex === index) editingIndex = null;

  const isFM = index === 0 && isFrontmatterBlock(blocks[0] ?? '');
  if (!blocks[index].trim() && blocks.length > 1 && !isFM) {
    blocks.splice(index, 1);
    return true;
  }
  return false;
}

function exitEditMode(index) {
  if (editingIndex === index) editingIndex = null;
  const blockEl = getBlockEl(index);
  if (!blockEl) return;

  const textarea = blockEl.querySelector('.block-editor');
  const newContent = textarea.value;
  const prevContent = blocks[index];
  blocks[index] = newContent;

  // Auto-remove empty blocks on blur/escape (keep the last one; never frontmatter)
  const isFM = index === 0 && isFrontmatterBlock(blocks[0] ?? '');
  if (!newContent.trim() && blocks.length > 1 && !isFM) {
    blocks.splice(index, 1);
    sendEdit();
    renderAll();
    return;
  }

  const rendered = blockEl.querySelector('.block-rendered');
  rendered.innerHTML = renderMarkdown(newContent);
  textarea.style.display = 'none';
  rendered.style.display = 'block';
  blockEl.classList.remove('active');

  if (newContent !== prevContent) sendEdit();
}

function exitEditModeNoSend(index) {
  acHide();
  if (editingIndex === index) editingIndex = null;
  const blockEl = getBlockEl(index);
  if (!blockEl) return;

  const textarea = blockEl.querySelector('.block-editor');
  const rendered = blockEl.querySelector('.block-rendered');
  blocks[index] = textarea.value;
  rendered.innerHTML = renderMarkdown(blocks[index]);
  textarea.style.display = 'none';
  rendered.style.display = 'block';
  blockEl.classList.remove('active');
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

/** True if the cursor is sitting on the first line of the textarea. */
function isOnFirstLine(textarea) {
  const firstNewline = textarea.value.indexOf('\n');
  // No newlines → single line, always qualifies
  if (firstNewline === -1) return true;
  return textarea.selectionStart <= firstNewline;
}

/** True if the cursor is sitting on the last line of the textarea. */
function isOnLastLine(textarea) {
  const lastNewline = textarea.value.lastIndexOf('\n');
  if (lastNewline === -1) return true;
  return textarea.selectionStart > lastNewline;
}

/**
 * When navigating into a block from above (Down arrow), place the cursor on
 * the first line at roughly the same column the user had in the source block.
 */
function cursorPosForEntry(targetValue, fromCol) {
  const firstLineEnd = targetValue.indexOf('\n');
  const lineLen = firstLineEnd === -1 ? targetValue.length : firstLineEnd;
  return Math.min(fromCol, lineLen);
}

/**
 * When navigating into a block from below (Up arrow), place the cursor on
 * the last line at roughly the same column.
 */
function cursorPosForEntryFromBelow(targetValue, fromCol) {
  const lastNewline = targetValue.lastIndexOf('\n');
  const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
  const lineLen = targetValue.length - lineStart;
  return lineStart + Math.min(fromCol, lineLen);
}

/** Column of the cursor within its current line. */
function cursorColumn(textarea) {
  const lastNewline = textarea.value.lastIndexOf('\n', textarea.selectionStart - 1);
  return textarea.selectionStart - (lastNewline + 1);
}

function handleTextareaKeydown(e, index) {
  // ── Autocomplete keyboard intercept (must run before all other handlers) ──
  if (acState) {
    if (e.key === 'ArrowDown') {
      e.preventDefault(); acMove(1); return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault(); acMove(-1); return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const sel = acDropdown.querySelector('.ac-selected');
      if (sel) { e.preventDefault(); acComplete(sel.dataset.name); return; }
    }
    if (e.key === 'Escape') {
      e.preventDefault(); acHide(); return;
    }
    // Left/right arrow or typed closing ] dismisses the dropdown
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ']') {
      acHide();
    }
  }

  // Tab → insert 2 spaces
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    insertAtCursor(e.target, '  ');
    return;
  }

  // Escape → exit edit mode
  if (e.key === 'Escape') {
    e.preventDefault();
    exitEditMode(index);
    return;
  }

  // ArrowUp on first line → jump to previous block (cursor on its last line)
  if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (index > 0 && isOnFirstLine(e.target)) {
      e.preventDefault();
      const col = cursorColumn(e.target);
      const removed = saveBlock(index);
      // Removing the current block doesn't shift anything at index-1
      const target = index - 1;
      sendEdit();
      renderAll();
      setTimeout(() => enterEditMode(target, cursorPosForEntryFromBelow(blocks[target], col)), 0);
      return;
    }
  }

  // ArrowDown on last line → jump to next block, or create one if on the last block
  if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (isOnLastLine(e.target)) {
      e.preventDefault();
      const col = cursorColumn(e.target);
      if (index < blocks.length - 1) {
        // Navigate to existing next block
        const removed = saveBlock(index);
        // If current was removed, old index+1 slid down to index
        const target = removed ? index : index + 1;
        sendEdit();
        renderAll();
        setTimeout(() => enterEditMode(target, cursorPosForEntry(blocks[target], col)), 0);
      } else {
        // Last block → create a new empty block below and enter it
        saveBlock(index); // remove if empty, otherwise keep
        blocks.push('');
        sendEdit();
        renderAll();
        setTimeout(() => enterEditMode(blocks.length - 1, 'start'), 0);
      }
      return;
    }
  }

  // Alt+Up → move block up
  if (e.altKey && e.key === 'ArrowUp') {
    e.preventDefault();
    if (index > 0) {
      exitEditModeNoSend(index);
      reorderBlock(index, index - 1);
      setTimeout(() => enterEditMode(index - 1), 0);
    }
    return;
  }

  // Alt+Down → move block down
  if (e.altKey && e.key === 'ArrowDown') {
    e.preventDefault();
    if (index < blocks.length - 1) {
      exitEditModeNoSend(index);
      reorderBlock(index, index + 1);
      setTimeout(() => enterEditMode(index + 1), 0);
    }
    return;
  }

  // Ctrl+Shift+K → delete block
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'K') {
    e.preventDefault();
    deleteBlock(index);
    return;
  }

  // Enter on empty textarea → split or add new block
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    const textarea = e.target;
    const cursorPos = textarea.selectionStart;
    const value = textarea.value;
    const before = value.slice(0, cursorPos);
    const after = value.slice(cursorPos);

    // Only split if there's text on both sides of cursor
    if (before.trim() && after.trim()) {
      e.preventDefault();
      exitEditModeNoSend(index);
      blocks[index] = before.trimEnd();
      blocks.splice(index + 1, 0, after.trimStart());
      sendEdit();
      renderAll();
      setTimeout(() => enterEditMode(index + 1), 0);
    }
    // Otherwise let normal Enter work (newline inside block)
  }
}

// ─── Block Operations ─────────────────────────────────────────────────────────

function reorderBlock(fromIndex, toIndex) {
  const [block] = blocks.splice(fromIndex, 1);
  blocks.splice(toIndex, 0, block);
  sendEdit();
  renderAll();
}

function deleteBlock(index) {
  if (blocks.length <= 1) {
    blocks[0] = '';
  } else {
    blocks.splice(index, 1);
  }
  editingIndex = null;
  sendEdit();
  renderAll();
}

function addBlock() {
  if (editingIndex !== null) exitEditMode(editingIndex);
  blocks.push('');
  sendEdit();
  renderAll();
  setTimeout(() => enterEditMode(blocks.length - 1), 0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBlockEl(index) {
  return container.querySelector(`.block[data-index="${index}"]`);
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value =
    textarea.value.slice(0, start) + text + textarea.value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

/**
 * If the cursor is inside an unclosed [[... wiki link, return the partial
 * name being typed. Otherwise return null.
 */
function getWikiQuery(textarea) {
  const before = textarea.value.slice(0, textarea.selectionStart);
  const match = before.match(/\[\[([^\[\]\n]*)$/);
  return match ? match[1] : null;
}

function acShow(textarea, blockIndex, query) {
  const filtered = notesList
    .filter(n => n.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 10);

  if (!filtered.length) { acHide(); return; }

  // Record where the [[ starts so we can replace the right range on completion
  const before = textarea.value.slice(0, textarea.selectionStart);
  const insertStart = before.lastIndexOf('[[');
  acState = { textarea, blockIndex, insertStart };

  acDropdown.innerHTML = filtered.map((name, i) =>
    `<div class="ac-item${i === 0 ? ' ac-selected' : ''}" role="option" data-name="${escapeHtml(name)}">${escapeHtml(name)}</div>`
  ).join('');

  // Position just below the textarea using fixed coords
  const rect = textarea.getBoundingClientRect();
  acDropdown.style.top  = `${rect.bottom + 4}px`;
  acDropdown.style.left = `${rect.left}px`;
  acDropdown.style.minWidth = `${Math.max(rect.width, 180)}px`;
  acDropdown.style.display = 'block';

  acDropdown.querySelectorAll('.ac-item').forEach(item => {
    // mousedown (not click) so it fires before the textarea blur
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      acComplete(item.dataset.name);
    });
  });
}

function acHide() {
  acDropdown.style.display = 'none';
  acState = null;
}

function acMove(delta) {
  const items = [...acDropdown.querySelectorAll('.ac-item')];
  const cur = acDropdown.querySelector('.ac-selected');
  let idx = items.indexOf(cur) + delta;
  idx = Math.max(0, Math.min(idx, items.length - 1));
  items.forEach((el, i) => el.classList.toggle('ac-selected', i === idx));
  items[idx]?.scrollIntoView({ block: 'nearest' });
}

function acComplete(name) {
  if (!acState) return;
  const { textarea, blockIndex, insertStart } = acState;
  const cursor = textarea.selectionStart;

  // Replace from [[ up to the current cursor with [[name]]
  textarea.value =
    textarea.value.slice(0, insertStart) +
    `[[${name}]]` +
    textarea.value.slice(cursor);

  const newCursor = insertStart + name.length + 4; // +4 for [[ and ]]
  textarea.selectionStart = textarea.selectionEnd = newCursor;

  acHide();
  autoResize(textarea);
  blocks[blockIndex] = textarea.value;
  sendEdit();
}

// ─── Communication ────────────────────────────────────────────────────────────

function sendEdit() {
  ignoreNextUpdate = true;
  vscode.postMessage({ type: 'edit', blocks: [...blocks] });
}

function initializeBlocks(content) {
  blocks = parseBlocks(content);
  editingIndex = null;
  renderAll();
}

// Messages from extension
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'notesList') {
    notesList = msg.notes;
    return;
  }
  if (msg.type === 'init') {
    initializeBlocks(msg.content);
  } else if (msg.type === 'update') {
    if (ignoreNextUpdate) {
      ignoreNextUpdate = false;
      return;
    }
    // External change: only re-render if not mid-edit, or if content differs
    const incoming = msg.content;
    const current = serializeBlocks();
    if (incoming !== current) {
      initializeBlocks(incoming);
    }
  }
});

// Add block button
addBtn.addEventListener('click', addBlock);

// Signal ready
vscode.postMessage({ type: 'ready' });
