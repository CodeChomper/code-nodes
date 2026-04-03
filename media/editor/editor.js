// @ts-nocheck
/* global CodeNodesEditorVendor, acquireVsCodeApi */

const vscode = acquireVsCodeApi();
const { marked, hljs } = CodeNodesEditorVendor;

// Configure marked: use highlight.js for fenced code blocks, gfm for wiki-friendly parsing
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      const highlighted = hljs.highlight(code, { language }).value;
      return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
    },
  },
});

// ─── State ────────────────────────────────────────────────────────────────────

let blocks = [];          // string[] — raw markdown per block
let editingIndex = null;  // index of block currently in edit mode
let ignoreNextUpdate = false; // suppress echo from our own edits

const container = document.getElementById('blocks-container');
const addBtn = document.getElementById('add-block-btn');

// ─── Autocomplete State ───────────────────────────────────────────────────────

let notesList = [];  // string[] — display names of all real notes in workspace
let acState = null;  // { div, blockIndex, insertStart } | null

const acDropdown = document.createElement('div');
acDropdown.id = 'ac-dropdown';
acDropdown.setAttribute('role', 'listbox');
document.body.appendChild(acDropdown);

// ─── Spell Check State ────────────────────────────────────────────────────────

let spellCheckTimer = null;
let contextMenuActive = false; // true while a right-click context menu is open
let suggestionTarget = null;  // the .misspelled <span> that was right-clicked
let pendingMenuPos = null;  // { x, y } position for the suggestion menu

// ─── Spell Suggestion Menu ────────────────────────────────────────────────────

const spellMenu = document.createElement('div');
spellMenu.id = 'spell-menu';
document.body.appendChild(spellMenu);

function showSpellMenu(x, y, suggestions) {
  spellMenu.innerHTML = '';

  if (suggestions.length === 0) {
    const item = document.createElement('div');
    item.className = 'spell-menu-item spell-menu-empty';
    item.textContent = 'No suggestions';
    spellMenu.appendChild(item);
  } else {
    for (const s of suggestions) {
      const item = document.createElement('div');
      item.className = 'spell-menu-item';
      item.textContent = s;
      item.addEventListener('mousedown', e => {
        e.preventDefault(); // keep focus on editor
        applySuggestion(s);
      });
      spellMenu.appendChild(item);
    }
  }

  spellMenu.style.display = 'block';
  // Keep menu within the viewport
  const mw = spellMenu.offsetWidth || 160;
  const mh = spellMenu.offsetHeight || suggestions.length * 28 + 8;
  spellMenu.style.left = `${x + mw > window.innerWidth ? x - mw : x}px`;
  spellMenu.style.top = `${y + mh > window.innerHeight ? y - mh : y}px`;
}

function hideSpellMenu() {
  spellMenu.style.display = 'none';
  suggestionTarget = null;
}

function applySuggestion(word) {
  if (!suggestionTarget) return;
  suggestionTarget.replaceWith(document.createTextNode(word));
  suggestionTarget = null;
  hideSpellMenu();
  if (editingIndex !== null) {
    const blockEl = getBlockEl(editingIndex);
    const editor = blockEl?.querySelector('.block-editor');
    if (editor) {
      blocks[editingIndex] = getContent(editor);
      sendEdit();
      scheduleSpellCheck(editor, editingIndex);
    }
  }
}

// Hide spell menu when clicking outside it
document.addEventListener('mousedown', e => {
  if (spellMenu.style.display !== 'none' && !spellMenu.contains(e.target)) {
    hideSpellMenu();
  }
});

/** Schedule a spell check request for the active block, debounced. */
function scheduleSpellCheck(div, blockIndex) {
  clearTimeout(spellCheckTimer);
  spellCheckTimer = setTimeout(() => {

    /** Added false to getContent to avoid striping newlines during spell check.
     *  This would remove a line before your could type in that line during edit.
     */
    vscode.postMessage({ type: 'spellCheck', blockIndex, text: getContent(div, false) });

  }, 400);
}

/**
 * Apply spell check underlines by wrapping misspelled words in <span class="misspelled">.
 * Rebuilds the div content and restores cursor position.
 * Only called when text still matches the checked version (staleness check in caller).
 */
function applySpellCheckMarks(div, text, misspelled) {
  const cursor = getCursor(div);

  while (div.firstChild) div.removeChild(div.firstChild);

  if (!misspelled || misspelled.length === 0) {
    // No misspellings — just plain content
    appendPlainText(div, text);
  } else {
    let lastIndex = 0;
    for (const { start, end } of misspelled) {
      if (start > lastIndex) appendPlainText(div, text.slice(lastIndex, start));
      const span = document.createElement('span');
      span.className = 'misspelled';
      span.textContent = text.slice(start, end);
      div.appendChild(span);
      lastIndex = end;
    }
    if (lastIndex < text.length) appendPlainText(div, text.slice(lastIndex));
  }

  setCursor(div, cursor);
}

/** Append plain text to a parent, converting \n to <br> elements. */
function appendPlainText(parent, text) {
  const parts = text.split('\n');
  parts.forEach((part, i) => {
    if (part) parent.appendChild(document.createTextNode(part));
    if (i < parts.length - 1) parent.appendChild(document.createElement('br'));
  });
}

// ─── Contenteditable Helpers ──────────────────────────────────────────────────

/**
 * Serialize a contenteditable div to plain text.
 * Walks text nodes (counted as-is) and <br> elements (counted as '\n').
 * Spans (misspelled marks) are transparent — their text nodes are walked normally.
 */
function getContentRaw(div) {
  let text = '';
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    } else if (node.nodeName === 'BR') {
      text += '\n';
    } else {
      for (const child of node.childNodes) walk(child);
    }
  }
  for (const child of div.childNodes) walk(child);
  return text;
}

/** Plain-text content of a contenteditable div, stripping the browser's trailing bogus <br>. */
function getContent(div, stripNewLine = true) {
  if (stripNewLine) {
    return getContentRaw(div).replace(/\n$/, '');
  } else {
    return getContentRaw(div);
  }
}

/** Set the plain-text content of a contenteditable div. Newlines become <br> elements. */
function setContent(div, text) {
  while (div.firstChild) div.removeChild(div.firstChild);
  if (!text) return;
  appendPlainText(div, text);
}

/** Return the cursor position as a character offset in getContent() space.
 *  Clones DOM from start to cursor, then measures via getContentRaw — correctly
 *  counts <br> as one character and looks through <span> elements. */
function getCursor(div) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  try {
    preRange.setStart(div, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
  } catch {
    return 0;
  }
  const tmp = document.createElement('div');
  tmp.appendChild(preRange.cloneContents());
  return getContentRaw(tmp).length;
}

/** Place the cursor at a character offset in getContent() space. */
function setCursor(div, offset) {
  const content = getContent(div);
  offset = Math.max(0, Math.min(offset, content.length));
  let remaining = offset;
  let found = false;

  function walk(node) {
    if (found) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (remaining <= node.textContent.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        found = true;
        return;
      }
      remaining -= node.textContent.length;
    } else if (node.nodeName === 'BR') {
      if (remaining === 0) {
        const range = document.createRange();
        const idx = Array.from(node.parentNode.childNodes).indexOf(node);
        range.setStart(node.parentNode, idx);
        range.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        found = true;
        return;
      }
      remaining -= 1;
      if (remaining === 0) {
        const range = document.createRange();
        const idx = Array.from(node.parentNode.childNodes).indexOf(node);
        range.setStart(node.parentNode, idx + 1);
        range.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        found = true;
        return;
      }
    } else {
      for (const child of node.childNodes) walk(child);
    }
  }

  for (const child of div.childNodes) walk(child);

  if (!found) {
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }
}

/** Insert text at cursor using execCommand so input events fire and undo works. */
function insertAtCursor(text) {
  if (text === '\n') {
    document.execCommand('insertLineBreak');
  } else {
    document.execCommand('insertText', false, text);
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

// Matches YAML frontmatter at the very start of the document.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

function isFrontmatterBlock(md) {
  return FRONTMATTER_RE.test(md.trimEnd() + '\n');
}

/**
 * Split document text into blocks on blank lines.
 * Handles frontmatter (never split) and fenced code blocks (blank lines preserved).
 */
function parseBlocks(content) {
  if (!content.trim()) return [''];

  let rest = content;
  const leading = [];

  const fmMatch = content.match(FRONTMATTER_RE);
  if (fmMatch) {
    leading.push(fmMatch[0].trimEnd());
    rest = content.slice(fmMatch[0].length);
  }

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

function renderMarkdown(md) {
  if (isFrontmatterBlock(md)) return renderFrontmatter(md);
  const html = marked.parse(md || '');
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

  // contenteditable div — required for JS spell check underlines
  const editor = document.createElement('div');
  editor.className = 'block-editor';
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('spellcheck', 'false'); // using JS spell check instead
  setContent(editor, blocks[index]);

  blockEl.appendChild(handle);
  blockEl.appendChild(rendered);
  blockEl.appendChild(editor);

  rendered.addEventListener('click', () => enterEditMode(index));

  editor.addEventListener('input', () => {
    // Autocomplete
    const query = getWikiQuery(editor);
    if (query !== null) {
      acShow(editor, index, query);
    } else {
      acHide();
    }
    // Schedule spell check (skip frontmatter)
    if (!isFrontmatter) scheduleSpellCheck(editor, index);
  });

  editor.addEventListener('keydown', e => handleEditorKeydown(e, index));

  editor.addEventListener('contextmenu', e => {
    contextMenuActive = true;
    const target = e.target.closest('.misspelled');
    if (target) {
      e.preventDefault(); // suppress browser menu; show our suggestions instead
      suggestionTarget = target;
      pendingMenuPos = { x: e.clientX, y: e.clientY };
      vscode.postMessage({ type: 'getSuggestions', word: target.textContent });
    }
  });

  editor.addEventListener('focus', () => {
    contextMenuActive = false;
  });

  editor.addEventListener('blur', () => {
    // Suppress exit while a context menu is open — the user is picking a suggestion
    if (contextMenuActive) return;
    setTimeout(() => {
      if (editingIndex === index) {
        acHide();
        exitEditMode(index);
      }
    }, 100);
  });

  // Paste: strip HTML, insert as plain text only
  editor.addEventListener('paste', e => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

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
    if (fromIndex !== index) reorderBlock(fromIndex, index);
  });

  return blockEl;
}

function renderAll() {
  container.innerHTML = '';
  blocks.forEach((_, i) => container.appendChild(createBlockElement(i)));
  if (editingIndex !== null && editingIndex < blocks.length) {
    enterEditMode(editingIndex);
  }
}

// ─── Edit Mode ────────────────────────────────────────────────────────────────

function enterEditMode(index, cursorPos = 'end') {
  if (editingIndex !== null && editingIndex !== index) {
    exitEditModeNoSend(editingIndex);
  }

  editingIndex = index;
  const blockEl = getBlockEl(index);
  if (!blockEl) return;

  const rendered = blockEl.querySelector('.block-rendered');
  const editor = blockEl.querySelector('.block-editor');
  rendered.style.display = 'none';
  editor.style.display = 'block';
  setContent(editor, blocks[index]);
  editor.focus();

  const len = blocks[index].length;
  const pos =
    cursorPos === 'end' ? len :
      cursorPos === 'start' ? 0 :
        Math.min(cursorPos, len);
  setCursor(editor, pos);
  blockEl.classList.add('active');

  // Run spell check on existing content when entering edit mode
  const isFrontmatter = index === 0 && isFrontmatterBlock(blocks[0]);
  if (!isFrontmatter) scheduleSpellCheck(editor, index);
}

function saveBlock(index) {
  const blockEl = getBlockEl(index);
  if (blockEl) {
    const editor = blockEl.querySelector('.block-editor');
    if (editor) blocks[index] = getContent(editor);
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
  clearTimeout(spellCheckTimer);
  if (editingIndex === index) editingIndex = null;
  const blockEl = getBlockEl(index);
  if (!blockEl) return;

  const editor = blockEl.querySelector('.block-editor');
  const newContent = getContent(editor);
  const prevContent = blocks[index];
  blocks[index] = newContent;

  const isFM = index === 0 && isFrontmatterBlock(blocks[0] ?? '');
  if (!newContent.trim() && blocks.length > 1 && !isFM) {
    blocks.splice(index, 1);
    sendEdit();
    renderAll();
    return;
  }

  const rendered = blockEl.querySelector('.block-rendered');
  rendered.innerHTML = renderMarkdown(newContent);
  editor.style.display = 'none';
  rendered.style.display = 'block';
  blockEl.classList.remove('active');

  if (newContent !== prevContent) sendEdit();
}

function exitEditModeNoSend(index) {
  clearTimeout(spellCheckTimer);
  acHide();
  if (editingIndex === index) editingIndex = null;
  const blockEl = getBlockEl(index);
  if (!blockEl) return;

  const editor = blockEl.querySelector('.block-editor');
  const rendered = blockEl.querySelector('.block-rendered');
  blocks[index] = getContent(editor);
  rendered.innerHTML = renderMarkdown(blocks[index]);
  editor.style.display = 'none';
  rendered.style.display = 'block';
  blockEl.classList.remove('active');
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

function isOnFirstLine(div) {
  const text = getContent(div);
  const cursor = getCursor(div);
  const first = text.indexOf('\n');
  return first === -1 || cursor <= first;
}

function isOnLastLine(div) {
  const text = getContent(div);
  const cursor = getCursor(div);
  const last = text.lastIndexOf('\n');
  return last === -1 || cursor > last;
}

function cursorPosForEntry(targetValue, fromCol) {
  const firstLineEnd = targetValue.indexOf('\n');
  const lineLen = firstLineEnd === -1 ? targetValue.length : firstLineEnd;
  return Math.min(fromCol, lineLen);
}

function cursorPosForEntryFromBelow(targetValue, fromCol) {
  const lastNewline = targetValue.lastIndexOf('\n');
  const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
  return lineStart + Math.min(fromCol, targetValue.length - lineStart);
}

function cursorColumn(div) {
  const text = getContent(div);
  const cursor = getCursor(div);
  const last = text.lastIndexOf('\n', cursor - 1);
  return cursor - (last + 1);
}

function handleEditorKeydown(e, index) {
  // ── Autocomplete intercept ────────────────────────────────────────────────
  if (acState) {
    if (e.key === 'ArrowDown') { e.preventDefault(); acMove(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); acMove(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const sel = acDropdown.querySelector('.ac-selected');
      if (sel) { e.preventDefault(); acComplete(sel.dataset.name); return; }
    }
    if (e.key === 'Escape') { e.preventDefault(); acHide(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ']') acHide();
  }

  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    insertAtCursor('  ');
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    exitEditMode(index);
    return;
  }

  if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (index > 0 && isOnFirstLine(e.target)) {
      e.preventDefault();
      const col = cursorColumn(e.target);
      saveBlock(index);
      const target = index - 1;
      sendEdit();
      renderAll();
      setTimeout(() => enterEditMode(target, cursorPosForEntryFromBelow(blocks[target], col)), 0);
      return;
    }
  }

  if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (isOnLastLine(e.target)) {
      e.preventDefault();
      const col = cursorColumn(e.target);
      if (index < blocks.length - 1) {
        const removed = saveBlock(index);
        const target = removed ? index : index + 1;
        sendEdit();
        renderAll();
        setTimeout(() => enterEditMode(target, cursorPosForEntry(blocks[target], col)), 0);
      } else {
        saveBlock(index);
        blocks.push('');
        sendEdit();
        renderAll();
        setTimeout(() => enterEditMode(blocks.length - 1, 'start'), 0);
      }
      return;
    }
  }

  if (e.altKey && e.key === 'ArrowUp') {
    e.preventDefault();
    if (index > 0) { exitEditModeNoSend(index); reorderBlock(index, index - 1); setTimeout(() => enterEditMode(index - 1), 0); }
    return;
  }

  if (e.altKey && e.key === 'ArrowDown') {
    e.preventDefault();
    if (index < blocks.length - 1) { exitEditModeNoSend(index); reorderBlock(index, index + 1); setTimeout(() => enterEditMode(index + 1), 0); }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'K') {
    e.preventDefault();
    deleteBlock(index);
    return;
  }

  // Enter — split block if text on both sides, otherwise insert newline
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const div = e.target;
    const curPos = getCursor(div);
    const value = getContent(div);
    const before = value.slice(0, curPos);
    const after = value.slice(curPos);

    if (before.trim() && after.trim()) {
      exitEditModeNoSend(index);
      blocks[index] = before.trimEnd();
      blocks.splice(index + 1, 0, after.trimStart());
      sendEdit();
      renderAll();
      setTimeout(() => enterEditMode(index + 1), 0);
    } else {
      insertAtCursor('\n');
    }
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
  if (blocks.length <= 1) { blocks[0] = ''; }
  else { blocks.splice(index, 1); }
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

// ─── Autocomplete ─────────────────────────────────────────────────────────────

function getWikiQuery(div) {
  const cursor = getCursor(div);
  const before = getContent(div).slice(0, cursor);
  const match = before.match(/\[\[([^\[\]\n]*)$/);
  return match ? match[1] : null;
}

function acShow(div, blockIndex, query) {
  const filtered = notesList
    .filter(n => n.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 10);

  if (!filtered.length) { acHide(); return; }

  const cursor = getCursor(div);
  const before = getContent(div).slice(0, cursor);
  const insertStart = before.lastIndexOf('[[');
  acState = { div, blockIndex, insertStart };

  acDropdown.innerHTML = filtered.map((name, i) =>
    `<div class="ac-item${i === 0 ? ' ac-selected' : ''}" role="option" data-name="${escapeHtml(name)}">${escapeHtml(name)}</div>`
  ).join('');

  const rect = div.getBoundingClientRect();
  acDropdown.style.top = `${rect.bottom + 4}px`;
  acDropdown.style.left = `${rect.left}px`;
  acDropdown.style.minWidth = `${Math.max(rect.width, 180)}px`;
  acDropdown.style.display = 'block';

  acDropdown.querySelectorAll('.ac-item').forEach(item => {
    item.addEventListener('mousedown', e => { e.preventDefault(); acComplete(item.dataset.name); });
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
  const { div, blockIndex, insertStart } = acState;
  const cursor = getCursor(div);
  const text = getContent(div);
  const newText = text.slice(0, insertStart) + `[[${name}]]` + text.slice(cursor);
  setContent(div, newText);
  setCursor(div, insertStart + name.length + 4);
  acHide();
  blocks[blockIndex] = getContent(div);
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

window.addEventListener('message', event => {
  const msg = event.data;

  if (msg.type === 'notesList') {
    notesList = msg.notes;
    return;
  }

  if (msg.type === 'suggestions') {
    if (pendingMenuPos) {
      showSpellMenu(pendingMenuPos.x, pendingMenuPos.y, msg.suggestions);
      pendingMenuPos = null;
    }
    return;
  }

  if (msg.type === 'spellCheckResult') {
    const { blockIndex, text, misspelled } = msg;
    // Discard if stale (user has moved to a different block or content changed)
    if (blockIndex !== editingIndex) return;
    const blockEl = getBlockEl(blockIndex);
    if (!blockEl) return;
    const editor = blockEl.querySelector('.block-editor');
    if (!editor || editor.style.display === 'none') return;
    if (getContent(editor) !== text) return; // content changed since request
    applySpellCheckMarks(editor, text, misspelled);
    return;
  }

  if (msg.type === 'init') {
    initializeBlocks(msg.content);
  } else if (msg.type === 'update') {
    if (ignoreNextUpdate) { ignoreNextUpdate = false; return; }
    const incoming = msg.content;
    const current = serializeBlocks();
    if (incoming !== current) initializeBlocks(incoming);
  }
});

addBtn.addEventListener('click', addBlock);

// When the context menu closes (user picked a suggestion or clicked away),
// clear the flag and re-focus the editor so typing can continue.
document.addEventListener('click', () => {
  if (!contextMenuActive) return;
  contextMenuActive = false;
  if (editingIndex !== null) {
    const blockEl = getBlockEl(editingIndex);
    const ed = blockEl?.querySelector('.block-editor');
    if (ed && ed.style.display !== 'none') {
      setTimeout(() => ed.focus(), 50);
    }
  }
});

vscode.postMessage({ type: 'ready' });
