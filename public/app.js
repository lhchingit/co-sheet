/**
 * @file app.js
 * @description Client-side application engine for co-sheet collaborative spreadsheet.
 * Handles WebSocket connection, dynamic grid generation, formula evaluation,
 * collaborative cursor rendering, cell styling, context menus, and micro-interactions.
 */


// ---------------------------------------------------------------------------
// Extracted-module bindings. Shared utilities, the formula engine and the i18n
// runtime now live in separate classic scripts (sheet-utils.js, formula-engine.js,
// i18n.js) loaded before this file; each publishes onto window.CoSheet. Re-bind
// them to local names so the rest of app.js continues to use bare identifiers.
// ---------------------------------------------------------------------------
const { escapeHtml, getColLetter, parseCellCoord, parseCoordinates } = window.CoSheet.utils;
const { evaluateFormula, formulaIsSupported } = window.CoSheet.formula;
const { t, getLang, translatePage, loadLocales } = window.CoSheet.i18n;
// Sandboxed test environment decoration and safety fallbacks
if (typeof document !== 'undefined' && document) {
  // Ensure document.documentElement exists with standard methods
  if (!document.documentElement) {
    document.documentElement = { setAttribute: () => {} };
  }
  // Ensure documentElement has a classList (real browsers always do; some
  // sandboxed document mocks omit it, so provide a no-op stub).
  if (!document.documentElement.classList) {
    document.documentElement.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  }
  // Ensure document.body exists with standard appendChild method
  if (!document.body) {
    document.body = { appendChild: () => {} };
  } else if (typeof document.body.appendChild !== 'function') {
    document.body.appendChild = () => {};
  }
  // Ensure removeEventListener exists
  if (typeof document.removeEventListener !== 'function') {
    document.removeEventListener = () => {};
  }
  // Ensure addEventListener exists
  if (typeof document.addEventListener !== 'function') {
    document.addEventListener = () => {};
  }
  // Helper to safely decorate an element object with standard mock DOM APIs
  const decorateElement = (el) => {
    if (!el || typeof el !== 'object') return el;
    if (!el.style) el.style = {};
    if (!el.classList) {
      el.classList = {
        add: () => {},
        remove: () => {},
        toggle: () => {},
        contains: () => false
      };
    } else {
      if (typeof el.classList.add !== 'function') {
        el.classList.add = function(className) {
          if (Array.isArray(el.classList.classes)) {
            if (!el.classList.classes.includes(className)) el.classList.classes.push(className);
          } else if (el.classList.classes instanceof Set) {
            el.classList.classes.add(className);
          }
        };
      }
      if (typeof el.classList.remove !== 'function') {
        el.classList.remove = function(className) {
          if (Array.isArray(el.classList.classes)) {
            el.classList.classes = el.classList.classes.filter(c => c !== className);
          } else if (el.classList.classes instanceof Set) {
            el.classList.classes.delete(className);
          }
        };
      }
      if (typeof el.classList.toggle !== 'function') {
        el.classList.toggle = function(className) {
          if (el.classList.contains(className)) {
            el.classList.remove(className);
          } else {
            el.classList.add(className);
          }
        };
      }
      if (typeof el.classList.contains !== 'function') {
        el.classList.contains = function(className) {
          if (Array.isArray(el.classList.classes)) {
            return el.classList.classes.includes(className);
          } else if (el.classList.classes instanceof Set) {
            return el.classList.classes.has(className);
          }
          return false;
        };
      }
    }
    if (typeof el.addEventListener !== 'function') el.addEventListener = () => {};
    if (typeof el.removeEventListener !== 'function') el.removeEventListener = () => {};
    if (typeof el.appendChild !== 'function') el.appendChild = () => {};
    if (typeof el.remove !== 'function') el.remove = () => {};
    if (typeof el.getBoundingClientRect !== 'function') {
      el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0 });
    }
    if (typeof el.querySelectorAll !== 'function') el.querySelectorAll = () => [];
    const origQuerySelector = el.querySelector;
    el.querySelector = function(selector) {
      let matched = null;
      if (typeof origQuerySelector === 'function') {
        try { matched = origQuerySelector.apply(this, arguments); } catch(e) {}
      }
      return matched ? decorateElement(matched) : decorateElement({ id: selector.replace('#', '').replace('.', '') });
    };
    if (typeof el.setAttribute !== 'function') el.setAttribute = () => {};
    if (typeof el.removeAttribute !== 'function') el.removeAttribute = () => {};
    return el;
  };

  // Decorate document.createElement if it's missing or incomplete
  const origCreateElement = document.createElement;
  document.createElement = function(_tagName) {
    let el = {};
    if (typeof origCreateElement === 'function') {
      try { el = origCreateElement.apply(this, arguments) || {}; } catch(e) {}
    }
    return decorateElement(el);
  };

  // Decorate document.getElementById to return safely decorated elements
  const origGetElementById = document.getElementById;
  document.getElementById = function(_id) {
    let el = null;
    if (typeof origGetElementById === 'function') {
      try { el = origGetElementById.apply(this, arguments); } catch(e) {}
    }
    return el ? decorateElement(el) : null;
  };
}

// Fallback for sandboxed test environments lacking setTimeout
if (typeof setTimeout === 'undefined') {
  globalThis.setTimeout = (fn) => { fn(); };
}

// Fallback for sandboxed test environments lacking queueMicrotask
if (typeof queueMicrotask === 'undefined') {
  globalThis.queueMicrotask = (fn) => { fn(); };
}

// Guarded dynamic-property helpers. Several of the state maps below are keyed by a
// sheet name, cell id, or user id that originates from a peer's WebSocket message.
// Even though these containers are prototype-less (Object.create(null)), route every
// keyed write through these helpers so a crafted key can never be used to pollute
// Object.prototype or shadow object internals — the three reserved names are rejected
// and can never be a legitimate sheet name (server-validated), cell id, or user id.
// The comparisons are inlined at each write (not factored into a predicate) so the
// guard is local to the sink.
function setKey(obj, key, value) {
  if (obj && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') obj[key] = value;
  return obj ? obj[key] : undefined;
}
function deleteKey(obj, key) {
  if (obj && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') delete obj[key];
}
// Ensure obj[key] exists (creating it via factory) and return it. A reserved key
// yields a throwaway object so downstream writes stay harmless.
function ensureKey(obj, key, factory) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return factory();
  if (!obj[key]) obj[key] = factory();
  return obj[key];
}

// Global state variables
let localSheets = Object.create(null);
let activeSheetName = 'Sheet1';
let sheetOrder = ['Sheet1'];
let sheetColors = Object.create(null);
let hiddenSheets = [];
// Name of the sheet currently being renamed inline (null when not editing).
let renamingSheet = null;

// Global spreadsheet grid zoom level percentage
let currentZoom = 100;

// Default sheet dimensions: 26 columns (A-Z) and 1000 rows.
const TOTAL_ROWS = 1000;
// Columns start at A-Z and grow rightward, labelled AA, AB, … up to the ZZ cap.
// The rendered count (see getColCount) is the larger of the rightmost column
// holding data and an explicit per-sheet count bumped by column inserts, so a
// column insert always adds a column even on an empty sheet while data is never
// hidden. A column delete (or clearing far columns) shrinks it back.
const DEFAULT_COLS = 26;        // A-Z
const MAX_COLS = 26 + 26 * 26;  // up to ZZ (702 columns)

// Initialize with a default sheet
setKey(localSheets, activeSheetName, Object.create(null));

// Define a localCells proxy for backward compatibility with existing codebase functions
let localCells = new Proxy({}, {
  get(target, prop) {
    return ensureKey(localSheets, activeSheetName, () => Object.create(null))[prop];
  },
  set(target, prop, value) {
    setKey(ensureKey(localSheets, activeSheetName, () => Object.create(null)), prop, value);
    return true;
  },
  deleteProperty(target, prop) {
    deleteKey(localSheets[activeSheetName], prop);
    return true;
  },
  has(target, prop) {
    return !!(localSheets[activeSheetName] && prop in localSheets[activeSheetName]);
  },
  ownKeys(_target) {
    return localSheets[activeSheetName] ? Reflect.ownKeys(localSheets[activeSheetName]) : [];
  },
  getOwnPropertyDescriptor(target, prop) {
    if (localSheets[activeSheetName] && prop in localSheets[activeSheetName]) {
      return { enumerable: true, configurable: true };
    }
    return undefined;
  }
});

let remoteCursors = Object.create(null); // Active remote cursors
// This client's own presence identity, sent by the server in the `init` payload.
// Used to filter our own cursor out of the roster: a refresh or WebSocket
// reconnect gives us a fresh connection id while the previous connection lingers
// briefly in the server's roster (with its last active cell), so without this we
// would render our own username as a "peer" tag in that cell. Matching on the
// (stable) username — not just the per-connection id — also catches that ghost.
let myUserId = null;
let myUsername = null;
/** Whether a presence entry belongs to this client (never render our own tag). */
const isSelfPresence = (u) =>
  !!u && ((myUserId && u.userId === myUserId) || (myUsername != null && u.username === myUsername));
let activeCellId = null; // Currently selected cell ID
let isSelecting = false; // Whether selection drag is active
let isColumnSelection = false; // Whether the current selection is a full-column header click
let isRowSelection = false; // Whether the current selection is a full-row header click
let selectionStartCellId = null; // Start cell of range selection
let selectionEndCellId = null; // End cell of range selection
// Extra ranges added by Ctrl/Cmd+clicking row/column headers, each {startId,
// endId}. The start/end pair above stays the ACTIVE range (anchor, overlay,
// name box); these only add highlight and join getSelectedCellIds() so
// per-cell operations (formatting, clearing) cover them. Rectangle-shaped
// operations (copy/cut/merge/borders) pass activeRangeOnly and ignore them.
let extraSelectionRanges = [];
// Fill-handle drag: dragging the dot at the selection's bottom-right corner
// extends the selection from its original bounds along one axis only (the
// dominant drag direction), like Google Sheets' fill handle.
let isFillDragging = false;
let fillDragBaseRange = null; // Selection bounds ({minRow,maxRow,minCol,maxCol}) when the drag began
// Format painter ("Apply format" roller) armed state. `paintFormatStyle` holds
// the source cell's style snapshot (null while idle); `paintFormatSource`
// remembers where the snapshot was copied from so the dashed source outline
// can be re-applied after any full grid rebuild (and only on that sheet).
let paintFormatStyle = null;
let paintFormatSource = null; // { cellId, sheetName } of the armed painter's source
// Each sheet's last selection, so switching away and back restores where you were.
// In-memory only (keyed by sheet name); intentionally not persisted, so a page
// reload starts fresh (the initial load selects A1).
let sheetSelections = Object.create(null);
// Formula "point mode": while a formula is being edited (inline cell or formula
// bar) and the caret sits where a cell reference is expected, clicking/dragging
// over the grid paints an orange box and writes the picked A1[:B4] range into the
// formula instead of moving the selection. See the formula-pick module below.
let activeFormulaEditor = null; // adapter for the formula editor with focus (or null)
let fpActive = false;           // a point-mode drag is currently in progress
let fpStartCell = null;         // anchor cell of the current pick
let fpEndCell = null;           // far cell of the current pick
let fpInsertStart = -1;         // caret offset in the formula where the ref begins
let fpInsertLen = 0;            // length of the ref text currently written there
let fpJustPicked = false;       // true after a pick until the user types (drag replaces)
// Sheet that owns the cell being edited. Picks made on a *different* sheet are
// written sheet-qualified ('Other Sheet'!A1); unqualified picks/refs belong here.
// Set when an editor gains focus, preserved across mid-formula sheet switches.
let fpOriginSheet = null;
let fpOriginCell = null;        // cell being edited (commit target across sheet switches)
let fpHandoff = false;          // true while moving an inline edit to the formula bar
let socket = null; // WebSocket connection
let clipboardData = null; // Stores copied cell data offset details
let frozenRows = 0; // Number of top rows frozen via View > Freeze (0 = none)
let frozenCols = 0; // Number of left columns frozen via View > Freeze (0 = none)

// Per-sheet column widths / row heights (px), keyed by sheet name then column
// letter / row number. Populated from the server `init` payload and kept in sync
// via `resize-update` broadcasts; an absent entry falls back to the defaults below.
let colWidths = Object.create(null); // { [sheetName]: { [colLetter]: px } }
let rowHeights = Object.create(null); // { [sheetName]: { [rowNumber]: px } }

// Per-sheet explicit column count, grown by column inserts and shrunk by column
// deletes so the grid gains/loses a column even when no data sits at the edge.
// Loaded from the init payload, kept in sync via `col-count-update` broadcasts,
// and persisted server-side (like colWidths/rowHeights); an absent entry means
// the default. See getColCount, which also raises this by the data-derived floor.
let colCounts = Object.create(null); // { [sheetName]: number }

// Per-sheet hidden columns, keyed by sheet name → array of column letters. A
// hidden column keeps its index/data but renders as a zero-width track (see
// getColWidth); the two visible neighbours carry unhide arrows. Loaded from the
// init payload and kept in sync via `hidden-cols-update` broadcasts; an absent
// entry means nothing is hidden.
let hiddenCols = Object.create(null); // { [sheetName]: string[] }

// Default track sizes — must match the base grid-template-columns / row min-height
// in private/index.html (46px gutter + 100px columns, 21px rows).
const DEFAULT_COL_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 21;
// Smallest size a column/row may be dragged to (mirrors dimensionService.MIN_SIZE).
const MIN_DIMENSION = 20;
// Width of the row-index gutter (the first grid column: `46px repeat(26, 100px)`).
const GUTTER_WIDTH = 46;

/** Whether a column letter is hidden on the active (or given) sheet. */
const isColHidden = (colLetter, sheetName = activeSheetName) => {
  const arr = hiddenCols[sheetName];
  return Array.isArray(arr) && arr.includes(colLetter);
};

/** Resolved width (px) of a column letter on the active sheet. */
const getColWidth = (colLetter, sheetName = activeSheetName) => {
  // Hidden columns collapse to a zero-width track so their column — and every
  // pixel measurement derived from it (grid template, selection overlay, freeze
  // offsets) — disappears; the stored width stays in colWidths and returns when
  // the column is unhidden. History previews render the snapshot as-is and
  // ignore the live hidden set.
  if (!isHistoryMode && isColHidden(colLetter, sheetName)) return 0;
  const m = colWidths[sheetName];
  const w = m && m[colLetter];
  return (typeof w === 'number' && isFinite(w)) ? w : DEFAULT_COL_WIDTH;
};
// Font-driven row heights for the active sheet: row number -> px, for rows a
// large-font cell grows past the default. Rebuilt from the model each render by
// rebuildAutoFontRowHeights (deterministic via getCellMinHeight, no DOM), so
// getRowHeight is authoritative for these rows and a windowed render can size and
// map their off-screen tracks. Wrapped-text growth needs real text measurement
// and is not modelled here (see sheetHasWrappedRows).
let autoFontRowHeights = Object.create(null);

/** Resolved model height (px) of a row (1-based) on the active (or given) sheet:
 *  an explicit (resized) height wins, else a font-driven auto height on the
 *  active sheet, else the default. */
const getRowHeight = (row, sheetName = activeSheetName) => {
  const m = rowHeights[sheetName];
  const h = m && m[row];
  if (typeof h === 'number' && isFinite(h)) return h;
  if (sheetName === activeSheetName) {
    const fh = autoFontRowHeights[row];
    if (typeof fh === 'number' && isFinite(fh)) return fh;
  }
  return DEFAULT_ROW_HEIGHT;
};

/**
 * Number of columns the grid renders for a sheet. The floor is the rightmost
 * populated column (so columns holding data are always shown, growing past A-Z
 * as data extends), raised by any explicit count from column inserts and capped
 * at MAX_COLS. In history mode the count comes from the previewed snapshot.
 * @param {string} [sheetName]
 * @returns {number} Column count in [DEFAULT_COLS, MAX_COLS].
 */
const getColCount = (sheetName = activeSheetName) => {
  const cells = (isHistoryMode && selectedVersionState)
    ? (selectedVersionState.sheets && selectedVersionState.sheets[sheetName])
    : localSheets[sheetName];
  let maxIndex = DEFAULT_COLS - 1;
  if (cells) {
    for (const id in cells) {
      const coord = parseCellCoord(id);
      if (coord && coord.colIndex > maxIndex) maxIndex = coord.colIndex;
    }
  }
  // History previews show the snapshot as-is; the live explicit count doesn't apply.
  const explicit = isHistoryMode ? 0 : (colCounts[sheetName] || 0);
  return Math.min(Math.max(maxIndex + 1, explicit), MAX_COLS);
};

/**
 * Set the active sheet's explicit column count, clamped to [DEFAULT_COLS,
 * MAX_COLS]. The default is stored as "no entry" (kept lean, matching the
 * server). Broadcasts so the server persists it and peers grow/shrink in step;
 * the server echoes a col-count-update which is harmlessly idempotent here.
 * @param {number} count
 */
const setActiveColCount = (count) => {
  const n = Math.min(MAX_COLS, Math.max(DEFAULT_COLS, count));
  if (n > DEFAULT_COLS) setKey(colCounts, activeSheetName, n); else deleteKey(colCounts, activeSheetName);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'set-col-count', payload: { sheetName: activeSheetName, count: n } }));
  }
};

/**
 * Adjust the active sheet's explicit column count by `delta` (used by undo/redo
 * to reverse/replay a column insert or delete) and re-render so the header band
 * and grid tracks reflect the new width. No-op when delta is 0.
 * @param {number} delta
 */
const applyColCountDelta = (delta) => {
  if (!delta) return;
  const base = colCounts[activeSheetName] != null ? colCounts[activeSheetName] : getColCount();
  setActiveColCount(base + delta);
  renderSpreadsheetGrid();
};

/** 0-based column index for a column letter (A→0, Z→25, AA→26 …). */
const colLetterIndex = (letter) => {
  const c = parseCellCoord(`${letter}1`);
  return c ? c.colIndex : 0;
};

/** Hidden column letters for a sheet (a fresh array; empty when none). */
const getHiddenCols = (sheetName = activeSheetName) => {
  const arr = hiddenCols[sheetName];
  return Array.isArray(arr) ? arr.slice() : [];
};

/**
 * Replace the active sheet's hidden-column set: normalise (de-dupe, order by
 * index), update local state, broadcast so the server persists it and peers
 * follow, then re-render. Mirrors setActiveColCount — the client always sends
 * the whole desired set, so the op is idempotent.
 * @param {string[]} cols
 */
const setActiveHiddenCols = (cols) => {
  const seen = new Set();
  const clean = [];
  for (const letter of cols) {
    if (typeof letter === 'string' && !seen.has(letter)) { seen.add(letter); clean.push(letter); }
  }
  clean.sort((a, b) => colLetterIndex(a) - colLetterIndex(b));
  if (clean.length) setKey(hiddenCols, activeSheetName, clean);
  else deleteKey(hiddenCols, activeSheetName);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'set-hidden-cols', payload: { sheetName: activeSheetName, cols: clean } }));
  }
  renderSpreadsheetGrid();
};

/** Hide a single column on the active sheet (no-op if already hidden). */
const hideColumn = (colLetter) => {
  if (!canEditWorkbook || isColHidden(colLetter)) return;
  // Drop the (now zero-width) column selection so no invisible overlay lingers.
  clearRangeSelection();
  setActiveHiddenCols([...getHiddenCols(), colLetter]);
};

/** Reveal a run of column letters on the active sheet. */
const unhideColumns = (letters) => {
  if (!canEditWorkbook || !letters.length) return;
  const drop = new Set(letters);
  setActiveHiddenCols(getHiddenCols().filter((c) => !drop.has(c)));
};

/**
 * Build the small arrow a visible column header shows on a hidden-run boundary.
 * `side` is 'left' (a ◀ pinned to this header's right edge, when the hidden run
 * sits to its right) or 'right' (a ▶ pinned to its left edge, when the run sits
 * to its left).
 *
 * The arrow sits directly over the boundary's resize handle, so it doubles as a
 * resize grip: a plain click reveals the whole `runLetters` run, while a drag
 * hands off to a normal column resize of the boundary's left visible column
 * (`resizeLetter` / `resizeHeaderEl`, omitted when the run is at the grid's left
 * edge and there is no column to widen).
 * @param {'left'|'right'} side
 * @param {string[]} runLetters
 * @param {string|null} resizeLetter
 * @param {HTMLElement|null} resizeHeaderEl
 * @returns {HTMLElement}
 */
const createUnhideArrow = (side, runLetters, resizeLetter, resizeHeaderEl) => {
  const arrow = document.createElement('span');
  arrow.className = `col-unhide-arrow ${side} material-symbols-outlined`;
  if (resizeLetter && resizeHeaderEl) arrow.classList.add('resizable');
  arrow.textContent = side === 'left' ? 'arrow_left' : 'arrow_right';
  arrow.title = t('col.unhide');
  // Distinguish a click (reveal the run) from a drag (resize the boundary's left
  // visible column). We start the resize only once the pointer has moved past a
  // small threshold, handing the original mousedown X to startDimensionResize so
  // its delta stays correct; a mouseup before then is treated as a click.
  arrow.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (isHistoryMode || !canEditWorkbook) return;
    const startX = e.clientX;
    let dragging = false;
    const teardown = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    const onMove = (me) => {
      if (dragging) return;
      if (resizeLetter && resizeHeaderEl && Math.abs(me.clientX - startX) >= 3) {
        dragging = true;
        teardown();
        startDimensionResize('col', resizeLetter, resizeHeaderEl, startX);
      }
    };
    const onUp = () => {
      teardown();
      if (!dragging) unhideColumns(runLetters);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  return arrow;
};

// Per-sheet value filters now live in sort-filter.js (window.CoSheet.sortFilter).

// Set by initGridScrollbars() to its layout() function; called after any change
// that affects the grid's scrollable extent (render, zoom, freeze) to resync the
// synthetic scrollbars. Null until the controller initializes.
let gridScrollbarLayout = null;

// History stacks for local cell edits (snapshot based)
const undoStack = [];
const redoStack = [];

// Version History state variables
// History preview view-state. The version-history.js controller owns the
// versions list and drives these via syncState(); the grid renderer reads them
// here for diff highlighting. See window.CoSheet.history.init() near the bottom.
let isHistoryMode = false;
let selectedVersionState = null;
let previousVersionState = null;



// Initialize WebSocket connection. The workbook is selected by the ?file=<id>
// query parameter on the editor page; absent => the legacy 'default' workbook.
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const currentFileId = (() => {
  try {
    const f = new URLSearchParams(window.location.search).get('file');
    return (f && /^[a-f0-9]{24}$/.test(f)) ? f : null;
  } catch (e) {
    return null;
  }
})();
const wsBase = `${protocol}//${window.location.host}`;
// The socket is created (and re-created on reconnect) by connectSocket() below.
const wsUrl = currentFileId ? `${wsBase}/?file=${currentFileId}` : wsBase;

// Whether this client may modify the workbook. Authoritatively set from the server's
// `init` payload (canEdit). A viewer-shared file arrives with canEdit === false and
// the editor switches to read-only mode. Defaults to true until init arrives.
let canEditWorkbook = true;

// Message types that mutate workbook state. Mirrors the server's enforcement list so
// a read-only client can't push changes even if a UI affordance slips through.
const WB_STATE_CHANGING_TYPES = [
  'cell-edit', 'add-sheet', 'delete-sheet', 'copy-sheet', 'rename-sheet',
  'color-sheet', 'hide-sheet', 'unhide-sheet', 'reorder-sheets', 'resize', 'set-col-count'
];

// Footer save-status indicator. The server never acks a save, so this reflects
// the only state we can truthfully observe: an edit was broadcast over an open
// socket ('saving' → 'saved' after a quiet window), or the socket dropped and
// edits can no longer reach the server ('reconnecting'). Swapping data-i18n in
// addition to textContent keeps the label correct across a later language switch.
const SAVE_STATUS = {
  saved:        { key: 'status.allSaved',     dot: 'bg-green-500' },
  saving:       { key: 'status.saving',       dot: 'bg-amber-500' },
  reconnecting: { key: 'status.reconnecting', dot: 'bg-red-500' }
};
let saveStatusTimer = null;
function setSaveStatus(state) {
  const cfg = SAVE_STATUS[state];
  if (!cfg) return;
  const textEl = document.getElementById('save-status-text');
  if (textEl) {
    textEl.setAttribute('data-i18n', cfg.key);
    textEl.textContent = t(cfg.key);
  }
  const dotEl = document.getElementById('save-status-dot');
  if (dotEl) {
    Object.values(SAVE_STATUS).forEach((s) => dotEl.classList.remove(s.dot));
    dotEl.classList.add(cfg.dot);
  }
}

// Wall-clock time of the last save that settled this session (null until the
// first edit is saved). Shown next to the status text as "Last saved HH:MM".
let lastSavedAt = null;

// Render the "Last saved HH:MM" stamp (24-hour, locale-formatted). Re-run on a
// language switch so the label re-localizes; hidden until there's a save to show.
function renderSavedTime() {
  const el = document.getElementById('save-status-time');
  if (!el) return;
  if (!lastSavedAt) { el.classList.add('hidden'); el.textContent = ''; return; }
  let time;
  try {
    time = lastSavedAt.toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'zh-TW',
      { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) {
    time = lastSavedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  el.textContent = t('status.lastSaved', { time });
  el.classList.remove('hidden');
}

// Show 'saving' on each broadcast edit, then settle back to 'saved' once edits
// stop for a beat. A dropped socket clears this so 'reconnecting' isn't overwritten.
function markSaving() {
  clearTimeout(saveStatusTimer);
  setSaveStatus('saving');
  saveStatusTimer = setTimeout(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      setSaveStatus('saved');
      // The save has settled — stamp it with the current time.
      lastSavedAt = new Date();
      renderSavedTime();
    }
  }, 700);
}

// Wrap socket.send to automatically inject sheetName in outgoing events. Applied
// to each freshly (re)connected socket by connectSocket() so the behavior survives
// reconnects.
function applySendWrapper(sock) {
  const originalSend = sock.send;
  sock.send = function(data) {
    try {
      const msg = JSON.parse(data);
      // Read-only safety net: drop state-changing messages regardless of call site.
      if (!canEditWorkbook && msg && WB_STATE_CHANGING_TYPES.includes(msg.type)) {
        return;
      }
      if (msg && (msg.type === 'cell-edit' || msg.type === 'cursor-move' || msg.type === 'resize') && msg.payload) {
        msg.payload.sheetName = activeSheetName;
      }
      const result = originalSend.call(this, JSON.stringify(msg));
      // A successfully broadcast state-changing edit means a save is in flight.
      if (msg && WB_STATE_CHANGING_TYPES.includes(msg.type) && this.readyState === WebSocket.OPEN) {
        markSaving();
      }
      return result;
    } catch (e) {
      return originalSend.call(this, data);
    }
  };
}

/**
 * Reflect the current workbook edit rights in the UI. In read-only mode (a viewer
 * of a shared file) the editing affordances are grayed out and made inert, the
 * formula bar is locked, and a "view only" badge appears beside the file name.
 * The underlying actions are independently blocked in JS; this governs presentation.
 */
function applyWorkbookAccessUI() {
  const readOnly = !canEditWorkbook;
  document.body.classList.toggle('wb-readonly', readOnly);

  // Containers / controls whose editing affordances should be grayed + inert.
  ['main-toolbar', 'menu-edit-btn', 'menu-insert-btn', 'menu-format-btn', 'add-sheet-btn'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('wb-readonly-disable', readOnly);
  });

  // The formula bar must not accept input in read-only mode.
  const fb = document.getElementById('formula-bar-input');
  if (fb) fb.readOnly = readOnly;

  // A small "view only" badge beside the file name.
  const fileNameEl = document.getElementById('file-name');
  let badge = document.getElementById('wb-readonly-badge');
  if (readOnly) {
    if (!badge && fileNameEl && fileNameEl.parentElement) {
      badge = document.createElement('span');
      badge.id = 'wb-readonly-badge';
      badge.className = 'ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant text-xs align-middle';
      badge.innerHTML = '<span class="material-symbols-outlined text-[14px]">visibility</span><span data-role="label"></span>';
      fileNameEl.parentElement.appendChild(badge);
    }
    if (badge) {
      const label = badge.querySelector('[data-role="label"]');
      if (label) label.textContent = t('share.readOnlyBadge');
      badge.classList.remove('hidden');
    }
  } else if (badge) {
    badge.classList.add('hidden');
  }
}

/**
 * Handle incoming WebSocket messages from the server.
 */
function handleSocketMessage(event) {
  try {
    const { type, payload } = JSON.parse(event.data);

    // Initial state load
    if (type === 'init') {
      // Capture this client's edit rights and reflect them in the UI (read-only
      // mode for viewers). canEdit may be undefined on older payloads => assume true.
      canEditWorkbook = payload.canEdit !== false;
      applyWorkbookAccessUI();

      localSheets = Object.create(null);
      if (payload.sheetOrder) sheetOrder = payload.sheetOrder;
      if (payload.sheetColors) sheetColors = payload.sheetColors;
      if (payload.hiddenSheets) hiddenSheets = payload.hiddenSheets;
      colWidths = (payload.colWidths && typeof payload.colWidths === 'object') ? payload.colWidths : Object.create(null);
      rowHeights = (payload.rowHeights && typeof payload.rowHeights === 'object') ? payload.rowHeights : Object.create(null);
      colCounts = (payload.colCounts && typeof payload.colCounts === 'object') ? payload.colCounts : Object.create(null);
      hiddenCols = (payload.hiddenCols && typeof payload.hiddenCols === 'object') ? payload.hiddenCols : Object.create(null);

      if (payload.sheets && Object.keys(payload.sheets).length > 0) {
        Object.assign(localSheets, payload.sheets);
        // Prefer a server-provided active sheet; otherwise restore the one this
        // browser was last on for this file (client-side memory); else the first.
        const savedSheet = loadActiveSheetPref();
        if (payload.activeSheet && localSheets[payload.activeSheet]) {
          activeSheetName = payload.activeSheet;
        } else if (savedSheet && localSheets[savedSheet] && !(hiddenSheets || []).includes(savedSheet)) {
          activeSheetName = savedSheet;
        } else {
          activeSheetName = Object.keys(localSheets)[0] || 'Sheet1';
        }
      } else if (payload.cells) {
        localSheets['Sheet1'] = Object.assign(Object.create(null), payload.cells);
        activeSheetName = 'Sheet1';
      } else {
        localSheets['Sheet1'] = Object.create(null);
        activeSheetName = 'Sheet1';
      }

      if (!localSheets[activeSheetName]) {
        setKey(localSheets, activeSheetName, Object.create(null));
      }

      // Restore any persisted value filters so they paint on the first render.
      window.CoSheet.sortFilter.loadFilters();

      renderSheetTabs();
      renderSpreadsheetGrid();

      // Auto-select the top-left cell on first load so the toolbar (font size,
      // formatting, etc.) always has an active target to act on. Broadcast the
      // active sheet too, since a restored sheet may differ from the join default.
      if (!activeCellId) {
        const defaultCellEl = document.querySelector('[data-cell-id="A1"]');
        if (defaultCellEl) {
          handleCellSelect('A1', defaultCellEl, true); // silent: broadcast below with the sheet
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'cursor-move',
              payload: { cellId: 'A1', sheetName: activeSheetName }
            }));
          }
        }
      }

      // Learn our own presence identity so we can exclude ourselves from the
      // roster below (and in later cursor-update / re-render passes).
      if (payload.self) {
        myUserId = payload.self.userId || null;
        myUsername = payload.self.username != null ? payload.self.username : null;
      }

      // Position active users' cursors (skipping our own, incl. a stale ghost of
      // a previous connection left by a refresh/reconnect — see isSelfPresence).
      if (payload.users) {
        payload.users.forEach(user => {
          if (isSelfPresence(user)) return;
          if (user.activeCell) {
            const sheet = user.activeSheet || 'Sheet1';
            user.activeSheet = sheet;
            setKey(remoteCursors, user.userId, user);
            if (sheet === activeSheetName) {
              renderCursorBorder(user);
            }
          }
        });
      }
    }

    // Dynamic cursor presence update from other peers
    if (type === 'cursor-update') {
      const { userId, activeCell, activeSheet } = payload;
      removeCursorBorder(userId);
      // Ignore updates that describe our own presence (e.g. a lingering previous
      // connection after a refresh/reconnect) so we never tag our own cell.
      if (isSelfPresence(payload)) { deleteKey(remoteCursors, userId); return; }
      const sheet = activeSheet || 'Sheet1';
      payload.activeSheet = sheet;

      if (activeCell) {
        setKey(remoteCursors, userId, payload);
        if (sheet === activeSheetName) {
          renderCursorBorder(payload);
        }
      } else {
        deleteKey(remoteCursors, userId);
      }
    }

    // Cell updates propagated from other peers
    if (type === 'cell-update') {
      const { cellId, formula, value, style, sheetName } = payload;
      const sheet = sheetName || 'Sheet1';
      const cellMap = ensureKey(localSheets, sheet, () => Object.create(null));
      setKey(cellMap, cellId, { formula, value, style: style || {} });
      
      if (sheet === activeSheetName) {
        // Propagate dependencies once per burst, not once per message — a remote
        // bulk edit echoes one cell-update per cell (see scheduleRecalc).
        scheduleRecalc();
        updateGridDOMCell(cellId, getCellValue(cellId), style);
        // Borders are drawn neighbour-aware: every cell draws its own copy of each
        // shared edge, resolved with pick() against the facing neighbour. A remote
        // border edit thus changes what all FOUR neighbours should paint on their
        // facing side, so refresh each so the coincident copies stay in sync.
        const coord = parseCellCoord(cellId);
        if (coord) {
          const neighbourIds = [
            coord.colIndex - 1 >= 0 ? `${getColLetter(coord.colIndex - 1)}${coord.row}` : null,
            `${getColLetter(coord.colIndex + 1)}${coord.row}`,
            coord.row - 1 >= 1 ? `${getColLetter(coord.colIndex)}${coord.row - 1}` : null,
            `${getColLetter(coord.colIndex)}${coord.row + 1}`,
          ];
          neighbourIds.forEach((nId) => {
            if (!nId) return;
            const nStyle = localCells[nId] ? localCells[nId].style : null;
            if (styleHasBorders(style) || styleHasBorders(nStyle)) {
              updateGridDOMCell(nId, getCellValue(nId), nStyle || {});
            }
          });
        }
      }
    }

    // Handle new sheet added broadcast
    if (type === 'add-sheet') {
      const { sheetName, sheetOrder: newOrder, cells } = payload;
      if (!localSheets[sheetName]) {
        setKey(localSheets, sheetName, cells ? Object.assign(Object.create(null), cells) : Object.create(null));
      }
      if (newOrder) sheetOrder = newOrder;
      else if (!sheetOrder.includes(sheetName)) sheetOrder.push(sheetName);
      renderSheetTabs();
    }

    // Handle sheet deletion broadcast
    if (type === 'delete-sheet') {
      const { sheetName } = payload;
      deleteKey(localSheets, sheetName);
      sheetOrder = sheetOrder.filter(s => s !== sheetName);
      hiddenSheets = hiddenSheets.filter(s => s !== sheetName);
      if (sheetColors[sheetName]) deleteKey(sheetColors, sheetName);
      
      if (activeSheetName === sheetName) {
        const nextVisible = sheetOrder.find(s => !hiddenSheets.includes(s)) || 'Sheet1';
        activeSheetName = nextVisible;
        renderSpreadsheetGrid();
      }
      renderSheetTabs();
    }

    // Handle sheet rename broadcast
    if (type === 'rename-sheet') {
      const { oldName, newName } = payload;
      setKey(localSheets, newName, localSheets[oldName]);
      deleteKey(localSheets, oldName);

      sheetOrder = sheetOrder.map(s => s === oldName ? newName : s);
      hiddenSheets = hiddenSheets.map(s => s === oldName ? newName : s);
      if (sheetColors[oldName]) {
        setKey(sheetColors, newName, sheetColors[oldName]);
        deleteKey(sheetColors, oldName);
      }
      
      if (activeSheetName === oldName) {
        activeSheetName = newName;
        renderSpreadsheetGrid();
      }
      renderSheetTabs();
    }

    // Handle sheet color update broadcast
    if (type === 'color-sheet') {
      const { sheetName, color } = payload;
      if (color === null) {
        deleteKey(sheetColors, sheetName);
      } else {
        setKey(sheetColors, sheetName, color);
      }
      renderSheetTabs();
    }

    // Handle sheet hiding broadcast
    if (type === 'hide-sheet') {
      const { sheetName } = payload;
      if (!hiddenSheets.includes(sheetName)) {
        hiddenSheets.push(sheetName);
        if (activeSheetName === sheetName) {
          const nextVisible = sheetOrder.find(s => !hiddenSheets.includes(s)) || 'Sheet1';
          activeSheetName = nextVisible;
          renderSpreadsheetGrid();
        }
        renderSheetTabs();
      }
    }

    // Handle sheet unhiding broadcast
    if (type === 'unhide-sheet') {
      const { sheetName } = payload;
      hiddenSheets = hiddenSheets.filter(s => s !== sheetName);
      renderSheetTabs();
    }

    // Handle sheet reordering broadcast
    if (type === 'reorder-sheets') {
      const { sheetOrder: newOrder } = payload;
      sheetOrder = newOrder;
      renderSheetTabs();
    }

    // Handle a column-width / row-height change from any peer (or our own echo).
    if (type === 'resize-update') {
      const { dimension, sheetName, col, row, size } = payload;
      const sheet = sheetName || 'Sheet1';
      const map = dimension === 'col' ? colWidths : rowHeights;
      const dimMap = ensureKey(map, sheet, () => Object.create(null));
      const key = dimension === 'col' ? col : row;
      if (key != null) setKey(dimMap, key, size);
      // Re-render only when the change lands on the sheet currently in view.
      if (sheet === activeSheetName) renderSpreadsheetGrid();
    }

    // Handle a column-count change (insert/delete/undo of columns) from any peer.
    if (type === 'col-count-update') {
      const { sheetName, count } = payload;
      const sheet = sheetName || 'Sheet1';
      const n = Math.min(MAX_COLS, Math.max(DEFAULT_COLS, Number(count) || DEFAULT_COLS));
      if (n > DEFAULT_COLS) setKey(colCounts, sheet, n); else deleteKey(colCounts, sheet);
      if (sheet === activeSheetName) renderSpreadsheetGrid();
    }

    // Handle a hidden-column change (Hide/unhide from the column menu) from any peer.
    if (type === 'hidden-cols-update') {
      const { sheetName, cols } = payload;
      const sheet = sheetName || 'Sheet1';
      const clean = Array.isArray(cols) ? cols.filter((c) => typeof c === 'string') : [];
      if (clean.length) setKey(hiddenCols, sheet, clean); else deleteKey(hiddenCols, sheet);
      if (sheet === activeSheetName) renderSpreadsheetGrid();
    }

    // User leaving connection event
    if (type === 'user-leave') {
      const { userId } = payload;
      removeCursorBorder(userId);
      deleteKey(remoteCursors, userId);
    }
  } catch (e) {
    console.error('Error handling WebSocket message:', e.message);
  }
}

/**
 * Open (or re-open) the WebSocket connection and wire up its handlers. Called once
 * on load and again by the reconnect logic after a drop.
 *
 * Reconnection is required on hosts like Cloud Run where a connection is bounded by
 * the request timeout and is also severed by redeploys and instance restarts. The
 * server re-sends the full `init` payload on every new connection, so a reconnect
 * transparently re-syncs workbook state with no extra client work.
 */
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
function connectSocket() {
  socket = new WebSocket(wsUrl);
  applySendWrapper(socket);
  socket.onmessage = handleSocketMessage;

  socket.onopen = () => {
    // Connection established: reset the backoff so the next drop retries quickly.
    wsReconnectAttempts = 0;
    // Reconnect re-sends the full init payload, so we're back in sync = saved.
    clearTimeout(saveStatusTimer);
    setSaveStatus('saved');
  };

  socket.onclose = () => {
    // Socket down: edits can no longer reach the server, so surface that the
    // workbook is not currently being saved.
    clearTimeout(saveStatusTimer);
    setSaveStatus('reconnecting');
    // Exponential backoff capped at 30s, plus jitter so that a fleet of clients
    // reconnecting after an instance restart doesn't stampede the server at once.
    const delay = Math.min(30000, 1000 * 2 ** wsReconnectAttempts) + Math.random() * 1000;
    wsReconnectAttempts += 1;
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectSocket, delay);
  };

  socket.onerror = () => {
    // Let onclose drive reconnection; closing here avoids leaving a half-open socket.
    try { socket.close(); } catch (e) { /* already closing */ }
  };
}

connectSocket();

// Elements currently carrying a selection-highlight class. updateRangeSelectionUI
// is the sole adder of these classes (updateGridDOMCell only re-applies them to an
// already-tracked element it mutates in place), so this list is authoritative: we
// clear by walking it instead of running four whole-document querySelectorAll
// sweeps per drag tick. Turns the clear from O(grid) into O(previous selection)
// (see #96).
let highlightedEls = [];
const clearSelectionHighlights = () => {
  for (let i = 0; i < highlightedEls.length; i++) {
    const el = highlightedEls[i];
    if (el && el.classList) {
      el.classList.remove('grid-cell-selected', 'grid-cell-active', 'active-header', 'header-selected');
    }
  }
  highlightedEls.length = 0;
};

/**
 * Resets range selection variables and clears selection UI components.
 */
const clearRangeSelection = () => {
  selectionStartCellId = null;
  selectionEndCellId = null;
  isColumnSelection = false;
  isRowSelection = false;
  extraSelectionRanges = [];
  const overlay = document.getElementById('selection-range-overlay');
  if (overlay) overlay.remove();
  clearSelectionHighlights();
};

// ─── Merged cells ────────────────────────────────────────────────────────────
// A merge is stored on its top-left "anchor" cell as style.merge = { rows, cols }
// (with rows*cols > 1). The cells it covers carry no marker of their own; they're
// derived from the anchors. Because the merge lives in the cell style, it rides
// the existing cell-edit broadcast and workbook-state persistence with no new
// message type — collaborators and reloads see merges for free.

/** True when a style object carries a real (multi-cell) merge. */
const styleHasMerge = (style) => !!(style && style.merge && (style.merge.rows * style.merge.cols) > 1);

/** All merge anchors on the active sheet: [{ anchorId, r, c, rows, cols }]. */
const getActiveSheetMerges = () => {
  const out = [];
  const cells = localSheets[activeSheetName];
  if (!cells) return out;
  for (const id of Object.keys(cells)) {
    const cell = cells[id];
    if (cell && styleHasMerge(cell.style)) {
      const co = parseCellCoord(id);
      if (co) out.push({ anchorId: id, r: co.row, c: co.colIndex, rows: cell.style.merge.rows, cols: cell.style.merge.cols });
    }
  }
  return out;
};

/**
 * Builds the coverage maps used by the renderer: each covered cell id → its
 * anchor id, and each anchor id → its { rows, cols } span.
 */
const getMergeCoverage = () => {
  const anchorSpan = new Map();  // anchorId -> { rows, cols }
  const coveredTo = new Map();   // coveredCellId -> anchorId
  const merges = getActiveSheetMerges();
  for (const m of merges) {
    anchorSpan.set(m.anchorId, { rows: m.rows, cols: m.cols });
    for (let dr = 0; dr < m.rows; dr++) {
      for (let dc = 0; dc < m.cols; dc++) {
        if (dr === 0 && dc === 0) continue;
        coveredTo.set(`${getColLetter(m.c + dc)}${m.r + dr}`, m.anchorId);
      }
    }
  }
  return { anchorSpan, coveredTo, hasMerges: merges.length > 0 };
};

/**
 * Grows a rectangle so it fully contains every merge it touches, repeating until
 * stable (one merge can push the bounds out far enough to pull in another).
 * @returns {{minRow:number,maxRow:number,minCol:number,maxCol:number}}
 */
const expandRangeForMerges = (minRow, maxRow, minCol, maxCol) => {
  const merges = getActiveSheetMerges();
  if (!merges.length) return { minRow, maxRow, minCol, maxCol };
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of merges) {
      const top = m.r, bottom = m.r + m.rows - 1;
      const left = m.c, right = m.c + m.cols - 1;
      // Skip merges that don't overlap the current rectangle.
      if (top > maxRow || bottom < minRow || left > maxCol || right < minCol) continue;
      if (top < minRow) { minRow = top; changed = true; }
      if (bottom > maxRow) { maxRow = bottom; changed = true; }
      if (left < minCol) { minCol = left; changed = true; }
      if (right > maxCol) { maxCol = right; changed = true; }
    }
  }
  return { minRow, maxRow, minCol, maxCol };
};

/**
 * Normalized, merge-expanded bounds of a {startId, endId} range, or null when
 * either id fails to parse.
 */
const rangeBounds = (startId, endId) => {
  const start = parseCellCoord(startId);
  const end = parseCellCoord(endId);
  if (!start || !end) return null;
  let minCol = Math.min(start.colIndex, end.colIndex);
  let maxCol = Math.max(start.colIndex, end.colIndex);
  let minRow = Math.min(start.row, end.row);
  let maxRow = Math.max(start.row, end.row);
  ({ minRow, maxRow, minCol, maxCol } = expandRangeForMerges(minRow, maxRow, minCol, maxCol));
  return { minRow, maxRow, minCol, maxCol };
};

/**
 * Helper to get all cell IDs within the current selection. The raw range is
 * expanded to fully include any merged cells it touches, so an operation on a
 * selection that clips a merge still covers the whole merged block. Extra
 * header ranges (Ctrl+click) are included, deduplicated, unless the caller
 * needs a single rectangle and passes activeRangeOnly (copy/cut/merge/borders,
 * whose offset or perimeter math is only defined on one rectangle).
 * @param {{activeRangeOnly?: boolean}} [opts]
 * @returns {string[]} List of cell IDs.
 */
const getSelectedCellIds = ({ activeRangeOnly = false } = {}) => {
  const baseId = selectionStartCellId || activeCellId;
  if (!baseId) return [];
  const bounds = rangeBounds(baseId, selectionEndCellId || selectionStartCellId || baseId);
  if (!bounds) return activeCellId ? [activeCellId] : [];

  const cellIds = [];
  for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
    const colLetter = getColLetter(c);
    for (let r = bounds.minRow; r <= bounds.maxRow; r++) {
      cellIds.push(`${colLetter}${r}`);
    }
  }
  if (activeRangeOnly || !extraSelectionRanges.length) return cellIds;

  const seen = new Set(cellIds);
  for (const range of extraSelectionRanges) {
    const b = rangeBounds(range.startId, range.endId);
    if (!b) continue;
    for (let c = b.minCol; c <= b.maxCol; c++) {
      const colLetter = getColLetter(c);
      for (let r = b.minRow; r <= b.maxRow; r++) {
        const id = `${colLetter}${r}`;
        if (!seen.has(id)) { seen.add(id); cellIds.push(id); }
      }
    }
  }
  return cellIds;
};

/**
 * Renders the absolute overlay border, highlights cells, and marks row/column headers as active.
 */
const updateRangeSelectionUI = () => {
  if (!selectionStartCellId) {
    clearRangeSelection();
    return;
  }

  const endId = selectionEndCellId || selectionStartCellId;
  const startCoord = parseCellCoord(selectionStartCellId);
  const endCoord = parseCellCoord(endId);
  if (!startCoord || !endCoord) return;

  let minColIndex = Math.min(startCoord.colIndex, endCoord.colIndex);
  let maxColIndex = Math.max(startCoord.colIndex, endCoord.colIndex);
  let minRow = Math.min(startCoord.row, endCoord.row);
  let maxRow = Math.max(startCoord.row, endCoord.row);
  // Snap the visible selection out to whole merged blocks it touches, so the
  // highlight and overlay frame a merge as one unit.
  ({ minRow, maxRow, minCol: minColIndex, maxCol: maxColIndex } =
    expandRangeForMerges(minRow, maxRow, minColIndex, maxColIndex));
  // True when the selection spans more than one cell. Used both for the Name Box
  // label and to decide whether the anchor cell also takes the range fill below.
  const isRange = minColIndex !== maxColIndex || minRow !== maxRow;

  // Update the Name Box (top-left of the formula bar). A single cell shows
  // e.g. "A1"; a multi-cell range shows "topLeft:bottomRight" e.g. "E2:F2".
  const nameBox = document.getElementById('name-box');
  if (nameBox) {
    const topLeft = `${getColLetter(minColIndex)}${minRow}`;
    // A full-column selection reads like Google Sheets, e.g. "A:A" / "A:C";
    // a full-row one reads e.g. "5:5" / "5:8".
    if (isColumnSelection) {
      nameBox.innerText = `${getColLetter(minColIndex)}:${getColLetter(maxColIndex)}`;
    } else if (isRowSelection) {
      nameBox.innerText = `${minRow}:${maxRow}`;
    } else {
      nameBox.innerText = isRange ? `${topLeft}:${getColLetter(maxColIndex)}${maxRow}` : topLeft;
    }
  }

  // Clear previous highlighted cells and active headers — walk the tracked set
  // rather than scanning the whole grid four times (see clearSelectionHighlights).
  clearSelectionHighlights();

  // Headers take the solid-blue "selected" style when their whole track is
  // inside the selection — geometry, not gesture, decides: a column header
  // darkens when the selection spans every row (a header click, Ctrl+A, or a
  // full-height drag all qualify), a row header when it spans every rendered
  // column. Anything less keeps the light active-header tint.
  const spansAllRows = minRow === 1 && maxRow === TOTAL_ROWS;
  const spansAllCols = minColIndex === 0 && maxColIndex === getColCount() - 1;

  // Highlight cells and headers in range. Lookups go through the O(1) render
  // indexes (getColHeaderEl / getRowHeaderEl / getCellEl), and each highlighted
  // element is recorded so the next clear is O(this selection), not O(grid).
  for (let c = minColIndex; c <= maxColIndex; c++) {
    const colLetter = getColLetter(c);
    const colHeader = getColHeaderEl(colLetter);
    if (colHeader) {
      colHeader.classList.add(spansAllRows ? 'header-selected' : 'active-header');
      highlightedEls.push(colHeader);
    }

    for (let r = minRow; r <= maxRow; r++) {
      const cellId = `${colLetter}${r}`;
      if (c === minColIndex) {
        const rowHeader = getRowHeaderEl(r);
        if (rowHeader) {
          rowHeader.classList.add(spansAllCols ? 'header-selected' : 'active-header');
          highlightedEls.push(rowHeader);
        }
      }

      // The primary active cell (first cell clicked) gets a thick border;
      // every other cell in the range gets the lighter range fill. In a
      // multi-cell selection the anchor also takes the fill class so a blank
      // anchor reflects the blue tint and a colored one keeps its background,
      // just like the rest of the range; a single-cell selection keeps the
      // border only and leaves the cell its natural color.
      const cellEl = getCellEl(cellId);
      if (cellEl) {
        if (cellId === activeCellId) {
          cellEl.classList.add('grid-cell-active');
          if (isRange) cellEl.classList.add('grid-cell-selected');
        } else {
          cellEl.classList.add('grid-cell-selected');
        }
        highlightedEls.push(cellEl);
      }
    }
  }

  // Paint the extra (Ctrl+click) header ranges: same cell fill and header
  // geometry rules as the active range, but no anchor border and no overlay —
  // those stay on the active range. A cell shared with the active range just
  // re-adds the same classes.
  for (const range of extraSelectionRanges) {
    const b = rangeBounds(range.startId, range.endId);
    if (!b) continue;
    const bSpansAllRows = b.minRow === 1 && b.maxRow === TOTAL_ROWS;
    const bSpansAllCols = b.minCol === 0 && b.maxCol === getColCount() - 1;
    for (let c = b.minCol; c <= b.maxCol; c++) {
      const colLetter = getColLetter(c);
      const extraColHeader = getColHeaderEl(colLetter);
      if (extraColHeader) {
        extraColHeader.classList.add(bSpansAllRows ? 'header-selected' : 'active-header');
        highlightedEls.push(extraColHeader);
      }
      for (let r = b.minRow; r <= b.maxRow; r++) {
        if (c === b.minCol) {
          const extraRowHeader = getRowHeaderEl(r);
          if (extraRowHeader) {
            extraRowHeader.classList.add(bSpansAllCols ? 'header-selected' : 'active-header');
            highlightedEls.push(extraRowHeader);
          }
        }
        const cellEl = getCellEl(`${colLetter}${r}`);
        if (cellEl) {
          cellEl.classList.add('grid-cell-selected');
          highlightedEls.push(cellEl);
        }
      }
    }
  }

  // Draw selection-range-overlay
  let overlay = document.getElementById('selection-range-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'selection-range-overlay';
    overlay.innerHTML = '<div class="fill-handle"></div>';
    const gridRoot = document.getElementById('grid-root');
    if (gridRoot) gridRoot.appendChild(overlay);
  }

  // Position and size the overlay from the grid model via colLeft / rowTop and the
  // column/row sizes, all in #grid-root's own layout space (the overlay is a child
  // of #grid-root, so CSS `zoom` scales it with the cells). Deriving the rect this
  // way needs no cell box to measure from, so it is correct even when the range's
  // top-left corner is a display:none merge-covered cell or isn't in the DOM at all
  // (hidden columns, and a future windowed render). Column widths are authoritative
  // (columns never auto-fit content); row heights use the rendered height so a
  // content-auto-grown row is enclosed exactly.
  const left = colLeft(minColIndex);
  const top = rowTop(minRow);
  let width = 0;
  for (let c = minColIndex; c <= maxColIndex; c++) width += getColWidth(getColLetter(c));
  let height = 0;
  for (let r = minRow; r <= maxRow; r++) height += resolvedRowHeight(r);

  // Position the overlay exactly on the range bounds. With box-sizing:border-box
  // the 1px outer border is drawn inside this rect, so along the anchor cell's
  // top/left edges it overlaps the anchor's 2px border (same colour) instead of
  // stacking beside it — keeping the anchor's border a uniform width.
  overlay.style.left = `${left}px`;
  overlay.style.width = `${width}px`;
  overlay.style.top = `${top}px`;
  overlay.style.height = `${height}px`;
};

/**
 * Serialize copied cells to tab/newline-delimited text (TSV) for the system
 * clipboard, laying each cell out by its row/column offset (gaps become empty
 * strings). This is the plain-text mirror of the in-memory clipboard so an
 * in-app copy and a browser-native paste agree on content.
 * @param {Array<{offsetRow:number, offsetCol:number, value?:string}>} copiedCells
 * @returns {string} TSV text (rows joined by "\n", columns by "\t").
 */
const copiedCellsToText = (copiedCells) => {
  if (!copiedCells || copiedCells.length === 0) return '';
  let maxRow = 0;
  let maxCol = 0;
  for (const c of copiedCells) {
    if (c.offsetRow > maxRow) maxRow = c.offsetRow;
    if (c.offsetCol > maxCol) maxCol = c.offsetCol;
  }
  const grid = Array.from({ length: maxRow + 1 }, () => Array(maxCol + 1).fill(''));
  for (const c of copiedCells) {
    grid[c.offsetRow][c.offsetCol] = c.value != null ? c.value : '';
  }
  return grid.map(row => row.join('\t')).join('\n');
};

/**
 * Best-effort mirror of the internal clipboard onto the system clipboard so a
 * browser-native paste (e.g. into a cell that is being edited, where the app's
 * Ctrl+V interception steps aside) inserts what the user actually copied rather
 * than stale OS-clipboard text. Failures — insecure context, denied permission,
 * no document focus — are swallowed; the in-memory buffer stays the source of
 * truth for in-app pastes.
 * @param {string} text - The text to place on the system clipboard.
 */
const writeSystemClipboard = (text) => {
  try {
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).catch(() => { /* clipboard write rejected */ });
    }
  } catch { /* clipboard API unavailable */ }
};

/**
 * Copies values, formulas, and styles of the currently selected range of cells.
 */
const copySelectedCells = () => {
  // Offset math needs one rectangle; a Ctrl+click multi-selection copies its
  // active range only.
  const cellIds = getSelectedCellIds({ activeRangeOnly: true });
  if (cellIds.length === 0) return;

  const coords = cellIds.map(id => parseCellCoord(id)).filter(c => c !== null);
  if (coords.length === 0) return;

  const minRow = Math.min(...coords.map(c => c.row));
  const minColIndex = Math.min(...coords.map(c => c.colIndex));

  const copiedCells = coords.map(c => {
    const id = `${c.colLetter}${c.row}`;
    const cellData = localCells[id] || { formula: '', value: '', style: {} };
    return {
      offsetRow: c.row - minRow,
      offsetCol: c.colIndex - minColIndex,
      formula: cellData.formula || '',
      value: cellData.value || '',
      style: cellData.style ? JSON.parse(JSON.stringify(cellData.style)) : {}
    };
  });

  clipboardData = { copiedCells };
  // Keep the OS clipboard in sync with the in-app copy so a native paste (e.g.
  // into a cell being edited) can't insert stale, unrelated clipboard content.
  writeSystemClipboard(copiedCellsToText(copiedCells));
};

/**
 * Copies the current selection and clears the source cells.
 */
const cutSelectedCells = () => {
  // Like copy: cut works on the active rectangle only.
  const cellIds = getSelectedCellIds({ activeRangeOnly: true });
  if (cellIds.length === 0) return;

  // First copy them
  copySelectedCells();

  // Then clear them
  const historyChanges = [];
  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    localCells[id] = { formula: '', value: '', style: {} };
    historyChanges.push({ cellId: id, before, after: { formula: '', value: '', style: {} } });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: '', value: '', style: {} }
      }));
    }
    updateGridDOMCell(id, '', {});
  });

  if (historyChanges.length > 0) {
    recordHistoryAction({ type: 'multi', changes: historyChanges });
    recalculateSheet();
  }
};

/**
 * Pastes copied cell data relative to the active cell.
 */
const pasteSelectedCells = () => {
  if (!clipboardData || !activeCellId) return;

  const target = parseCellCoord(activeCellId);
  if (!target) return;

  const historyChanges = [];
  clipboardData.copiedCells.forEach(copied => {
    const newRow = target.row + copied.offsetRow;
    const newColIndex = target.colIndex + copied.offsetCol;
    if (newRow < 1 || newRow > TOTAL_ROWS || newColIndex < 0 || newColIndex > MAX_COLS - 1) return;

    const newColLetter = getColLetter(newColIndex);
    const newCellId = `${newColLetter}${newRow}`;

    const before = localCells[newCellId] ? JSON.parse(JSON.stringify(localCells[newCellId])) : { formula: '', value: '', style: {} };
    
    localCells[newCellId] = {
      formula: copied.formula,
      value: copied.value,
      style: JSON.parse(JSON.stringify(copied.style))
    };

    historyChanges.push({ cellId: newCellId, before, after: JSON.parse(JSON.stringify(localCells[newCellId])) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: newCellId, formula: copied.formula, value: copied.value, style: copied.style }
      }));
    }
    updateGridDOMCell(newCellId, getCellValue(newCellId), copied.style);
  });

  if (historyChanges.length > 0) {
    recordHistoryAction({ type: 'multi', changes: historyChanges });
    recalculateSheet();
    // Pasting a cell with a larger font grows the destination row (its
    // font-driven min-height). Re-measure the selection so the overlay and its
    // fill handle track the new cell height; otherwise they stay at the old,
    // shorter size and leave a stray horizontal line across the middle.
    updateRangeSelectionUI();
    if (localCells[activeCellId]) {
      const formulaBar = document.getElementById('formula-bar-input');
      if (formulaBar) {
        formulaBar.value = localCells[activeCellId].formula ? localCells[activeCellId].formula : localCells[activeCellId].value;
      }
    }
  }
};

// Find & Replace lives in find-replace.js (window.CoSheet.findReplace); it is
// wired to the core via window.CoSheet.app near the bottom of this file.

/**
 * Records a single or composite cell state change to the local undo stack.
 * @param {string|Object} cellIdOrAction - Target cell ID or composite action object.
 * @param {Object} [before] - State before change (for single cell action).
 * @param {Object} [after] - State after change (for single cell action).
 */
const recordHistoryAction = (cellIdOrAction, before, after) => {
  let action;
  if (before !== undefined) {
    action = {
      type: 'single',
      cellId: cellIdOrAction,
      before: JSON.parse(JSON.stringify(before)),
      after: JSON.parse(JSON.stringify(after))
    };
  } else {
    action = JSON.parse(JSON.stringify(cellIdOrAction));
  }
  undoStack.push(action);
  if (undoStack.length > 50) {
    undoStack.shift();
  }
  redoStack.length = 0; // Clear redo history on new user action
  updateUndoRedoButtonsState();
};

/**
 * Updates the disabled attributes and visual opacity of the Undo/Redo buttons.
 */
const updateUndoRedoButtonsState = () => {
  const undoBtn = document.getElementById('toolbar-undo');
  const redoBtn = document.getElementById('toolbar-redo');

  const setEnabled = (btn, enabled) => {
    if (!btn) return;
    if (enabled) {
      btn.removeAttribute('disabled');
      btn.classList.remove('opacity-40', 'cursor-not-allowed');
    } else {
      btn.setAttribute('disabled', 'true');
      btn.classList.add('opacity-40', 'cursor-not-allowed');
    }
  };

  setEnabled(undoBtn, undoStack.length > 0);
  setEnabled(redoBtn, redoStack.length > 0);
};

/**
 * Applies the zoom factor to the spreadsheet grid container, updates input text and menu highlights.
 * @param {number} zoomValue - Zoom percentage value (50 to 200).
 */
const applyGridZoom = (zoomValue) => {
  const value = Math.max(50, Math.min(200, zoomValue));
  currentZoom = value;

  // Apply CSS zoom to grid container
  const gridRoot = document.getElementById('grid-root');
  if (gridRoot) {
    gridRoot.style.zoom = currentZoom / 100;
  }

  // Zoom changes the scrollable extent and the header size, so resync + reposition
  // the synthetic scrollbars.
  if (gridScrollbarLayout) gridScrollbarLayout();

  // Update zoom input value text
  const zoomInput = document.getElementById('toolbar-zoom-input');
  if (zoomInput) {
    zoomInput.value = `${currentZoom}%`;
  }

  // Toggle active highlights inside options menu
  document.querySelectorAll('.toolbar-zoom-option').forEach(btn => {
    const optionVal = parseInt(btn.getAttribute('data-zoom'), 10);
    if (optionVal === currentZoom) {
      btn.classList.add('bg-surface-variant');
    } else {
      btn.classList.remove('bg-surface-variant');
    }
  });

  // Mirror the active level as a check mark in the View > Zoom flyout.
  document.querySelectorAll('.view-zoom-option').forEach(btn => {
    const optionVal = parseInt(btn.getAttribute('data-zoom'), 10);
    const check = btn.querySelector('.view-zoom-check');
    if (check) check.textContent = optionVal === currentZoom ? 'check' : '';
  });
};

/**
 * Broadcasts the updated cell state to peers and updates the DOM cell locally.
 * @param {string} cellId - The cell ID.
 */
const syncCellState = (cellId) => {
  const cell = localCells[cellId] || { formula: '', value: '', style: {} };
  
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId, formula: cell.formula, value: cell.value, style: cell.style || {} }
    }));
  }
  
  updateGridDOMCell(cellId, getCellValue(cellId), cell.style);
  recalculateSheet();
  
  if (activeCellId === cellId) {
    // Update top formula bar
    const formulaBar = document.getElementById('formula-bar-input');
    if (formulaBar) {
      formulaBar.value = cell.formula ? cell.formula : cell.value;
    }
    updateToolbarFormattingStates(cell.style);
  }
};

/**
 * Re-renders the cells named by a multi-change action plus their immediate
 * four-neighbour ring, so neighbour-aware borders repaint without rebuilding the
 * entire grid. Each cell draws its own copy of every shared edge, resolved with
 * pick() against the facing neighbour, so a change to one cell can flip what any
 * of its four neighbours paint — the ring around every change covers them all.
 * Used by border undo/redo in place of a full renderSpreadsheetGrid(), which got
 * prohibitively expensive once a sheet had many framed cells (issue #75).
 * @param {{cellId:string}[]} changes
 */
const rerenderBorderRing = (changes) => {
  const colCount = getColCount(activeSheetName);
  const renderIds = new Set();
  changes.forEach(({ cellId }) => {
    const coord = parseCellCoord(cellId);
    if (!coord) return;
    const { row: r, colIndex: c } = coord;
    renderIds.add(cellId);
    if (c - 1 >= 0) renderIds.add(`${getColLetter(c - 1)}${r}`);
    if (c + 1 < colCount) renderIds.add(`${getColLetter(c + 1)}${r}`);
    if (r - 1 >= 1) renderIds.add(`${getColLetter(c)}${r - 1}`);
    if (r + 1 <= TOTAL_ROWS) renderIds.add(`${getColLetter(c)}${r + 1}`);
  });
  renderIds.forEach((id) => {
    const st = (localCells[id] && localCells[id].style) || EMPTY_STYLE;
    updateGridDOMCell(id, getCellValue(id), st);
  });
};

/**
 * Reverts the last recorded cell state modification from the undo stack.
 */
const performUndo = () => {
  if (undoStack.length === 0) return;
  const action = undoStack.pop();
  
  if (action.type === 'multi') {
    const redoChanges = [];
    let touchesBorders = false;
    let touchesMerge = false;
    action.changes.forEach(change => {
      const currentState = localCells[change.cellId] ? JSON.parse(JSON.stringify(localCells[change.cellId])) : { formula: '', value: '', style: {} };
      redoChanges.push({ cellId: change.cellId, before: change.before, after: currentState });
      if (styleHasBorders(currentState.style) || styleHasBorders(change.before.style)) touchesBorders = true;
      if (styleHasMerge(currentState.style) || styleHasMerge(change.before.style)) touchesMerge = true;
      localCells[change.cellId] = JSON.parse(JSON.stringify(change.before));
      syncCellState(change.cellId);
    });
    // A merge change moves grid tracks, which only a full rebuild reflects.
    // Border edges are drawn neighbour-aware (each cell draws its own copy of a
    // shared edge); a targeted ring re-render around the changed cells repaints
    // every affected edge without the cost of rebuilding the whole grid (#75).
    if (touchesMerge) renderSpreadsheetGrid();
    else if (touchesBorders) rerenderBorderRing(action.changes);
    // Reverse a column insert/delete's width change; re-renders the grid.
    applyColCountDelta(action.colDelta ? -action.colDelta : 0);
    redoStack.push({ type: 'multi', changes: redoChanges, colDelta: action.colDelta || 0 });
  } else {
    const cellId = action.cellId;
    const currentState = localCells[cellId] ? JSON.parse(JSON.stringify(localCells[cellId])) : { formula: '', value: '', style: {} };
    redoStack.push({ type: 'single', cellId, before: action.before, after: currentState });
    localCells[cellId] = JSON.parse(JSON.stringify(action.before));
    syncCellState(cellId);
  }
  // Restoring a cell can change its font-driven height (e.g. undoing the delete
  // of a tall cell). Re-measure the selection so the overlay tracks the new cell
  // height instead of leaving a stray horizontal line across the middle. (A
  // border change above already re-rendered, which refreshes the overlay too.)
  updateRangeSelectionUI();
  updateUndoRedoButtonsState();
};

/**
 * Re-applies the last undone cell state modification from the redo stack.
 */
const performRedo = () => {
  if (redoStack.length === 0) return;
  const action = redoStack.pop();
  
  if (action.type === 'multi') {
    const undoChanges = [];
    let touchesBorders = false;
    let touchesMerge = false;
    action.changes.forEach(change => {
      const currentState = localCells[change.cellId] ? JSON.parse(JSON.stringify(localCells[change.cellId])) : { formula: '', value: '', style: {} };
      undoChanges.push({ cellId: change.cellId, before: currentState, after: change.after });
      if (styleHasBorders(currentState.style) || styleHasBorders(change.after.style)) touchesBorders = true;
      if (styleHasMerge(currentState.style) || styleHasMerge(change.after.style)) touchesMerge = true;
      localCells[change.cellId] = JSON.parse(JSON.stringify(change.after));
      syncCellState(change.cellId);
    });
    if (touchesMerge) renderSpreadsheetGrid();
    else if (touchesBorders) rerenderBorderRing(action.changes);
    // Replay a column insert/delete's width change; re-renders the grid.
    applyColCountDelta(action.colDelta || 0);
    undoStack.push({ type: 'multi', changes: undoChanges, colDelta: action.colDelta || 0 });
  } else {
    const cellId = action.cellId;
    const currentState = localCells[cellId] ? JSON.parse(JSON.stringify(localCells[cellId])) : { formula: '', value: '', style: {} };
    undoStack.push({ type: 'single', cellId, before: currentState, after: action.after });
    localCells[cellId] = JSON.parse(JSON.stringify(action.after));
    syncCellState(cellId);
  }
  // See performUndo: re-measure the selection so the overlay tracks any
  // height change from the reapplied state.
  updateRangeSelectionUI();
  updateUndoRedoButtonsState();
};

/**
 * Gets cell display value, evaluating formulas if present.
 * @param {string} coord - Cell coordinates.
 * @param {number} [depth=0] - Current recursion depth to prevent infinite loops.
 * @param {string|null} [sheetName=null] - Sheet to read from (null = active sheet).
 *   A cross-sheet reference passes the referenced sheet here; a formula found on
 *   that sheet is then evaluated with it as the base so its own unqualified
 *   references stay within that sheet.
 * @returns {string} Evaluated text display value.
 */
const getCellValue = (coord, depth = 0, sheetName = null) => {
  const cells = sheetName != null ? localSheets[sheetName] : localCells;
  if (!cells) return ''; // reference to an unknown sheet → treated as blank
  const cell = cells[coord];
  if (!cell) return '';
  if (cell.formula) {
    // Imported .xlsx formulas can use functions this engine doesn't implement.
    // Re-evaluating those would overwrite Excel's cached result with #NAME? (or a
    // blank, when the formula wraps the call in IFERROR), so when the cell carries
    // a cached value, keep displaying it for any formula the engine can't fully
    // compute. With no cached value to preserve (e.g. a formula typed into an empty
    // cell), fall through and show the engine's honest error instead of a blank.
    if (cell.value && !formulaIsSupported(cell.formula)) return cell.value;
    return evaluateFormula(cell.formula, depth, coord, sheetName != null ? sheetName : null);
  }
  return cell.value || '';
};

/**
 * Applies a cell's number format (e.g. percentage) to its evaluated value for
 * display only. The underlying stored value is left untouched, so e.g. a cell
 * holding 1 with numberFormat 'percent' shows "100.00%".
 * @param {string} rawValue - The evaluated cell value.
 * @param {object} style - The cell's style object.
 * @returns {string} The value formatted for display.
 */
const formatCellDisplay = (rawValue, style) => {
  // Nothing to do without either a named format or an explicit decimal count.
  if (!style || (!style.numberFormat && style.decimalPlaces == null)) return rawValue;
  // Plain-text format shows the value verbatim — no numeric reformatting.
  if (style.numberFormat === 'text') return rawValue;
  // Only numeric values are reformatted; text/blank pass through untouched.
  const str = String(rawValue).trim();
  if (str === '' || isNaN(str) || !isFinite(Number(str))) return rawValue;
  const num = Number(str);
  // No named format, but the user pinned a decimal count: show a plain number
  // with that many fraction digits (no grouping), mirroring "general" format.
  if (!style.numberFormat) return num.toFixed(style.decimalPlaces);
  const out = formatNumberByType(num, style.numberFormat, style.decimalPlaces);
  return out === null ? rawValue : out;
};

/**
 * Renders a number in a named display format (used by both cell rendering and
 * the Format ▸ Number menu's example previews, so the two never drift apart).
 * Returns null for an unknown/unsupported format so the caller can fall back to
 * the raw value. Currency uses the NT$ symbol; negatives follow accounting
 * conventions (parentheses) for the accounting/financial styles.
 * @param {number} num - The numeric value to format.
 * @param {string} fmt - Format key (number, percent, scientific, currency, …).
 * @returns {string|null} The formatted string, or null if `fmt` is unsupported.
 */
const formatNumberByType = (num, fmt, decimals) => {
  const grouped = (n, dec) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const abs = Math.abs(num);
  // An explicit `decimals` (set via the increase/decrease-decimal toolbar
  // buttons) overrides each format's default fraction-digit count.
  const d = (def) => (decimals == null ? def : decimals);
  switch (fmt) {
    case 'percent':         return `${(num * 100).toFixed(d(2))}%`;
    case 'number':          return grouped(num, d(2));
    case 'scientific':      return num.toExponential(d(2)).replace(/e([+-])(\d+)/i, (m, s, dd) => `E${s}${dd.padStart(2, '0')}`);
    case 'currency':        return `${num < 0 ? '-' : ''}NT$${grouped(abs, d(2))}`;
    case 'currencyRounded': return `${num < 0 ? '-' : ''}NT$${grouped(abs, d(0))}`;
    case 'accounting':      return num < 0 ? `(NT$${grouped(abs, d(2))})` : `NT$${grouped(abs, d(2))}`;
    case 'financial':       return num < 0 ? `(${grouped(abs, d(2))})` : grouped(abs, d(2));
    default:                return null;
  }
};

/**
 * The number of decimal places a format shows by default (before any explicit
 * override via the increase/decrease-decimal buttons).
 * @param {string} fmt - Format key, or null/undefined for "no named format".
 * @returns {number} The default fraction-digit count.
 */
const defaultDecimalsForFormat = (fmt) => (fmt === 'currencyRounded' ? 0 : 2);

/**
 * Determines whether a cell's evaluated value is a plain number (integer or
 * decimal). Used to right-align numeric cells by default, mirroring spreadsheet
 * conventions. Blank values and non-numeric text return false.
 * @param {string} rawValue - The evaluated cell value.
 * @returns {boolean} True if the value is a finite number.
 */
const isNumericValue = (rawValue) => {
  if (rawValue === '' || rawValue === null || rawValue === undefined) return false;
  const trimmed = String(rawValue).trim();
  if (trimmed === '') return false;
  return !isNaN(trimmed) && isFinite(trimmed);
};

/**
 * Trim redundant leading zeros from a plain decimal number entry so "01" and
 * "007" commit as "1" and "7" (treated as ordinary numbers). Only decimal-format
 * numbers are rewritten — the integer part's leading zeros are stripped while the
 * sign, fraction, and exponent are preserved (so "0.5" stays "0.5" and "01.50"
 * becomes "1.50"). Any input that isn't a plain decimal number is returned
 * unchanged. Callers skip this for the plain-text format, which keeps literals.
 * @param {string} text - The raw text the user committed.
 * @returns {string} The text with redundant leading zeros removed.
 */
const stripLeadingZeros = (text) => {
  const match = /^([+-]?)(\d+)((?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(text);
  if (!match) return text;
  const [, sign, intPart, rest] = match;
  return sign + intPart.replace(/^0+(?=\d)/, '') + rest;
};

/**
 * Determines whether a cell's evaluated value is a date string in the format
 * the formula engine emits (e.g. "2026/6/13" or "2026/6/13 14:30:00").
 * @param {string} rawValue - The evaluated cell value.
 * @returns {boolean} True if the value looks like an engine-formatted date.
 */
const isDateValue = (rawValue) => /^\d{4}\/\d{1,2}\/\d{1,2}(\s+\d{1,2}:\d{2}:\d{2})?$/.test(String(rawValue).trim());

/**
 * Resolves the horizontal text alignment for a cell: an explicit alignment in
 * the style always wins; otherwise numeric values and dates default to right
 * alignment (matching spreadsheet conventions).
 * @param {string} rawValue - The evaluated cell value.
 * @param {object} style - The cell's style object.
 * @returns {string} A CSS text-align value, or '' for the default.
 */
const resolveCellAlign = (rawValue, style) => {
  if (style && style.align) return style.align;
  // Plain-text format treats contents as text, so numbers left-align (the
  // default) rather than picking up the numeric right-alignment below.
  if (style && style.numberFormat === 'text') return '';
  if (isNumericValue(rawValue) || isDateValue(rawValue)) return 'right';
  return '';
};

/* =============================================================================
 * Formula engine — extracted to formula-engine.js (window.CoSheet.formula).
 * The engine resolves cell references through this app-supplied accessor, which
 * reads the live sheet and recurses into dependent formulas.
 * ========================================================================== */
window.CoSheet.formula.setCellResolver(getCellValue);

/**
 * Triggers cascading recalculation of all formula cells in the sheet.
 */
const recalculateSheet = () => {
  Object.keys(localCells).forEach(coord => {
    const cell = localCells[coord];
    if (cell && cell.formula) {
      // Leave a formula the engine can't compute untouched when it carries an
      // imported cached value, so that value survives (see getCellValue):
      // re-evaluating would clobber it. Without a cached value there's nothing to
      // protect, so fall through and let the engine produce its result/error.
      if (cell.value && !formulaIsSupported(cell.formula)) return;
      const newVal = evaluateFormula(cell.formula, 0, coord);
      if (newVal !== cell.value) {
        cell.value = newVal;
        updateGridDOMCell(coord, newVal, cell.style);
      }
    }
  });
};

/**
 * Coalesces dependency-propagation recalcs. A remote bulk edit arrives as one
 * `cell-update` message per cell; running a full-sheet recalc on every message is
 * O(messages × formula cells). Each message still applies its own state + DOM cell
 * update immediately (cheap, per-cell), but the sheet-wide recalc that propagates
 * dependencies is debounced so a burst of incoming updates triggers a SINGLE recalc
 * on the next microtask — mirroring scheduleRowOverflow / flushPendingOverflow.
 */
let recalcScheduled = false;
const scheduleRecalc = () => {
  if (recalcScheduled) return;
  recalcScheduled = true;
  queueMicrotask(() => {
    recalcScheduled = false;
    recalculateSheet();
  });
};

/**
 * Helper to check if a cell's content or style has changed between the currently selected version
 * and the previous version.
 */
const isCellChanged = (cellId, sheetName) => {
  if (!selectedVersionState) return false;
  const currentCell = selectedVersionState?.sheets?.[sheetName]?.[cellId] || { formula: '', value: '', style: {} };
  const prevCell = previousVersionState?.sheets?.[sheetName]?.[cellId] || { formula: '', value: '', style: {} };

  const normalizeStyle = (style) => {
    if (!style) return {};
    const norm = {};
    const keys = ['bold', 'italic', 'color', 'strikethrough', 'textColor', 'border', 'align', 'link', 'verticalAlign'];
    keys.forEach(k => {
      if (style[k] !== undefined) norm[k] = style[k];
    });
    return norm;
  };

  const currentVal = currentCell.value || '';
  const currentFormula = currentCell.formula || '';
  const currentStyle = normalizeStyle(currentCell.style);

  const prevVal = prevCell.value || '';
  const prevFormula = prevCell.formula || '';
  const prevStyle = normalizeStyle(prevCell.style);

  if (currentVal !== prevVal || currentFormula !== prevFormula) return true;

  const keys = ['bold', 'italic', 'color', 'strikethrough', 'textColor', 'border', 'align', 'link', 'verticalAlign'];
  for (const k of keys) {
    if ((currentStyle[k] || '') !== (prevStyle[k] || '')) {
      return true;
    }
  }

  return false;
};

/**
 * Helper to check if a row has any cell changes in history mode.
 */
const isRowEdited = (r, sheetName) => {
  const cols = getColCount(sheetName);
  for (let c = 0; c < cols; c++) {
    const colLetter = getColLetter(c);
    const cellId = `${colLetter}${r}`;
    if (isCellChanged(cellId, sheetName)) {
      return true;
    }
  }
  return false;
};

// Width of a single grid column in px (must match the grid-template-columns rule).
const COLUMN_WIDTH = 100;

/**
 * Recomputing a row's overflow spill is expensive: it reads scrollWidth/clientWidth,
 * which forces a synchronous layout (reflow). Multi-cell formatting (fill colour,
 * borders, …) updates many cells in the same row, and doing a whole-row recompute
 * per cell turns that into O(cells × cols) forced reflows — the source of the lag
 * tracked in issue #73.
 *
 * Instead, callers schedule the affected row here; rows are de-duplicated and the
 * recompute runs once on the next microtask (see flushPendingOverflow, which itself
 * batches its reads and writes so the whole flush costs one reflow, not one per
 * cell — #92). A microtask still flushes before the browser paints, so the result
 * is visually synchronous, and computing overflow only after the whole batch has
 * mutated the DOM is also more correct (neighbours are all in their final state).
 */
// id → cell element for the cells built by the current renderSpreadsheetGrid.
// Targeted updates (updateGridDOMCell, the overflow flush, the border ring) look
// a cell up here in O(1) instead of running a full-document
// `document.querySelector('[data-cell-id]')`, which made a multi-cell border /
// format apply quadratic — O(updated-cells × DOM-nodes), the same per-cell scan
// that froze borders-heavy *loads* before #88, still left on the interactive
// path. Rebuilt wholesale by each full render; targeted updates mutate cells in
// place, so the cached element references stay live until the next full render.
let gridCellIndex = new Map();
const getCellEl = (cellId) =>
  gridCellIndex.get(cellId) || document.querySelector(`[data-cell-id="${cellId}"]`);

// Row/column header element indexes, populated by the same render that builds
// gridCellIndex. The selection highlighter touches a header per row and per
// column on every drag tick; an O(1) lookup keeps that off the full-document
// querySelector path (see #96), matching getCellEl for the cell grid.
let gridRowHeaderIndex = new Map();
let gridColHeaderIndex = new Map();
const getRowHeaderEl = (row) =>
  gridRowHeaderIndex.get(row) || document.querySelector(`[data-row-id="${row}"]`);
const getColHeaderEl = (colLetter) =>
  gridColHeaderIndex.get(colLetter) || document.querySelector(`[data-col-id="${colLetter}"]`);

// --- Grid geometry: prefix offsets in #grid-root's own layout space ---------
// colLeft(colIndex) / rowTop(row) return the left / top edge of a track measured
// from #grid-root's origin, the same coordinate space its cell children and the
// selection overlay live in — so CSS `zoom` on #grid-root scales them along with
// the grid, and they need no rendered cell box to measure from. That makes them
// correct even when the target track isn't in the DOM (a hidden column, or a
// future windowed render that only materialises the visible rows). Callers here
// sum a bounded range, so a direct cumulative sum is enough; a later step can
// back these with a cached prefix-sum array + binary search for scroll hot-paths.

/** Left edge (px) of column `colIndex` (0-based): gutter + widths before it.
 *  Hidden columns contribute 0 (see getColWidth), so they collapse out. */
const colLeft = (colIndex) => {
  let x = GUTTER_WIDTH;
  for (let c = 0; c < colIndex; c++) x += getColWidth(getColLetter(c));
  return x;
};

/** Rendered height (px) of a row: the live row-header box when that row is in the
 *  DOM (so a content-auto-grown row measures at its true height), else the model
 *  height. The model fallback keeps geometry correct for rows a windowed render
 *  hasn't built. */
const resolvedRowHeight = (row) => {
  const rh = getRowHeaderEl(row);
  const h = rh && rh.offsetHeight;
  return (typeof h === 'number' && h > 0) ? h : getRowHeight(row);
};

/** Top edge (px) of row `row` (1-based): the column-header band (the first grid
 *  track, 21px per the base template) plus the rendered heights of the rows above. */
const rowTop = (row) => {
  let y = DEFAULT_ROW_HEIGHT;
  for (let r = 1; r < row; r++) y += resolvedRowHeight(r);
  return y;
};

const pendingOverflowRows = new Set();
let overflowFlushScheduled = false;
const flushPendingOverflow = () => {
  overflowFlushScheduled = false;
  const rows = Array.from(pendingOverflowRows);
  pendingOverflowRows.clear();
  if (isHistoryMode) return;
  const cols = getColCount();
  // Re-evaluate spill for every cell across the pending rows (a cleared/edited cell
  // can change whether its row-mates spill, so the whole row is reconsidered).
  const candidates = [];
  rows.forEach(row => {
    for (let c = 0; c < cols; c++) {
      const id = `${getColLetter(c)}${row}`;
      const el = getCellEl(id);
      if (el && typeof el.scrollWidth === 'number') candidates.push([id, el]);
    }
  });
  // Split into read/write phases to avoid layout thrashing. The old per-cell loop
  // interleaved the clipPath/zIndex resets (writes) with the scrollWidth read, so
  // each cell forced a fresh full reflow of the non-virtualised 1000-row grid —
  // ~3ms apiece, ~400ms for a multi-row "clear formatting" (#92). This is the same
  // thrash #88 fixed on the render path; the interactive flush had been left on the
  // slow path. Phase 1 (writes): clear any prior spill so stale clips don't linger.
  candidates.forEach(([, el]) => { el.style.clipPath = ''; el.style.zIndex = ''; });
  // Phase 2 (reads): a SINGLE batched reflow resolves layout for the whole set.
  // wrap/clip cells never spill, so they're filtered out here (a non-geometry read).
  const overflowing = candidates.filter(([id, el]) => {
    const wrapMode = localCells[id] && localCells[id].style && localCells[id].style.textWrap;
    if (wrapMode === 'wrap' || wrapMode === 'clip') return false;
    return el.scrollWidth > el.clientWidth + 1;
  });
  // Phase 3 (writes): pure writes + non-geometry reads, so no further reflow.
  overflowing.forEach(([id, el]) => applyCellSpill(el, id));
};
const scheduleRowOverflow = (row) => {
  pendingOverflowRows.add(row);
  if (!overflowFlushScheduled) {
    overflowFlushScheduled = true;
    queueMicrotask(flushPendingOverflow);
  }
};

/**
 * Writes the spill styling for a cell already known to overflow: extends its clip
 * region across the consecutive empty neighbours and lifts it above their
 * backgrounds. Pure writes + non-geometry reads (getCellValue), no layout reads —
 * so a batch of these can run after a single batched geometry read without
 * thrashing (see the render pass / #88).
 * @param {HTMLElement} cellEl
 * @param {string} cellId
 */
const applyCellSpill = (cellEl, cellId) => {
  const coord = parseCellCoord(cellId);
  if (!coord) return;

  const align = (localCells[cellId] && localCells[cellId].style && localCells[cellId].style.align) || 'left';
  const spillRight = align !== 'right';            // left & centre spill right
  const spillLeft = align === 'right' || align === 'center'; // right & centre spill left

  // Count consecutive empty neighbours available for the text to spill over.
  let rightCols = 0;
  if (spillRight) {
    const cols = getColCount();
    for (let c = coord.colIndex + 1; c < cols; c++) {
      if (getCellValue(`${getColLetter(c)}${coord.row}`) !== '') break;
      rightCols++;
    }
  }
  let leftCols = 0;
  if (spillLeft) {
    for (let c = coord.colIndex - 1; c >= 0; c--) {
      if (getCellValue(`${getColLetter(c)}${coord.row}`) !== '') break;
      leftCols++;
    }
  }

  if (rightCols === 0 && leftCols === 0) return; // No room; neighbour clips it.

  // Expand the visible (clip) region across the empty run and lift the cell above
  // the neighbours' backgrounds so the overflowing text is shown, not obscured.
  // A few px of vertical slack keeps child cursor/presence borders (inset -1px)
  // from being clipped.
  cellEl.style.clipPath = `inset(-3px ${-(rightCols * COLUMN_WIDTH)}px -3px ${-(leftCols * COLUMN_WIDTH)}px)`;
  cellEl.style.zIndex = '1';
};

// Cell mouse interactions are handled by ONE delegated listener per event type on
// #grid-root rather than four listeners on every cell. A full render builds
// TOTAL_ROWS × colCount cells; per-cell listeners meant ~100k addEventListener
// calls (and as many retained closures) on every rebuild — a large, repeated
// allocation/GC cost. Delegation resolves the target cell from the event's
// bubble path, so the listener count is constant regardless of grid size.
let gridCellDelegationBound = false;
// Last cell the delegated mouseover acted on, so a drag re-entering the same cell
// (e.g. moving across its child <a>/border overlays) doesn't re-run the handler.
let delegatedHoverCellId = null;

const cellElFromEvent = (e) => {
  const t = e.target;
  return (t && typeof t.closest === 'function') ? t.closest('[data-cell-id]') : null;
};

/** The current selection's bounds (merge-expanded, matching the visible
 *  overlay), or null when nothing is selected. */
const currentSelectionRange = () => {
  const startId = selectionStartCellId || activeCellId;
  if (!startId) return null;
  const start = parseCellCoord(startId);
  const end = parseCellCoord(selectionEndCellId || startId);
  if (!start || !end) return null;
  return expandRangeForMerges(
    Math.min(start.row, end.row), Math.max(start.row, end.row),
    Math.min(start.colIndex, end.colIndex), Math.max(start.colIndex, end.colIndex),
  );
};

/** mousedown on the selection's fill handle: start an axis-locked extend drag.
 *  The base range is frozen here; mouseover then grows it toward the pointer. */
const beginFillHandleDrag = (e) => {
  const range = currentSelectionRange();
  if (!range) return;
  e.preventDefault(); // keep focus where it is; no text selection during the drag
  isFillDragging = true;
  fillDragBaseRange = range;
  document.body.classList.add('fill-dragging');
};

/** Extends the selection from the fill-drag base range toward `cellId`, along
 *  the dominant axis only (ties prefer vertical, the common fill-down case).
 *  A pointer inside the base range restores the original selection. */
const extendFillDrag = (cellId) => {
  const c = parseCellCoord(cellId);
  const b = fillDragBaseRange;
  if (!c || !b) return;
  const beyondCols = c.colIndex > b.maxCol ? c.colIndex - b.maxCol : (c.colIndex < b.minCol ? b.minCol - c.colIndex : 0);
  const beyondRows = c.row > b.maxRow ? c.row - b.maxRow : (c.row < b.minRow ? b.minRow - c.row : 0);
  let { minRow, maxRow, minCol, maxCol } = b;
  if (beyondRows >= beyondCols && beyondRows > 0) {
    if (c.row > b.maxRow) maxRow = c.row; else minRow = c.row;
  } else if (beyondCols > 0) {
    if (c.colIndex > b.maxCol) maxCol = c.colIndex; else minCol = c.colIndex;
  }
  // Re-anchor the range corners; activeCellId is untouched, so the thick
  // border stays on the cell the user originally selected.
  selectionStartCellId = `${getColLetter(minCol)}${minRow}`;
  selectionEndCellId = `${getColLetter(maxCol)}${maxRow}`;
  updateRangeSelectionUI();
};

/**
 * Rewrites the cell references inside a formula for a fill copy that lands
 * `rowOffset` rows and `colOffset` columns away from its source, spreadsheet
 * style: relative reference axes shift with the copy (C1's "=A1+B1" filled
 * down to C2 becomes "=A2+B2"), "$"-pinned axes stay put, and a reference
 * pushed above row 1 or left of column A becomes #REF! (mirroring the
 * structural-delete rewriters). String literals and function names are left
 * untouched — same tokenizer as adjustFormulaRefs.
 * @param {string} formula - Formula text (starting with '=').
 * @param {number} rowOffset - Rows from source cell to target cell.
 * @param {number} colOffset - Columns from source cell to target cell.
 * @returns {string} The adjusted formula.
 */
const shiftFormulaRefsForFill = (formula, rowOffset, colOffset) => {
  if (typeof formula !== 'string' || formula[0] !== '=' || (rowOffset === 0 && colOffset === 0)) return formula;
  const isAlpha = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  const isDigit = (c) => c >= '0' && c <= '9';
  let out = '=';
  let i = 1;
  const n = formula.length;
  while (i < n) {
    const c = formula[i];
    if (c === '"') { // copy a string literal verbatim ("" escapes a quote)
      out += c; i++;
      while (i < n) { out += formula[i]; if (formula[i] === '"') { if (formula[i + 1] === '"') { out += formula[i + 1]; i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (c === '$' || isAlpha(c)) {
      let k = i, run = '';
      while (k < n && (isAlpha(formula[k]) || isDigit(formula[k]) || formula[k] === '$' || formula[k] === '.')) { run += formula[k]; k++; }
      let m = k; while (m < n && formula[m] === ' ') m++;
      const isFunc = formula[m] === '(';
      const prevCh = formula[i - 1];
      const afterDigit = prevCh && isDigit(prevCh); // avoid mis-reading e.g. 1E5
      const ref = (!isFunc && !afterDigit) ? run.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/) : null;
      if (ref) {
        const colLetters = ref[2].toUpperCase();
        let colIdx = 0;
        for (let q = 0; q < colLetters.length; q++) colIdx = colIdx * 26 + (colLetters.charCodeAt(q) - 64);
        colIdx -= 1;
        let rowNum = parseInt(ref[4], 10);
        if (ref[1] !== '$') colIdx += colOffset;
        if (ref[3] !== '$') rowNum += rowOffset;
        out += (colIdx < 0 || rowNum < 1) ? '#REF!' : (ref[1] + getColLetter(colIdx) + ref[3] + rowNum);
      } else {
        out += run;
      }
      i = k;
      continue;
    }
    out += c; i++;
  }
  return out;
};

/** Completes a fill drag on mouseup: tiles the base range's cells into the
 *  extension the drag selected, as one undoable action. Values and styles are
 *  copied; a formula is copied with its relative references shifted by the
 *  copy offset (spreadsheet fill semantics) and re-evaluated in the target
 *  cell. No-op when the drag never left the base range. */
const applyFillDrag = () => {
  const b = fillDragBaseRange;
  const sel = currentSelectionRange();
  if (!b || !sel) return;
  if (sel.minRow === b.minRow && sel.maxRow === b.maxRow &&
      sel.minCol === b.minCol && sel.maxCol === b.maxCol) return;

  const height = b.maxRow - b.minRow + 1;
  const width = b.maxCol - b.minCol + 1;
  const historyChanges = [];
  for (let r = sel.minRow; r <= sel.maxRow; r++) {
    for (let c = sel.minCol; c <= sel.maxCol; c++) {
      if (r >= b.minRow && r <= b.maxRow && c >= b.minCol && c <= b.maxCol) continue; // base cell, not a target
      // Tile the base pattern across the extension. The double modulo keeps the
      // tiling aligned in both directions: the row just below the base repeats
      // the base's first row, the row just above it repeats the base's last row
      // (and likewise for columns).
      const srcRow = b.minRow + (((r - b.minRow) % height) + height) % height;
      const srcCol = b.minCol + (((c - b.minCol) % width) + width) % width;
      const src = localCells[`${getColLetter(srcCol)}${srcRow}`] || { formula: '', value: '', style: {} };
      const targetId = `${getColLetter(c)}${r}`;

      const before = localCells[targetId] ? JSON.parse(JSON.stringify(localCells[targetId])) : { formula: '', value: '', style: {} };
      const srcFormula = src.formula || '';
      const formula = srcFormula ? shiftFormulaRefsForFill(srcFormula, r - srcRow, c - srcCol) : '';
      const after = {
        formula,
        value: src.value || '',
        style: src.style ? JSON.parse(JSON.stringify(src.style)) : {}
      };
      localCells[targetId] = after;
      // The shifted formula's result differs from the source's, so re-evaluate
      // it in the target cell before it is recorded/broadcast.
      if (formula) {
        if (formulaIsSupported(formula)) {
          after.value = evaluateFormula(formula, 0, targetId);
        } else if (formula !== srcFormula || !after.value) {
          // The engine can't compute this formula, and the shift changed its
          // references, so the copied cached value no longer applies. A
          // reference the shift killed displays as #REF! (the rewritten
          // formula itself no longer parses); otherwise show the engine's
          // error result.
          after.value = formula.indexOf('#REF!') !== -1 ? '#REF!' : evaluateFormula(formula, 0, targetId);
        }
        // An unchanged engine-unsupported formula keeps the copied cached
        // value — the same imported-result protection recalculateSheet applies.
      }
      historyChanges.push({ cellId: targetId, before, after: JSON.parse(JSON.stringify(after)) });

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'cell-edit',
          payload: { cellId: targetId, formula: after.formula, value: after.value, style: after.style }
        }));
      }
      updateGridDOMCell(targetId, getCellValue(targetId), after.style);
    }
  }

  if (historyChanges.length > 0) {
    recordHistoryAction({ type: 'multi', changes: historyChanges });
    recalculateSheet();
    // Filled cells can grow row heights (e.g. a larger source font); re-measure
    // so the overlay and its fill handle track the new geometry — same reason
    // paste does this.
    updateRangeSelectionUI();
  }
};

// mousedown: begin range selection, or pick a reference in formula-point mode.
const onGridCellMouseDown = (e) => {
  if (isHistoryMode) return; // Disable selection in history mode
  if (e.button !== 0) return; // Only trigger selection on left mouse click
  // The fill handle sits inside the (pointer-events:none) selection overlay, so
  // a mousedown targeting it can only be the dot itself. It starts an extend
  // drag instead of a new selection — except in formula point mode, where the
  // grid is a reference picker and the dot is inert.
  const t = e.target;
  if (t && t.classList && typeof t.classList.contains === 'function' && t.classList.contains('fill-handle')
      && t.closest && t.closest('#selection-range-overlay')) {
    if (!formulaPickCapable()) beginFillHandleDrag(e);
    return;
  }
  const cellEl = cellElFromEvent(e);
  if (!cellEl) return;
  const cellId = cellEl.getAttribute('data-cell-id');
  // Formula point mode: while editing a formula that expects a reference,
  // clicking a cell picks it into the formula instead of moving selection.
  // preventDefault keeps the formula editor focused (no blur / commit).
  if (formulaPickCapable()) {
    e.preventDefault();
    e.stopPropagation();
    beginFormulaPick(cellId);
    return;
  }
  isSelecting = true;
  isColumnSelection = false; // a cell click is never a full-column/row selection
  isRowSelection = false;
  extraSelectionRanges = [];
  selectionStartCellId = cellId;
  selectionEndCellId = cellId;
  handleCellSelect(cellId, cellEl);
};

// mouseover (delegated stand-in for per-cell mouseenter, which doesn't bubble):
// extend a range-selection or formula-pick drag as the cursor crosses cells.
const onGridCellMouseOver = (e) => {
  if (isHistoryMode) return; // Disable selection in history mode
  if (!fpActive && !isSelecting && !isFillDragging) { delegatedHoverCellId = null; return; }
  const cellEl = cellElFromEvent(e);
  if (!cellEl) return;
  const cellId = cellEl.getAttribute('data-cell-id');
  if (cellId === delegatedHoverCellId) return; // same cell, nothing changed
  delegatedHoverCellId = cellId;
  if (fpActive) { extendFormulaPick(cellId); return; } // formula range drag
  if (isFillDragging) { extendFillDrag(cellId); return; } // fill-handle axis-locked extend
  if (isSelecting) {
    selectionEndCellId = cellId;
    updateRangeSelectionUI();
  }
};

// click: a linked cell shows a chip (favicon · URL · copy/edit/remove) instead of
// navigating immediately. preventDefault cancels the anchor's default navigation;
// selection still happens via the mousedown handler.
const onGridCellClick = (e) => {
  if (isHistoryMode) return;
  if (formulaPickCapable() || fpActive) return; // don't interrupt reference picking
  const cellEl = cellElFromEvent(e);
  if (!cellEl) return;
  const cellId = cellEl.getAttribute('data-cell-id');
  const cd = localCells[cellId];
  if (cd && cd.style && cd.style.link) {
    e.preventDefault();
    showLinkPopup(cellId, cellEl);
  }
};

// dblclick: enter inline edit on the cell.
const onGridCellDblClick = (e) => {
  if (isHistoryMode) return; // Disable editing in history mode
  const cellEl = cellElFromEvent(e);
  if (!cellEl) return;
  handleCellInlineEdit(cellEl.getAttribute('data-cell-id'), cellEl);
};

// Bind the delegated cell listeners once. #grid-root persists across renders
// (renderSpreadsheetGrid only replaces its children), so these survive rebuilds.
const ensureGridCellDelegation = (gridRoot) => {
  if (gridCellDelegationBound) return;
  gridRoot.addEventListener('mousedown', onGridCellMouseDown);
  gridRoot.addEventListener('mouseover', onGridCellMouseOver);
  gridRoot.addEventListener('click', onGridCellClick);
  gridRoot.addEventListener('dblclick', onGridCellDblClick);
  gridCellDelegationBound = true;
};

// ---------------------------------------------------------------------------
// Windowed (virtualized) grid rendering.
//
// A full render materialises TOTAL_ROWS × colCount cells as DOM nodes (~65k on a
// typical sheet), which dominates the tab's memory. Windowing renders only the
// rows in and near the viewport, relying on the explicit per-row
// grid-template-rows (see applyGridTemplate) to hold the full scroll height with
// no cell in the off-screen tracks. On by default, with an escape hatch — disable
// it (e.g. if a sheet renders wrong) without a deploy via
//   localStorage.setItem('cosheet:windowing','0')   // then reload; '1' re-enables
// It automatically falls back to the full render for the cases it can't window
// yet — history mode and sheets with wrapped-text rows, whose height isn't
// modelled — so those render exactly as before. Merges are windowed.
// ---------------------------------------------------------------------------
let windowingEnabled = true;
try {
  const pref = localStorage.getItem('cosheet:windowing');
  if (pref === '0') windowingEnabled = false;
  else if (pref === '1') windowingEnabled = true;
} catch { /* storage blocked — keep the default */ }

// Extra rows rendered above/below the viewport so a small scroll neither exposes a
// blank edge nor forces a re-render.
const WINDOW_OVERSCAN = 8;

// Set by each render: whether the active sheet is currently windowed, and the row
// span it last rendered, so the scroll handler rebuilds only when the visible
// window moves to a new span (and never for a non-windowed sheet).
let activeSheetWindowed = false;
let lastRenderedRowWindow = '';

/** Whether the active sheet has any wrapped-text cell. A wrapped row's height
 *  depends on text layout (content x column width x font), which the model can't
 *  compute without measuring, so computeRowWindow's scroll->row mapping would be
 *  wrong; such sheets fall back to the full render. Font-driven growth, by
 *  contrast, is modelled deterministically (see rebuildAutoFontRowHeights). */
const sheetHasWrappedRows = () => {
  const cells = localSheets[activeSheetName];
  if (!cells) return false;
  for (const id in cells) {
    const st = cells[id] && cells[id].style;
    if (st && st.textWrap === 'wrap') return true;
  }
  return false;
};

/** Whether this render should window its rows. Merges are supported (the render
 *  force-includes anchor rows whose span reaches into the window); only wrapped
 *  text — whose row height isn't modelled — still forces the full render. */
const shouldWindowRows = () =>
  windowingEnabled && !isHistoryMode && !sheetHasWrappedRows();

/** The 1-based [start,end] row range visible in the viewport, grown by the
 *  overscan, derived from scrollTop and the model row heights. */
const computeRowWindow = () => {
  const viewport = document.getElementById('grid-viewport');
  if (!viewport) return { start: 1, end: TOTAL_ROWS };
  const top = viewport.scrollTop;
  const bottom = top + viewport.clientHeight;
  let y = DEFAULT_ROW_HEIGHT; // top of row 1, below the header band
  let start = 1, end = TOTAL_ROWS;
  for (let r = 1; r <= TOTAL_ROWS; r++) {
    const h = getRowHeight(r);
    if (y + h <= top) start = r + 1;               // row is fully above the viewport
    else if (y >= bottom) { end = r - 1; break; }  // first row fully below the viewport
    y += h;
  }
  start = Math.max(1, start - WINDOW_OVERSCAN);
  end = Math.min(TOTAL_ROWS, Math.max(start, end + WINDOW_OVERSCAN));
  return { start, end };
};

/** Scroll the grid viewport so `cellId` is within the visible band, using model
 *  geometry (colLeft / rowTop) so it works whether or not the cell is currently
 *  rendered — the reveal a windowed render needs when the selection jumps to an
 *  off-screen cell (Enter past the fold, a find match, …). Scrolls an axis only
 *  when the cell falls outside the band on that axis; the scroll then drives the
 *  windowed re-render via onGridScrollWindow. */
const revealCell = (cellId) => {
  const viewport = document.getElementById('grid-viewport');
  const coord = parseCellCoord(cellId);
  if (!viewport || !coord) return;
  // Vertical: the sticky column-header band covers the viewport's top edge, so the
  // scrollable content band starts DEFAULT_ROW_HEIGHT below scrollTop.
  const rTop = rowTop(coord.row);
  const rBottom = rTop + getRowHeight(coord.row);
  if (rTop < viewport.scrollTop + DEFAULT_ROW_HEIGHT) {
    viewport.scrollTop = Math.max(0, rTop - DEFAULT_ROW_HEIGHT);
  } else if (rBottom > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = rBottom - viewport.clientHeight;
  }
  // Horizontal: the sticky row gutter covers the left edge.
  const cLeft = colLeft(coord.colIndex);
  const cRight = cLeft + getColWidth(getColLetter(coord.colIndex));
  if (cLeft < viewport.scrollLeft + GUTTER_WIDTH) {
    viewport.scrollLeft = Math.max(0, cLeft - GUTTER_WIDTH);
  } else if (cRight > viewport.scrollLeft + viewport.clientWidth) {
    viewport.scrollLeft = cRight - viewport.clientWidth;
  }
};

// rAF-throttled scroll response: when the visible row window moves, rebuild the
// grid (now only the windowed rows). Cheap-exits for a non-windowed sheet.
let windowRenderScheduled = false;
const onGridScrollWindow = () => {
  if (!activeSheetWindowed || windowRenderScheduled) return;
  windowRenderScheduled = true;
  requestAnimationFrame(() => {
    windowRenderScheduled = false;
    if (!activeSheetWindowed) return;
    const w = computeRowWindow();
    if (`${w.start}:${w.end}` !== lastRenderedRowWindow) renderSpreadsheetGrid();
  });
};

/**
 * Dynamically builds and renders the interactive spreadsheet grid inside the DOM.
 */
const renderSpreadsheetGrid = () => {
  const gridRoot = document.getElementById('grid-root');
  if (!gridRoot) return;
  ensureGridCellDelegation(gridRoot);

  // Fresh header indexes for this render — reset before the headers below are
  // built (the column headers are created further down) so getRowHeaderEl /
  // getColHeaderEl resolve against this render's elements. The cell index is
  // reset just before the cell loop. See #96.
  gridRowHeaderIndex = new Map();
  gridColHeaderIndex = new Map();

  // Column count for this render — grows past A-Z as data extends rightward.
  const colCount = getColCount();

  // Merge coverage for this render. When the active sheet has merged cells we
  // switch the grid from auto-flow to explicit line placement so anchors can
  // span multiple tracks and their covered cells can be hidden without throwing
  // off the placement of everything after them. The common (no-merge) case keeps
  // pure auto-flow and is untouched. Skipped in history mode, whose collapsed
  // "unedited" bars break the 1-row-per-track mapping merges rely on.
  const mergeCoverage = isHistoryMode
    ? { anchorSpan: new Map(), coveredTo: new Map(), hasMerges: false }
    : getMergeCoverage();
  const { anchorSpan, coveredTo, hasMerges } = mergeCoverage;

  // Windowing: when active, only rows in (and near) the viewport are built, and
  // every header/cell is placed on explicit grid lines so a rendered row lands on
  // its true track despite the skipped rows before it. The frozen band and the
  // active cell's row are always kept so freeze and cell editing keep working.
  // Recorded on module state so the scroll handler knows the current window.
  // With windowing enabled, refresh font-driven row heights first so getRowHeight
  // (used by the window math and the row template) is authoritative for large-font
  // rows. Skipped when the flag is off: the empty map leaves getRowHeight at the
  // default, and the row template's minmax(21px, auto) + the cell's min-height
  // reproduce the old height — so the default path pays nothing.
  if (windowingEnabled) rebuildAutoFontRowHeights();
  const windowActive = shouldWindowRows();
  activeSheetWindowed = windowActive;
  const rowWin = windowActive ? computeRowWindow() : null;
  lastRenderedRowWindow = windowActive ? `${rowWin.start}:${rowWin.end}` : '';
  const frozenRowFloor = windowActive ? (frozenRows || 0) : 0;
  const activeRowKept = windowActive && activeCellId ? (parseCellCoord(activeCellId)?.row || 0) : 0;
  // A merge anchor above the window whose span reaches into it must still be built,
  // or the merge's visible portion (and the content its covered cells defer to)
  // would be blank. Collect those anchor rows so the row loop keeps them.
  const extraMergeRows = new Set();
  if (windowActive && hasMerges) {
    for (const [anchorId, sp] of anchorSpan) {
      const ac = parseCellCoord(anchorId);
      if (ac && ac.row < rowWin.start && ac.row + sp.rows - 1 >= rowWin.start) extraMergeRows.add(ac.row);
    }
  }
  const inRowWindow = (r) =>
    !windowActive || (r >= rowWin.start && r <= rowWin.end) ||
    r <= frozenRowFloor || r === activeRowKept || extraMergeRows.has(r);
  // Explicit line placement is used for merges (anchors span tracks) and whenever
  // windowing is on (rows are sparse, so auto-flow would pack them at the top).
  const useExplicitPlacement = hasMerges || windowActive;

  // Preserve the sticky top-left corner header
  gridRoot.innerHTML = '<div class="grid-header sticky top-0 left-0 z-30"></div>';
  if (useExplicitPlacement) {
    const corner = gridRoot.firstElementChild;
    if (corner) { corner.style.gridColumn = '1'; corner.style.gridRow = '1'; }
  }

  // Column letters for this render, computed once. getColLetter walks a base-26
  // loop building a string; resolving it here avoids recomputing the same value
  // TOTAL_ROWS times per column inside the cell loop below.
  const colLetters = new Array(colCount);
  for (let c = 0; c < colCount; c++) colLetters[c] = getColLetter(c);

  // Hidden columns for this render (see getColWidth: their track collapses to
  // 0px). Resolved once so the header/cell loops can O(1)-check membership.
  // Ignored in history mode, which previews the snapshot as-is.
  const hiddenColLetters = isHistoryMode ? new Set() : new Set(getHiddenCols());

  // Build the whole grid (headers, rows, cells, buffer) into a detached fragment
  // and attach it in one append at the end, so the browser lays out / reflows
  // once for the entire grid instead of after each of the ~tens-of-thousands of
  // element insertions a live-tree append would trigger.
  const frag = document.createDocumentFragment();

  // Render Column Headers (A-Z and beyond as the grid grows)
  for (let c = 0; c < colCount; c++) {
    const colLetter = colLetters[c];
    // A hidden column still renders a header, but on a zero-width track (see
    // getColWidth), so it is invisible; it gets no menu button, resize handle or
    // unhide arrows — those live on the visible neighbours.
    const colIsHidden = hiddenColLetters.has(colLetter);
    const colHeader = document.createElement('div');
    // No cursor-pointer: headers keep the arrow cursor like Google Sheets even
    // though clicking selects the column (the menu button keeps its own finger).
    colHeader.className = 'grid-header sticky top-0 z-20';
    if (colIsHidden) colHeader.classList.add('col-hidden');
    colHeader.innerText = colLetter;
    // With explicit placement on, pin each header to its column/header track.
    if (useExplicitPlacement) { colHeader.style.gridColumn = `${c + 2}`; colHeader.style.gridRow = '1'; }
    // Store column identifier for selection highlighting
    colHeader.setAttribute('data-col-id', colLetter);
    gridColHeaderIndex.set(colLetter, colHeader);
    // Clicking a column header selects the entire column: the cells fill with
    // the selection colour, the active anchor is the top cell, and the header
    // is highlighted in solid blue. Shift+click selects the whole span of
    // columns from the anchor to this one; Ctrl/Cmd+click keeps the current
    // selection and adds this column to it.
    colHeader.addEventListener('mousedown', (e) => {
      if (isHistoryMode) return;
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.shiftKey && (selectionStartCellId || activeCellId)) {
        extendSelectionToColumn(colLetter);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && selectionStartCellId) {
        extraSelectionRanges.push({
          startId: selectionStartCellId,
          endId: selectionEndCellId || selectionStartCellId,
        });
      } else {
        extraSelectionRanges = [];
      }
      selectColumn(colLetter);
    });

    if (!colIsHidden) {
      // Dropdown button shown on hover at the far right of the header. Clicking
      // it selects the whole column and opens the column-specific menu (see
      // showColumnMenu / images/column_header_menu.png), anchored to the column.
      // It auto-hides 0.2s after the cursor leaves the header.
      const menuBtn = document.createElement('span');
      menuBtn.className = 'col-header-menu material-symbols-outlined';
      menuBtn.textContent = 'arrow_drop_down';
      let hideTimer = null;
      colHeader.addEventListener('mouseenter', () => {
        if (isHistoryMode) return;
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        menuBtn.classList.add('show');
      });
      colHeader.addEventListener('mouseleave', () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { menuBtn.classList.remove('show'); hideTimer = null; }, 200);
      });
      // Swallow the header's column-select mousedown so the button click is clean.
      menuBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      menuBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isHistoryMode) return;
        extraSelectionRanges = []; // the menu acts on this column alone
        selectColumn(colLetter);
        const r = menuBtn.getBoundingClientRect();
        showColumnMenu(colLetter, r.left, r.bottom);
      });
      colHeader.appendChild(menuBtn);
    }

    // Drag handle on the column's right boundary. Hovering it shows a col-resize
    // cursor; dragging resizes the whole column (see startDimensionResize).
    if (!isHistoryMode && !colIsHidden) {
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'col-resize-handle';
      resizeHandle.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !canEditWorkbook) return;
        // Swallow the event so the header's column-select mousedown doesn't fire.
        e.preventDefault();
        e.stopPropagation();
        startDimensionResize('col', colLetter, colHeader, e.clientX);
      });
      colHeader.appendChild(resizeHandle);
    }

    // Unhide arrows: a visible header adjacent to a run of hidden columns shows a
    // small arrow on the touching edge (◀ on the right edge when the run is to
    // the right, ▶ on the left edge when the run is to the left). Clicking either
    // reveals the whole run. Suppressed in history mode.
    if (!colIsHidden && !isHistoryMode && hiddenColLetters.size) {
      // ◀ on this header's right edge: the hidden run is to the right, and this
      // very column is the boundary's left visible neighbour, so it resizes here.
      if (c + 1 < colCount && hiddenColLetters.has(colLetters[c + 1])) {
        const run = [];
        for (let k = c + 1; k < colCount && hiddenColLetters.has(colLetters[k]); k++) run.push(colLetters[k]);
        colHeader.appendChild(createUnhideArrow('left', run, colLetter, colHeader));
      }
      // ▶ on this header's left edge: the hidden run is to the left; the column
      // just past it (already built this render) is the boundary's left visible
      // neighbour that a drag resizes. None exists when the run hugs column A.
      if (c - 1 >= 0 && hiddenColLetters.has(colLetters[c - 1])) {
        const run = [];
        for (let k = c - 1; k >= 0 && hiddenColLetters.has(colLetters[k]); k--) run.push(colLetters[k]);
        const leftVisIdx = c - run.length - 1;
        const leftVisLetter = leftVisIdx >= 0 ? colLetters[leftVisIdx] : null;
        const leftVisHeader = leftVisLetter ? gridColHeaderIndex.get(leftVisLetter) : null;
        colHeader.appendChild(createUnhideArrow('right', run, leftVisLetter, leftVisHeader));
      }
    }

    frag.appendChild(colHeader);
  }

  const sheetName = activeSheetName || 'Sheet1';

  // In history mode, pre-calculate which rows are edited to support row collapsing
  const editedRows = new Set();
  if (isHistoryMode) {
    for (let r = 1; r <= TOTAL_ROWS; r++) {
      if (isRowEdited(r, sheetName)) {
        editedRows.add(r);
      }
    }
  }

  const showUneditedChecked = document.getElementById('showUnedited')?.checked ?? false;
  const highlightChangesChecked = document.getElementById('highlightChanges')?.checked ?? false;

  // id → element for every cell built this render, so the post-render passes
  // (text-overflow spill, etc.) and later targeted updates can look a cell up in
  // O(1) instead of running a full-document `document.querySelector('[data-cell-id]')`
  // per cell. With a bordered cell for every entry in localCells, that per-cell
  // DOM scan turned the overflow pass quadratic and was the real cause of
  // multi-second loads on borders-heavy sheets (#88). This render's map replaces
  // the persistent gridCellIndex so updateGridDOMCell / the overflow flush share
  // the same O(1) lookup; a fresh Map drops references to the discarded cells.
  const cellElById = new Map();
  gridCellIndex = cellElById;

  // Render Grid Rows and Cells
  for (let r = 1; r <= TOTAL_ROWS; r++) {
    // Windowing: skip rows outside the visible window (kept frozen/active rows and
    // the overscan aside). Their grid-template-rows tracks still hold the height.
    if (windowActive && !inRowWindow(r)) continue;
    // If we are in history mode, and "show unedited" is not checked, collapse consecutive unedited rows
    if (isHistoryMode && !showUneditedChecked && !editedRows.has(r)) {
      let startRow = r;
      let endRow = r;
      while (endRow + 1 <= TOTAL_ROWS && !editedRows.has(endRow + 1)) {
        endRow++;
      }
      const count = endRow - startRow + 1;

      // Create unedited row bar spanning columns
      const uneditedBar = document.createElement('div');
      uneditedBar.className = 'unedited-row-bar';
      uneditedBar.innerHTML = `
        <div class="unedited-row-gutter"></div>
        <div class="unedited-row-label">有 ${count} 列未修改</div>
      `;
      frag.appendChild(uneditedBar);

      r = endRow; // Skip to the end of collapsed sequence
      continue;
    }

    // Row Header
    const rowNum = r;
    const rowHeader = document.createElement('div');
    // No cursor-pointer: same arrow-cursor rule as the column headers above.
    rowHeader.className = 'grid-header sticky left-0 z-20';
    rowHeader.innerText = r;
    // Store row identifier for selection highlighting
    rowHeader.setAttribute('data-row-id', r);
    gridRowHeaderIndex.set(r, rowHeader);
    // With explicit placement on, pin the row header to the gutter / its row track.
    if (useExplicitPlacement) { rowHeader.style.gridColumn = '1'; rowHeader.style.gridRow = `${r + 1}`; }
    // Clicking a row header selects the entire row: the cells fill with the
    // selection colour, the active anchor is the first cell, and the header is
    // highlighted in solid blue (mirrors the column-header click). Shift+click
    // selects the whole span of rows from the anchor to this one; Ctrl/Cmd+
    // click keeps the current selection and adds this row to it.
    rowHeader.addEventListener('mousedown', (e) => {
      if (isHistoryMode) return;
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.shiftKey && (selectionStartCellId || activeCellId)) {
        extendSelectionToRow(rowNum);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && selectionStartCellId) {
        extraSelectionRanges.push({
          startId: selectionStartCellId,
          endId: selectionEndCellId || selectionStartCellId,
        });
      } else {
        extraSelectionRanges = [];
      }
      selectRow(rowNum);
    });

    // Drag handle on the row's bottom boundary (mirrors the column handle).
    if (!isHistoryMode) {
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'row-resize-handle';
      resizeHandle.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !canEditWorkbook) return;
        e.preventDefault();
        e.stopPropagation();
        startDimensionResize('row', rowNum, rowHeader, e.clientY);
      });
      rowHeader.appendChild(resizeHandle);
    }

    frag.appendChild(rowHeader);

    // Cells for row (A-Z and any grown columns)
    for (let c = 0; c < colCount; c++) {
      const colLetter = colLetters[c];
      const cellId = `${colLetter}${r}`;
      
      const cellData = isHistoryMode
        ? (selectedVersionState?.sheets?.[sheetName]?.[cellId])
        : localCells[cellId];

      const cellEl = document.createElement('div');
      cellEl.className = 'grid-cell text-body-sm font-body-sm select-none cursor-default';
      // Cells in a hidden column sit on a zero-width track; clip their content so
      // it can't paint outside the collapsed box (grid cells overflow visibly by
      // default so long values spill into empty neighbours).
      if (hiddenColLetters.has(colLetter)) cellEl.classList.add('col-hidden');
      cellEl.setAttribute('data-cell-id', cellId);

      // Display evaluated cell value
      const rawVal = isHistoryMode
        ? (cellData?.value || '')
        : getCellValue(cellId);
      const val = formatCellDisplay(rawVal, cellData && cellData.style);

      if (cellData && cellData.style && cellData.style.link) {
        // Fall back to the URL as link text when the cell has no value, so a link
        // inserted into an empty cell is still visible (matches Google Sheets).
        const escapedValue = escapeHtml(val || cellData.style.link);
        const escapedLink = escapeHtml(cellData.style.link);
        cellEl.innerHTML = `<a href="${escapedLink}" target="_blank" class="text-blue-600 underline cursor-pointer hover:text-blue-800">${escapedValue}</a>`;
      } else {
        cellEl.innerText = val;
      }

      // Apply saved cell styles
      if (cellData && cellData.style) {
        if (cellData.style.bold) cellEl.classList.add('font-bold');
        if (cellData.style.italic) cellEl.classList.add('italic');
        if (cellData.style.fontFamily) cellEl.style.fontFamily = resolveFontFamily(cellData.style.fontFamily);
        if (cellData.style.fontSize) {
          cellEl.style.fontSize = `${cellData.style.fontSize}pt`;
          // Grow the row to fit larger fonts (no-op at or below the default size).
          // Only an empty cell's font size is ignored: a blank cell keeps the base
          // row height, and the row grows once text is actually entered.
          const minHeight = val ? getCellMinHeight(cellData.style.fontSize) : null;
          if (minHeight) cellEl.style.minHeight = `${minHeight}px`;
        }
        if (cellData.style.color) cellEl.style.backgroundColor = cellData.style.color;
        if (cellData.style.textColor) cellEl.style.color = cellData.style.textColor;
        const deco = [];
        if (cellData.style.underline) deco.push('underline');
        if (cellData.style.strikethrough) deco.push('line-through');
        if (deco.length) cellEl.style.textDecoration = deco.join(' ');
        // Text wrapping mode: 'wrap' reflows within the cell (rows auto-grow),
        // 'clip' truncates at the cell edge; the default spills across empties.
        if (cellData.style.textWrap === 'wrap') {
          cellEl.style.whiteSpace = 'normal';
          cellEl.style.overflow = 'hidden';
          cellEl.style.wordBreak = 'break-word';
        } else if (cellData.style.textWrap === 'clip') {
          cellEl.style.overflow = 'hidden';
        }
        // Apply vertical alignment style if present
        if (cellData.style.verticalAlign) {
          cellEl.style.justifyContent = cellData.style.verticalAlign === 'top' ? 'flex-start' :
                                        (cellData.style.verticalAlign === 'center' ? 'center' : 'flex-end');
        }
      }

      // Render borders for every cell, even blank ones: an interior boundary
      // line is painted by the cell to its left/top, so a blank cell may still
      // need to draw a bordered neighbour's right/bottom edge.
      applyCellBorders(cellEl, (cellData && cellData.style) || EMPTY_STYLE, cellId);

      // Horizontal alignment: explicit style wins, else numbers right-align
      const cellAlign = resolveCellAlign(rawVal, cellData && cellData.style);
      if (cellAlign) cellEl.style.textAlign = cellAlign;

      // Highlight cell changes in history mode
      if (isHistoryMode && highlightChangesChecked && isCellChanged(cellId, sheetName)) {
        cellEl.classList.add('grid-cell-history-highlight');
      }

      // Cell mouse interactions (mousedown/mouseover/click/dblclick) are handled
      // by delegated listeners on #grid-root — see ensureGridCellDelegation above.

      // Explicit placement: anchors span their block; covered cells are hidden so
      // the anchor shows through; everything else is pinned to its own track so the
      // spans (merges) or skipped rows (windowing) don't shift it.
      if (useExplicitPlacement) {
        if (coveredTo.has(cellId)) {
          cellEl.style.display = 'none';
        } else if (anchorSpan.has(cellId)) {
          const sp = anchorSpan.get(cellId);
          cellEl.style.gridColumn = `${c + 2} / span ${sp.cols}`;
          cellEl.style.gridRow = `${r + 1} / span ${sp.rows}`;
        } else {
          cellEl.style.gridColumn = `${c + 2}`;
          cellEl.style.gridRow = `${r + 1}`;
        }
      }

      frag.appendChild(cellEl);
      cellElById.set(cellId, cellEl);
    }
  }

  // Empty buffer panel below the final row so the last row can scroll fully into
  // view instead of being half-clipped by the horizontal scrollbar / footer.
  // Styled like the header band (#f8f9fa); ~2x a cell's height (see CSS). With
  // explicit placement (merges) we must pin its row track, since it carries no
  // auto-placed cells of its own.
  const bottomBuffer = document.createElement('div');
  bottomBuffer.className = 'grid-bottom-buffer';
  if (useExplicitPlacement) bottomBuffer.style.gridRow = `${TOTAL_ROWS + 2}`;
  frag.appendChild(bottomBuffer);

  // Attach the whole grid in one append (single layout pass — see frag above).
  gridRoot.appendChild(frag);

  // Apply per-sheet column widths / row heights to the freshly built grid.
  applyGridTemplate(gridRoot);

  // Re-apply the selection highlight (cell fill, overlay and header styling)
  // after the grid is rebuilt, so it survives re-renders — including a
  // full-column selection.
  if (selectionStartCellId && !isHistoryMode) {
    updateRangeSelectionUI();
  }

  // After layout, let cells with overflowing text spill across empty neighbours.
  // Only data-bearing cells can overflow, so iterate localCells rather than the
  // whole grid. This pass is split into a read phase then a write phase to avoid
  // layout thrashing: updateCellOverflow both reads geometry (scrollWidth) and
  // writes style (clipPath/zIndex), so calling it in a loop forced a full reflow
  // of the (non-virtualised, 1000-row) grid for every data cell — ~3s for a few
  // hundred cells, the real cause of the borders-heavy-sheet freeze (#88). The
  // freshly built cells carry no stale spill styling, so we can read every
  // candidate's overflow first (one reflow for the batch) and only then write the
  // spill on the few that overflow (writes + getCellValue, no layout reads).
  if (!isHistoryMode) {
    const candidates = [];
    Object.keys(localCells).forEach(id => {
      // Merged anchors already span their block, and covered cells are hidden —
      // neither should spill across neighbours.
      if (hasMerges && (anchorSpan.has(id) || coveredTo.has(id))) return;
      const el = cellElById.get(id); // O(1) lookup, not a per-cell querySelector
      if (!el || typeof el.scrollWidth !== 'number') return;
      const wrapMode = localCells[id].style && localCells[id].style.textWrap;
      if (wrapMode === 'wrap' || wrapMode === 'clip') return;
      candidates.push([id, el]);
    });
    // Read phase: a single reflow resolves layout for the whole batch.
    const overflowing = candidates.filter(([, el]) => el.scrollWidth > el.clientWidth + 1);
    // Write phase: no geometry reads here, so these don't trigger further reflows.
    overflowing.forEach(([id, el]) => applyCellSpill(el, id));
  }

  // Re-apply frozen rows/columns (if any) on the freshly built DOM.
  applyFreeze();

  // Re-apply the active value filter (scope tint, funnel icon, hidden rows) on
  // the freshly built DOM, so it survives re-renders and remote edits.
  window.CoSheet.sortFilter.applyFilter();

  // Keep the toolbar funnel button (icon fill, tint, tooltip) in sync with the
  // active sheet's filter state across re-renders and sheet switches.
  window.CoSheet.sortFilter.updateToolbarButton();

  // Re-apply remote collaborators' cursor/presence tags: the innerHTML rebuild
  // above discarded the borders appended to individual cells, so without this a
  // peer's name tag disappears on every full re-render (e.g. a remote resize or
  // sheet change) until they next move their cursor.
  renderRemoteCursors();

  // Re-apply the armed format painter's dashed source outline, which the
  // rebuild above just discarded.
  refreshPaintFormatSourceOutline();

  // The content height/width just changed; resync the synthetic scrollbars.
  if (gridScrollbarLayout) gridScrollbarLayout();
};

// Darker line drawn along the freeze boundary, matching Google Sheets.
const FREEZE_BORDER = '2px solid #919191';

/**
 * Apply the active sheet's column widths (and any custom row heights) to the grid
 * by writing explicit CSS grid templates. Columns are always written from the
 * per-sheet widths (defaulting to 100px); row heights are only written when the
 * sheet has custom heights — otherwise the base `grid-auto-rows: minmax(21px,auto)`
 * rule is kept so rows still auto-grow with tall content. The row template is
 * skipped in history mode, where collapsed "unedited" bars break the
 * 1-row-per-grid-track mapping; the column template is still written there.
 * @param {HTMLElement} gridRoot
 */
function applyGridTemplate(gridRoot) {
  // Columns: gutter + each column's resolved width. Always written (even in
  // history mode) so a sheet grown past A-Z gets enough tracks for every column
  // — the base CSS only defines 26.
  const colCount = getColCount();
  const cols = [`${GUTTER_WIDTH}px`];
  for (let c = 0; c < colCount; c++) cols.push(`${getColWidth(getColLetter(c))}px`);
  gridRoot.style.gridTemplateColumns = cols.join(' ');

  // Rows are skipped in history mode, where collapsed "unedited" bars break the
  // 1-row-per-grid-track mapping.
  if (isHistoryMode) {
    gridRoot.style.gridTemplateRows = '';
    return;
  }
  // Rows: emit an explicit track for the header band + every row, so each row has
  // a defined height even when no cell occupies its track. That is the invariant a
  // windowed render relies on — an off-screen row keeps its height with no cell to
  // auto-size it. A resized row is a fixed track; otherwise the floor is
  // getRowHeight (default 21, or a font-driven auto height), with `auto` still
  // letting a rendered row grow. Behaviour-neutral for the full render: a rendered
  // font-grown row reaches the same height via its cell's min-height. The header
  // band is the first track.
  const rows = ['minmax(21px, auto)'];
  const m = rowHeights[activeSheetName];
  for (let r = 1; r <= TOTAL_ROWS; r++) {
    const h = m && m[r];
    rows.push((typeof h === 'number' && isFinite(h)) ? `${h}px` : `minmax(${getRowHeight(r)}px, auto)`);
  }
  gridRoot.style.gridTemplateRows = rows.join(' ');
}

// Active drag-resize state ({ dimension, key, headerEl, start, startSize, guide,
// onMove, onUp }) or null when no resize is in progress.
let dimensionResize = null;

/**
 * Begin a column-width / row-height drag from a header boundary handle. Shows a
 * blue guide line that tracks the cursor; on release the new size is applied
 * locally and broadcast (resize). Google-Sheets-style: the grid itself only
 * reflows on commit, not during the drag.
 * @param {'col'|'row'} dimension
 * @param {string|number} key - column letter or row number being resized.
 * @param {HTMLElement} headerEl - the header element for that column/row.
 * @param {number} clientStart - clientX (col) or clientY (row) at mousedown.
 */
function startDimensionResize(dimension, key, headerEl, clientStart) {
  const gridRoot = document.getElementById('grid-root');
  if (!gridRoot || dimensionResize) return;

  const isCol = dimension === 'col';
  const startSize = isCol ? headerEl.offsetWidth : headerEl.offsetHeight;
  // Offset of the boundary (right/bottom edge of the header) within #grid-root.
  const boundaryStart = isCol
    ? headerEl.offsetLeft + headerEl.offsetWidth
    : headerEl.offsetTop + headerEl.offsetHeight;

  // The guide line spans the full grid extent along the cross axis.
  const guide = document.createElement('div');
  guide.className = `grid-resize-guide ${isCol ? 'vertical' : 'horizontal'}`;
  if (isCol) {
    guide.style.left = `${boundaryStart}px`;
    guide.style.top = '0';
    guide.style.height = `${gridRoot.scrollHeight}px`;
  } else {
    guide.style.top = `${boundaryStart}px`;
    guide.style.left = '0';
    guide.style.width = `${gridRoot.scrollWidth}px`;
  }
  gridRoot.appendChild(guide);

  document.body.classList.add(isCol ? 'col-resizing' : 'row-resizing');

  let newSize = startSize;
  const onMove = (e) => {
    const delta = (isCol ? e.clientX : e.clientY) - clientStart;
    newSize = Math.max(MIN_DIMENSION, Math.round(startSize + delta));
    const pos = boundaryStart + (newSize - startSize);
    if (isCol) guide.style.left = `${pos}px`;
    else guide.style.top = `${pos}px`;
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('col-resizing', 'row-resizing');
    if (guide.parentNode) guide.parentNode.removeChild(guide);
    dimensionResize = null;

    if (newSize !== startSize) {
      // Apply locally for instant feedback, then broadcast for persistence + peers.
      const map = isCol ? colWidths : rowHeights;
      const dimMap = ensureKey(map, activeSheetName, () => Object.create(null));
      setKey(dimMap, key, newSize);
      renderSpreadsheetGrid();
      if (socket && socket.readyState === WebSocket.OPEN) {
        const payload = { dimension, size: newSize };
        if (isCol) payload.col = key; else payload.row = key;
        socket.send(JSON.stringify({ type: 'resize', payload }));
      }
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  dimensionResize = { dimension, key };
}

/**
 * Pins the first `frozenRows` rows and/or `frozenCols` columns in place using
 * CSS sticky positioning, and draws a thicker boundary line at the freeze edge.
 * Called at the end of every grid render so the freeze survives re-renders.
 * Re-rendering with both counts at 0 simply rebuilds a normal grid.
 */
function applyFreeze() {
  if (!frozenRows && !frozenCols) return;
  const gridRoot = document.getElementById('grid-root');
  if (!gridRoot) return;

  const corner = gridRoot.firstElementChild;
  const headerH = corner ? corner.offsetHeight : 21;

  // Cumulative sticky `top` for each frozen row (rows can have variable height),
  // precomputed into a lookup so the per-cell loop below stays O(1). Named to not
  // shadow the module-scope rowTop() geometry helper. Sticky `left` for frozen
  // columns uses the shared colLeft() prefix offset.
  const frozenRowTop = {};
  if (frozenRows > 0) {
    let off = headerH;
    for (let r = 1; r <= frozenRows; r++) {
      frozenRowTop[r] = off;
      const rh = gridRoot.querySelector(`[data-row-id="${r}"]`);
      off += rh ? rh.offsetHeight : 21;
    }
  }

  // Frozen column headers: stick to the left as well as the top, and draw the
  // boundary line on the last frozen column.
  for (let c = 0; c < frozenCols; c++) {
    const colHeader = gridRoot.querySelector(`[data-col-id="${getColLetter(c)}"]`);
    if (!colHeader) continue;
    colHeader.style.left = `${colLeft(c)}px`;
    colHeader.style.zIndex = '25';
    if (c === frozenCols - 1) colHeader.style.borderRight = FREEZE_BORDER;
  }
  // Frozen row headers: stick to the top as well as the left.
  for (let r = 1; r <= frozenRows; r++) {
    const rh = gridRoot.querySelector(`[data-row-id="${r}"]`);
    if (!rh) continue;
    rh.style.top = `${frozenRowTop[r]}px`;
    rh.style.zIndex = '25';
    if (r === frozenRows) rh.style.borderBottom = FREEZE_BORDER;
  }

  // Data cells in the frozen band(s).
  gridRoot.querySelectorAll('[data-cell-id]').forEach(el => {
    const coord = parseCellCoord(el.getAttribute('data-cell-id'));
    if (!coord) return;
    const inFrozenRow = coord.row <= frozenRows;       // row is 1-based
    const inFrozenCol = coord.colIndex < frozenCols;   // colIndex is 0-based
    if (!inFrozenRow && !inFrozenCol) return;
    el.style.position = 'sticky';
    if (inFrozenRow) {
      el.style.top = `${frozenRowTop[coord.row]}px`;
      if (coord.row === frozenRows) el.style.borderBottom = FREEZE_BORDER;
    }
    if (inFrozenCol) {
      el.style.left = `${colLeft(coord.colIndex)}px`;
      if (coord.colIndex === frozenCols - 1) el.style.borderRight = FREEZE_BORDER;
    }
    // Intersection cells sit above single-axis frozen cells; both sit above the
    // scrolling body but below the sticky headers (z-20+).
    el.style.zIndex = (inFrozenRow && inFrozenCol) ? '6' : '5';
  });
}

/**
 * Sets the freeze counts and rebuilds the grid so the change takes effect
 * (a full rebuild clears any stale inline freeze styles from prior states).
 * @param {number|null} rows - New frozen-row count, or null to leave unchanged.
 * @param {number|null} cols - New frozen-column count, or null to leave unchanged.
 */
const setFreeze = (rows, cols) => {
  if (rows != null) frozenRows = Math.max(0, rows);
  if (cols != null) frozenCols = Math.max(0, cols);
  renderSpreadsheetGrid();
};

/**
 * Updates individual grid cell element inside the DOM.
 * @param {string} cellId - Target cell ID.
 * @param {string} value - Text or evaluated formula.
 * @param {Object} [style] - Custom styles object.
 */
const updateGridDOMCell = (cellId, value, style) => {
  const cellEl = getCellEl(cellId);
  if (!cellEl) return;

  // Check and preserve whether the cell is currently selected to retain the highlight class
  const hasClass = cellEl.classList && typeof cellEl.classList.contains === 'function';
  const isSelected = hasClass ? cellEl.classList.contains('grid-cell-selected') : false;
  const isActive = hasClass ? cellEl.classList.contains('grid-cell-active') : false;

  // Preserve collaborator cursors/presence overlays on this cell across the
  // innerText/innerHTML rewrite below (which would otherwise drop them). Skip the
  // two lookups entirely when the cell has no element children at all — the common
  // case — so a multi-cell update (e.g. clearing formatting over a large selection,
  // #92) doesn't run two querySelectorAll per cell for overlays that aren't there.
  const hasChildEls = !!cellEl.firstElementChild;
  const cursorBorders = hasChildEls ? cellEl.querySelectorAll('.active-cell-border') : EMPTY_ELS;
  const presenceTags = hasChildEls ? cellEl.querySelectorAll('.presence-tag') : EMPTY_ELS;

  // Display evaluated cell value (render as anchor element if link exists, otherwise plain text)
  const val = formatCellDisplay(value || '', style);
  if (style && style.link) {
    // Fall back to the URL as link text when the cell has no value, so a link
    // inserted into an empty cell is still visible (matches Google Sheets).
    const escapedValue = escapeHtml(val || style.link);
    const escapedLink = escapeHtml(style.link);
    cellEl.innerHTML = `<a href="${escapedLink}" target="_blank" class="text-blue-600 underline cursor-pointer hover:text-blue-800">${escapedValue}</a>`;
  } else {
    cellEl.innerText = val;
  }

  // Re-append cursors
  cursorBorders.forEach(border => cellEl.appendChild(border));
  presenceTags.forEach(tag => cellEl.appendChild(tag));

  // Reset standard styling classes. Use cursor-default to match the initial
  // grid render; cursor-pointer here would wrongly show a finger icon over any
  // cell that has been styled (e.g. given a border or fill).
  cellEl.className = 'grid-cell text-body-sm font-body-sm select-none cursor-default';
  // Restore the selection highlight class if the cell was previously selected
  if (cellEl.classList && typeof cellEl.classList.add === 'function') {
    if (isSelected) cellEl.classList.add('grid-cell-selected');
    if (isActive) cellEl.classList.add('grid-cell-active');
  }
  cellEl.style.backgroundColor = '';
  cellEl.style.color = '';
  cellEl.style.textDecoration = '';
  cellEl.style.border = '';
  cellEl.style.textAlign = '';
  cellEl.style.justifyContent = '';
  cellEl.style.fontFamily = '';
  cellEl.style.fontSize = '';
  cellEl.style.minHeight = '';
  cellEl.style.whiteSpace = '';
  cellEl.style.overflow = '';
  cellEl.style.wordBreak = '';

  // Apply custom styling
  if (style) {
    if (style.bold) cellEl.classList.add('font-bold');
    if (style.italic) cellEl.classList.add('italic');
    if (style.fontFamily) cellEl.style.fontFamily = resolveFontFamily(style.fontFamily);
    if (style.fontSize) {
      cellEl.style.fontSize = `${style.fontSize}pt`;
      // Grow the row to fit larger fonts (no-op at or below the default size).
      // Only an empty cell's font size is ignored: a blank cell keeps the base
      // row height, and the row grows once text is actually entered.
      const minHeight = val ? getCellMinHeight(style.fontSize) : null;
      if (minHeight) cellEl.style.minHeight = `${minHeight}px`;
    }
    if (style.color) cellEl.style.backgroundColor = style.color;
    if (style.textColor) cellEl.style.color = style.textColor;
    const deco = [];
    if (style.underline) deco.push('underline');
    if (style.strikethrough) deco.push('line-through');
    if (deco.length) cellEl.style.textDecoration = deco.join(' ');
    // Text wrapping mode (see renderSpreadsheetGrid for the full description).
    if (style.textWrap === 'wrap') {
      cellEl.style.whiteSpace = 'normal';
      cellEl.style.overflow = 'hidden';
      cellEl.style.wordBreak = 'break-word';
    } else if (style.textWrap === 'clip') {
      cellEl.style.overflow = 'hidden';
    }
    applyCellBorders(cellEl, style, cellId);
    // Apply vertical alignment style if present
    if (style.verticalAlign) {
      cellEl.style.justifyContent = style.verticalAlign === 'top' ? 'flex-start' :
                                    (style.verticalAlign === 'center' ? 'center' : 'flex-end');
    }
  }

  // Horizontal alignment: explicit style wins, else numbers right-align
  const cellAlign = resolveCellAlign(value || '', style);
  if (cellAlign) cellEl.style.textAlign = cellAlign;

  // Recompute overflow spill for the whole row: this cell's content may now
  // overflow, and a change to its emptiness affects neighbours' ability to spill.
  // Scheduled (and de-duplicated by row) so a multi-cell update recomputes each
  // affected row once rather than once per cell — see scheduleRowOverflow / #73.
  if (!isHistoryMode) {
    const coord = parseCellCoord(cellId);
    if (coord) scheduleRowOverflow(coord.row);
  }
};

/**
 * Focuses selection on a spreadsheet cell and triggers cursor events.
 * @param {string} cellId - The selected cell identifier.
 * @param {HTMLElement} cellEl - The selected DOM element.
 * @param {boolean} [silent=false] - When true, skip the cursor-move WS broadcast
 *   (the caller sends its own — e.g. switchSheet, which must include the sheet).
 */
const handleCellSelect = (cellId, cellEl, silent = false) => {
  activeCellId = cellId;
  selectionStartCellId = cellId;
  if (!selectionEndCellId) {
    selectionEndCellId = cellId;
  }
  updateRangeSelectionUI();

  // Update top formula bar
  const cellData = localCells[cellId];
  const formulaBar = document.getElementById('formula-bar-input');
  const coordDisplay = document.querySelector('.w-12.text-center');

  // For a full-column/row selection the Name Box already shows "A:A" / "5:5"
  // (set by updateRangeSelectionUI); don't overwrite it with the anchor cell ID.
  if (coordDisplay && !isColumnSelection && !isRowSelection) coordDisplay.innerText = cellId;
  if (formulaBar) {
    formulaBar.value = cellData && cellData.formula ? cellData.formula : (cellData && cellData.value ? cellData.value : '');
  }

  // Notify server of active cell cursor movement
  if (!silent && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'cursor-move',
      payload: { cellId }
    }));
  }

  // Update toolbar active formatting buttons state
  updateToolbarFormattingStates(cellData ? cellData.style : null);
};

/**
 * Moves the selection to the next cell directly below the given cell (same
 * column, next row). Used when committing an inline edit with Enter so focus
 * advances down the column, mirroring spreadsheet behaviour. No-op if already
 * on the bottom row.
 * @param {string} cellId - The cell to move down from.
 */
const selectCellBelow = (cellId) => {
  const coord = parseCellCoord(cellId);
  if (!coord) return;
  const nextRow = coord.row + 1;
  if (nextRow > TOTAL_ROWS) return; // already at the bottom of the grid
  const nextCellId = `${getColLetter(coord.colIndex)}${nextRow}`;
  // Reset any range/column/row selection so this becomes a single-cell selection,
  // matching what a plain click on the cell would do.
  isColumnSelection = false;
  isRowSelection = false;
  extraSelectionRanges = [];
  selectionStartCellId = nextCellId;
  selectionEndCellId = nextCellId;
  // The target may be outside the current window (off-DOM); handleCellSelect works
  // from the id alone, so pass whatever element exists (possibly none). When
  // windowing, reveal it so it scrolls into view and the re-render materialises it.
  handleCellSelect(nextCellId, document.querySelector(`[data-cell-id="${nextCellId}"]`));
  if (activeSheetWindowed) revealCell(nextCellId);
};

/**
 * Selects an entire column from its header: fills every cell in the column,
 * anchors the active cell at the top row, and highlights the column header in
 * solid blue (see updateRangeSelectionUI for the column-selection styling).
 * @param {string} colLetter - The column letter, e.g. "A".
 */
const selectColumn = (colLetter) => {
  if (isHistoryMode) return;
  isColumnSelection = true;
  isRowSelection = false;
  // Pre-set the range end to the bottom of the column; handleCellSelect keeps it
  // because it only defaults the end when none is set.
  selectionEndCellId = `${colLetter}${TOTAL_ROWS}`;
  const topCellEl = document.querySelector(`[data-cell-id="${colLetter}1"]`);
  handleCellSelect(`${colLetter}1`, topCellEl);
};

/**
 * Selects an entire row from its header: fills every cell in the row, anchors
 * the active cell at the first column, and highlights the row header in solid
 * blue (see updateRangeSelectionUI for the row-selection styling).
 * @param {number} rowNum - The 1-based row number.
 */
const selectRow = (rowNum) => {
  if (isHistoryMode) return;
  isRowSelection = true;
  isColumnSelection = false;
  // Pre-set the range end to the last column of the row; handleCellSelect keeps
  // it because it only defaults the end when none is set.
  selectionEndCellId = `${getColLetter(getColCount() - 1)}${rowNum}`;
  const firstCellEl = document.querySelector(`[data-cell-id="A${rowNum}"]`);
  handleCellSelect(`A${rowNum}`, firstCellEl);
};

/**
 * Shift+click on a column header: selects the whole span of columns between
 * the current anchor's column and the clicked one (e.g. A then Shift+C → A:C),
 * keeping the anchor. Falls back to a plain column selection with no anchor.
 * @param {string} colLetter - The clicked column letter.
 */
const extendSelectionToColumn = (colLetter) => {
  if (isHistoryMode) return;
  const anchor = parseCellCoord(selectionStartCellId || activeCellId);
  if (!anchor) { selectColumn(colLetter); return; }
  isColumnSelection = true;
  isRowSelection = false;
  selectionEndCellId = `${colLetter}${TOTAL_ROWS}`;
  const anchorTopId = `${anchor.colLetter}1`;
  handleCellSelect(anchorTopId, document.querySelector(`[data-cell-id="${anchorTopId}"]`));
};

/**
 * Shift+click on a row header: selects the whole span of rows between the
 * current anchor's row and the clicked one (e.g. 2 then Shift+4 → 2:4),
 * keeping the anchor. Falls back to a plain row selection with no anchor.
 * @param {number} rowNum - The clicked 1-based row number.
 */
const extendSelectionToRow = (rowNum) => {
  if (isHistoryMode) return;
  const anchor = parseCellCoord(selectionStartCellId || activeCellId);
  if (!anchor) { selectRow(rowNum); return; }
  isRowSelection = true;
  isColumnSelection = false;
  selectionEndCellId = `${getColLetter(getColCount() - 1)}${rowNum}`;
  const anchorFirstId = `A${anchor.row}`;
  handleCellSelect(anchorFirstId, document.querySelector(`[data-cell-id="${anchorFirstId}"]`));
};

/**
 * Activates inline contenteditable editing for a cell, focuses, and positions caretaker at end.
 * @param {string} cellId - Cell target.
 * @param {HTMLElement} cellEl - Cell DOM element.
 * @param {string} [initialText] - Optional starting text to overwrite content.
 */
const startCellInlineEdit = (cellId, cellEl, initialText = null) => {
  if (!canEditWorkbook) return; // viewers cannot edit cells
  // Make cell contenteditable
  cellEl.setAttribute('contenteditable', 'true');
  // Suppress the browser's spellcheck squiggles on cell data (numbers, codes).
  cellEl.setAttribute('spellcheck', 'false');
  
  // Set cell text: either the initial text or the cell's formula/value
  if (initialText !== null) {
    cellEl.innerText = initialText;
  } else {
    const cellData = localCells[cellId] || { formula: '', value: '' };
    cellEl.innerText = cellData.formula ? cellData.formula : cellData.value;
  }
  cellEl.focus();

  // Position caret at end of cell content using Range and Selection APIs
  if (typeof window.getSelection !== 'undefined' && typeof document.createRange !== 'undefined') {
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(cellEl);
    range.collapse(false); // false means collapse to end
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Route the function autocomplete to this cell while it is being edited, so a
  // formula typed inline gets the same suggestion dropdown as the formula bar.
  // The same adapter drives formula point mode (range picking by drag).
  activeFormulaEditor = makeCellEditor(cellEl);
  resetFormulaPick();
  // Remember which cell/sheet this edit belongs to so picks made after switching
  // sheets are written sheet-qualified and the edit commits back to the right cell.
  fpOriginSheet = activeSheetName;
  fpOriginCell = cellId;
  // Highlight the references of an existing formula (e.g. double-clicking a SUM
  // cell outlines its range in orange); refreshed on every keystroke below.
  refreshFormulaRefHighlights();
  cellEl.oninput = () => { onFormulaEditorTyped(); window.CoSheet.fnAutocomplete.update(makeCellEditor(cellEl)); };

  // Handle saving inline edits on blur
  const saveInlineEdit = () => {
    window.CoSheet.fnAutocomplete.close();
    cellEl.oninput = null;
    cellEl.removeAttribute('contenteditable');
    // Auto-close any unbalanced "(" before committing (e.g. "=SUM(B1:B4" → ")").
    const text = balanceFormulaParens(cellEl.innerText.trim());
    activeFormulaEditor = null;
    resetFormulaPick();
    saveCellUpdate(cellId, text);
  };

  cellEl.onblur = saveInlineEdit;
  cellEl.onkeydown = (e) => {
    // When the autocomplete is open, let it consume navigation/accept keys
    // first so Enter/Tab pick a suggestion instead of committing the cell.
    if (window.CoSheet.fnAutocomplete.isOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); window.CoSheet.fnAutocomplete.move(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); window.CoSheet.fnAutocomplete.move(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); window.CoSheet.fnAutocomplete.accept(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); e.stopPropagation(); window.CoSheet.fnAutocomplete.close(); return; }
    }
    // Esc ends an in-progress range pick (removing the just-picked reference)
    // before it would cancel the whole cell edit.
    if (e.key === 'Escape' && cancelFormulaPick()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Stop the keydown bubbling to the document-level handler, which would
      // otherwise re-open editing on the (now committed) cell once blur has
      // cleared contenteditable.
      e.stopPropagation();
      cellEl.blur(); // Triggers blur event to save
      // Advance the selection to the next cell in the same column, matching
      // spreadsheet behaviour (Enter commits and moves down).
      selectCellBelow(cellId);
    }
  };
};

/**
 * Handles inline double-click spreadsheet cell text editing.
 * @param {string} cellId - The cell identifier.
 * @param {HTMLElement} cellEl - The cell DOM element.
 */
const handleCellInlineEdit = (cellId, cellEl) => {
  startCellInlineEdit(cellId, cellEl);
};

/**
 * Processes cell updates from formula input or inline changes,
 * recalculates formulas, propagates locally, and syncs via WS.
 * @param {string} cellId - The target cell identifier.
 * @param {string} text - Entered value or formula.
 */
const saveCellUpdate = (cellId, text) => {
  if (!canEditWorkbook) return; // read-only: ignore any cell mutation
  // Capture cell state before update for undo/redo history
  const before = localCells[cellId] ? JSON.parse(JSON.stringify(localCells[cellId])) : { formula: '', value: '', style: {} };

  const cell = localCells[cellId] || { formula: '', value: '', style: {} };
  
  if (text.startsWith('=')) {
    cell.formula = text;
    cell.value = evaluateFormula(text, 0, cellId);
    // A formula whose referenced cells carry an explicit decimal-place count
    // inherits that styling, so e.g. a SUM matches the cells it adds up. An
    // explicit setting already on this cell is left untouched.
    if (!cell.style) cell.style = {};
    if (cell.style.decimalPlaces == null) {
      const inherited = inheritFormulaDecimals(text);
      if (inherited != null) cell.style.decimalPlaces = inherited;
    }
  } else {
    cell.formula = '';
    // Numeric entries with redundant leading zeros ("01" → "1") are normalized so
    // the value is treated as an ordinary number. The plain-text format is exempt:
    // it deliberately preserves the literal input (e.g. "007").
    const isPlainText = cell.style && cell.style.numberFormat === 'text';
    cell.value = isPlainText ? text : stripLeadingZeros(text);
  }

  localCells[cellId] = cell;

  // Record action to undo stack
  recordHistoryAction(cellId, before, cell);

  // Run cascading calculation formulas sheet-wide
  recalculateSheet();

  // Send update payload via WebSocket to other peers
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId, formula: cell.formula, value: cell.value, style: cell.style || {} }
    }));
  }

  // Update only the edited cell's DOM. recalculateSheet() above already
  // refreshed any dependent formula cells, so a full renderSpreadsheetGrid()
  // rebuild is unnecessary here — it caused a visible pause on every commit
  // and a selection race when clicking another cell immediately afterwards
  // (the post-rebuild re-select fought with the new click, leaving both
  // cells highlighted). The targeted update preserves the existing selection
  // highlight and any remote cursors on this cell.
  updateGridDOMCell(cellId, getCellValue(cellId), cell.style);

  // Keep the formula bar and toolbar in sync only if this cell is still the
  // active selection (i.e. the edit was committed via Enter, not by clicking
  // away to another cell).
  if (activeCellId === cellId) {
    const formulaBar = document.getElementById('formula-bar-input');
    if (formulaBar) formulaBar.value = cell.formula ? cell.formula : cell.value;
    updateToolbarFormattingStates(cell.style);
  }
};

// Hook up changes from the top Formula Bar when hitting Enter
const formulaBarInput = document.getElementById('formula-bar-input');
if (formulaBarInput) {
  formulaBarInput.addEventListener('keydown', (e) => {
    // When the function autocomplete is open, let it consume navigation/accept
    // keys first so Enter/Tab pick a suggestion instead of committing the cell.
    if (window.CoSheet.fnAutocomplete.isOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); window.CoSheet.fnAutocomplete.move(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); window.CoSheet.fnAutocomplete.move(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); window.CoSheet.fnAutocomplete.accept(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); window.CoSheet.fnAutocomplete.close(); return; }
    }
    // Esc ends an in-progress range pick (removing the just-picked reference).
    if (e.key === 'Escape' && cancelFormulaPick()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' && (activeCellId || fpOriginCell)) {
      e.preventDefault(); // Prevent default enter key behavior
      // Commit to the cell the edit started in. For a cross-sheet pick this also
      // returns to that cell's sheet; balanceFormulaParens auto-closes any "(".
      commitFormulaToOrigin(formulaBarInput.value);
      formulaBarInput.blur(); // Remove focus from the formula bar
    }
  });

  // Track the formula bar as the active formula editor while it has focus, so a
  // click on the grid picks a reference into it (point mode).
  formulaBarInput.addEventListener('focus', () => {
    // A handoff (mid-formula sheet switch) sets the editor up itself; and a focus
    // that returns to the bar mid cross-sheet pick (after a grid re-render) must
    // not reset the in-progress edit. In both cases leave the existing state.
    if (fpHandoff) return;
    if (fpOriginSheet != null && fpOriginSheet !== activeSheetName) return;
    activeFormulaEditor = makeInputEditor(formulaBarInput);
    resetFormulaPick();
    // The formula bar edits the active cell on the active sheet.
    fpOriginSheet = activeSheetName;
    fpOriginCell = activeCellId;
    refreshFormulaRefHighlights(); // outline an existing formula's references
  });

  // Recompute suggestions as the user types / moves the caret. These are
  // wrapped in arrows so the (const) handlers are resolved lazily at event
  // time rather than read here during top-level execution (TDZ-safe).
  formulaBarInput.addEventListener('input', () => { onFormulaEditorTyped(); window.CoSheet.fnAutocomplete.update(makeInputEditor(formulaBarInput)); });
  formulaBarInput.addEventListener('click', () => { window.CoSheet.fnAutocomplete.update(makeInputEditor(formulaBarInput)); });
  // Close when leaving the field (delayed so a click on a suggestion still
  // registers via its mousedown handler before blur tears the popup down). A
  // point-mode grid click keeps focus (preventDefault), so this only runs on a
  // real exit — clear the pick state and drop the formula-editor context.
  formulaBarInput.addEventListener('blur', () => setTimeout(() => {
    // A mid-formula sheet switch re-focuses the bar; don't tear down an edit that
    // is being handed off or whose focus has already returned to the bar.
    if (fpHandoff) return;
    if (document.activeElement === formulaBarInput) return;
    window.CoSheet.fnAutocomplete.close();
    activeFormulaEditor = null;
    resetFormulaPick();
  }, 120));
}

// Function-name autocomplete state/logic moved to fn-autocomplete.js
// (window.CoSheet.fnAutocomplete). The editor adapters below are also used by
// formula point mode (activeFormulaEditor), so they stay here.

/** Adapter for the formula-bar <input> (value / selection / setSelectionRange). */
function makeInputEditor(input) {
  return {
    el: input,
    getValue: () => input.value,
    // Collapsed caret only; -1 signals a selection (insertion would be ambiguous).
    getCaret: () => (input.selectionStart === input.selectionEnd ? input.selectionStart : -1),
    getRect: () => input.getBoundingClientRect(),
    focus: () => input.focus(),
    replaceToken: (start, caret, insert) => {
      const value = input.value;
      const next = value.slice(0, start) + insert + value.slice(caret);
      input.value = next;
      const newCaret = start + insert.length;
      input.setSelectionRange(newCaret, newCaret);
      input.focus();
    },
  };
}

/**
 * Caret offset (in characters from the start of the element) for a collapsed
 * selection inside a contenteditable. Returns -1 when there is no collapsed
 * caret within `el`. Inline cell edits hold a single text node, so the range
 * text length is the character offset.
 */
function ceCaretOffset(el) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return -1;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return -1;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** Places a collapsed caret at character `offset` inside a contenteditable. */
function ceSetCaret(el, offset) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const node = el.firstChild;
  if (node && node.nodeType === 3 /* TEXT_NODE */) {
    range.setStart(node, Math.min(offset, node.textContent.length));
    range.collapse(true);
  } else {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
  el.focus();
}

/** Adapter for an inline-editing cell (contenteditable <div>). */
function makeCellEditor(cellEl) {
  return {
    el: cellEl,
    getValue: () => cellEl.innerText,
    getCaret: () => ceCaretOffset(cellEl),
    getRect: () => cellEl.getBoundingClientRect(),
    focus: () => cellEl.focus(),
    replaceToken: (start, caret, insert) => {
      const value = cellEl.innerText;
      cellEl.innerText = value.slice(0, start) + insert + value.slice(caret);
      ceSetCaret(cellEl, start + insert.length);
    },
  };
}

/* ---------------------------------------------------------------------------
 * Formula range picking ("point mode")
 * ---------------------------------------------------------------------------
 * Mirrors Google Sheets / Excel. While a formula is being edited (inline in a cell
 * or in the top formula bar), every cell/range it references is outlined with an
 * orange dashed, light-orange-filled box (see renderFormulaRefHighlights) — so
 * double-clicking "=SUM(B3:C8)" frames B3:C8 immediately. When the caret sits where
 * a reference is expected — right after "=", "(", a comma, or an operator — clicking
 * a cell and dragging writes that A1[:B4] reference into the formula; the boxes are
 * always rebuilt from the current formula text, so the dragged range and any other
 * references stay outlined. The boxes clear on commit; on commit (Enter or blur)
 * any unbalanced "(" is auto-closed with ")".
 *
 * The two editors are reached through the same getValue/getCaret/replaceToken
 * adapters used by the function autocomplete (makeInputEditor / makeCellEditor),
 * stored in `activeFormulaEditor` while that editor holds focus.
 * ------------------------------------------------------------------------- */

// Characters after which (ignoring trailing spaces) a cell reference may follow.
const FORMULA_REF_TRIGGER = /[(,=+\-*/^&<>]\s*$/;

/** True when the formula text up to `caret` is at a reference-accepting position. */
const formulaExpectsReference = (value, caret) => {
  if (typeof caret !== 'number' || caret < 0) caret = value.length;
  const left = value.slice(0, caret);
  if (!left.startsWith('=')) return false;
  return FORMULA_REF_TRIGGER.test(left);
};

// A sheet name may be written unquoted only when it is a plain identifier; any
// other name (spaces, punctuation, CJK, leading digit) is wrapped in single
// quotes with internal quotes doubled, matching the formula tokenizer.
const SHEET_NAME_BARE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const formatSheetPrefix = (name) =>
  `${SHEET_NAME_BARE_RE.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`}!`;

/**
 * Normalised A1-style reference for a pick: "B1" for a single cell, "B1:B4" else.
 * When the pick is made on a sheet other than the one being edited (fpOriginSheet),
 * the reference is qualified with that sheet, e.g. 'Sheet 1'!B1:B4.
 */
const buildRangeRef = (startId, endId) => {
  const s = parseCellCoord(startId);
  const e = parseCellCoord(endId);
  if (!s || !e) return startId;
  const minCol = Math.min(s.colIndex, e.colIndex);
  const maxCol = Math.max(s.colIndex, e.colIndex);
  const minRow = Math.min(s.row, e.row);
  const maxRow = Math.max(s.row, e.row);
  const topLeft = `${getColLetter(minCol)}${minRow}`;
  const local = (minCol === maxCol && minRow === maxRow)
    ? topLeft
    : `${topLeft}:${getColLetter(maxCol)}${maxRow}`;
  const prefix = (fpOriginSheet != null && activeSheetName !== fpOriginSheet)
    ? formatSheetPrefix(activeSheetName)
    : '';
  return prefix + local;
};

/** Appends the ")" needed to balance unclosed "(" in a committed formula. */
const balanceFormulaParens = (text) => {
  if (!text.startsWith('=')) return text;
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inStr = !inStr;
    else if (!inStr) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
    }
  }
  return depth > 0 ? text + ')'.repeat(depth) : text;
};

// Matches an A1-style cell reference or A1:B4 range, with an optional leading sheet
// qualifier ('Sheet 1'! or Sheet1!), ignoring an optional "$" and not consuming a
// function name (a trailing "(" rules the token out, e.g. LOG10()). Capture groups:
// 1=quoted sheet, 2=bare sheet, 3=col, 4=row, 5=end col, 6=end row (5/6 absent for
// a single cell; 1/2 absent for an unqualified reference).
const FORMULA_REF_RE =
  /(?<![A-Za-z0-9_$])(?:'((?:[^']|'')*)'!|([A-Za-z_][A-Za-z0-9_]*)!)?\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?(?![A-Za-z0-9_(])/g;

/**
 * Extracts every cell/range reference from a formula string as {sheet,startId,endId}
 * objects (e.g. "'S1'!B3:C8" -> {sheet:"S1", startId:"B3", endId:"C8"}; sheet is
 * null for an unqualified reference). String literals are masked out first so text
 * like "A1" inside double-quotes is not treated as a reference.
 */
const parseFormulaRefs = (value) => {
  if (!value || !value.startsWith('=')) return [];
  // Blank out quoted strings (keep length/positions) so refs inside them are skipped.
  const masked = value.replace(/"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length));
  const refs = [];
  let m;
  FORMULA_REF_RE.lastIndex = 0;
  while ((m = FORMULA_REF_RE.exec(masked)) !== null) {
    const sheet = m[1] != null ? m[1].replace(/''/g, "'") : (m[2] != null ? m[2] : null);
    const startId = `${m[3].toUpperCase()}${m[4]}`;
    const endId = m[5] ? `${m[5].toUpperCase()}${m[6]}` : startId;
    refs.push({ sheet, startId, endId });
  }
  return refs;
};

/** Pixel rect ({left,top,width,height}) for the cell range startId..endId, or null. */
const rangeRectFor = (startId, endId) => {
  const s = parseCellCoord(startId);
  const e = parseCellCoord(endId);
  if (!s || !e) return null;
  const minCol = Math.min(s.colIndex, e.colIndex);
  const maxCol = Math.max(s.colIndex, e.colIndex);
  const minRow = Math.min(s.row, e.row);
  const maxRow = Math.max(s.row, e.row);
  // Skip references outside the sheet's rendered grid — there's nothing to point
  // at (mirrors the old "no cell to anchor to" guard, without needing the anchor
  // cell's DOM box).
  if (minRow < 1 || minRow > TOTAL_ROWS || minCol < 0 || minCol >= getColCount()) return null;
  // Position/size from the grid model via colLeft / rowTop, exactly like the blue
  // selection overlay (see updateRangeSelectionUI): offsets in #grid-root's layout
  // space, so it needs no cell box and stays correct under zoom / hidden columns.
  let width = 0;
  for (let c = minCol; c <= maxCol; c++) width += getColWidth(getColLetter(c));
  let height = 0;
  for (let r = minRow; r <= maxRow; r++) height += resolvedRowHeight(r);
  return { left: colLeft(minCol), top: rowTop(minRow), width, height };
};

/** Removes every orange reference box from the grid. */
const clearFormulaRefHighlights = () => {
  document.querySelectorAll('.formula-ref-box').forEach((el) => el.remove());
};

/**
 * Draws an orange dashed box around each cell/range the formula references. Used
 * both when editing an existing formula (double-click) and live while picking a
 * range by drag — in either case the boxes are derived from the formula text.
 * Only references that resolve to the currently displayed sheet are drawn: an
 * unqualified reference belongs to `baseSheet` (the formula's own sheet), while a
 * qualified one (e.g. 'Sheet 1'!E3) belongs to the named sheet.
 */
const renderFormulaRefHighlights = (value, baseSheet = activeSheetName) => {
  clearFormulaRefHighlights();
  const gridRoot = document.getElementById('grid-root');
  if (!gridRoot) return;
  for (const { sheet, startId, endId } of parseFormulaRefs(value)) {
    const effectiveSheet = sheet != null ? sheet : baseSheet;
    if (effectiveSheet !== activeSheetName) continue; // reference lives on another sheet
    const rect = rangeRectFor(startId, endId);
    if (!rect) continue;
    const box = document.createElement('div');
    box.className = 'formula-ref-box';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    gridRoot.appendChild(box);
  }
};

/** Re-highlights references from whichever formula editor currently has focus. */
const refreshFormulaRefHighlights = () => {
  if (activeFormulaEditor) {
    renderFormulaRefHighlights(activeFormulaEditor.getValue(), fpOriginSheet != null ? fpOriginSheet : activeSheetName);
  } else clearFormulaRefHighlights();
};

/** True when a grid click should pick a reference rather than move the selection. */
const formulaPickCapable = () => {
  if (!canEditWorkbook || isHistoryMode || !activeFormulaEditor) return false;
  const value = activeFormulaEditor.getValue();
  if (!value.startsWith('=')) return false;
  // Right after a pick (before any typing) a fresh click replaces that reference.
  if (fpJustPicked) return true;
  return formulaExpectsReference(value, activeFormulaEditor.getCaret());
};

/** Writes the current pick range into the formula and redraws the reference boxes. */
const applyFormulaPick = () => {
  const ed = activeFormulaEditor;
  if (!ed) return;
  const ref = buildRangeRef(fpStartCell, fpEndCell);
  ed.replaceToken(fpInsertStart, fpInsertStart + fpInsertLen, ref);
  fpInsertLen = ref.length;
  fpJustPicked = true;
  window.CoSheet.fnAutocomplete.close(); // the picked ref takes precedence over any suggestions
  renderFormulaRefHighlights(ed.getValue());
};

/** Starts a pick at `cellId` (mousedown on the grid while editing a formula). */
const beginFormulaPick = (cellId) => {
  const ed = activeFormulaEditor;
  if (!ed) return;
  fpActive = true;
  fpStartCell = cellId;
  fpEndCell = cellId;
  // Reuse the previous insertion span only when the last pick hasn't been typed
  // over (so a second drag overwrites it); otherwise insert at the caret.
  if (!fpJustPicked || fpInsertStart < 0) {
    let caret = ed.getCaret();
    if (typeof caret !== 'number' || caret < 0) caret = ed.getValue().length;
    fpInsertStart = caret;
    fpInsertLen = 0;
  }
  applyFormulaPick();
};

/** Extends the in-progress pick to `cellId` (mouseenter during a drag). */
const extendFormulaPick = (cellId) => {
  if (!fpActive) return;
  fpEndCell = cellId;
  applyFormulaPick();
};

/** Ends the drag on mouseup; the written range and the boxes stay until typed over. */
const endFormulaPick = () => {
  if (fpActive) fpActive = false;
};

/**
 * Cancels an in-progress range pick: removes the reference text the drag/click
 * wrote and clears its orange box, leaving the rest of the formula (and the caret)
 * intact. Returns true when there was a pick to cancel — the Esc key uses this so
 * it ends the range selection instead of cancelling the whole edit.
 */
const cancelFormulaPick = () => {
  const ed = activeFormulaEditor;
  if (!ed || fpInsertStart < 0 || fpInsertLen <= 0) return false;
  ed.replaceToken(fpInsertStart, fpInsertStart + fpInsertLen, '');
  fpActive = false;
  fpStartCell = null;
  fpEndCell = null;
  fpInsertStart = -1;
  fpInsertLen = 0;
  fpJustPicked = false;
  refreshFormulaRefHighlights(); // redraw any references that remain in the formula
  return true;
};

/** Clears all point-mode state and the reference boxes (on commit / leaving an editor). */
const resetFormulaPick = () => {
  fpActive = false;
  fpStartCell = null;
  fpEndCell = null;
  fpInsertStart = -1;
  fpInsertLen = 0;
  fpJustPicked = false;
  fpOriginSheet = null;
  fpOriginCell = null;
  clearFormulaRefHighlights();
};

/**
 * Switches the visible sheet in the middle of a formula edit without committing
 * or losing the in-progress formula. Unlike switchSheet() it preserves the
 * formula-pick state (origin cell/sheet, insertion span) so a range can be picked
 * on another sheet; the visible active cell is dropped (the commit target is
 * fpOriginCell). The formula bar keeps focus so the next grid click picks a ref.
 */
const switchSheetForFormulaPick = (sheetName) => {
  clearRangeSelection();
  activeCellId = null;
  activeSheetName = sheetName;
  renderSheetTabs();
  renderSpreadsheetGrid();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'cursor-move', payload: { cellId: null, sheetName: activeSheetName } }));
  }
  // Re-outline any references that resolve to the now-visible sheet, and keep the
  // formula bar focused so point mode stays armed after the grid re-render.
  refreshFormulaRefHighlights();
  const formulaBar = document.getElementById('formula-bar-input');
  if (formulaBar) formulaBar.focus();
};

/**
 * Begins a cross-sheet range pick: moves an in-progress formula edit to the
 * persistent formula bar (so it survives the grid re-render), switches to
 * `targetSheet`, and keeps focus for picking. No-op (returns false) unless a
 * formula is being edited and the target differs from the current sheet.
 */
const beginCrossSheetFormulaSwitch = (targetSheet) => {
  const ed = activeFormulaEditor;
  if (!ed || typeof ed.getValue !== 'function') return false;
  const text = ed.getValue();
  if (typeof text !== 'string' || !text.startsWith('=')) return false; // formulas only
  if (!targetSheet || targetSheet === activeSheetName) return false;
  const formulaBar = document.getElementById('formula-bar-input');
  if (!formulaBar) return false;

  const caret = ed.getCaret();
  fpHandoff = true;
  try {
    // If editing inline in a grid cell, neutralise that editor so the imminent
    // blur (focus moving to the bar / the grid re-rendering) neither commits nor
    // resets the formula-pick state.
    if (ed.el && ed.el !== formulaBar) {
      ed.el.oninput = null;
      ed.el.onkeydown = null;
      ed.el.onblur = null;
      if (typeof ed.el.removeAttribute === 'function') ed.el.removeAttribute('contenteditable');
      window.CoSheet.fnAutocomplete.close();
    }
    // Adopt the formula bar as the live editor, preserving text + caret.
    formulaBar.value = text;
    activeFormulaEditor = makeInputEditor(formulaBar);
    formulaBar.focus();
    const pos = (typeof caret === 'number' && caret >= 0) ? caret : text.length;
    try { formulaBar.setSelectionRange(pos, pos); } catch (e) {}
  } finally {
    fpHandoff = false;
  }

  switchSheetForFormulaPick(targetSheet);
  return true;
};

/**
 * Commits an in-progress formula/value edit to the cell it started in, returning
 * to that cell's sheet first when the user switched away to pick a cross-sheet
 * range. Falls back to the active cell for an ordinary same-sheet edit.
 */
const commitFormulaToOrigin = (rawText) => {
  const cellId = fpOriginCell || activeCellId;
  const originSheet = fpOriginSheet;
  const text = balanceFormulaParens(String(rawText).trim());
  window.CoSheet.fnAutocomplete.close();
  resetFormulaPick();
  activeFormulaEditor = null;
  if (!cellId) return;
  if (originSheet && originSheet !== activeSheetName) {
    switchSheet(originSheet); // back to the origin cell's sheet before writing
  }
  activeCellId = cellId;
  saveCellUpdate(cellId, text);
  // Re-select the origin cell so the user lands back where they started.
  const cellEl = document.querySelector(`[data-cell-id="${cellId}"]`);
  if (cellEl) handleCellSelect(cellId, cellEl);
};

/**
 * Called when the user types into the formula editor. A freshly picked range is
 * now "locked in" as text, so the next pick starts at the new caret; the
 * reference boxes are then redrawn from the updated formula text. (Programmatic
 * edits from applyFormulaPick do not fire input events, so this runs only for
 * real keystrokes.)
 */
const onFormulaEditorTyped = () => {
  fpJustPicked = false;
  fpInsertStart = -1;
  fpInsertLen = 0;
  refreshFormulaRefHighlights();
};

// Function-name autocomplete lives in fn-autocomplete.js
// (window.CoSheet.fnAutocomplete); the editor handlers above drive it via update().

/**
 * Renders active cursor border highlights for collaborative remote peers.
 * @param {Object} user - User metadata from WS.
 */
const renderCursorBorder = (user) => {
  const cellEl = document.querySelector(`[data-cell-id="${user.activeCell}"]`);
  if (!cellEl) return;

  // Clean any old border highlights for this peer
  removeCursorBorder(user.userId);

  const borderEl = document.createElement('div');
  borderEl.id = `cursor-${user.userId}`;
  borderEl.className = 'active-cell-border';
  borderEl.style.borderColor = user.color;
  borderEl.innerHTML = `
    <div class="presence-tag" style="background-color: ${user.color};">${user.username}</div>
    <div class="fill-handle" style="background-color: ${user.color};"></div>
  `;
  cellEl.appendChild(borderEl);
};

/**
 * Removes collaborative cursor boundary highlight from cell.
 * @param {string} userId - Target peer connection ID.
 */
const removeCursorBorder = (userId) => {
  const el = document.getElementById(`cursor-${userId}`);
  if (el) el.remove();
};

/**
 * Re-renders every known remote collaborator's cursor/presence tag for the active
 * sheet. A full renderSpreadsheetGrid() rebuilds gridRoot from scratch, discarding
 * the presence borders appended to individual cells, so they must be re-applied
 * afterwards — otherwise a peer's name tag silently vanishes on any full re-render
 * (e.g. a remote column/row resize or sheet add/delete) and only reappears the next
 * time that peer moves their cursor. Skipped in history mode, which shows a past
 * snapshot rather than the live collaborative grid.
 */
const renderRemoteCursors = () => {
  if (isHistoryMode) return;
  Object.keys(remoteCursors).forEach(id => {
    const cursor = remoteCursors[id];
    if (isSelfPresence(cursor)) return; // never render our own presence tag
    if (cursor && cursor.activeCell && cursor.activeSheet === activeSheetName) {
      renderCursorBorder(cursor);
    }
  });
};

/**
 * Handles toggling styles (bold/italic) and syncing formatting state for selection range.
 * @param {string} cellId - The target cell ID.
 * @param {string} property - Style property name.
 */
const toggleFormat = (cellId, property) => {
  // Cache selected cell IDs to avoid multiple DOM/calculation overhead when checking inclusion.
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];
  
  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    cell.style[property] = !cell.style[property];
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });
    
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });
  
  recordHistoryAction({ type: 'multi', changes: historyChanges });
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Compatibility wrapper to toggle border styling for selection range.
 * @param {string} cellId - The target cell ID.
 */
// eslint-disable-next-line no-unused-vars -- retained wrapper; no in-app caller, but exercised by the format-recalc test suite.
const toggleBorder = (cellId) => {
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];

  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    cell.style.border = !cell.style.border;
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });

  recordHistoryAction({ type: 'multi', changes: historyChanges });
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Handles setting backgrounds/fill colors and syncing state for selection range.
 * @param {string} cellId - Selected cell ID.
 * @param {string} hex - HEX Color string.
 */
const changeCellColor = (cellId, hex) => {
  // Cache selected cell IDs to avoid multiple DOM/calculation overhead when checking inclusion.
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];
  
  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    cell.style.color = hex;
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });
    
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });
  
  recordHistoryAction({ type: 'multi', changes: historyChanges });
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Handles setting text color and syncing state for selection range.
 * @param {string} cellId - Selected cell ID.
 * @param {string} hex - HEX Color string.
 */
const changeCellTextColor = (cellId, hex) => {
  // Cache selected cell IDs to avoid multiple DOM/calculation overhead when checking inclusion.
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];
  
  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    cell.style.textColor = hex;
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });
    
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });
  
  recordHistoryAction({ type: 'multi', changes: historyChanges });
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Clears all formatting from the selected cell(s), restoring them to their
 * unstyled default while leaving the underlying content (formula/value) intact.
 * Mirrors Google Sheets' "Clear formatting" (Ctrl+\): font, colors, borders,
 * bold/italic/strikethrough, alignment, number format, text wrapping, merges,
 * etc. are all reset. One style property is *not* visual formatting and survives:
 *   • link – the cell's hyperlink target (a cell can render purely from it via
 *            the `val || link` fallback in the renderer, so dropping it would
 *            lose content).
 * `merge` used to survive here too, on the reasoning that a merge isn't visual
 * formatting. Google Sheets disagrees — Ctrl+\ splits merged blocks — so a merge
 * anchored on a cleared cell is now dropped, unmerging the block (see #149).
 * @param {string} cellId - Selected cell ID.
 */
const clearFormatting = (cellId) => {
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];
  // Borders are drawn neighbour-aware: every shared edge is also painted by the
  // facing neighbour, which draws its own coincident copy (resolved with pick()).
  // So when a bordered cell is cleared, all four neighbours around it must be
  // re-rendered too — otherwise their copies of the shared edges linger, drawn by
  // neighbours we never refreshed.
  const renderIds = new Set();
  // Dropping a merge changes cell geometry across the whole block — including
  // cells outside `renderIds` that the block used to cover — so the per-cell DOM
  // refresh below can't express it. Track whether any merge actually went away and
  // fall back to a full grid render only then, keeping the common (unmerged) clear
  // on the cheap per-cell path.
  let unmergedAny = false;

  cellIds.forEach(id => {
    const cell = localCells[id];
    if (!cell || !cell.style) return;
    const preserved = {};
    if (cell.style.link) preserved.link = cell.style.link;
    // Nothing to clear when every style property is one we keep (or there are none).
    if (Object.keys(cell.style).length === Object.keys(preserved).length) return;

    if (styleHasMerge(cell.style)) unmergedAny = true;
    const hadBorders = styleHasBorders(cell.style);
    const before = JSON.parse(JSON.stringify(cell));
    cell.style = preserved;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }

    renderIds.add(id);
    if (hadBorders) {
      const coord = parseCellCoord(id);
      if (coord) {
        const { row: r, colIndex: c } = coord;
        const colCount = getColCount(activeSheetName);
        if (c - 1 >= 0) renderIds.add(`${getColLetter(c - 1)}${r}`);
        if (c + 1 < colCount) renderIds.add(`${getColLetter(c + 1)}${r}`);
        if (r - 1 >= 1) renderIds.add(`${getColLetter(c)}${r - 1}`);
        if (r + 1 <= TOTAL_ROWS) renderIds.add(`${getColLetter(c)}${r + 1}`);
      }
    }
  });

  // Render only after every cell is mutated so neighbour-aware edge de-duping
  // reads final state.
  if (unmergedAny) {
    // A block just split back into its constituent cells; only a full re-render
    // rebuilds the grid's geometry (mirrors unmergeSelectedCells).
    renderSpreadsheetGrid();
  } else {
    renderIds.forEach(id => {
      const cell = localCells[id];
      const st = (cell && cell.style) || EMPTY_STYLE;
      // Use the cached value, not getCellValue(): clearing formatting can't change
      // any cell's value, so re-evaluating each cleared formula cell here is wasted.
      updateGridDOMCell(id, (cell && cell.value) || '', st);
    });
  }

  if (historyChanges.length) {
    recordHistoryAction({ type: 'multi', changes: historyChanges });
  }
  // No recalculateSheet(): clearing formatting only strips display styles
  // (number format, decimals, font, colours, borders, alignment, wrap) — it never
  // changes a cell's value or formula, so walking every cell and re-evaluating
  // every formula here was pure waste (a full-sheet recalc on each clear, the same
  // anti-pattern removed from the border path in #91). Each cleared cell's DOM is
  // already refreshed above by updateGridDOMCell.
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Sets the number format on the selected cell(s). Applying the same format
 * again is a no-op (the value already displays in that format).
 * @param {string} cellId - Selected cell ID.
 * @param {string} numberFormat - Format key, e.g. 'percent'.
 */
const setCellNumberFormat = (cellId, numberFormat) => {
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];

  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    // Skip cells that already carry this format so re-pressing has no effect.
    if (cell.style.numberFormat === numberFormat) return;
    cell.style.numberFormat = numberFormat;
    // A new format resets any pinned decimal count back to that format's default.
    delete cell.style.decimalPlaces;
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });

  if (historyChanges.length) {
    recordHistoryAction({ type: 'multi', changes: historyChanges });
  }
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Resolves the decimal-place count currently shown for a cell: an explicit
 * `decimalPlaces` override wins; otherwise it falls back to the named format's
 * default, or — with no format at all — the decimals present in the value.
 * @param {object} style - The cell's style object.
 * @param {string} value - The cell's evaluated value.
 * @returns {number} The effective decimal-place count.
 */
const effectiveDecimals = (style, value) => {
  if (style && style.decimalPlaces != null) return style.decimalPlaces;
  if (style && style.numberFormat) return defaultDecimalsForFormat(style.numberFormat);
  const s = String(value);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : (s.length - dot - 1);
};

/** True if the cell currently holds a formula (its display is a computed result). */
const cellHasFormula = (id) =>
  !!(localCells[id] && localCells[id].formula && String(localCells[id].formula).startsWith('='));

/** True if `cellId` falls inside the rectangular range startId..endId. */
const cellInRange = (cellId, startId, endId) => {
  const c = parseCellCoord(cellId);
  const s = parseCellCoord(startId);
  const e = parseCellCoord(endId);
  if (!c || !s || !e) return false;
  const minCol = Math.min(s.colIndex, e.colIndex);
  const maxCol = Math.max(s.colIndex, e.colIndex);
  const minRow = Math.min(s.row, e.row);
  const maxRow = Math.max(s.row, e.row);
  return c.colIndex >= minCol && c.colIndex <= maxCol && c.row >= minRow && c.row <= maxRow;
};

/** True if `formula` references `cellId` within any of its cell/range references. */
const formulaReferencesCell = (formula, cellId) =>
  parseFormulaRefs(formula).some(({ startId, endId }) => cellInRange(cellId, startId, endId));

/**
 * Finds the decimal-place count a newly-entered formula should inherit: if any
 * data cell the formula references carries an explicit `decimalPlaces`, the
 * formula's result adopts the same styling (e.g. a SUM matches its operands).
 * @param {string} formula - The formula being applied (must start with '=').
 * @returns {number|null} The decimal count to inherit, or null if none.
 */
const inheritFormulaDecimals = (formula) => {
  const refs = parseFormulaRefs(formula);
  if (!refs.length) return null;
  let best = null;
  for (const id of Object.keys(localCells)) {
    const c = localCells[id];
    if (!c || !c.style || c.style.decimalPlaces == null || cellHasFormula(id)) continue;
    if (refs.some(({ startId, endId }) => cellInRange(id, startId, endId))) best = c.style.decimalPlaces;
  }
  return best;
};

/**
 * Increases or decreases the number of decimal places shown for the selected
 * numeric cell(s). The stored value is untouched — only its display changes.
 * Non-numeric cells are skipped, and the count is clamped to [0, 20]. A formula
 * cell whose referenced range includes an adjusted cell is kept in sync, so e.g.
 * a SUM matches the decimal styling of the cells it adds up.
 * @param {string} cellId - Selected cell ID.
 * @param {number} delta - +1 to add a decimal place, -1 to remove one.
 */
const adjustCellDecimals = (cellId, delta) => {
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];
  // The cells actually changed and their new decimal count, used to sync any
  // formula cells that reference them.
  const adjustedTargets = [];

  // Applies `dp` decimals to one cell, recording history + syncing peers/DOM.
  const applyDecimals = (id, dp) => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    if (cell.style.decimalPlaces === dp) return;
    cell.style.decimalPlaces = dp;
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  };

  cellIds.forEach(id => {
    // Only numeric cells can carry a decimal-place setting.
    const value = getCellValue(id);
    if (!isNumericValue(value)) return;
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    const current = effectiveDecimals(cell.style || {}, value);
    const next = Math.max(0, Math.min(20, current + delta));
    if (next === current) return;          // already at the clamp limit — no change
    applyDecimals(id, next);
    adjustedTargets.push({ id, next });
  });

  // Sync formula cells that reference any adjusted cell: only a formula whose
  // range actually includes the adjusted cell follows along — other formula
  // cells are left untouched.
  if (adjustedTargets.length) {
    Object.keys(localCells).forEach(fid => {
      if (cellIds.includes(fid) || !cellHasFormula(fid)) return;
      if (!isNumericValue(getCellValue(fid))) return;
      const formula = localCells[fid].formula;
      let dp = null;
      for (const tgt of adjustedTargets) {
        if (formulaReferencesCell(formula, tgt.id)) dp = tgt.next;
      }
      if (dp != null) applyDecimals(fid, dp);
    });
  }

  if (historyChanges.length) {
    recordHistoryAction({ type: 'multi', changes: historyChanges });
  }
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Sets the text-wrapping mode on the selected cell(s): 'overflow' (default —
 * spill across empty neighbours), 'wrap' (reflow within the cell), or 'clip'
 * (truncate at the cell edge). Re-applying the same mode is a no-op.
 * @param {string} cellId - Selected cell ID.
 * @param {string} mode - 'overflow' | 'wrap' | 'clip'.
 */
const setCellTextWrap = (cellId, mode) => {
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];

  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    // 'overflow' is the implicit default, so store it as the absence of a value.
    const next = mode === 'overflow' ? undefined : mode;
    if (cell.style.textWrap === next) return;
    if (next === undefined) delete cell.style.textWrap;
    else cell.style.textWrap = next;
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });

  if (historyChanges.length) {
    recordHistoryAction({ type: 'multi', changes: historyChanges });
  }
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

// ─── Merge / unmerge operations ──────────────────────────────────────────────

/**
 * Shared writer for merge/unmerge. Runs `mutate(id, cell)` for each id, diffs the
 * result for undo, broadcasts each changed cell on the existing cell-edit channel,
 * records a single multi history action, and rebuilds the grid (merges move grid
 * tracks, so a per-cell DOM update isn't enough). No-op if nothing changed.
 * @returns {boolean} whether anything changed.
 */
const commitMergeMutation = (ids, mutate) => {
  const historyChanges = [];
  ids.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] ? localCells[id] : { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    mutate(id, cell);
    const after = JSON.parse(JSON.stringify(cell));
    if (JSON.stringify(before) === JSON.stringify(after)) return; // unchanged
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after });
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
  });
  if (!historyChanges.length) return false;
  recordHistoryAction({ type: 'multi', changes: historyChanges });
  recalculateSheet();
  renderSpreadsheetGrid();
  return true;
};

/**
 * Merges the current selection. `mode` controls the shape:
 *   'all'        — one block spanning the whole selection.
 *   'vertical'   — one block per column (each column merged top-to-bottom).
 *   'horizontal' — one block per row (each row merged left-to-right).
 * Only the top-left cell of each block keeps its content; the cells it covers are
 * cleared, matching Google Sheets. Undoable and broadcast to collaborators.
 */
const mergeSelectedCells = (mode) => {
  if (!canEditWorkbook || isHistoryMode) return;
  // Merging is defined on one rectangle; ignore Ctrl+click extra ranges.
  const ids = getSelectedCellIds({ activeRangeOnly: true });
  const coords = ids.map(parseCellCoord).filter(Boolean);
  if (coords.length < 2) return;
  const minRow = Math.min(...coords.map(c => c.row));
  const maxRow = Math.max(...coords.map(c => c.row));
  const minCol = Math.min(...coords.map(c => c.colIndex));
  const maxCol = Math.max(...coords.map(c => c.colIndex));

  // anchorId -> { rows, cols } for the block(s) this mode creates.
  const anchors = new Map();
  if (mode === 'vertical') {
    if (maxRow - minRow < 1) return;
    for (let c = minCol; c <= maxCol; c++) {
      anchors.set(`${getColLetter(c)}${minRow}`, { rows: maxRow - minRow + 1, cols: 1 });
    }
  } else if (mode === 'horizontal') {
    if (maxCol - minCol < 1) return;
    for (let r = minRow; r <= maxRow; r++) {
      anchors.set(`${getColLetter(minCol)}${r}`, { rows: 1, cols: maxCol - minCol + 1 });
    }
  } else { // 'all'
    anchors.set(`${getColLetter(minCol)}${minRow}`, { rows: maxRow - minRow + 1, cols: maxCol - minCol + 1 });
  }

  commitMergeMutation(ids, (id, cell) => {
    const span = anchors.get(id);
    if (span && span.rows * span.cols > 1) {
      cell.style.merge = { rows: span.rows, cols: span.cols };
    } else {
      // Drop any pre-existing merge marker. Cells that aren't a block anchor are
      // covered by one, so clear their content (only the top-left value is kept).
      if (cell.style.merge) delete cell.style.merge;
      if (!span) { cell.formula = ''; cell.value = ''; }
    }
  });
};

/** Removes any merges intersecting the selection (re-splits them into cells). */
const unmergeSelectedCells = () => {
  if (!canEditWorkbook || isHistoryMode) return;
  const ids = getSelectedCellIds({ activeRangeOnly: true });
  if (!ids.length) return;
  const hasAny = ids.some(id => styleHasMerge(localCells[id] && localCells[id].style));
  if (!hasAny) return;
  commitMergeMutation(ids, (id, cell) => {
    if (cell.style && cell.style.merge) delete cell.style.merge;
  });
};

/**
 * Maps a font display name to the CSS font-family stack used when rendering cells.
 * Keep these stacks in sync with the .ff-* preview classes in index.html.
 */
const FONT_FAMILY_MAP = {
  'Arial': 'Arial, sans-serif',
  'Alegreya': "'Alegreya', serif",
  'Amatic SC': "'Amatic SC', cursive",
  'Bree Serif': "'Bree Serif', serif",
  'Calibri': "Calibri, 'Carlito', sans-serif",
  'Cambria': 'Cambria, Georgia, serif',
  'Comic Sans MS': "'Comic Sans MS', 'Comic Neue', cursive",
  'Courier New': "'Courier New', 'Courier Prime', monospace",
  'Georgia': 'Georgia, serif',
  'Impact': "Impact, 'Arial Narrow Bold', sans-serif",
  'Merriweather': "'Merriweather', serif",
  'Permanent Marker': "'Permanent Marker', cursive",
  'Pinyon Script': "'Pinyon Script', cursive",
  'Playfair Display': "'Playfair Display', serif",
  'Proxima Nova': 'Helvetica, Arial, sans-serif',
  'Roboto': "'Roboto', sans-serif",
  'Roboto Mono': "'Roboto Mono', monospace",
  'Times New Roman': "'Times New Roman', Times, serif",
  'Trebuchet MS': "'Trebuchet MS', sans-serif",
  'Ultra': "'Ultra', serif",
  'Varela Round': "'Varela Round', sans-serif",
  'Verdana': 'Verdana, sans-serif',
  '微軟正黑體': "'微軟正黑體', 'Microsoft JhengHei', sans-serif",
  '新細明體': "'新細明體', 'PMingLiU', serif",
  '標楷體': "'標楷體', 'DFKai-SB', cursive"
};

/**
 * Resolves a stored font name to a CSS font-family stack (falls back to the raw value).
 * @param {string} fontName - The stored font display name.
 * @returns {string} A CSS font-family value.
 */
const resolveFontFamily = (fontName) => FONT_FAMILY_MAP[fontName] || fontName;

/**
 * Sets a cell's font family and syncs state for the current selection range.
 * @param {string} cellId - The target cell ID.
 * @param {string} fontName - The font display name (key of FONT_FAMILY_MAP).
 */
const setCellFont = (cellId, fontName) => {
  // Cache selected cell IDs to avoid multiple DOM/calculation overhead when checking inclusion.
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];

  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    cell.style.fontFamily = fontName;
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });

  recordHistoryAction({ type: 'multi', changes: historyChanges });
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

// Default cell font size (in points) shown when a cell has no explicit size.
const DEFAULT_FONT_SIZE = 10;
// Bounds enforced for custom font sizes entered by the user.
const MIN_FONT_SIZE = 1;
const MAX_FONT_SIZE = 400;

/**
 * Clamps a font size to the supported range, returning null if not a valid number.
 * @param {*} size - Raw size value.
 * @returns {number|null} An integer within bounds, or null when invalid.
 */
const clampFontSize = (size) => {
  const parsed = parseInt(size, 10);
  if (isNaN(parsed)) return null;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parsed));
};

// Vertical breathing room (px) kept between the text and the top/bottom cell
// edges so larger fonts never butt up against the boundary.
const CELL_VERTICAL_PADDING = 10;
const CELL_LINE_HEIGHT_FACTOR = 1.2;
const PT_TO_PX = 96 / 72;

/**
 * Computes the minimum cell height (px) needed to comfortably fit a font size,
 * preserving breathing room from the cell boundary. Returns null for sizes at
 * or below the default so those rows keep the base grid height unchanged.
 * @param {number} fontSize - Font size in points.
 * @returns {number|null} Height in px, or null to use the default row height.
 */
const getCellMinHeight = (fontSize) => {
  const size = clampFontSize(fontSize);
  if (size === null || size <= DEFAULT_FONT_SIZE) return null;
  return Math.round(size * PT_TO_PX * CELL_LINE_HEIGHT_FACTOR) + CELL_VERTICAL_PADDING;
};

/**
 * Recompute the active sheet's font-driven row heights (see autoFontRowHeights)
 * from the model: a row grows to the tallest getCellMinHeight among its non-empty
 * cells. Deterministic and DOM-free — it mirrors the per-cell min-height the
 * renderer applies (only a value-bearing cell above the default font grows a row)
 * — so getRowHeight stays exact for these rows even when they are off-screen.
 * Called once per render; the map then serves the scroll handler between renders.
 */
const rebuildAutoFontRowHeights = () => {
  const next = Object.create(null);
  const cells = localSheets[activeSheetName];
  if (cells) {
    for (const id in cells) {
      const cell = cells[id];
      // Only a value-bearing cell grows its row (matches the renderer's `val ?`);
      // treat 0 / false as present, skip null / undefined / empty string.
      if (!cell || !cell.style || !cell.style.fontSize) continue;
      if (cell.value == null || cell.value === '') continue;
      const mh = getCellMinHeight(cell.style.fontSize);
      if (!mh) continue;
      const coord = parseCellCoord(id);
      if (!coord) continue;
      if (!(next[coord.row] >= mh)) next[coord.row] = mh;
    }
  }
  autoFontRowHeights = next;
};

/**
 * Sets a cell's font size and syncs state for the current selection range.
 * @param {string} cellId - The target cell ID.
 * @param {number} size - The font size in points.
 */
const setCellFontSize = (cellId, size) => {
  const fontSize = clampFontSize(size);
  if (fontSize === null) return;

  // Cache selected cell IDs to avoid multiple DOM/calculation overhead when checking inclusion.
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];

  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    cell.style.fontSize = fontSize;
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });

  recordHistoryAction({ type: 'multi', changes: historyChanges });
  // No recalculateSheet(): font size is display-only and never changes a value
  // (see #98). The selection still needs re-measuring for the new cell height.
  // Re-measure the selection frame so it matches the new (taller/shorter) cells.
  updateRangeSelectionUI();
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

// ---------------------------------------------------------------------------
// Cell borders. A cell's borders live in `style.borders = { top,right,bottom,left }`
// where each side is null or `{ color, style }` (style ∈ BORDER_STYLE_CSS keys).
// Legacy data may carry a boolean `style.border` (all sides, thin grey) — still honoured.
// `currentBorderColor` / `currentBorderStyle` are the pen settings the border menu applies.
// ---------------------------------------------------------------------------
const BORDER_STYLE_CSS = {
  thin:   (c) => `1px solid ${c}`,
  medium: (c) => `2px solid ${c}`,
  thick:  (c) => `3px solid ${c}`,
  dashed: (c) => `1px dashed ${c}`,
  dotted: (c) => `1px dotted ${c}`,
  double: (c) => `3px double ${c}`,
};
let currentBorderColor = '#000000';
let currentBorderStyle = 'thin';

// Width (px) and line type of each border style. The width doubles as the
// "visual weight" used to resolve which of two coincident specs wins a shared
// edge — a heavier border must not be hidden behind a lighter one.
const BORDER_WEIGHT = { thin: 1, dashed: 1, dotted: 1, medium: 2, thick: 3, double: 3 };
const BORDER_LINE = { thin: 'solid', medium: 'solid', thick: 'solid', dashed: 'dashed', dotted: 'dotted', double: 'double' };
/** Weight of a border spec (0 if none); higher draws over a lighter neighbour. */
const borderWeight = (spec) => (spec ? (BORDER_WEIGHT[spec.style] || 1) : 0);
/** Build a full-width CSS border value for a spec (used only in history mode). */
const borderCss = (spec) =>
  `${BORDER_WEIGHT[spec.style] || 1}px ${BORDER_LINE[spec.style] || 'solid'} ${spec.color || '#000000'}`;
// Width (px) of a cell's default gridline border — must match the
// `border-right`/`border-bottom` width on `.grid-cell`. Border overlays are
// positioned relative to the padding box, which sits this far inside the track
// boundary on the gridline sides, so the offset is compensated by it.
const GRIDLINE_W = 1;
// Shared read-only stand-in for a blank cell's (absent) style, so applyCellBorders
// can still be asked to paint a bordered neighbour's edge without allocating.
const EMPTY_STYLE = Object.freeze({});
// Shared empty list for the "no overlays to preserve" fast path in updateGridDOMCell
// (its .forEach is a no-op), so that path allocates nothing per cell.
const EMPTY_ELS = Object.freeze([]);

/**
 * Returns the border spec for one side of a cell's style, normalising the
 * legacy boolean `style.border` to a thin-grey spec on every side.
 * @returns {?{color:string,style:string}}
 */
const cellBorderSide = (style, side) => {
  if (!style) return null;
  if (style.border && !style.borders) return { color: '#717686', style: 'thin' };
  return style.borders ? (style.borders[side] || null) : null;
};

/** True if a style carries any border (legacy boolean or any structured side). */
const styleHasBorders = (style) => !!(style && (style.border || (style.borders &&
  (style.borders.top || style.borders.right || style.borders.bottom || style.borders.left))));

/**
 * Append a single border line as an absolutely-positioned overlay on `cellEl`.
 *
 * A whole cell's borders are normally drawn by ONE box overlay (addBorderBox);
 * this single-edge helper now only draws the SECOND, reinforcing copy of a grid-
 * frame edge (column A's left, row 1's top — see applyCellBorders). The line is
 * drawn at its full integer width (so thin/medium/thick stay visually distinct —
 * fractional CSS border widths round to a 1px minimum and collapse together) and
 * CENTRED on the cell boundary, half its width on each side, coinciding exactly
 * with the box overlay's same edge so the two reinforce each other.
 * @param {HTMLElement} cellEl
 * @param {'top'|'right'|'bottom'|'left'} edge
 * @param {{color:string,style:string}} spec
 */
const addBorderLine = (cellEl, edge, spec) => {
  const w = BORDER_WEIGHT[spec.style] || 1;
  const line = BORDER_LINE[spec.style] || 'solid';
  const color = spec.color || '#000000';
  // Centre the line on the track boundary: push it out by half its width so
  // half sits each side. The right/bottom edges carry the default gridline
  // border, so the padding box (which absolute offsets reference) is GRIDLINE_W
  // inside the track boundary there; left/top have no default border, so their
  // padding box already sits on the boundary.
  const half = w / 2;
  const off = (edge === 'right' || edge === 'bottom') ? -(GRIDLINE_W + half) : -half;
  const el = document.createElement('div');
  el.className = 'grid-border-line';
  // Span the full track on the cross axis, overrunning the padding box at BOTH
  // ends so this line reaches the outline's outer corners and meets the
  // perpendicular edges flush. Overrunning the far end lets a cell's own
  // right+bottom overlap and fill its bottom-right corner; overrunning the near
  // end (top for verticals, left for horizontals) is the symmetric fix for the
  // top-left corner, whose left edge is drawn by the left neighbour and top edge
  // by the upper neighbour — without it those two lines only met at a point,
  // leaving the corner open (#82).
  //
  // The overrun must reach the outline's outer corner, which sits half the
  // perpendicular line's width beyond the boundary. For a frame of uniform
  // weight that equals THIS line's own half-width, so a fixed GRIDLINE_W (1px)
  // overrun fell short of a thick line's 1.5px half — leaving a ~0.5px notch
  // chipped out of every corner (#86). Overrun by max(GRIDLINE_W, half): thin /
  // medium keep the 1px gridline-gap overhang, thick / double reach their full
  // 1.5px so the corners close.
  const over = Math.max(GRIDLINE_W, half);
  let css = 'position:absolute;pointer-events:none;z-index:3;';
  if (edge === 'right' || edge === 'left') {
    css += `top:-${over}px;bottom:-${over}px;width:0;${edge}:${off}px;border-left:${w}px ${line} ${color};`;
  } else {
    css += `left:-${over}px;right:-${over}px;height:0;${edge}:${off}px;border-top:${w}px ${line} ${color};`;
  }
  el.style.cssText = css;
  cellEl.appendChild(el);
};

/**
 * Append ONE overlay box carrying all of a cell's effective border sides.
 *
 * A cell's four edges used to be four separate overlay lines; on a borders-heavy
 * sheet that meant ~4 overlay <div>s per cell (~100k extra nodes for a full
 * 1000×26 grid), and laying out / painting that many absolutely-positioned nodes
 * froze the main thread for seconds when opening or switching to the sheet
 * (#88). A single box carrying border-top/right/bottom/left collapses that to one
 * node per cell, and CSS mitres its corners so a thick frame closes flush (no
 * #86 notch) and a cell's own edges can never chip each other (no #80 within a
 * cell).
 *
 * The box is positioned so each present border is CENTRED on its track boundary
 * (half its width each side, Excel/Sheets style): the borderless near sides
 * (top/left) reference a padding box on the boundary, so the inset is -half; the
 * gridline-bearing far sides (right/bottom) reference a padding box GRIDLINE_W
 * inside the boundary, so the inset is -(GRIDLINE_W + half). An absent side gets
 * a zero-width border and a flush inset, so it neither paints nor shifts the box.
 * box-sizing:border-box keeps the borders inside the inset-defined edges.
 *
 * Each cell draws its own box, so an interior boundary is still drawn by BOTH
 * neighbours (coincident, reinforcing at fractional DPR) and the half a higher-
 * stacking neighbour (the active cell, z-index 6) repaints over is always
 * redrawn by that neighbour's own box — the boundary survives any repaint.
 * @param {HTMLElement} cellEl
 * @param {?{color:string,style:string}} top
 * @param {?{color:string,style:string}} right
 * @param {?{color:string,style:string}} bottom
 * @param {?{color:string,style:string}} left
 */
const addBorderBox = (cellEl, top, right, bottom, left) => {
  const half = (spec) => (spec ? (BORDER_WEIGHT[spec.style] || 1) / 2 : 0);
  const sideCss = (spec) =>
    `${BORDER_WEIGHT[spec.style] || 1}px ${BORDER_LINE[spec.style] || 'solid'} ${spec.color || '#000000'}`;
  const el = document.createElement('div');
  el.className = 'grid-border-line';
  let css = 'position:absolute;pointer-events:none;z-index:3;box-sizing:border-box;';
  css += `top:-${half(top)}px;left:-${half(left)}px;`;
  css += `right:-${GRIDLINE_W + half(right)}px;bottom:-${GRIDLINE_W + half(bottom)}px;`;
  if (top) css += `border-top:${sideCss(top)};`;
  if (right) css += `border-right:${sideCss(right)};`;
  if (bottom) css += `border-bottom:${sideCss(bottom)};`;
  if (left) css += `border-left:${sideCss(left)};`;
  el.style.cssText = css;
  cellEl.appendChild(el);
};

/**
 * Applies a cell's stored borders to its DOM element.
 *
 * A border between two cells is centred on the shared boundary, so it bleeds
 * equally into both cells the way a spreadsheet's gridlines do. Because a centred
 * border crosses the boundary, EACH cell draws its own copy of every edge it
 * touches — both neighbours resolve the edge to the heavier of the two specs via
 * pick(), so a thick border is never hidden behind a neighbour's thin one, and a
 * neighbour with a higher stacking context (the active cell) repaints over only
 * its own copy, never erasing the boundary. A cell's four effective edges are
 * emitted as ONE box overlay (addBorderBox) rather than four separate lines, to
 * keep the node count down on borders-heavy sheets (#88). A cell suppresses its
 * own default gridline on the right/bottom of any edge it draws so the gridline
 * doesn't peek out beside the custom line.
 *
 * History mode renders from a snapshot (no live neighbours), so it falls back
 * to plain full-width CSS borders on each cell's four stored sides.
 * @param {HTMLElement} cellEl - The grid cell element.
 * @param {Object} [style] - The cell's style object.
 * @param {string} [cellId] - The cell ID, enabling neighbour-aware rendering.
 */
const applyCellBorders = (cellEl, style, cellId) => {
  if (!cellEl) return;
  // Clear any overlay lines / suppressed gridlines from a previous render so
  // repeated calls on the same element stay idempotent. The querySelectorAll is
  // worth skipping when the cell has no element children at all (nothing to
  // remove) — it runs once per cell on every full render and every targeted update
  // (e.g. clearing formatting over a large selection, #92).
  if (cellEl.firstElementChild) {
    cellEl.querySelectorAll(':scope > .grid-border-line').forEach((e) => e.remove());
  }
  cellEl.style.borderRightColor = '';
  cellEl.style.borderBottomColor = '';
  if (!style) return;

  const coord = (cellId && !isHistoryMode) ? parseCellCoord(cellId) : null;

  if (!coord) {
    // No neighbour context (history mode): draw each stored side full width.
    const top = cellBorderSide(style, 'top'), left = cellBorderSide(style, 'left');
    const right = cellBorderSide(style, 'right'), bottom = cellBorderSide(style, 'bottom');
    if (top) cellEl.style.borderTop = borderCss(top);
    if (left) cellEl.style.borderLeft = borderCss(left);
    if (right) cellEl.style.borderRight = borderCss(right);
    if (bottom) cellEl.style.borderBottom = borderCss(bottom);
    return;
  }

  const c = coord.colIndex, r = coord.row;
  const sideOf = (id, side) => cellBorderSide(localCells[id] && localCells[id].style, side);
  // Effective boundary spec = heavier of the two coincident sides; equal
  // weights resolve to the left/top cell so both neighbours agree.
  const pick = (lo, hi) => (borderWeight(lo) >= borderWeight(hi) ? lo : hi);

  // A merged anchor is rendered as a single element spanning its whole block, so
  // its right/bottom boundary is the FAR edge of the block. applyBordersToSelection
  // stores the block's outer border on the perimeter members, so the right spec
  // lives on the top-right member and the bottom spec on the bottom-left member,
  // and the neighbour past the boundary is one track beyond the span. A 1×1 cell
  // spans itself, reducing to the anchor and its immediate neighbour.
  const isMerged = !!(style.merge && style.merge.rows * style.merge.cols > 1);
  const rightCol = isMerged ? c + style.merge.cols - 1 : c;
  const bottomRow = isMerged ? r + style.merge.rows - 1 : r;
  const ownRight = isMerged ? sideOf(`${getColLetter(rightCol)}${r}`, 'right') : cellBorderSide(style, 'right');
  const ownBottom = isMerged ? sideOf(`${getColLetter(c)}${bottomRow}`, 'bottom') : cellBorderSide(style, 'bottom');

  // Resolve each boundary to its effective spec (heavier of the two coincident
  // sides). Right/bottom are owned by this cell, merged with the neighbour past
  // the boundary; left/top are shared with the preceding neighbour, with the tie
  // resolving to that neighbour (the left/top owner) so both cells agree on which
  // spec wins. At the grid's outer edge (column A / row 1) there is no preceding
  // neighbour, so the cell's own side stands alone.
  const rightEff = pick(ownRight, sideOf(`${getColLetter(rightCol + 1)}${r}`, 'left'));
  const bottomEff = pick(ownBottom, sideOf(`${getColLetter(c)}${bottomRow + 1}`, 'top'));
  const leftNbr = c > 0 ? sideOf(`${getColLetter(c - 1)}${r}`, 'right') : null;
  const leftEff = pick(leftNbr, cellBorderSide(style, 'left'));
  const topNbr = r > 1 ? sideOf(`${getColLetter(c)}${r - 1}`, 'bottom') : null;
  const topEff = pick(topNbr, cellBorderSide(style, 'top'));

  // Suppress this cell's own default gridline wherever it draws a custom edge, so
  // the grey gridline doesn't peek out beside the custom line.
  if (rightEff) cellEl.style.borderRightColor = 'transparent';
  if (bottomEff) cellEl.style.borderBottomColor = 'transparent';

  // Draw all four effective edges as ONE box overlay (one node per cell instead
  // of one per edge — see addBorderBox / #88). Its mitred corners close a frame
  // flush and keep a cell's own edges from chipping each other.
  if (topEff || rightEff || bottomEff || leftEff) {
    addBorderBox(cellEl, topEff, rightEff, bottomEff, leftEff);
    // An interior boundary is reinforced by the facing neighbour's own coincident
    // box, so it stays full-weight when it lands on a fractional device pixel
    // (e.g. at 150% zoom). The grid's physical frame — column A's left, row 1's
    // top — has no neighbour to draw that second copy, so a lone box edge there
    // anti-aliases to half intensity and looks thinner than the other sides. Add
    // a single-edge reinforcing copy that coincides with the box's frame edge.
    if (c === 0 && leftEff) addBorderLine(cellEl, 'left', leftEff);
    if (r === 1 && topEff) addBorderLine(cellEl, 'top', topEff);
  }
};

/**
 * Applies a border mode to the current selection, using the current pen
 * color/style. Edge-aware: "outer" hits the selection perimeter, "inner"/
 * "horizontal"/"vertical" hit interior edges, "clear" removes all borders.
 * @param {('all'|'inner'|'horizontal'|'vertical'|'outer'|'left'|'top'|'right'|'bottom'|'clear')} mode
 */
const applyBordersToSelection = (mode) => {
  // Perimeter/interior edges are defined against one rectangle's bounds;
  // ignore Ctrl+click extra ranges.
  const ids = getSelectedCellIds({ activeRangeOnly: true });
  if (!ids.length) return;

  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  ids.forEach((id) => {
    const c = parseCellCoord(id);
    if (!c) return;
    if (c.colIndex < minCol) minCol = c.colIndex;
    if (c.colIndex > maxCol) maxCol = c.colIndex;
    if (c.row < minRow) minRow = c.row;
    if (c.row > maxRow) maxRow = c.row;
  });

  const mkSpec = () => ({ color: currentBorderColor, style: currentBorderStyle });
  const specEq = (a, b) => (!a && !b) || !!(a && b && a.color === b.color && a.style === b.style);
  const historyChanges = [];
  const colCount = getColCount(activeSheetName);
  const selectedSet = new Set(ids);
  // A shared boundary stores a spec on each cell's facing side, and both cells
  // resolve it with pick() to draw their own coincident copy. When a freshly-
  // applied side ties an already-bordered neighbour's coincident side, pick()
  // keeps the neighbour's (stale) spec, so the just-applied colour would show
  // only on the target's own copy while the neighbour's copy kept the old colour
  // (#82). Mirror each set side onto the neighbour's opposite face so the
  // boundary is stored consistently and both copies paint the applied spec. Only
  // the FOUR neighbour opposite of a
  // changed side, only when that neighbour already holds a *different* non-null
  // spec there (a null face already loses to the applied one in pick(), so leave
  // empty neighbours untouched — no record/history bloat), and never a neighbour
  // that is itself in the selection (it sets its own face).
  const propTargets = [];

  ids.forEach((id) => {
    const coord = parseCellCoord(id);
    if (!coord) return;
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const beforeBorders = (before.style && before.style.borders) || {};
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};
    delete cell.style.border; // drop legacy boolean in favour of structured borders

    const b = Object.assign({ top: null, right: null, bottom: null, left: null }, cell.style.borders || {});
    const isTop = coord.row === minRow;
    const isBottom = coord.row === maxRow;
    const isLeft = coord.colIndex === minCol;
    const isRight = coord.colIndex === maxCol;

    switch (mode) {
      case 'all':
        b.top = mkSpec(); b.right = mkSpec(); b.bottom = mkSpec(); b.left = mkSpec();
        break;
      case 'inner':
        if (!isTop) b.top = mkSpec();
        if (!isBottom) b.bottom = mkSpec();
        if (!isLeft) b.left = mkSpec();
        if (!isRight) b.right = mkSpec();
        break;
      case 'horizontal':
        if (!isTop) b.top = mkSpec();
        if (!isBottom) b.bottom = mkSpec();
        break;
      case 'vertical':
        if (!isLeft) b.left = mkSpec();
        if (!isRight) b.right = mkSpec();
        break;
      case 'outer':
        if (isTop) b.top = mkSpec();
        if (isBottom) b.bottom = mkSpec();
        if (isLeft) b.left = mkSpec();
        if (isRight) b.right = mkSpec();
        break;
      case 'left':   if (isLeft) b.left = mkSpec(); break;
      case 'top':    if (isTop) b.top = mkSpec(); break;
      case 'right':  if (isRight) b.right = mkSpec(); break;
      case 'bottom': if (isBottom) b.bottom = mkSpec(); break;
      case 'clear':
        b.top = null; b.right = null; b.bottom = null; b.left = null;
        break;
    }

    if (!b.top && !b.right && !b.bottom && !b.left) {
      delete cell.style.borders;
    } else {
      cell.style.borders = b;
    }
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }

    // Record neighbour faces to mirror: each side this op set to a new non-null
    // spec, whose opposite-face neighbour exists in-grid and isn't itself selected.
    // (A cleared side leaves b[side] null, so 'clear' propagates nothing here and
    // keeps its current behaviour.)
    const r = coord.row, c = coord.colIndex;
    const neigh = {
      top:    { id: `${getColLetter(c)}${r - 1}`, face: 'bottom', ok: r - 1 >= 1 },
      bottom: { id: `${getColLetter(c)}${r + 1}`, face: 'top',    ok: r + 1 <= TOTAL_ROWS },
      left:   { id: `${getColLetter(c - 1)}${r}`, face: 'right',  ok: c - 1 >= 0 },
      right:  { id: `${getColLetter(c + 1)}${r}`, face: 'left',   ok: c + 1 < colCount },
    };
    ['top', 'bottom', 'left', 'right'].forEach((side) => {
      if (!b[side] || specEq(b[side], beforeBorders[side])) return; // unchanged / not set
      const n = neigh[side];
      if (n.ok && !selectedSet.has(n.id)) propTargets.push({ id: n.id, face: n.face });
    });
  });

  // Apply the mirrored faces (deduped per neighbour), but only where the neighbour
  // currently holds a different non-null spec on that face — see note above.
  const propByCell = new Map();
  propTargets.forEach(({ id, face }) => {
    if (!propByCell.has(id)) propByCell.set(id, new Set());
    propByCell.get(id).add(face);
  });
  propByCell.forEach((faces, id) => {
    const existing = localCells[id] && localCells[id].style && localCells[id].style.borders;
    const toSet = [...faces].filter((face) => existing && existing[face] && !specEq(existing[face], mkSpec()));
    if (!toSet.length) return;
    const before = JSON.parse(JSON.stringify(localCells[id]));
    const cell = localCells[id];
    if (!cell.style.borders) cell.style.borders = { top: null, right: null, bottom: null, left: null };
    toSet.forEach((face) => { cell.style.borders[face] = mkSpec(); });
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
  });

  // Render only after every cell is mutated, so neighbour-aware edge de-duping
  // reads final state. Also refresh the ring of cells just outside the
  // selection: an edge's winning side can flip in either direction, so a
  // neighbour on any of the four sides may need to start or stop drawing the
  // shared edge.
  const renderIds = new Set(ids);
  propByCell.forEach((_faces, id) => renderIds.add(id));
  for (let r = minRow; r <= maxRow; r++) {
    if (minCol - 1 >= 0) renderIds.add(`${getColLetter(minCol - 1)}${r}`);
    if (maxCol + 1 < colCount) renderIds.add(`${getColLetter(maxCol + 1)}${r}`);
  }
  for (let c = minCol; c <= maxCol; c++) {
    if (minRow - 1 >= 1) renderIds.add(`${getColLetter(c)}${minRow - 1}`);
    if (maxRow + 1 <= TOTAL_ROWS) renderIds.add(`${getColLetter(c)}${maxRow + 1}`);
  }
  // A border change touches only the overlay edges — not the cell's text, other
  // styles, or its text-overflow spill. So refresh just the border overlays on
  // each affected cell (applyCellBorders) instead of rebuilding the whole cell
  // via updateGridDOMCell, which rewrites innerText, re-evaluates the value,
  // resets ~a dozen inline styles, re-appends cursor/presence nodes AND schedules
  // a full row-overflow recompute (a forced reflow of the 1000-row grid) per
  // touched row. applyCellBorders is self-contained: it clears its own prior
  // overlays and gridline suppression first, so calling it directly is idempotent.
  renderIds.forEach((id) => {
    const el = getCellEl(id);
    if (!el) return;
    const st = (localCells[id] && localCells[id].style) || EMPTY_STYLE;
    applyCellBorders(el, st, id);
  });

  recordHistoryAction({ type: 'multi', changes: historyChanges });
  // No recalculateSheet(): a border never changes any cell's value, so walking
  // every cell and re-evaluating every formula here was pure waste — a full-sheet
  // recalc on each border click on a formula-heavy sheet.
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Sets a cell's text alignment (left, center, or right) and syncs for selection range.
 * @param {string} cellId - The target cell ID.
 * @param {string} alignment - The alignment direction ('left', 'center', 'right').
 */
const setCellAlignment = (cellId, alignment) => {
  // Cache selected cell IDs to avoid multiple DOM/calculation overhead when checking inclusion.
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];

  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};

    if (alignment && ['left', 'center', 'right'].includes(alignment)) {
      cell.style.align = alignment;
    } else {
      delete cell.style.align;
    }
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });

  recordHistoryAction({ type: 'multi', changes: historyChanges });
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Sets a cell's vertical alignment (top, center, or bottom) and syncs for selection range.
 * @param {string} cellId - The target cell ID.
 * @param {string} alignment - The alignment direction ('top', 'center', 'bottom').
 */
const setCellVerticalAlignment = (cellId, alignment) => {
  // Cache selected cell IDs to avoid multiple DOM/calculation overhead when checking inclusion.
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];

  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    if (!cell.style) cell.style = {};

    if (alignment && ['top', 'center', 'bottom'].includes(alignment)) {
      cell.style.verticalAlign = alignment;
    } else {
      delete cell.style.verticalAlign;
    }
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }
    updateGridDOMCell(id, getCellValue(id), cell.style);
  });

  recordHistoryAction({ type: 'multi', changes: historyChanges });
  // No recalculateSheet(): a style change never alters a cell value — formulas
  // read referenced cells' values, not their styles — so a recalc here only
  // re-derives identical values. (Same reasoning as clearFormatting; see #98.)
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Updates the URL link property of a cell and syncs.
 * @param {string} cellId - The target cell ID.
 * @param {string} url - The URL destination string.
 */
const changeCellLink = (cellId, url) => {
  // Capture cell state before update for undo/redo history
  const before = localCells[cellId] ? JSON.parse(JSON.stringify(localCells[cellId])) : { formula: '', value: '', style: {} };

  const cell = localCells[cellId] || { formula: '', value: '', style: {} };
  if (!cell.style) cell.style = {};
  if (url) {
    cell.style.link = url;
  } else {
    delete cell.style.link;
  }
  localCells[cellId] = cell;

  // Record action to undo stack
  recordHistoryAction(cellId, before, cell);

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId, formula: cell.formula, value: cell.value, style: cell.style }
    }));
  }
  updateGridDOMCell(cellId, getCellValue(cellId), cell.style);
  // No recalculateSheet(): setting/clearing a link is display-only and never
  // changes a cell value (see #98).
  updateToolbarFormattingStates(cell.style);
};

/** Teardown callback for the currently-open link chip popup, if any. */
let linkPopupCleanup = null;

/** Close the floating link-chip popup and detach its dismiss listeners. */
const closeLinkPopup = () => {
  const existing = document.getElementById('cell-link-popup');
  if (existing) existing.remove();
  if (linkPopupCleanup) { linkPopupCleanup(); linkPopupCleanup = null; }
};

/**
 * Show a Google-Sheets-style link chip anchored beneath a cell: favicon, the URL,
 * and copy / edit / remove actions. Clicking a linked cell opens this chip instead
 * of navigating straight to the URL.
 * @param {string} cellId - The cell whose link is shown.
 * @param {HTMLElement} cellEl - The cell element the chip is anchored to.
 */
const showLinkPopup = (cellId, cellEl) => {
  closeLinkPopup();
  const cell = localCells[cellId];
  const url = cell && cell.style && cell.style.link;
  if (!url) return;

  const safeUrl = escapeHtml(url);
  let host = url;
  try { host = new URL(url, window.location.href).hostname || url; } catch { /* keep raw */ }
  const btnCls = 'flex items-center justify-center w-8 h-8 rounded-full hover:bg-surface-variant cursor-pointer';
  const iconCls = 'material-symbols-outlined text-[18px] leading-none text-on-surface-variant';

  const popup = document.createElement('div');
  popup.id = 'cell-link-popup';
  popup.className = 'fixed z-[1002] flex items-center gap-1 max-w-md pl-3 pr-1.5 py-1 bg-surface-container-lowest dark:bg-inverse-surface text-on-surface dark:text-on-surface-variant rounded-lg shadow-lg border border-outline-variant';
  popup.innerHTML = `
    <img id="link-popup-favicon" src="https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}" alt="" class="w-4 h-4 shrink-0">
    <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="flex-1 min-w-0 truncate text-blue-600 hover:underline text-label-lg" title="${safeUrl}">${safeUrl}</a>
    <button type="button" id="link-popup-copy" class="${btnCls}" title="${escapeHtml(t('link.copy'))}"><span class="${iconCls}">content_copy</span></button>
    <button type="button" id="link-popup-edit" class="${btnCls}" title="${escapeHtml(t('link.edit'))}"><span class="${iconCls}">edit</span></button>
    <button type="button" id="link-popup-remove" class="${btnCls}" title="${escapeHtml(t('link.remove'))}"><span class="${iconCls}">link_off</span></button>
  `;
  document.body.appendChild(popup);

  // If the remote favicon fails to load, fall back to a generic globe glyph.
  const favicon = popup.querySelector('#link-popup-favicon');
  favicon.addEventListener('error', () => {
    const globe = document.createElement('span');
    globe.className = iconCls + ' shrink-0';
    globe.textContent = 'public';
    favicon.replaceWith(globe);
  });

  // Position below the cell, clamped to the viewport (flip above if it would overflow).
  const rect = cellEl.getBoundingClientRect();
  const pr = popup.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + pr.width > window.innerWidth) left = Math.max(4, window.innerWidth - pr.width - 4);
  if (top + pr.height > window.innerHeight) top = Math.max(4, rect.top - pr.height - 4);
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  // Copy: write the URL to the clipboard, with brief icon feedback.
  const copyBtn = popup.querySelector('#link-popup-copy');
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(url); } catch { /* clipboard unavailable */ }
    const icon = copyBtn.querySelector('span');
    if (icon) icon.textContent = 'check';
    copyBtn.title = t('link.copied');
  };
  // Edit: open the insert/edit-link dialog seeded with this cell's text and URL.
  popup.querySelector('#link-popup-edit').onclick = () => {
    closeLinkPopup();
    openLinkDialog(cellId, cellEl);
  };
  // Remove: strip the link from the cell.
  popup.querySelector('#link-popup-remove').onclick = () => {
    changeCellLink(cellId, '');
    closeLinkPopup();
  };

  // Dismiss on outside click, Escape, or scroll/resize. The mousedown listener is
  // attached on the next tick so the click that opened the chip doesn't close it.
  const onDocMouseDown = (e) => { if (!popup.contains(e.target)) closeLinkPopup(); };
  const onKey = (e) => { if (e.key === 'Escape') closeLinkPopup(); };
  const onReflow = () => closeLinkPopup();
  setTimeout(() => document.addEventListener('mousedown', onDocMouseDown), 0);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onReflow);
  window.addEventListener('scroll', onReflow, true);
  linkPopupCleanup = () => {
    document.removeEventListener('mousedown', onDocMouseDown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('scroll', onReflow, true);
  };
};

/**
 * Commits a cell's display text and link together as a single undoable action.
 * Mirrors saveCellUpdate's value/formula handling, then sets or clears the link.
 * @param {string} cellId - The target cell ID.
 * @param {string} text - The text to display in the cell (may be a formula).
 * @param {string} url - The link URL; empty string removes the link.
 */
const applyCellLink = (cellId, text, url) => {
  if (!canEditWorkbook) return; // read-only: ignore
  const before = localCells[cellId] ? JSON.parse(JSON.stringify(localCells[cellId])) : { formula: '', value: '', style: {} };

  const cell = localCells[cellId] || { formula: '', value: '', style: {} };
  if (!cell.style) cell.style = {};
  if (text.startsWith('=')) {
    cell.formula = text;
    cell.value = evaluateFormula(text, 0, cellId);
  } else {
    cell.formula = '';
    cell.value = text;
  }
  if (url) cell.style.link = url; else delete cell.style.link;
  localCells[cellId] = cell;

  recordHistoryAction(cellId, before, cell);
  recalculateSheet();
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId, formula: cell.formula, value: cell.value, style: cell.style }
    }));
  }
  updateGridDOMCell(cellId, getCellValue(cellId), cell.style);
  if (activeCellId === cellId) {
    const formulaBar = document.getElementById('formula-bar-input');
    if (formulaBar) formulaBar.value = cell.formula ? cell.formula : cell.value;
    updateToolbarFormattingStates(cell.style);
  }
};

/** Teardown callback for the currently-open insert/edit-link dialog, if any. */
let linkDialogCleanup = null;

/** Close the insert/edit-link dialog and detach its listeners. */
const closeLinkDialog = () => {
  const existing = document.getElementById('cell-link-dialog');
  if (existing) existing.remove();
  if (linkDialogCleanup) { linkDialogCleanup(); linkDialogCleanup = null; }
};

/**
 * Open the insert/edit-link dialog: a small panel with a "Text" field (what the
 * cell shows) and a link field, plus an Apply action. Used by the toolbar button,
 * the right-click "Insert link" item, and the link chip's "Edit" button. Esc
 * cancels; clicking outside dismisses.
 * @param {string} cellId - The cell receiving the link.
 * @param {HTMLElement} [cellEl] - Cell element to anchor the dialog to (defaults to the cell's DOM node).
 */
const openLinkDialog = (cellId, cellEl) => {
  if (!canEditWorkbook) return; // viewers cannot edit
  closeLinkPopup();
  closeLinkDialog();

  const anchorEl = cellEl || document.querySelector(`[data-cell-id="${cellId}"]`);
  const cellData = localCells[cellId] || { formula: '', value: '', style: {} };
  const currentText = cellData.formula ? cellData.formula : (cellData.value || '');
  const currentUrl = cellData.style && cellData.style.link ? cellData.style.link : '';

  // Both fields share one size: ~2.5x a default cell wide, ~1.3x a default cell tall.
  const groupCls = 'flex items-center gap-2 px-2.5 w-[250px] h-[27px] rounded-lg border border-outline-variant focus-within:border-primary focus-within:ring-1 focus-within:ring-primary';
  const iconCls = 'material-symbols-outlined text-[18px] leading-none text-on-surface-variant';
  const inputCls = 'flex-1 min-w-0 bg-transparent border-0 outline-none focus:ring-0 text-label-lg text-on-surface placeholder:text-on-surface-variant';

  const dialog = document.createElement('div');
  dialog.id = 'cell-link-dialog';
  dialog.className = 'fixed z-[1003] w-fit flex flex-col gap-2 p-3 bg-surface-container-lowest dark:bg-inverse-surface text-on-surface dark:text-on-surface-variant rounded-xl shadow-lg border border-outline-variant';
  dialog.innerHTML = `
    <label class="${groupCls}">
      <span class="${iconCls}">text_fields</span>
      <input id="link-dialog-text" type="text" class="${inputCls}" placeholder="${escapeHtml(t('link.text'))}">
    </label>
    <div class="flex items-center gap-2">
      <label class="${groupCls}">
        <span class="${iconCls}">search</span>
        <input id="link-dialog-url" type="text" class="${inputCls}" placeholder="${escapeHtml(t('link.urlPlaceholder'))}">
      </label>
      <button type="button" id="link-dialog-apply" class="shrink-0 px-3 py-1.5 rounded-lg text-label-lg font-medium text-primary hover:bg-surface-variant disabled:text-on-surface-variant/50 disabled:cursor-default disabled:hover:bg-transparent">${escapeHtml(t('link.apply'))}</button>
    </div>
  `;
  document.body.appendChild(dialog);

  const textInput = /** @type {HTMLInputElement} */ (dialog.querySelector('#link-dialog-text'));
  const urlInput = /** @type {HTMLInputElement} */ (dialog.querySelector('#link-dialog-url'));
  const applyBtn = /** @type {HTMLButtonElement} */ (dialog.querySelector('#link-dialog-apply'));
  textInput.value = currentText;
  urlInput.value = currentUrl;

  // Apply is enabled only once there is a URL to link to.
  const syncApplyEnabled = () => { applyBtn.disabled = urlInput.value.trim() === ''; };
  syncApplyEnabled();
  urlInput.addEventListener('input', syncApplyEnabled);

  // Position below the anchored cell, clamped to the viewport (flip above if needed).
  if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
    const rect = anchorEl.getBoundingClientRect();
    const dr = dialog.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + dr.width > window.innerWidth) left = Math.max(4, window.innerWidth - dr.width - 4);
    if (top + dr.height > window.innerHeight) top = Math.max(4, rect.top - dr.height - 4);
    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
  } else {
    dialog.style.left = '50%';
    dialog.style.top = '120px';
    dialog.style.transform = 'translateX(-50%)';
  }

  const commit = () => {
    const url = urlInput.value.trim();
    if (!url) return; // nothing to link
    // Default the visible text to the URL when left blank, matching Google Sheets.
    const text = textInput.value !== '' ? textInput.value : url;
    closeLinkDialog();
    applyCellLink(cellId, text, url);
  };
  applyBtn.addEventListener('click', commit);

  // Enter applies (from either field); Esc cancels without changes.
  const onFieldKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLinkDialog(); }
  };
  textInput.addEventListener('keydown', onFieldKey);
  urlInput.addEventListener('keydown', onFieldKey);

  // Dismiss on outside click; reflow/scroll closes to avoid a detached panel.
  // Ignore scrolls originating inside the dialog (e.g. a long pasted URL scrolling
  // the link input horizontally fires a captured 'scroll' that must not dismiss it).
  const onDocMouseDown = (e) => { if (!dialog.contains(e.target)) closeLinkDialog(); };
  const onReflow = (e) => { if (e && e.target && e.target.nodeType && dialog.contains(e.target)) return; closeLinkDialog(); };
  setTimeout(() => document.addEventListener('mousedown', onDocMouseDown), 0);
  window.addEventListener('resize', onReflow);
  window.addEventListener('scroll', onReflow, true);
  linkDialogCleanup = () => {
    document.removeEventListener('mousedown', onDocMouseDown);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('scroll', onReflow, true);
  };

  // Focus the most useful field: the link box (text usually already reflects the cell).
  urlInput.focus();
  urlInput.select();
};

/**
 * Wipes out cell contents and triggers calculations for selection range.
 * @param {string} cellId - Chosen cell ID.
 */
const clearCell = (cellId) => {
  if (!canEditWorkbook) return; // read-only: nothing to clear
  // Cache selected cell IDs to avoid multiple DOM/calculation overhead when checking inclusion.
  const selectedIds = getSelectedCellIds();
  const cellIds = selectedIds.includes(cellId) ? selectedIds : [cellId];
  const historyChanges = [];

  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    localCells[id] = { formula: '', value: '', style: {} };
    historyChanges.push({ cellId: id, before, after: { formula: '', value: '', style: {} } });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: '', value: '', style: {} }
      }));
    }
    updateGridDOMCell(id, '', {});
  });

  recordHistoryAction({ type: 'multi', changes: historyChanges });
  recalculateSheet();
  // Clearing a cell drops its font-driven min-height, so the row shrinks back to
  // the default height. Re-measure the selection so the overlay and its fill
  // handle follow the smaller cell; otherwise they stay at the old, taller size
  // and leave a stray horizontal line across the middle.
  updateRangeSelectionUI();
};

/* ---------------------------------------------------------------------------
 * Row / column insertion
 * ---------------------------------------------------------------------------
 * The grid starts at 26 columns (A-Z) x TOTAL_ROWS and grows rightward up to
 * MAX_COLS as data is pushed past the current edge. Inserting a blank row or
 * column shifts existing cell data down/right (content pushed past the absolute
 * MAX_COLS / TOTAL_ROWS edge is dropped) and rewrites cell references inside
 * every formula so they keep pointing at the same data. The change is recorded
 * as one multi-cell history action and broadcast per-cell, reusing the existing
 * edit/undo/sync plumbing.
 * ------------------------------------------------------------------------- */

/**
 * Rewrites the cell references inside a formula to account for an inserted row
 * or column. String literals and function names are left untouched.
 * @param {string} formula - Formula text (starting with '=').
 * @param {'row'|'col'} mode - Whether a row or column was inserted.
 * @param {number} at - 1-based row number (row mode) or 0-based column index
 *   (col mode) at/after which references shift.
 * @returns {string} The adjusted formula.
 */
const adjustFormulaRefs = (formula, mode, at) => {
  if (typeof formula !== 'string' || formula[0] !== '=') return formula;
  const isAlpha = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  const isDigit = (c) => c >= '0' && c <= '9';
  let out = '=';
  let i = 1;
  const n = formula.length;
  while (i < n) {
    const c = formula[i];
    if (c === '"') { // copy a string literal verbatim ("" escapes a quote)
      out += c; i++;
      while (i < n) { out += formula[i]; if (formula[i] === '"') { if (formula[i + 1] === '"') { out += formula[i + 1]; i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (c === '$' || isAlpha(c)) {
      let k = i, run = '';
      while (k < n && (isAlpha(formula[k]) || isDigit(formula[k]) || formula[k] === '$' || formula[k] === '.')) { run += formula[k]; k++; }
      let m = k; while (m < n && formula[m] === ' ') m++;
      const isFunc = formula[m] === '(';
      const prevCh = formula[i - 1];
      const afterDigit = prevCh && isDigit(prevCh); // avoid mis-reading e.g. 1E5
      const ref = (!isFunc && !afterDigit) ? run.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/) : null;
      if (ref) {
        const colLetters = ref[2].toUpperCase();
        let colIdx = 0;
        for (let q = 0; q < colLetters.length; q++) colIdx = colIdx * 26 + (colLetters.charCodeAt(q) - 64);
        colIdx -= 1;
        let rowNum = parseInt(ref[4], 10);
        if (mode === 'row') { if (rowNum >= at) rowNum += 1; }
        else { if (colIdx >= at) colIdx += 1; }
        out += ref[1] + getColLetter(colIdx) + ref[3] + rowNum;
      } else {
        out += run;
      }
      i = k;
      continue;
    }
    out += c; i++;
  }
  return out;
};

/**
 * Like adjustFormulaRefs, but for a partial-range cell insert (shift right or
 * down) rather than a full row/column insert. A reference is shifted only when
 * the cell it points at lies inside the moved region, mirroring how the data
 * itself moves. Works per-reference token, so range endpoints adjust correctly.
 * @param {string} formula - Formula text (starting with '=').
 * @param {'right'|'down'} direction - Direction existing cells shift.
 * @param {{minCol:number,maxCol:number,minRow:number,maxRow:number}} bounds -
 *   Selection box (minCol/maxCol 0-based, minRow/maxRow 1-based).
 * @param {number} W - Selection width (columns), the right-shift amount.
 * @param {number} H - Selection height (rows), the down-shift amount.
 * @returns {string} The adjusted formula.
 */
const adjustFormulaRefsForCellShift = (formula, direction, bounds, W, H) => {
  if (typeof formula !== 'string' || formula[0] !== '=') return formula;
  const isAlpha = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  const isDigit = (c) => c >= '0' && c <= '9';
  const { minCol, maxCol, minRow, maxRow } = bounds;
  let out = '=';
  let i = 1;
  const n = formula.length;
  while (i < n) {
    const c = formula[i];
    if (c === '"') { // copy a string literal verbatim ("" escapes a quote)
      out += c; i++;
      while (i < n) { out += formula[i]; if (formula[i] === '"') { if (formula[i + 1] === '"') { out += formula[i + 1]; i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (c === '$' || isAlpha(c)) {
      let k = i, run = '';
      while (k < n && (isAlpha(formula[k]) || isDigit(formula[k]) || formula[k] === '$' || formula[k] === '.')) { run += formula[k]; k++; }
      let m = k; while (m < n && formula[m] === ' ') m++;
      const isFunc = formula[m] === '(';
      const prevCh = formula[i - 1];
      const afterDigit = prevCh && isDigit(prevCh);
      const ref = (!isFunc && !afterDigit) ? run.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/) : null;
      if (ref) {
        const colLetters = ref[2].toUpperCase();
        let colIdx = 0;
        for (let q = 0; q < colLetters.length; q++) colIdx = colIdx * 26 + (colLetters.charCodeAt(q) - 64);
        colIdx -= 1;
        let rowNum = parseInt(ref[4], 10);
        if (direction === 'right') {
          if (rowNum >= minRow && rowNum <= maxRow && colIdx >= minCol) colIdx += W;
        } else { // down
          if (colIdx >= minCol && colIdx <= maxCol && rowNum >= minRow) rowNum += H;
        }
        out += ref[1] + getColLetter(colIdx) + ref[3] + rowNum;
      } else {
        out += run;
      }
      i = k;
      continue;
    }
    out += c; i++;
  }
  return out;
};

/**
 * Inserts a blank row or column and shifts existing data, syncing the result.
 * @param {'row'|'col'} mode - Insert a row or a column.
 * @param {number} at - 1-based row number (row mode) or 0-based column index
 *   (col mode) where the blank line is inserted.
 */
const performStructuralInsert = (mode, at) => {
  if (isHistoryMode) return;
  // A column insert adds one column to the grid even if no data sits at the edge.
  const prevCols = mode === 'col' ? getColCount() : 0;
  const oldKeys = Object.keys(localCells);

  // Snapshot current state and compute the shifted target state.
  const before = {};
  const newState = {};
  oldKeys.forEach((id) => {
    before[id] = JSON.parse(JSON.stringify(localCells[id]));
    const { col, row } = parseCoordinates(id); // 0-based
    let newCol = col, newRow = row;
    if (mode === 'row') { if (row + 1 >= at) newRow = row + 1; }
    else { if (col >= at) newCol = col + 1; }
    if (newRow > TOTAL_ROWS - 1 || newCol > MAX_COLS - 1) return; // shifted off-grid -> dropped
    const cell = JSON.parse(JSON.stringify(localCells[id]));
    if (cell.formula) cell.formula = adjustFormulaRefs(cell.formula, mode, at);
    newState[`${getColLetter(newCol)}${newRow + 1}`] = cell;
  });

  // Apply, recording every cell whose content actually changed.
  const EMPTY = { formula: '', value: '', style: {} };
  const affected = new Set([...oldKeys, ...Object.keys(newState)]);
  const changes = [];
  affected.forEach((id) => {
    const beforeCell = before[id] || { formula: '', value: '', style: {} };
    const afterCell = newState[id] || EMPTY;
    if (JSON.stringify(beforeCell) === JSON.stringify(afterCell)) return;
    localCells[id] = JSON.parse(JSON.stringify(afterCell));
    changes.push({ cellId: id, before: beforeCell, after: JSON.parse(JSON.stringify(afterCell)) });
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: afterCell.formula || '', value: afterCell.value || '', style: afterCell.style || {} }
      }));
    }
  });

  // Grow the grid by one column (recorded as colDelta so undo/redo can reverse
  // it — needed even when no cells changed, e.g. inserting into an empty sheet).
  let colDelta = 0;
  if (mode === 'col') {
    const newCount = Math.min(prevCols + 1, MAX_COLS);
    colDelta = newCount - prevCols;
    setActiveColCount(newCount);
  }
  if (changes.length || colDelta) recordHistoryAction({ type: 'multi', changes, colDelta });
  recalculateSheet();
  renderSpreadsheetGrid();

  // The active cell's content may have shifted; keep the formula bar in sync.
  const fb = document.getElementById('formula-bar-input');
  if (fb && activeCellId) {
    const cell = localCells[activeCellId];
    fb.value = cell ? (cell.formula || cell.value || '') : '';
  }
};

/**
 * Inserts blank cells over the current selection, shifting existing cells in
 * the selection's rows (right) or columns (down) to make room. Only the cells
 * in the affected band move — the rest of the sheet stays put — and formula
 * references into the moved band are rewritten. One multi-cell history action.
 * @param {'right'|'down'} direction - Which way existing cells shift.
 */
const performCellInsert = (direction) => {
  if (isHistoryMode) return;
  const b = getInsertSelectionBounds();
  if (!b) return;
  const { minCol, maxCol, minRow, maxRow } = b; // cols 0-based, rows 1-based
  const W = maxCol - minCol + 1;
  const H = maxRow - minRow + 1;
  const oldKeys = Object.keys(localCells);

  // Snapshot current state and compute the shifted target state.
  const before = {};
  const newState = {};
  oldKeys.forEach((id) => {
    before[id] = JSON.parse(JSON.stringify(localCells[id]));
    const coord = parseCellCoord(id);
    if (!coord) return;
    let newCol = coord.colIndex, newRow = coord.row;
    if (direction === 'right') {
      if (coord.row >= minRow && coord.row <= maxRow && coord.colIndex >= minCol) newCol = coord.colIndex + W;
    } else { // down
      if (coord.colIndex >= minCol && coord.colIndex <= maxCol && coord.row >= minRow) newRow = coord.row + H;
    }
    if (newCol > MAX_COLS - 1 || newRow > TOTAL_ROWS) return; // shifted off-grid -> dropped
    const cell = JSON.parse(JSON.stringify(localCells[id]));
    if (cell.formula) cell.formula = adjustFormulaRefsForCellShift(cell.formula, direction, b, W, H);
    newState[`${getColLetter(newCol)}${newRow}`] = cell;
  });

  // Apply, recording every cell whose content actually changed.
  const EMPTY = { formula: '', value: '', style: {} };
  const affected = new Set([...oldKeys, ...Object.keys(newState)]);
  const changes = [];
  affected.forEach((id) => {
    const beforeCell = before[id] || { formula: '', value: '', style: {} };
    const afterCell = newState[id] || EMPTY;
    if (JSON.stringify(beforeCell) === JSON.stringify(afterCell)) return;
    localCells[id] = JSON.parse(JSON.stringify(afterCell));
    changes.push({ cellId: id, before: beforeCell, after: JSON.parse(JSON.stringify(afterCell)) });
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: afterCell.formula || '', value: afterCell.value || '', style: afterCell.style || {} }
      }));
    }
  });

  if (changes.length) recordHistoryAction({ type: 'multi', changes });
  recalculateSheet();
  renderSpreadsheetGrid();

  const fb = document.getElementById('formula-bar-input');
  if (fb && activeCellId) {
    const cell = localCells[activeCellId];
    fb.value = cell ? (cell.formula || cell.value || '') : '';
  }
};

/**
 * Like adjustFormulaRefsForCellShift, but for a partial-range cell delete
 * (shift left or up). References that pointed into the deleted band become
 * #REF!; references beyond the band shift back to follow their data.
 * @param {string} formula
 * @param {'left'|'up'} direction
 * @param {{minCol:number,maxCol:number,minRow:number,maxRow:number}} bounds
 * @param {number} W - Selection width (left-shift amount).
 * @param {number} H - Selection height (up-shift amount).
 * @returns {string}
 */
const adjustFormulaRefsForCellDelete = (formula, direction, bounds, W, H) => {
  if (typeof formula !== 'string' || formula[0] !== '=') return formula;
  const isAlpha = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  const isDigit = (c) => c >= '0' && c <= '9';
  const { minCol, maxCol, minRow, maxRow } = bounds;
  let out = '=';
  let i = 1;
  const n = formula.length;
  while (i < n) {
    const c = formula[i];
    if (c === '"') { // copy a string literal verbatim ("" escapes a quote)
      out += c; i++;
      while (i < n) { out += formula[i]; if (formula[i] === '"') { if (formula[i + 1] === '"') { out += formula[i + 1]; i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (c === '$' || isAlpha(c)) {
      let k = i, run = '';
      while (k < n && (isAlpha(formula[k]) || isDigit(formula[k]) || formula[k] === '$' || formula[k] === '.')) { run += formula[k]; k++; }
      let m = k; while (m < n && formula[m] === ' ') m++;
      const isFunc = formula[m] === '(';
      const prevCh = formula[i - 1];
      const afterDigit = prevCh && isDigit(prevCh);
      const ref = (!isFunc && !afterDigit) ? run.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/) : null;
      if (ref) {
        const colLetters = ref[2].toUpperCase();
        let colIdx = 0;
        for (let q = 0; q < colLetters.length; q++) colIdx = colIdx * 26 + (colLetters.charCodeAt(q) - 64);
        colIdx -= 1;
        let rowNum = parseInt(ref[4], 10);
        let dead = false;
        if (direction === 'left') {
          if (rowNum >= minRow && rowNum <= maxRow) {
            if (colIdx >= minCol && colIdx <= maxCol) dead = true;
            else if (colIdx > maxCol) colIdx -= W;
          }
        } else { // up
          if (colIdx >= minCol && colIdx <= maxCol) {
            if (rowNum >= minRow && rowNum <= maxRow) dead = true;
            else if (rowNum > maxRow) rowNum -= H;
          }
        }
        out += dead ? '#REF!' : (ref[1] + getColLetter(colIdx) + ref[3] + rowNum);
      } else {
        out += run;
      }
      i = k;
      continue;
    }
    out += c; i++;
  }
  return out;
};

/**
 * Deletes the cells in the current selection, pulling the cells beyond the
 * selection back into the gap: 'left' shifts the cells to the right of the
 * selection (same rows) leftwards; 'up' shifts the cells below (same columns)
 * upwards. Only the affected band moves — the rest of the sheet stays put — and
 * formula references into the deleted band are rewritten to #REF!. One
 * multi-cell history action, the mirror of performCellInsert.
 * @param {'left'|'up'} direction - Which way the surviving cells shift.
 */
const performCellDelete = (direction) => {
  if (isHistoryMode) return;
  const b = getInsertSelectionBounds();
  if (!b) return;
  const { minCol, maxCol, minRow, maxRow } = b; // cols 0-based, rows 1-based
  const W = maxCol - minCol + 1;
  const H = maxRow - minRow + 1;
  const oldKeys = Object.keys(localCells);

  // Snapshot current state and compute the shifted-back target state.
  const before = {};
  const newState = {};
  oldKeys.forEach((id) => {
    before[id] = JSON.parse(JSON.stringify(localCells[id]));
    const coord = parseCellCoord(id);
    if (!coord) return;
    let newCol = coord.colIndex, newRow = coord.row;
    if (direction === 'left') {
      if (coord.row >= minRow && coord.row <= maxRow) {
        if (coord.colIndex >= minCol && coord.colIndex <= maxCol) return; // deleted
        if (coord.colIndex > maxCol) newCol = coord.colIndex - W;
      }
    } else { // up
      if (coord.colIndex >= minCol && coord.colIndex <= maxCol) {
        if (coord.row >= minRow && coord.row <= maxRow) return; // deleted
        if (coord.row > maxRow) newRow = coord.row - H;
      }
    }
    const cell = JSON.parse(JSON.stringify(localCells[id]));
    if (cell.formula) cell.formula = adjustFormulaRefsForCellDelete(cell.formula, direction, b, W, H);
    newState[`${getColLetter(newCol)}${newRow}`] = cell;
  });

  // Apply, recording every cell whose content actually changed.
  const EMPTY = { formula: '', value: '', style: {} };
  const affected = new Set([...oldKeys, ...Object.keys(newState)]);
  const changes = [];
  affected.forEach((id) => {
    const beforeCell = before[id] || { formula: '', value: '', style: {} };
    const afterCell = newState[id] || EMPTY;
    if (JSON.stringify(beforeCell) === JSON.stringify(afterCell)) return;
    localCells[id] = JSON.parse(JSON.stringify(afterCell));
    changes.push({ cellId: id, before: beforeCell, after: JSON.parse(JSON.stringify(afterCell)) });
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: afterCell.formula || '', value: afterCell.value || '', style: afterCell.style || {} }
      }));
    }
  });

  if (changes.length) recordHistoryAction({ type: 'multi', changes });
  recalculateSheet();
  renderSpreadsheetGrid();

  const fb = document.getElementById('formula-bar-input');
  if (fb && activeCellId) {
    const cell = localCells[activeCellId];
    fb.value = cell ? (cell.formula || cell.value || '') : '';
  }
};

/**
 * Rewrites the cell references inside a formula to account for a deleted row or
 * column: references past the removed line shift back by one, and references
 * that pointed *at* the removed line become #REF!. Mirrors adjustFormulaRefs.
 * @param {string} formula - Formula text (starting with '=').
 * @param {'row'|'col'} mode - Whether a row or column was deleted.
 * @param {number} at - 1-based row number (row mode) or 0-based column index
 *   (col mode) that was removed.
 * @returns {string} The adjusted formula.
 */
const adjustFormulaRefsForDelete = (formula, mode, at) => {
  if (typeof formula !== 'string' || formula[0] !== '=') return formula;
  const isAlpha = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  const isDigit = (c) => c >= '0' && c <= '9';
  let out = '=';
  let i = 1;
  const n = formula.length;
  while (i < n) {
    const c = formula[i];
    if (c === '"') { // copy a string literal verbatim ("" escapes a quote)
      out += c; i++;
      while (i < n) { out += formula[i]; if (formula[i] === '"') { if (formula[i + 1] === '"') { out += formula[i + 1]; i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (c === '$' || isAlpha(c)) {
      let k = i, run = '';
      while (k < n && (isAlpha(formula[k]) || isDigit(formula[k]) || formula[k] === '$' || formula[k] === '.')) { run += formula[k]; k++; }
      let m = k; while (m < n && formula[m] === ' ') m++;
      const isFunc = formula[m] === '(';
      const prevCh = formula[i - 1];
      const afterDigit = prevCh && isDigit(prevCh); // avoid mis-reading e.g. 1E5
      const ref = (!isFunc && !afterDigit) ? run.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/) : null;
      if (ref) {
        const colLetters = ref[2].toUpperCase();
        let colIdx = 0;
        for (let q = 0; q < colLetters.length; q++) colIdx = colIdx * 26 + (colLetters.charCodeAt(q) - 64);
        colIdx -= 1;
        let rowNum = parseInt(ref[4], 10);
        let dead = false;
        if (mode === 'row') {
          if (rowNum === at) dead = true; else if (rowNum > at) rowNum -= 1;
        } else {
          if (colIdx === at) dead = true; else if (colIdx > at) colIdx -= 1;
        }
        out += dead ? '#REF!' : (ref[1] + getColLetter(colIdx) + ref[3] + rowNum);
      } else {
        out += run;
      }
      i = k;
      continue;
    }
    out += c; i++;
  }
  return out;
};

/**
 * Deletes a whole row or column, shifting the remaining data back to fill the
 * gap and rewriting formula references. Recorded as one multi-cell history
 * action and broadcast per-cell, reusing the existing edit/undo/sync plumbing.
 * @param {'row'|'col'} mode - Delete a row or a column.
 * @param {number} at - 1-based row number (row mode) or 0-based column index
 *   (col mode) to remove.
 */
const performStructuralDelete = (mode, at) => {
  if (isHistoryMode) return;
  // A column delete removes one column from the grid (never below the default).
  const prevCols = mode === 'col' ? getColCount() : 0;
  const oldKeys = Object.keys(localCells);

  // Snapshot current state and compute the shifted-back target state.
  const before = {};
  const newState = {};
  oldKeys.forEach((id) => {
    before[id] = JSON.parse(JSON.stringify(localCells[id]));
    const { col, row } = parseCoordinates(id); // 0-based
    if (mode === 'row') { if (row + 1 === at) return; } // cell on the deleted row -> dropped
    else { if (col === at) return; }                    // cell in the deleted column -> dropped
    let newCol = col, newRow = row;
    if (mode === 'row') { if (row + 1 > at) newRow = row - 1; }
    else { if (col > at) newCol = col - 1; }
    const cell = JSON.parse(JSON.stringify(localCells[id]));
    if (cell.formula) cell.formula = adjustFormulaRefsForDelete(cell.formula, mode, at);
    newState[`${getColLetter(newCol)}${newRow + 1}`] = cell;
  });

  // Apply, recording every cell whose content actually changed.
  const EMPTY = { formula: '', value: '', style: {} };
  const affected = new Set([...oldKeys, ...Object.keys(newState)]);
  const changes = [];
  affected.forEach((id) => {
    const beforeCell = before[id] || { formula: '', value: '', style: {} };
    const afterCell = newState[id] || EMPTY;
    if (JSON.stringify(beforeCell) === JSON.stringify(afterCell)) return;
    localCells[id] = JSON.parse(JSON.stringify(afterCell));
    changes.push({ cellId: id, before: beforeCell, after: JSON.parse(JSON.stringify(afterCell)) });
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: afterCell.formula || '', value: afterCell.value || '', style: afterCell.style || {} }
      }));
    }
  });

  // Shrink the grid by one column (never below the default), recorded as colDelta
  // so undo/redo can restore it.
  let colDelta = 0;
  if (mode === 'col') {
    const newCount = Math.max(DEFAULT_COLS, prevCols - 1);
    colDelta = newCount - prevCols;
    setActiveColCount(newCount);
  }
  if (changes.length || colDelta) recordHistoryAction({ type: 'multi', changes, colDelta });
  recalculateSheet();
  renderSpreadsheetGrid();

  // The active cell's content may have shifted; keep the formula bar in sync.
  const fb = document.getElementById('formula-bar-input');
  if (fb && activeCellId) {
    const cell = localCells[activeCellId];
    fb.value = cell ? (cell.formula || cell.value || '') : '';
  }
};

/** Deletes the entire row containing the given cell, shifting lower rows up. */
const deleteRow = (cellId) => {
  const m = String(cellId).match(/^[A-Z]+(\d+)$/);
  if (!m) return;
  performStructuralDelete('row', parseInt(m[1], 10));
};

/** Deletes the entire column containing the given cell, shifting columns left. */
const deleteColumn = (cellId) => {
  const coord = parseCoordinates(cellId);
  performStructuralDelete('col', coord.col);
};

// Custom Right-Click Context Menu Trigger for Formatting UI
window.addEventListener('contextmenu', (e) => {
  if (isHistoryMode) return;
  const cellEl = e.target.closest('.grid-cell');
  if (!cellEl) return;

  e.preventDefault();
  const cellId = cellEl.dataset.cellId;

  // Helper check to determine if coordinates are inside range bounds
  const isCellInRange = (targetId) => {
    if (!selectionStartCellId) return false;
    const start = parseCellCoord(selectionStartCellId);
    const end = parseCellCoord(selectionEndCellId || selectionStartCellId);
    const cell = parseCellCoord(targetId);
    if (!start || !end || !cell) return false;

    const minCol = Math.min(start.colIndex, end.colIndex);
    const maxCol = Math.max(start.colIndex, end.colIndex);
    const minRow = Math.min(start.row, end.row);
    const maxRow = Math.max(start.row, end.row);

    return cell.colIndex >= minCol && cell.colIndex <= maxCol &&
           cell.row >= minRow && cell.row <= maxRow;
  };

  if (!isCellInRange(cellId)) {
    isSelecting = false;
    selectionStartCellId = cellId;
    selectionEndCellId = cellId;
    handleCellSelect(cellId, cellEl);
  }

  // Read-only mode: the context menu is almost entirely editing actions, so it is
  // suppressed for viewers (copy remains available via Ctrl+C).
  if (!canEditWorkbook) return;

  showContextMenu(cellId, e.clientX, e.clientY);
});

/**
 * Renders custom dropdown formatting menu at coordinates.
 * @param {string} cellId - Cell reference identifier.
 * @param {number} x - Client X Coordinate.
 * @param {number} y - Client Y Coordinate.
 */
const showContextMenu = (cellId, x, y) => {
  // Clear any existing menu dialog
  const oldMenu = document.getElementById('grid-context-menu');
  if (oldMenu) oldMenu.remove();

  const menu = document.createElement('div');
  menu.id = 'grid-context-menu';
  // Styled with the app's Material theme tokens (matches the sheet-tab context
  // menu) rather than the mockup's raw Google colors, so it fits the rest of
  // the UI. Only actions that map to real, existing functions are included.
  menu.className = 'fixed bg-surface-container-lowest dark:bg-inverse-surface shadow-lg rounded-lg py-1.5 z-[1000] border border-outline-variant text-label-lg text-on-surface dark:text-on-surface-variant w-60 select-none';

  // Shared class strings for the menu rows.
  const itemCls = 'w-full flex items-center gap-3 px-3 py-1.5 hover:bg-surface-variant cursor-pointer text-left';
  const iconCls = 'material-symbols-outlined text-[20px] leading-none text-on-surface-variant';
  const shortcutCls = 'text-xs text-on-surface-variant/70';
  const dividerCls = 'h-px bg-outline-variant my-1.5';
  // Rows whose backing feature does not yet exist are shown greyed-out rather
  // than guessed at, per the project's "don't guess — gray it out" rule.
  const disabledCls = 'w-full flex items-center gap-3 px-3 py-1.5 cursor-not-allowed opacity-40 text-left';

  // When several cells across multiple rows/columns are selected, the insert
  // actions operate on the whole span, so the labels reflect the live count
  // (e.g. "Insert 3 rows above"). Reuses the toolbar Insert menu's {n}/{u} keys.
  const ctxBounds = getInsertSelectionBounds();
  const ctxRows = ctxBounds ? ctxBounds.maxRow - ctxBounds.minRow + 1 : 1;
  const ctxCols = ctxBounds ? ctxBounds.maxCol - ctxBounds.minCol + 1 : 1;
  const insertRowLabel = t('ins.rowAbove', { n: ctxRows, u: ctxRows === 1 ? 'row' : 'rows' });
  const insertColLabel = t('ins.colLeft', { n: ctxCols, u: ctxCols === 1 ? 'column' : 'columns' });

  menu.innerHTML = `
    <button class="${itemCls}" id="menu-cut">
      <span class="${iconCls}">content_cut</span>
      <span class="flex-grow">${t('ctx.cut')}</span>
      <span class="${shortcutCls}">Ctrl+X</span>
    </button>
    <button class="${itemCls}" id="menu-copy">
      <span class="${iconCls}">content_copy</span>
      <span class="flex-grow">${t('ctx.copy')}</span>
      <span class="${shortcutCls}">Ctrl+C</span>
    </button>
    <button class="${itemCls}" id="menu-paste">
      <span class="${iconCls}">content_paste</span>
      <span class="flex-grow">${t('ctx.paste')}</span>
      <span class="${shortcutCls}">Ctrl+V</span>
    </button>
    <div class="${disabledCls}">
      <span class="${iconCls}">content_paste_go</span>
      <span class="flex-grow">${t('ctx.pasteSpecial')}</span>
      <span class="${iconCls}">chevron_right</span>
    </div>
    <div class="${dividerCls}"></div>
    <button class="${itemCls}" id="menu-insert-row">
      <span class="${iconCls}">add</span>
      <span class="flex-grow">${insertRowLabel}</span>
    </button>
    <button class="${itemCls}" id="menu-insert-col">
      <span class="${iconCls}">add</span>
      <span class="flex-grow">${insertColLabel}</span>
    </button>
    <div class="relative group">
      <div class="${itemCls}">
        <span class="${iconCls}">add</span>
        <span class="flex-grow">${t('ctx.insertCell')}</span>
        <span class="${iconCls}">chevron_right</span>
      </div>
      <div class="hidden group-hover:block absolute left-full top-0 -mt-1.5 bg-surface-container-lowest dark:bg-inverse-surface shadow-lg rounded-lg py-1.5 z-[1001] border border-outline-variant w-72 text-on-surface dark:text-on-surface-variant">
        <button class="${itemCls}" id="menu-insert-cell-right">
          <span class="${iconCls}">arrow_forward</span>
          <span class="flex-grow">${t('ins.cellRight')}</span>
        </button>
        <button class="${itemCls}" id="menu-insert-cell-down">
          <span class="${iconCls}">arrow_downward</span>
          <span class="flex-grow">${t('ins.cellDown')}</span>
        </button>
      </div>
    </div>
    <div class="${dividerCls}"></div>
    <button class="${itemCls}" id="menu-delete-row">
      <span class="${iconCls}">delete</span>
      <span class="flex-grow">${t('ctx.deleteRow')}</span>
    </button>
    <button class="${itemCls}" id="menu-delete-col">
      <span class="${iconCls}">delete</span>
      <span class="flex-grow">${t('ctx.deleteCol')}</span>
    </button>
    <div class="relative group">
      <div class="${itemCls}">
        <span class="${iconCls}">delete</span>
        <span class="flex-grow">${t('ctx.deleteCell')}</span>
        <span class="${iconCls}">chevron_right</span>
      </div>
      <div class="hidden group-hover:block absolute left-full top-0 -mt-1.5 bg-surface-container-lowest dark:bg-inverse-surface shadow-lg rounded-lg py-1.5 z-[1001] border border-outline-variant w-72 text-on-surface dark:text-on-surface-variant">
        <button class="${itemCls}" id="menu-delete-cell-left">
          <span class="${iconCls}">arrow_back</span>
          <span class="flex-grow">${t('del.cellLeft')}</span>
        </button>
        <button class="${itemCls}" id="menu-delete-cell-up">
          <span class="${iconCls}">arrow_upward</span>
          <span class="flex-grow">${t('del.cellUp')}</span>
        </button>
      </div>
    </div>
    <div class="${dividerCls}"></div>
    <div class="${disabledCls}">
      <span class="${iconCls}">table</span>
      <span class="flex-grow">${t('ctx.convertTable')}</span>
      <span class="text-[10px] font-semibold text-[#188038] bg-[#e6f4ea] dark:bg-[#0f3d23] dark:text-[#6dd58c] px-1.5 py-0.5 rounded">${t('ctx.newBadge')}</span>
    </div>
    <button class="${itemCls}" id="menu-create-filter">
      <span class="${iconCls}">filter_alt</span>
      <span class="flex-grow">${t(window.CoSheet.sortFilter.hasActiveFilter() ? 'data.removeFilter' : 'ctx.createFilter')}</span>
    </button>
    <div class="${dividerCls}"></div>
    <button class="${itemCls}" id="menu-history">
      <span class="${iconCls}">history</span>
      <span class="flex-grow">${t('ctx.editHistory')}</span>
    </button>
    <div class="${dividerCls}"></div>
    <button class="${itemCls}" id="menu-link">
      <span class="${iconCls}">link</span>
      <span class="flex-grow">${t('ctx.insertLink')}</span>
    </button>
    <div class="${disabledCls}">
      <span class="${iconCls}">add_comment</span>
      <span class="flex-grow">${t('ctx.comment')}</span>
      <span class="${shortcutCls}">Ctrl+Alt+M</span>
    </div>
    <div class="${disabledCls}">
      <span class="${iconCls}">sticky_note_2</span>
      <span class="flex-grow">${t('ctx.insertNote')}</span>
    </div>
    <div class="${disabledCls}">
      <span class="${iconCls}">table_view</span>
      <span class="flex-grow">${t('ctx.prebuiltTable')}</span>
    </div>
    <div class="${disabledCls}">
      <span class="${iconCls}">arrow_drop_down_circle</span>
      <span class="flex-grow">${t('ctx.dropdown')}</span>
    </div>
    <div class="${dividerCls}"></div>
    <div class="${disabledCls}">
      <span class="${iconCls}">more_vert</span>
      <span class="flex-grow">${t('ctx.moreActions')}</span>
      <span class="${iconCls}">chevron_right</span>
    </div>
  `;

  // Position, then clamp to the viewport so the (now taller) menu stays on-screen.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
  }

  // Hook action handlers — each maps to an existing app function.
  document.getElementById('menu-cut').onclick = () => { cutSelectedCells(); menu.remove(); };
  document.getElementById('menu-copy').onclick = () => { copySelectedCells(); menu.remove(); };
  document.getElementById('menu-paste').onclick = () => { pasteSelectedCells(); menu.remove(); };
  document.getElementById('menu-insert-row').onclick = () => {
    // Insert as many rows as the selection spans, above the topmost selected row.
    const at = ctxBounds ? ctxBounds.minRow : (parseCellCoord(cellId) || {}).row;
    if (at) for (let i = 0; i < ctxRows; i++) performStructuralInsert('row', at);
    menu.remove();
  };
  document.getElementById('menu-insert-col').onclick = () => {
    // Insert as many columns as the selection spans, left of the leftmost column.
    const at = ctxBounds ? ctxBounds.minCol : (parseCellCoord(cellId) || {}).colIndex;
    if (at != null) for (let i = 0; i < ctxCols; i++) performStructuralInsert('col', at);
    menu.remove();
  };
  document.getElementById('menu-delete-row').onclick = () => { deleteRow(cellId); menu.remove(); };
  document.getElementById('menu-delete-col').onclick = () => { deleteColumn(cellId); menu.remove(); };
  // "Insert Cell" flyout — same behaviour as the toolbar Insert > Cells submenu.
  const insCellRight = document.getElementById('menu-insert-cell-right');
  const insCellDown = document.getElementById('menu-insert-cell-down');
  if (insCellRight) insCellRight.onclick = () => { performCellInsert('right'); menu.remove(); };
  if (insCellDown) insCellDown.onclick = () => { performCellInsert('down'); menu.remove(); };
  // "Delete Cell" flyout — mirror of the Insert Cell flyout, shifting survivors back.
  const delCellLeft = document.getElementById('menu-delete-cell-left');
  const delCellUp = document.getElementById('menu-delete-cell-up');
  if (delCellLeft) delCellLeft.onclick = () => { performCellDelete('left'); menu.remove(); };
  if (delCellUp) delCellUp.onclick = () => { performCellDelete('up'); menu.remove(); };
  document.getElementById('menu-create-filter').onclick = () => {
    // Toggle the per-sheet value filter on the right-clicked cell's column —
    // the same action as the toolbar funnel and Data ▸ Create/Remove filter.
    if (window.CoSheet.sortFilter.hasActiveFilter()) window.CoSheet.sortFilter.removeFilter();
    else window.CoSheet.sortFilter.createFilter((parseCellCoord(cellId) || { colIndex: 0 }).colIndex);
    menu.remove();
  };
  document.getElementById('menu-history').onclick = () => { window.CoSheet.history.toggle(true); menu.remove(); };
  document.getElementById('menu-link').onclick = () => {
    menu.remove();
    openLinkDialog(cellId);
  };
  // Note: paste-special, convert-to-table, comment, note, pre-built table,
  // dropdown, smart chips and "more actions" are rendered greyed-out and
  // intentionally left unwired until those features exist — see the reference
  // mock-up (images/right_click_menu.png).
};

/**
 * Renders the column-header dropdown menu (opened by the ▾ button that appears
 * on a column header) at the given viewport coordinates. Mirrors the reference
 * mock-up in images/column_header_menu.png, but is styled with the app's
 * Material theme tokens to match the cell context menu. The column is expected
 * to already be selected by the caller, so cut/copy/paste/clear operate on the
 * whole column and sort/filter key on its index. Actions that map to a real,
 * existing feature are wired; the rest are shown greyed-out and unclickable per
 * the project's "don't guess — gray it out" rule.
 * @param {string} colLetter - The column the menu acts on (e.g. "C").
 * @param {number} x - Client X coordinate to anchor the menu's left edge.
 * @param {number} y - Client Y coordinate to anchor the menu's top edge.
 */
const showColumnMenu = (colLetter, x, y) => {
  // Reuse the shared context-menu id so opening replaces any existing menu and
  // the outside-click dismiss handler below tears it down.
  const oldMenu = document.getElementById('grid-context-menu');
  if (oldMenu) oldMenu.remove();

  const colIndex = (parseCellCoord(`${colLetter}1`) || { colIndex: 0 }).colIndex;
  const topCellId = `${colLetter}1`;

  const menu = document.createElement('div');
  menu.id = 'grid-context-menu';
  menu.className = 'fixed bg-surface-container-lowest dark:bg-inverse-surface shadow-lg rounded-lg py-1.5 z-[1000] border border-outline-variant text-label-lg text-on-surface dark:text-on-surface-variant w-60 select-none';

  // Same row/icon/divider classes as showContextMenu so the two menus are
  // visually identical.
  const itemCls = 'w-full flex items-center gap-3 px-3 py-1.5 hover:bg-surface-variant cursor-pointer text-left';
  const iconCls = 'material-symbols-outlined text-[20px] leading-none text-on-surface-variant';
  const shortcutCls = 'text-xs text-on-surface-variant/70';
  const dividerCls = 'h-px bg-outline-variant my-1.5';
  const disabledCls = 'w-full flex items-center gap-3 px-3 py-1.5 cursor-not-allowed opacity-40 text-left';

  // The header menu always acts on exactly one column, so the insert labels are
  // fixed to a single column (reusing the toolbar Insert menu's {n}/{u} keys).
  const insLeftLabel = t('ins.colLeft', { n: 1, u: 'column' });
  const insRightLabel = t('ins.colRight', { n: 1, u: 'column' });

  menu.innerHTML = `
    <button class="${itemCls}" id="col-cut">
      <span class="${iconCls}">content_cut</span>
      <span class="flex-grow">${t('ctx.cut')}</span>
      <span class="${shortcutCls}">Ctrl+X</span>
    </button>
    <button class="${itemCls}" id="col-copy">
      <span class="${iconCls}">content_copy</span>
      <span class="flex-grow">${t('ctx.copy')}</span>
      <span class="${shortcutCls}">Ctrl+C</span>
    </button>
    <button class="${itemCls}" id="col-paste">
      <span class="${iconCls}">content_paste</span>
      <span class="flex-grow">${t('ctx.paste')}</span>
      <span class="${shortcutCls}">Ctrl+V</span>
    </button>
    <div class="${disabledCls}">
      <span class="${iconCls}">content_paste_go</span>
      <span class="flex-grow">${t('ctx.pasteSpecial')}</span>
      <span class="${iconCls}">chevron_right</span>
    </div>
    <div class="${dividerCls}"></div>
    <button class="${itemCls}" id="col-insert-left">
      <span class="${iconCls}">add</span>
      <span class="flex-grow">${insLeftLabel}</span>
    </button>
    <button class="${itemCls}" id="col-insert-right">
      <span class="${iconCls}">add</span>
      <span class="flex-grow">${insRightLabel}</span>
    </button>
    <button class="${itemCls}" id="col-delete">
      <span class="${iconCls}">delete</span>
      <span class="flex-grow">${t('ctx.deleteCol')}</span>
    </button>
    <button class="${itemCls}" id="col-clear">
      <span class="${iconCls}">clear</span>
      <span class="flex-grow">${t('col.clear')}</span>
    </button>
    <button class="${itemCls}" id="col-hide">
      <span class="${iconCls}">visibility_off</span>
      <span class="flex-grow">${t('col.hide')}</span>
    </button>
    <div class="${disabledCls}">
      <span class="${iconCls}">width</span>
      <span class="flex-grow">${t('col.resize')}</span>
    </div>
    <div class="${dividerCls}"></div>
    <button class="${itemCls}" id="col-create-filter">
      <span class="${iconCls}">filter_alt</span>
      <span class="flex-grow">${t('ctx.createFilter')}</span>
    </button>
    <div class="${dividerCls}"></div>
    <button class="${itemCls}" id="col-sort-asc">
      <span class="${iconCls}">arrow_downward</span>
      <span class="flex-grow">${t('col.sortAsc')}</span>
    </button>
    <button class="${itemCls}" id="col-sort-desc">
      <span class="${iconCls}">arrow_upward</span>
      <span class="flex-grow">${t('col.sortDesc')}</span>
    </button>
    <div class="${dividerCls}"></div>
    <div class="${disabledCls}">
      <span class="${iconCls}">format_color_fill</span>
      <span class="flex-grow">${t('col.condFormat')}</span>
    </div>
    <div class="${disabledCls}">
      <span class="${iconCls}">rule</span>
      <span class="flex-grow">${t('col.dataValidation')}</span>
    </div>
    <div class="${disabledCls}">
      <span class="${iconCls}">lightbulb</span>
      <span class="flex-grow">${t('col.stats')}</span>
    </div>
    <div class="${disabledCls}">
      <span class="${iconCls}">arrow_drop_down_circle</span>
      <span class="flex-grow">${t('ctx.dropdown')}</span>
    </div>
    <div class="${disabledCls}">
      <span class="${iconCls}">deployed_code</span>
      <span class="flex-grow">${t('col.smartChips')}</span>
      <span class="${iconCls}">chevron_right</span>
    </div>
    <div class="${dividerCls}"></div>
    <div class="${disabledCls}">
      <span class="${iconCls}">more_vert</span>
      <span class="flex-grow">${t('col.moreActions')}</span>
      <span class="${iconCls}">chevron_right</span>
    </div>
  `;

  // Position, then clamp to the viewport so the menu stays on-screen.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
  }

  // Wire the actions that map to real features. Cut/copy/paste/clear act on the
  // live selection (the whole column, already selected by the header button).
  document.getElementById('col-cut').onclick = () => { cutSelectedCells(); menu.remove(); };
  document.getElementById('col-copy').onclick = () => { copySelectedCells(); menu.remove(); };
  document.getElementById('col-paste').onclick = () => { pasteSelectedCells(); menu.remove(); };
  document.getElementById('col-insert-left').onclick = () => { performStructuralInsert('col', colIndex); menu.remove(); };
  document.getElementById('col-insert-right').onclick = () => { performStructuralInsert('col', colIndex + 1); menu.remove(); };
  document.getElementById('col-delete').onclick = () => { deleteColumn(topCellId); menu.remove(); };
  document.getElementById('col-clear').onclick = () => { clearCell(topCellId); menu.remove(); };
  document.getElementById('col-hide').onclick = () => { hideColumn(colLetter); menu.remove(); };
  document.getElementById('col-create-filter').onclick = () => {
    // Toggle the per-sheet value filter on this column (mirrors Data ▸ filter).
    if (window.CoSheet.sortFilter.hasActiveFilter()) window.CoSheet.sortFilter.removeFilter();
    else window.CoSheet.sortFilter.createFilter(colIndex);
    menu.remove();
  };
  document.getElementById('col-sort-asc').onclick = () => {
    window.CoSheet.sortFilter.sortDataRows(colIndex, true, (frozenRows || 0) + 1);
    menu.remove();
  };
  document.getElementById('col-sort-desc').onclick = () => {
    window.CoSheet.sortFilter.sortDataRows(colIndex, false, (frozenRows || 0) + 1);
    menu.remove();
  };
  // Note: paste-special, resize column, conditional formatting, data validation,
  // column stats, dropdown, smart chips and "more actions" are rendered
  // greyed-out and intentionally left unwired until those features exist — see
  // the reference mock-up (images/column_header_menu.png).
};

// Dismiss context menu on click elsewhere
window.addEventListener('click', (e) => {
  const menu = document.getElementById('grid-context-menu');
  if (menu && !menu.contains(e.target)) {
    menu.remove();
  }
});

/**
 * Updates the active styling states of the toolbar buttons.
 * @param {Object} [style] - The current cell's style object.
 */
// Format-key → Format ▸ Number menu button id, for the active-format check mark.
// A null/absent numberFormat means "Automatic".
const NUMBER_FORMAT_MENU_IDS = {
  auto: 'fmt-num-auto',
  text: 'fmt-num-plain-text',
  number: 'fmt-num-number',
  percent: 'fmt-num-percent',
  scientific: 'fmt-num-scientific',
  accounting: 'fmt-num-accounting',
  financial: 'fmt-num-financial',
  currency: 'fmt-num-currency',
  currencyRounded: 'fmt-num-currency-rounded',
};

/**
 * Show a check mark beside the active cell's number format in the
 * Format ▸ Number menu (falling back to "Automatic" when no explicit format is
 * set). Called whenever the toolbar formatting state is refreshed.
 * @param {{ numberFormat?: string|null }|null|undefined} style - Active cell style.
 */
const updateNumberFormatMenuChecks = (style) => {
  const activeKey = (style && style.numberFormat) || 'auto';
  for (const [key, id] of Object.entries(NUMBER_FORMAT_MENU_IDS)) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const check = btn.querySelector('.fmt-num-check');
    if (check) check.classList.toggle('invisible', key !== activeKey);
  }
};

// Font sizes offered by the toolbar control and the Format ▸ Font size menu.
const FONT_SIZE_PRESETS = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];

/**
 * Show a check mark beside the active cell's font size in the Format ▸ Font size
 * menu (falling back to DEFAULT_FONT_SIZE when the cell has no explicit size).
 * A custom size typed into the toolbar may match no preset, in which case every
 * option stays unchecked. Called whenever the toolbar formatting state is refreshed.
 * @param {{ fontSize?: number|null }|null|undefined} style - Active cell style.
 */
const updateFontSizeMenuChecks = (style) => {
  const list = document.getElementById('fmt-fontsize-list');
  if (!list) return;
  const activeSize = (style && style.fontSize) || DEFAULT_FONT_SIZE;
  list.querySelectorAll('[data-size]').forEach((btn) => {
    const check = btn.querySelector('.fmt-size-check');
    if (check) check.classList.toggle('invisible', Number(btn.getAttribute('data-size')) !== activeSize);
  });
};

const updateToolbarFormattingStates = (style) => {
  const toolbarBold = document.getElementById('toolbar-bold');
  const toolbarItalic = document.getElementById('toolbar-italic');
  const toolbarStrikethrough = document.getElementById('toolbar-strikethrough');
  const toolbarColorTextInput = document.getElementById('toolbar-color-text-input');
  const toolbarColorFillInput = document.getElementById('toolbar-color-fill-input');
  const toolbarBorder = document.getElementById('toolbar-border');
  const toolbarAlignIcon = document.getElementById('toolbar-align-icon');
  const alignLeftBtn = document.getElementById('toolbar-align-left');
  const alignCenterBtn = document.getElementById('toolbar-align-center');
  const alignRightBtn = document.getElementById('toolbar-align-right');
  const toolbarLink = document.getElementById('toolbar-link');
  // Vertical alignment toolbar references
  const toolbarValignIcon = document.getElementById('toolbar-valign-icon');
  const valignTopBtn = document.getElementById('toolbar-valign-top');
  const valignCenterBtn = document.getElementById('toolbar-valign-center');
  const valignBottomBtn = document.getElementById('toolbar-valign-bottom');

  // Toggle the "active" highlight on a toolbar button (no-op when absent).
  const setActive = (btn, active) => {
    if (btn) btn.classList.toggle('bg-surface-variant', !!active);
  };

  setActive(toolbarBold, style && style.bold);
  setActive(toolbarItalic, style && style.italic);
  setActive(toolbarStrikethrough, style && style.strikethrough);
  setActive(toolbarBorder, styleHasBorders(style));

  // Mark the active number format in the Format ▸ Number menu.
  updateNumberFormatMenuChecks(style);

  // Mark the active font size in the Format ▸ Font size menu.
  updateFontSizeMenuChecks(style);

  // Determine the effective alignment: an explicit style wins, otherwise a
  // numeric active cell defaults to right (mirroring the grid rendering),
  // falling back to left for everything else.
  let currentAlign = 'left';
  if (style && style.align) {
    currentAlign = style.align;
  } else if (activeCellId && isNumericValue(getCellValue(activeCellId))) {
    currentAlign = 'right';
  }
  if (toolbarAlignIcon) {
    toolbarAlignIcon.textContent = `format_align_${currentAlign}`;
  }

  // Update active state highlight classes for each button option
  setActive(alignLeftBtn, currentAlign === 'left');
  setActive(alignCenterBtn, currentAlign === 'center');
  setActive(alignRightBtn, currentAlign === 'right');

  // Set the default vertical alignment icon based on style (fallback to vertical_align_bottom)
  const currentValign = style && style.verticalAlign ? style.verticalAlign : 'bottom';
  if (toolbarValignIcon) {
    toolbarValignIcon.textContent = `vertical_align_${currentValign}`;
  }

  // Update active state highlight classes for each vertical alignment option button
  setActive(valignTopBtn, currentValign === 'top');
  setActive(valignCenterBtn, currentValign === 'center');
  setActive(valignBottomBtn, currentValign === 'bottom');

  setActive(toolbarLink, style && style.link);

  if (toolbarColorTextInput) {
    const textColor = style && style.textColor ? style.textColor : '#000000';
    toolbarColorTextInput.value = textColor;
    window.CoSheet.colorPalette.setSwatch('text', textColor);
  }

  if (toolbarColorFillInput) {
    const fillColor = style && style.color ? style.color : '#ffffff';
    toolbarColorFillInput.value = fillColor;
    window.CoSheet.colorPalette.setSwatch('fill', fillColor);
  }

  // Reflect the active cell's font family in the toolbar label (fallback to Arial)
  const toolbarFontLabel = document.getElementById('toolbar-font-label');
  if (toolbarFontLabel) {
    toolbarFontLabel.textContent = style && style.fontFamily ? style.fontFamily : 'Arial';
  }

  // Reflect the active cell's font size in the toolbar input (fallback to default)
  const toolbarFontSizeInput = document.getElementById('toolbar-font-size-input');
  if (toolbarFontSizeInput && document.activeElement !== toolbarFontSizeInput) {
    toolbarFontSizeInput.value = style && style.fontSize ? style.fontSize : DEFAULT_FONT_SIZE;
  }
};

// Make the document title editable on double-click (it is the file name).
// Maximum file-name length, kept in lockstep with the server (POST/PATCH
// /api/files enforce 1–120 chars). Enforcing the same cap on the client gives
// immediate feedback and prevents a renamed name from being silently rejected
// server-side while still showing on screen.
const MAX_FILE_NAME_LEN = 120;

const fileNameEl = document.getElementById('file-name');
if (fileNameEl) {
  let fileNameBeforeEdit = '';

  // The file id this editor is bound to ('default' for the legacy workbook).
  // The name itself is rendered into the page server-side (see GET /sheet), so
  // there is no initial fetch here — only renames are pushed back below.
  const effectiveFileId = currentFileId || 'default';

  // Persist a renamed file back to the registry so the drive stays in sync.
  const persistFileName = async (name) => {
    try {
      await fetch(`/api/files/${encodeURIComponent(effectiveFileId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name })
      });
    } catch (e) {
      // Non-fatal: the on-screen name still reflects the edit.
    }
  };

  fileNameEl.addEventListener('dblclick', () => {
    if (!canEditWorkbook) return; // viewers cannot rename the file
    fileNameBeforeEdit = fileNameEl.innerText.trim();
    fileNameEl.setAttribute('contenteditable', 'true');
    fileNameEl.focus();
    // Select the whole name so typing replaces it.
    if (typeof window.getSelection !== 'undefined' && typeof document.createRange !== 'undefined') {
      const range = document.createRange();
      range.selectNodeContents(fileNameEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  const commitFileName = () => {
    fileNameEl.removeAttribute('contenteditable');
    // Collapse whitespace, trim, and cap to the server limit so the on-screen
    // name always matches what is actually persisted.
    let name = fileNameEl.innerText.replace(/\s+/g, ' ').trim();
    if (name.length > MAX_FILE_NAME_LEN) name = name.slice(0, MAX_FILE_NAME_LEN);
    // Revert to the previous name if left blank.
    const finalName = name || fileNameBeforeEdit;
    fileNameEl.innerText = finalName;
    // Keep the browser tab in sync with the file name ("{name} - Co-Sheet").
    if (finalName) document.title = `${finalName} - Co-Sheet`;
    // Persist only when the name actually changed.
    if (finalName && finalName !== fileNameBeforeEdit) {
      persistFileName(finalName);
    }
  };

  fileNameEl.addEventListener('blur', commitFileName);
  // Hard-cap the length live (contenteditable has no maxlength), so typing or
  // pasting past the limit is rejected immediately rather than truncated only
  // on commit. Excess is trimmed from the end and the caret restored there.
  fileNameEl.addEventListener('input', () => {
    if (fileNameEl.innerText.length <= MAX_FILE_NAME_LEN) return;
    fileNameEl.innerText = fileNameEl.innerText.slice(0, MAX_FILE_NAME_LEN);
    if (typeof window.getSelection !== 'undefined' && typeof document.createRange !== 'undefined') {
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(fileNameEl);
      range.collapse(false); // caret to end
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  fileNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fileNameEl.blur(); // triggers commit
    } else if (e.key === 'Escape') {
      e.preventDefault();
      fileNameEl.innerText = fileNameBeforeEdit;
      fileNameEl.blur();
    }
  });
}

// Star toggle next to the file name. Starring is a personal, per-user favourite
// (PUT /api/files/:id/star); starred files appear under "Starred" in the drive.
const starToggleEl = document.getElementById('star-toggle');
if (starToggleEl) {
  const starFileId = currentFileId || 'default';
  let isStarred = false;
  let starBusy = false;

  // Reflect the starred state: a solid amber star when on, an outline star when off,
  // and keep the tooltip (and its data-i18n-title for language switches) in sync.
  // The FILL axis and colour are set inline so they win over the global
  // `.material-symbols-outlined` rule and don't depend on the Tailwind palette;
  // clearing them when off lets the base `text-outline` class show through.
  const applyStarUI = () => {
    starToggleEl.style.fontVariationSettings = isStarred ? "'FILL' 1" : "'FILL' 0";
    starToggleEl.style.color = isStarred ? '#f9ab00' : '';
    const key = isStarred ? 'tip.unstar' : 'tip.star';
    starToggleEl.setAttribute('data-i18n-title', key);
    starToggleEl.title = t(key);
    starToggleEl.setAttribute('aria-pressed', isStarred ? 'true' : 'false');
  };

  // Load the current starred state from the file's drive row.
  const loadStarState = async () => {
    try {
      const list = await (await fetch('/api/files', { credentials: 'same-origin' })).json();
      const row = Array.isArray(list) ? list.find((f) => f.id === starFileId) : null;
      isStarred = !!(row && row.starred);
    } catch (e) { /* default to unstarred */ }
    applyStarUI();
  };

  const toggleStar = async () => {
    if (starBusy) return;
    starBusy = true;
    const next = !isStarred;
    // Optimistically reflect the change, then reconcile with the server.
    isStarred = next;
    applyStarUI();
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(starFileId)}/star`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ starred: next })
      });
      if (!res.ok) throw new Error('star failed');
      const data = await res.json().catch(() => ({}));
      if (typeof data.starred === 'boolean') isStarred = data.starred;
    } catch (e) {
      isStarred = !next; // revert on failure
    }
    applyStarUI();
    starBusy = false;
  };

  starToggleEl.addEventListener('click', toggleStar);
  starToggleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleStar(); }
  });

  applyStarUI();
  loadStarState();
}

// Hook up the "Format as percentage" toolbar button
const toolbarFormatPercentBtn = document.getElementById('toolbar-format-percent');
if (toolbarFormatPercentBtn) {
  toolbarFormatPercentBtn.addEventListener('click', () => {
    if (activeCellId) {
      setCellNumberFormat(activeCellId, 'percent');
    }
  });
}

// Hook up the decrease / increase decimal-places toolbar buttons
const toolbarDecimalDecreaseBtn = document.getElementById('toolbar-decimal-decrease');
if (toolbarDecimalDecreaseBtn) {
  toolbarDecimalDecreaseBtn.addEventListener('click', () => {
    if (activeCellId) adjustCellDecimals(activeCellId, -1);
  });
}
const toolbarDecimalIncreaseBtn = document.getElementById('toolbar-decimal-increase');
if (toolbarDecimalIncreaseBtn) {
  toolbarDecimalIncreaseBtn.addEventListener('click', () => {
    if (activeCellId) adjustCellDecimals(activeCellId, 1);
  });
}

// ---------------------------------------------------------------------------
// Format painter — the toolbar "Apply format" roller. Clicking the button
// snapshots the active cell's visual style and arms the painter; the source
// cell wears a dashed outline until the next cell/range selection receives a
// copy of that style (an unformatted source paints "no format", i.e. clears
// the targets) and the painter disarms. Escape or a second click on the
// button cancels. Two style properties are never painted and the targets
// keep their own: `link` (a hyperlink is cell content, not formatting) and
// `merge` (block geometry — painting it would stamp overlapping merges
// across the target range). State lives up with the selection globals
// (paintFormatStyle / paintFormatSource) so renderSpreadsheetGrid can consult
// it safely.

/**
 * Puts the dashed "format being copied" outline on the armed painter's source
 * cell. Safe to call after any full grid rebuild (hoisted; renderSpreadsheetGrid
 * calls it): the cell is looked up fresh, and nothing is marked unless the
 * painter is armed and its source sheet is the one on screen.
 */
function refreshPaintFormatSourceOutline() {
  if (!paintFormatStyle || !paintFormatSource || paintFormatSource.sheetName !== activeSheetName) return;
  const el = document.querySelector(`[data-cell-id="${paintFormatSource.cellId}"]`);
  if (el) el.classList.add('paint-format-source');
}

const toolbarPaintFormatBtn = document.getElementById('toolbar-paint-format');

const cancelPaintFormat = () => {
  if (paintFormatSource && paintFormatSource.sheetName === activeSheetName) {
    const el = document.querySelector(`[data-cell-id="${paintFormatSource.cellId}"]`);
    if (el) el.classList.remove('paint-format-source');
  }
  paintFormatStyle = null;
  paintFormatSource = null;
  if (toolbarPaintFormatBtn) toolbarPaintFormatBtn.classList.remove('bg-surface-variant');
  document.body.classList.remove('paint-format-mode');
};

if (toolbarPaintFormatBtn) {
  toolbarPaintFormatBtn.addEventListener('click', () => {
    if (paintFormatStyle) { cancelPaintFormat(); return; } // second click disarms
    if (!activeCellId || isHistoryMode || !canEditWorkbook) return;
    const src = localCells[activeCellId];
    const style = src && src.style ? JSON.parse(JSON.stringify(src.style)) : {};
    delete style.link;
    delete style.merge;
    paintFormatStyle = style;
    paintFormatSource = { cellId: activeCellId, sheetName: activeSheetName };
    refreshPaintFormatSourceOutline();
    toolbarPaintFormatBtn.classList.add('bg-surface-variant');
    document.body.classList.add('paint-format-mode');
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && paintFormatStyle) cancelPaintFormat();
});

/**
 * Stamps the armed painter's style onto every cell of the just-completed
 * selection, then disarms. Runs from the window mouseup that ends a grid
 * selection drag, so a click paints one cell and a drag paints the range.
 */
const applyPaintFormat = () => {
  const source = paintFormatStyle;
  cancelPaintFormat();
  if (!source) return;

  const cellIds = getSelectedCellIds();
  const historyChanges = [];
  // Borders are neighbour-aware (each shared edge is also drawn by the facing
  // cell), so whenever a paint adds or removes borders the four neighbours
  // must re-render too — same bookkeeping as clearFormatting.
  const renderIds = new Set();

  cellIds.forEach(id => {
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
    const cell = localCells[id] || { formula: '', value: '', style: {} };
    const newStyle = JSON.parse(JSON.stringify(source));
    if (cell.style && cell.style.link) newStyle.link = cell.style.link;
    if (cell.style && cell.style.merge) newStyle.merge = cell.style.merge;
    const bordersInPlay = styleHasBorders(cell.style) || styleHasBorders(newStyle);
    cell.style = newStyle;
    localCells[id] = cell;
    historyChanges.push({ cellId: id, before, after: JSON.parse(JSON.stringify(cell)) });

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'cell-edit',
        payload: { cellId: id, formula: cell.formula, value: cell.value, style: cell.style }
      }));
    }

    renderIds.add(id);
    if (bordersInPlay) {
      const coord = parseCellCoord(id);
      if (coord) {
        const { row: r, colIndex: c } = coord;
        const colCount = getColCount(activeSheetName);
        if (c - 1 >= 0) renderIds.add(`${getColLetter(c - 1)}${r}`);
        if (c + 1 < colCount) renderIds.add(`${getColLetter(c + 1)}${r}`);
        if (r - 1 >= 1) renderIds.add(`${getColLetter(c)}${r - 1}`);
        if (r + 1 <= TOTAL_ROWS) renderIds.add(`${getColLetter(c)}${r + 1}`);
      }
    }
  });

  // Render only after every cell is mutated so neighbour-aware edge de-duping
  // reads final state.
  renderIds.forEach(id => {
    const cell = localCells[id];
    updateGridDOMCell(id, getCellValue(id), (cell && cell.style) || EMPTY_STYLE);
  });

  if (historyChanges.length) {
    recordHistoryAction({ type: 'multi', changes: historyChanges });
  }
  // No recalculateSheet(): a style change never alters a cell value (see
  // clearFormatting). But a painted font/size can change row heights, so the
  // selection overlay must re-measure.
  updateRangeSelectionUI();
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

// Hook up toolbar formatting buttons for bold, italic, and strikethrough
const toolbarBoldBtn = document.getElementById('toolbar-bold');
if (toolbarBoldBtn) {
  toolbarBoldBtn.addEventListener('click', () => {
    if (activeCellId) {
      toggleFormat(activeCellId, 'bold');
    }
  });
}

const toolbarItalicBtn = document.getElementById('toolbar-italic');
if (toolbarItalicBtn) {
  toolbarItalicBtn.addEventListener('click', () => {
    if (activeCellId) {
      toggleFormat(activeCellId, 'italic');
    }
  });
}

const toolbarStrikethroughBtn = document.getElementById('toolbar-strikethrough');
if (toolbarStrikethroughBtn) {
  toolbarStrikethroughBtn.addEventListener('click', () => {
    if (activeCellId) {
      toggleFormat(activeCellId, 'strikethrough');
    }
  });
}

const toolbarClearFormatBtn = document.getElementById('toolbar-clear-format');
if (toolbarClearFormatBtn) {
  toolbarClearFormatBtn.addEventListener('click', () => {
    if (activeCellId) {
      clearFormatting(activeCellId);
    }
  });
}

// Hook up toolbar border, alignment, and link buttons
const toolbarBorderBtn = document.getElementById('toolbar-border');
if (toolbarBorderBtn) {
  toolbarBorderBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    const wasOpen = window.CoSheet.borderMenu.isOpen();
    closeAllMenus();
    if (!wasOpen) window.CoSheet.borderMenu.open(toolbarBorderBtn);
  });
}

// Close every toolbar/menu-bar dropdown and popover so only one is ever open at
// a time. Static dropdowns are hidden via the `hidden` class; the dynamically
// created border menu and color palette own their DOM nodes and outside-click
// handlers, so they get torn down through their dedicated close functions.
// Callers capture each menu's open state first, then re-open it after this call
// only when it was previously closed — preserving click-to-toggle behavior.
function closeAllMenus() {
  ['toolbar-align-menu', 'toolbar-valign-menu', 'toolbar-zoom-menu',
   'toolbar-font-menu', 'toolbar-font-size-menu',
   'menu-file-dropdown', 'menu-edit-dropdown', 'menu-view-dropdown', 'menu-insert-dropdown', 'menu-format-dropdown', 'menu-data-dropdown',
   'lang-switch-menu', 'share-menu'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  window.CoSheet.borderMenu.close();
  window.CoSheet.colorPalette.close();
}

// Toggle toolbar alignment dropdown menu visibility
const toolbarAlignBtn = document.getElementById('toolbar-align');
const toolbarAlignMenu = document.getElementById('toolbar-align-menu');
if (toolbarAlignBtn && toolbarAlignMenu) {
  toolbarAlignBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    const wasOpen = !toolbarAlignMenu.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) toolbarAlignMenu.classList.remove('hidden');
  });
}

// Hook up individual alignment buttons inside the dropdown
const alignLeftBtn = document.getElementById('toolbar-align-left');
if (alignLeftBtn) {
  alignLeftBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    if (activeCellId) {
      setCellAlignment(activeCellId, 'left');
    }
    if (toolbarAlignMenu) {
      toolbarAlignMenu.classList.add('hidden');
    }
  });
}

const alignCenterBtn = document.getElementById('toolbar-align-center');
if (alignCenterBtn) {
  alignCenterBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    if (activeCellId) {
      setCellAlignment(activeCellId, 'center');
    }
    if (toolbarAlignMenu) {
      toolbarAlignMenu.classList.add('hidden');
    }
  });
}

const alignRightBtn = document.getElementById('toolbar-align-right');
if (alignRightBtn) {
  alignRightBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    if (activeCellId) {
      setCellAlignment(activeCellId, 'right');
    }
    if (toolbarAlignMenu) {
      toolbarAlignMenu.classList.add('hidden');
    }
  });
}

// Toggle toolbar vertical alignment dropdown menu visibility
const toolbarValignBtn = document.getElementById('toolbar-valign');
const toolbarValignMenu = document.getElementById('toolbar-valign-menu');
if (toolbarValignBtn && toolbarValignMenu) {
  toolbarValignBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    const wasOpen = !toolbarValignMenu.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) toolbarValignMenu.classList.remove('hidden');
  });
}

// Hook up individual vertical alignment buttons inside the dropdown
const valignTopBtn = document.getElementById('toolbar-valign-top');
if (valignTopBtn) {
  valignTopBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    if (activeCellId) {
      setCellVerticalAlignment(activeCellId, 'top');
    }
    if (toolbarValignMenu) {
      toolbarValignMenu.classList.add('hidden');
    }
  });
}

const valignCenterBtn = document.getElementById('toolbar-valign-center');
if (valignCenterBtn) {
  valignCenterBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    if (activeCellId) {
      setCellVerticalAlignment(activeCellId, 'center');
    }
    if (toolbarValignMenu) {
      toolbarValignMenu.classList.add('hidden');
    }
  });
}

const valignBottomBtn = document.getElementById('toolbar-valign-bottom');
if (valignBottomBtn) {
  valignBottomBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    if (activeCellId) {
      setCellVerticalAlignment(activeCellId, 'bottom');
    }
    if (toolbarValignMenu) {
      toolbarValignMenu.classList.add('hidden');
    }
  });
}

// Toggle toolbar zoom dropdown menu visibility
const toolbarZoomArrow = document.getElementById('toolbar-zoom-arrow');
const toolbarZoomMenu = document.getElementById('toolbar-zoom-menu');
if (toolbarZoomArrow && toolbarZoomMenu) {
  toolbarZoomArrow.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    const wasOpen = !toolbarZoomMenu.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) toolbarZoomMenu.classList.remove('hidden');
  });
}

// Hook up individual zoom preset option click listeners
document.querySelectorAll('.toolbar-zoom-option').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    const value = parseInt(btn.getAttribute('data-zoom'), 10);
    if (!isNaN(value)) {
      applyGridZoom(value);
    }
    if (toolbarZoomMenu) {
      toolbarZoomMenu.classList.add('hidden');
    }
  });
});

// View navigation dropdown. Zoom (wired to applyGridZoom) and Full screen are the
// interactive entries; the remaining flyouts are greyed-out in the markup because
// their underlying features aren't supported here. Toggling follows the same
// click-to-open / click-to-close pattern as File/Edit/Insert/Format.
const menuViewBtn = document.getElementById('menu-view-btn');
const menuViewDropdown = document.getElementById('menu-view-dropdown');
if (menuViewBtn && menuViewDropdown) {
  menuViewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menuViewDropdown.classList.contains('hidden');
    closeAllMenus();
    if (willOpen) {
      menuViewDropdown.classList.remove('hidden');
      // Refresh the check mark so it reflects the current zoom each time it opens.
      applyGridZoom(currentZoom);
      // Refresh Freeze labels/checks from the active cell + current freeze state.
      updateFreezeMenu();
      // Refresh the Hidden sheets entry (count + flyout list) from current state.
      updateHiddenSheetsMenu();
    }
  });

  // Zoom flyout options reuse the existing grid zoom logic.
  menuViewDropdown.querySelectorAll('.view-zoom-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = parseInt(btn.getAttribute('data-zoom'), 10);
      if (!isNaN(value)) applyGridZoom(value);
      menuViewDropdown.classList.add('hidden');
    });
  });

  // Full screen: toggle the browser Fullscreen API on the whole document.
  const viewFullscreenBtn = document.getElementById('view-fullscreen');
  if (viewFullscreenBtn) viewFullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menuViewDropdown.classList.add('hidden');
    if (!document.fullscreenElement) {
      const root = document.documentElement;
      if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  });

  // Display ▸ Formula bar: show/hide the formula bar row (checked by default).
  // The menu stays open so the check-mark change is visible immediately.
  const viewFormulaBarBtn = document.getElementById('view-display-formulabar');
  if (viewFormulaBarBtn) viewFormulaBarBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const formulaBar = document.getElementById('formula-bar');
    const check = viewFormulaBarBtn.querySelector('.view-display-check');
    if (!formulaBar) return;
    const willHide = formulaBar.style.display !== 'none';
    formulaBar.style.display = willHide ? 'none' : '';
    if (check) check.textContent = willHide ? '' : 'check';
  });

  // Display ▸ Gridlines: toggle the light-gray spreadsheet gridlines (checked by
  // default) via the .gridlines-off class on the grid container.
  const viewGridlinesBtn = document.getElementById('view-display-gridlines');
  if (viewGridlinesBtn) viewGridlinesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const gridRoot = document.getElementById('grid-root');
    const check = viewGridlinesBtn.querySelector('.view-display-check');
    if (!gridRoot) return;
    const nowOff = gridRoot.classList.toggle('gridlines-off');
    if (check) check.textContent = nowOff ? '' : 'check';
  });

  // Freeze flyout: the 0/1/2 entries freeze a fixed count; the "up to" entry
  // freezes through the active cell's row/column. Labels and check marks are
  // refreshed from the active cell each time the View menu opens.
  const freezeOpts = menuViewDropdown.querySelectorAll('.view-freeze-opt');
  const updateFreezeMenu = () => {
    const coord = parseCellCoord(activeCellId || selectionStartCellId || 'A1') || parseCellCoord('A1');
    const activeRow = coord.row;                 // 1-based row of the active cell
    const activeColLetter = coord.colLetter;     // e.g. "C"
    const activeColCount = coord.colIndex + 1;   // columns up to & including it
    const rowUpto = document.getElementById('view-freeze-row-upto');
    const colUpto = document.getElementById('view-freeze-col-upto');
    if (rowUpto) rowUpto.setAttribute('data-n', String(activeRow));
    if (colUpto) colUpto.setAttribute('data-n', String(activeColCount));

    freezeOpts.forEach(btn => {
      const axis = btn.getAttribute('data-axis');
      const n = parseInt(btn.getAttribute('data-n'), 10);
      const labelEl = btn.querySelector('.view-freeze-label');
      const checkEl = btn.querySelector('.view-freeze-check');
      const isUpto = btn.id.endsWith('-upto');
      if (axis === 'row') {
        if (isUpto) labelEl.innerHTML = t('view.freeze.upToRow', { n: activeRow });
        else labelEl.textContent = t('view.freeze.rowCount', { n });
        const checked = isUpto ? (frozenRows > 2 && frozenRows === activeRow) : (frozenRows === n);
        checkEl.textContent = checked ? 'check' : '';
      } else {
        if (isUpto) labelEl.innerHTML = t('view.freeze.upToCol', { col: activeColLetter });
        else labelEl.textContent = t('view.freeze.colCount', { n });
        const checked = isUpto ? (frozenCols > 2 && frozenCols === activeColCount) : (frozenCols === n);
        checkEl.textContent = checked ? 'check' : '';
      }
    });
  };

  freezeOpts.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const axis = btn.getAttribute('data-axis');
      const n = parseInt(btn.getAttribute('data-n'), 10);
      if (isNaN(n)) return;
      if (axis === 'row') setFreeze(n, null); else setFreeze(null, n);
      menuViewDropdown.classList.add('hidden');
    });
  });

  // Hidden sheets entry: greyed out with no flyout when nothing is hidden. When
  // the file has hidden worksheets, the label shows a "(X)" count, the chevron
  // appears, and the right flyout is (re)built with one "Show «name»" row per
  // hidden sheet. Clicking a row broadcasts unhide-sheet and closes the menu.
  const hiddenTrigger = document.getElementById('view-hidden-sheets-trigger');
  const hiddenLabel = document.getElementById('view-hidden-sheets-label');
  const hiddenChevron = document.getElementById('view-hidden-sheets-chevron');
  const hiddenFlyout = document.getElementById('view-hidden-sheets-flyout');
  const updateHiddenSheetsMenu = () => {
    if (!hiddenTrigger || !hiddenLabel || !hiddenChevron || !hiddenFlyout) return;
    // Preserve workbook order rather than hide-event order.
    const hidden = sheetOrder.filter(s => hiddenSheets.includes(s));
    const count = hidden.length;

    if (count === 0) {
      hiddenLabel.textContent = t('view.hiddenSheets');
      hiddenTrigger.className = 'flex items-center justify-between w-full px-4 py-2 text-label-lg text-outline opacity-50 cursor-default select-none';
      hiddenChevron.classList.add('invisible');
      hiddenFlyout.classList.remove('group-hover:block');
      hiddenFlyout.classList.add('hidden');
      hiddenFlyout.innerHTML = '';
      return;
    }

    hiddenLabel.textContent = t('view.hiddenSheets.count', { n: count });
    hiddenTrigger.className = 'flex items-center justify-between w-full px-4 py-2 text-label-lg text-on-surface-variant hover:bg-surface-variant cursor-default select-none';
    hiddenChevron.classList.remove('invisible');
    hiddenFlyout.classList.add('group-hover:block');

    hiddenFlyout.innerHTML = '';
    hidden.forEach(sheetName => {
      const btn = document.createElement('button');
      btn.className = 'flex items-center gap-3 w-full px-4 py-2 text-left hover:bg-surface-variant text-label-lg text-on-surface-variant';
      btn.textContent = t('view.hiddenSheets.unhide', { name: sheetName });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'unhide-sheet', payload: { sheetName } }));
        }
        menuViewDropdown.classList.add('hidden');
      });
      hiddenFlyout.appendChild(btn);
    });
  };
}

// Toggle the Select Font dropdown menu visibility
const toolbarFontBtn = document.getElementById('toolbar-font-btn');
const toolbarFontMenu = document.getElementById('toolbar-font-menu');
if (toolbarFontBtn && toolbarFontMenu) {
  toolbarFontBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    const wasOpen = !toolbarFontMenu.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) toolbarFontMenu.classList.remove('hidden');
  });
}

// Hook up individual font option click listeners
document.querySelectorAll('.toolbar-font-option').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    const fontName = btn.getAttribute('data-font');
    if (fontName && activeCellId) {
      setCellFont(activeCellId, fontName);
    }
    if (toolbarFontMenu) {
      toolbarFontMenu.classList.add('hidden');
    }
  });
});

// Font size controls: editable input, preset menu, and increment/decrement buttons
const toolbarFontSizeInput = document.getElementById('toolbar-font-size-input');
const toolbarFontSizeMenu = document.getElementById('toolbar-font-size-menu');
const toolbarFontSizeDecrease = document.getElementById('toolbar-font-size-decrease');
const toolbarFontSizeIncrease = document.getElementById('toolbar-font-size-increase');

// Reads the current input value, clamps it, applies it to the active cell, and syncs the display.
const applyFontSizeFromInput = () => {
  if (!toolbarFontSizeInput) return;
  const activeStyle = activeCellId && localCells[activeCellId] ? localCells[activeCellId].style : null;
  const currentSize = activeStyle && activeStyle.fontSize ? activeStyle.fontSize : DEFAULT_FONT_SIZE;
  const size = clampFontSize(toolbarFontSizeInput.value);
  if (size === null) {
    // Revert invalid entry to the active cell's size (or default)
    toolbarFontSizeInput.value = currentSize;
    return;
  }
  toolbarFontSizeInput.value = size;
  // Skip applying when unchanged to avoid redundant history entries (e.g. on blur)
  if (activeCellId && size !== currentSize) {
    setCellFontSize(activeCellId, size);
  }
};

// Steps the font size up or down by one point, applying it to the active cell.
const stepFontSize = (delta) => {
  if (!toolbarFontSizeInput) return;
  const current = clampFontSize(toolbarFontSizeInput.value);
  const base = current === null
    ? (activeCellId && localCells[activeCellId] && localCells[activeCellId].style && localCells[activeCellId].style.fontSize
        ? localCells[activeCellId].style.fontSize : DEFAULT_FONT_SIZE)
    : current;
  const next = clampFontSize(base + delta);
  if (next === null) return;
  toolbarFontSizeInput.value = next;
  if (activeCellId) {
    setCellFontSize(activeCellId, next);
  }
};

if (toolbarFontSizeInput && toolbarFontSizeMenu) {
  // Open the preset menu (and select text for easy overwrite) when the input is focused/clicked
  const openFontSizeMenu = (e) => {
    if (e) e.stopPropagation();
    closeAllMenus();
    toolbarFontSizeMenu.classList.remove('hidden');
  };
  toolbarFontSizeInput.addEventListener('focus', function () {
    this.select();
    openFontSizeMenu();
  });
  toolbarFontSizeInput.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    openFontSizeMenu();
  });

  // Apply on Enter (closing the menu) or on blur
  toolbarFontSizeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyFontSizeFromInput();
      toolbarFontSizeMenu.classList.add('hidden');
      toolbarFontSizeInput.blur();
    }
  });
  toolbarFontSizeInput.addEventListener('blur', applyFontSizeFromInput);
}

// Hook up preset font size option click listeners
document.querySelectorAll('.toolbar-font-size-option').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    const size = clampFontSize(btn.getAttribute('data-size'));
    if (size !== null && toolbarFontSizeInput) {
      toolbarFontSizeInput.value = size;
      if (activeCellId) {
        setCellFontSize(activeCellId, size);
      }
    }
    if (toolbarFontSizeMenu) {
      toolbarFontSizeMenu.classList.add('hidden');
    }
  });
});

if (toolbarFontSizeDecrease) {
  toolbarFontSizeDecrease.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    stepFontSize(-1);
  });
}
if (toolbarFontSizeIncrease) {
  toolbarFontSizeIncrease.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    stepFontSize(1);
  });
}

const zoomInputEl = document.getElementById('toolbar-zoom-input');
if (zoomInputEl) {
  // Automatically select input text on focus for easier overwrite
  zoomInputEl.addEventListener('focus', function() {
    this.select();
  });

  // Validate custom zoom level on Enter key or losing focus (blur)
  const handleZoomValidation = () => {
    const rawVal = zoomInputEl.value.trim();
    // Remove trailing percent sign if present
    const cleanVal = rawVal.endsWith('%') ? rawVal.slice(0, -1).trim() : rawVal;
    const parsed = parseInt(cleanVal, 10);

    if (!isNaN(parsed) && parsed >= 50 && parsed <= 200) {
      applyGridZoom(parsed);
    } else {
      // Revert to current valid zoom value if input is invalid
      zoomInputEl.value = `${currentZoom}%`;
    }
  };

  zoomInputEl.addEventListener('blur', handleZoomValidation);
  zoomInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleZoomValidation();
      zoomInputEl.blur();
    }
  });
}

// Close alignment, vertical alignment, and zoom dropdown menus when clicking anywhere else on the page
window.addEventListener('click', (e) => {
  // Dismiss File menu dropdown if clicking outside
  const menuFileDropdownEl = document.getElementById('menu-file-dropdown');
  const menuFileBtnEl = document.getElementById('menu-file-btn');
  if (menuFileDropdownEl && !menuFileDropdownEl.classList.contains('hidden')) {
    if (menuFileBtnEl && !menuFileBtnEl.contains(e.target) && !menuFileDropdownEl.contains(e.target)) {
      menuFileDropdownEl.classList.add('hidden');
    }
  }

  // Dismiss Edit menu dropdown if clicking outside
  const menuEditDropdown = document.getElementById('menu-edit-dropdown');
  const menuEditBtn = document.getElementById('menu-edit-btn');
  if (menuEditDropdown && !menuEditDropdown.classList.contains('hidden')) {
    if (menuEditBtn && !menuEditBtn.contains(e.target) && !menuEditDropdown.contains(e.target)) {
      menuEditDropdown.classList.add('hidden');
    }
  }

  // Dismiss View menu dropdown if clicking outside
  const menuViewDropdownEl = document.getElementById('menu-view-dropdown');
  const menuViewBtnEl = document.getElementById('menu-view-btn');
  if (menuViewDropdownEl && !menuViewDropdownEl.classList.contains('hidden')) {
    if (menuViewBtnEl && !menuViewBtnEl.contains(e.target) && !menuViewDropdownEl.contains(e.target)) {
      menuViewDropdownEl.classList.add('hidden');
    }
  }

  // Dismiss Insert menu dropdown if clicking outside
  const menuInsertDropdown = document.getElementById('menu-insert-dropdown');
  const menuInsertBtn = document.getElementById('menu-insert-btn');
  if (menuInsertDropdown && !menuInsertDropdown.classList.contains('hidden')) {
    if (menuInsertBtn && !menuInsertBtn.contains(e.target) && !menuInsertDropdown.contains(e.target)) {
      menuInsertDropdown.classList.add('hidden');
    }
  }

  // Dismiss Format menu dropdown if clicking outside
  const menuFormatDropdown = document.getElementById('menu-format-dropdown');
  const menuFormatBtn = document.getElementById('menu-format-btn');
  if (menuFormatDropdown && !menuFormatDropdown.classList.contains('hidden')) {
    if (menuFormatBtn && !menuFormatBtn.contains(e.target) && !menuFormatDropdown.contains(e.target)) {
      menuFormatDropdown.classList.add('hidden');
    }
  }

  // Dismiss Data menu dropdown if clicking outside
  const menuDataDropdown = document.getElementById('menu-data-dropdown');
  const menuDataBtn = document.getElementById('menu-data-btn');
  if (menuDataDropdown && !menuDataDropdown.classList.contains('hidden')) {
    if (menuDataBtn && !menuDataBtn.contains(e.target) && !menuDataDropdown.contains(e.target)) {
      menuDataDropdown.classList.add('hidden');
    }
  }

  // Dismiss language switcher menu if clicking outside
  const langSwitchMenu = document.getElementById('lang-switch-menu');
  const langSwitchBtn = document.getElementById('lang-switch-btn');
  if (langSwitchMenu && !langSwitchMenu.classList.contains('hidden')) {
    if (langSwitchBtn && !langSwitchBtn.contains(e.target) && !langSwitchMenu.contains(e.target)) {
      langSwitchMenu.classList.add('hidden');
    }
  }

  // Dismiss the Share split-button menu if clicking outside it or its caret toggle.
  const shareMenuEl = document.getElementById('share-menu');
  const shareMenuToggle = document.getElementById('share-menu-btn');
  if (shareMenuEl && !shareMenuEl.classList.contains('hidden')) {
    if (shareMenuToggle && !shareMenuToggle.contains(e.target) && !shareMenuEl.contains(e.target)) {
      shareMenuEl.classList.add('hidden');
      shareMenuToggle.setAttribute('aria-expanded', 'false');
    }
  }

  const alignMenu = document.getElementById('toolbar-align-menu');
  const alignBtn = document.getElementById('toolbar-align');
  if (alignMenu && !alignMenu.classList.contains('hidden')) {
    if (alignBtn && !alignBtn.contains(e.target) && !alignMenu.contains(e.target)) {
      alignMenu.classList.add('hidden');
    }
  }

  const valignMenu = document.getElementById('toolbar-valign-menu');
  const valignBtn = document.getElementById('toolbar-valign');
  if (valignMenu && !valignMenu.classList.contains('hidden')) {
    if (valignBtn && !valignBtn.contains(e.target) && !valignMenu.contains(e.target)) {
      valignMenu.classList.add('hidden');
    }
  }

  const zoomMenu = document.getElementById('toolbar-zoom-menu');
  const zoomInput = document.getElementById('toolbar-zoom-input');
  const zoomArrow = document.getElementById('toolbar-zoom-arrow');
  if (zoomMenu && !zoomMenu.classList.contains('hidden')) {
    if (zoomInput && zoomArrow && !zoomInput.contains(e.target) && !zoomArrow.contains(e.target) && !zoomMenu.contains(e.target)) {
      zoomMenu.classList.add('hidden');
    }
  }

  const fontMenu = document.getElementById('toolbar-font-menu');
  const fontBtn = document.getElementById('toolbar-font-btn');
  if (fontMenu && !fontMenu.classList.contains('hidden')) {
    if (fontBtn && !fontBtn.contains(e.target) && !fontMenu.contains(e.target)) {
      fontMenu.classList.add('hidden');
    }
  }

  const fontSizeMenu = document.getElementById('toolbar-font-size-menu');
  const fontSizeInput = document.getElementById('toolbar-font-size-input');
  if (fontSizeMenu && !fontSizeMenu.classList.contains('hidden')) {
    if (fontSizeInput && !fontSizeInput.contains(e.target) && !fontSizeMenu.contains(e.target)) {
      fontSizeMenu.classList.add('hidden');
    }
  }
});

const toolbarLinkBtn = document.getElementById('toolbar-link');
if (toolbarLinkBtn) {
  toolbarLinkBtn.addEventListener('click', () => {
    if (activeCellId) openLinkDialog(activeCellId);
  });
}

// Color palette popup + toolbar color inputs live in color-palette.js
// (window.CoSheet.colorPalette); wired via window.CoSheet.app near the bottom.
// The border menu and sheet-tab menu open it via the "border" / "sheet" types.

// Border menu (toolbar border button) lives in border-menu.js
// (window.CoSheet.borderMenu); wired via window.CoSheet.app near the bottom.

// Global keyboard listener for direct cell typing (overwrite & inline) and clear actions
document.addEventListener('keydown', (e) => {
  // Ignore keyboard interactions in history mode
  if (isHistoryMode) return;

  // Only intercept keyboard inputs if we have an active cell selected
  if (!activeCellId) return;

  // Ignore keyboard inputs if user is currently typing in an input field, textarea, or editing a cell
  const activeEl = document.activeElement;
  if (activeEl && (
    activeEl.tagName === 'INPUT' ||
    activeEl.tagName === 'TEXTAREA' ||
    activeEl.getAttribute('contenteditable') === 'true'
  )) {
    return;
  }

  // Ctrl+A toggles a whole-grid selection (every row and column) instead of
  // the browser's page-wide select-all: a first press selects everything, a
  // second press (the grid is already fully selected) collapses back to the
  // active cell alone. Sits above the read-only gate because it only moves
  // the selection — viewers can use it too. When a text field or cell editor
  // has focus the guard above already returned, so the browser's own text
  // select-all still applies there.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    const allStart = 'A1';
    const allEnd = `${getColLetter(getColCount() - 1)}${TOTAL_ROWS}`;
    const allSelected = selectionStartCellId === allStart && selectionEndCellId === allEnd;
    selectionStartCellId = allSelected ? activeCellId : allStart;
    selectionEndCellId = allSelected ? activeCellId : allEnd;
    // Whichever way it toggles, this is a plain range selection, not a
    // column/row-header one — reset the flags so the name box reads A1:Z1000
    // (or the bare cell), not A:Z. It also covers everything, so any extra
    // Ctrl+click header ranges are redundant.
    isColumnSelection = false;
    isRowSelection = false;
    extraSelectionRanges = [];
    updateRangeSelectionUI();
    return;
  }

  // Read-only mode (viewer): every editing shortcut below this point mutates the
  // workbook, so permit only copy and ignore the rest. Cell navigation lives in a
  // separate handler and is unaffected.
  if (!canEditWorkbook) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelectedCells();
    }
    return;
  }

  // Handle keyboard shortcuts: Ctrl+Z (Undo), Ctrl+Y (Redo), Ctrl+C (Copy), Ctrl+X (Cut), Ctrl+V (Paste)
  if (e.ctrlKey || e.metaKey) {
    // Horizontal alignment: Ctrl+Shift+L / C / R. Checked before the plain
    // Ctrl+C copy handler so Ctrl+Shift+C aligns instead of copying. Uses
    // e.code (physical key) to stay layout-independent.
    if (e.shiftKey && (e.code === 'KeyL' || e.code === 'KeyC' || e.code === 'KeyR')) {
      e.preventDefault();
      const alignMap = { KeyL: 'left', KeyC: 'center', KeyR: 'right' };
      setCellAlignment(activeCellId, alignMap[e.code]);
      return;
    }
    if (e.key.toLowerCase() === 'z') {
      e.preventDefault();
      performUndo();
      return;
    }
    if (e.key.toLowerCase() === 'y') {
      e.preventDefault();
      performRedo();
      return;
    }
    if (e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelectedCells();
      return;
    }
    if (e.key.toLowerCase() === 'x') {
      e.preventDefault();
      cutSelectedCells();
      return;
    }
    if (e.key.toLowerCase() === 'v') {
      e.preventDefault();
      pasteSelectedCells();
      return;
    }
    if (e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleFormat(activeCellId, 'bold');
      return;
    }
    if (e.key.toLowerCase() === 'i') {
      e.preventDefault();
      toggleFormat(activeCellId, 'italic');
      return;
    }
    if (e.key.toLowerCase() === 'u') {
      e.preventDefault();
      toggleFormat(activeCellId, 'underline');
      return;
    }
    // Ctrl+K opens the insert/edit-link dialog for the active cell.
    if (e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (activeCellId) openLinkDialog(activeCellId);
      return;
    }
    // Ctrl+\ clears all formatting from the selection (Google Sheets parity).
    if (e.code === 'Backslash' && !e.shiftKey) {
      e.preventDefault();
      clearFormatting(activeCellId);
      return;
    }
    // Ctrl+Shift+. increases font size; Ctrl+Shift+, decreases it
    if (e.shiftKey && e.code === 'Period') {
      e.preventDefault();
      stepFontSize(1);
      return;
    }
    if (e.shiftKey && e.code === 'Comma') {
      e.preventDefault();
      stepFontSize(-1);
      return;
    }
  }

  // Strikethrough: Alt+Shift+5
  if (e.altKey && e.shiftKey && e.code === 'Digit5') {
    e.preventDefault();
    toggleFormat(activeCellId, 'strikethrough');
    return;
  }

  // Ignore keyboard event if any modifier keys are held down (e.g. Ctrl+C, Ctrl+V, etc.)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // Clear active cell value if Backspace or Delete is pressed
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    clearCell(activeCellId);
    return;
  }

  // Enter begins inline editing of the active cell (showing a text cursor).
  // While editing, the cell's own keydown handler takes over: pressing Enter
  // again commits and moves the selection down to the next cell in the column.
  if (e.key === 'Enter') {
    const cellEl = document.querySelector(`[data-cell-id="${activeCellId}"]`);
    if (cellEl) {
      e.preventDefault();
      startCellInlineEdit(activeCellId, cellEl);
    }
    return;
  }

  // Intercept alphanumeric or symbol keypress to initiate inline cell editing
  if (e.key.length === 1) {
    const cellEl = document.querySelector(`[data-cell-id="${activeCellId}"]`);
    if (cellEl) {
      e.preventDefault();
      startCellInlineEdit(activeCellId, cellEl, e.key);
    }
  }
});

// Hook up toolbar undo/redo buttons
const toolbarUndoBtn = document.getElementById('toolbar-undo');
if (toolbarUndoBtn) {
  toolbarUndoBtn.addEventListener('click', () => {
    performUndo();
  });
}

const toolbarRedoBtn = document.getElementById('toolbar-redo');
if (toolbarRedoBtn) {
  toolbarRedoBtn.addEventListener('click', () => {
    performRedo();
  });
}

// Initialise toolbar undo/redo button states
updateUndoRedoButtonsState();

/**
 * Renders the sheet tabs in the footer and sets click handlers to switch active sheets.
 */
const renderSheetTabs = () => {
  const container = document.getElementById('sheet-tabs-container');
  if (!container) return;
  
  container.innerHTML = '';
  sheetOrder.forEach(sheetName => {
    if (hiddenSheets.includes(sheetName)) return;
    
    const tab = document.createElement('div');
    const isActive = sheetName === activeSheetName;
    
    tab.className = isActive
      ? 'bg-surface-container-lowest text-primary font-bold px-4 h-full flex items-center text-label-lg font-label-lg group cursor-pointer transition-all relative'
      : 'text-on-surface-variant px-4 h-full flex items-center hover:bg-surface-container-highest text-label-lg font-label-lg group cursor-pointer transition-all relative';
      
    // Apply custom sheet colors if defined. Drawn as an inset box-shadow rather
    // than a real bottom border so the colored bar takes up no layout space —
    // with border-box sizing a 3px border would shrink the content box and nudge
    // the vertically-centered label up, changing the tab's apparent height only
    // for colored sheets.
    if (sheetColors[sheetName]) {
      tab.style.boxShadow = `inset 0 -3px 0 0 ${sheetColors[sheetName]}`;
    }
    
    if (sheetName === renamingSheet) {
      // Inline rename: swap the label for an editable input seeded with the name.
      const input = document.createElement('input');
      input.type = 'text';
      input.value = sheetName;
      input.maxLength = 30;
      input.className = 'bg-surface-container-lowest dark:bg-inverse-surface text-on-surface dark:text-on-surface-variant border border-primary rounded px-1.5 py-0.5 m-0.5 outline-none text-label-lg font-label-lg';
      input.addEventListener('click', (e) => e.stopPropagation());
      // Auto-size the input to its content. Count CJK/full-width characters as
      // ~2 units since a `ch` is the width of a narrow glyph ('0').
      const autoSize = () => {
        const units = [...input.value].reduce((n, c) =>
          n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
        input.style.width = `${Math.max(6, units + 3)}ch`;
      };
      autoSize();
      input.addEventListener('input', autoSize);

      let settled = false;
      const commit = () => {
        if (settled) return;
        settled = true;
        const cleanName = input.value.trim();
        renamingSheet = null;
        if (cleanName && cleanName !== sheetName) {
          if (/^[\p{L}\p{N} ]{2,30}$/u.test(cleanName)) {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'rename-sheet', payload: { oldName: sheetName, newName: cleanName } }));
            }
          } else {
            alert(t('sheet.invalidName'));
          }
        }
        renderSheetTabs();
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        renamingSheet = null;
        renderSheetTabs();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });
      input.addEventListener('blur', commit);

      tab.appendChild(input);
      container.appendChild(tab);
      // Focus and select after it's in the DOM.
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return;
    }

    const label = document.createElement('span');
    label.innerText = sheetName;
    tab.appendChild(label);

    // Render the dropdown arrow on every tab (not just the active one)
    if (!isHistoryMode) {
      const arrowSpan = document.createElement('span');
      arrowSpan.className = 'material-symbols-outlined text-[18px] ml-1 cursor-pointer select-none';
      arrowSpan.innerText = 'arrow_drop_down';
      arrowSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        switchSheet(sheetName);
        showSheetContextMenu(sheetName, e.clientX, e.clientY);
      });
      tab.appendChild(arrowSpan);
    }

    // While editing a formula, clicking another sheet's tab switches to it to
    // pick a cross-sheet range instead of committing. Handled on mousedown (before
    // the editor would blur/commit); preventDefault keeps focus, and the handoff
    // moves editing to the formula bar. The click below then no-ops (same sheet).
    tab.addEventListener('mousedown', (e) => {
      if (isHistoryMode) return;
      if (sheetName === activeSheetName) return;
      if (activeFormulaEditor && typeof activeFormulaEditor.getValue === 'function'
          && activeFormulaEditor.getValue().startsWith('=')) {
        e.preventDefault();
        beginCrossSheetFormulaSwitch(sheetName);
      }
    });

    tab.addEventListener('click', () => {
      switchSheet(sheetName);
    });

    container.appendChild(tab);
  });
};

/**
 * Displays a styled modal confirmation dialog for deleting a sheet.
 * Replaces the native window.confirm() with a themed modal (see
 * images/delete_sheet_dialog.html). Resolves the supplied callback on confirm.
 * @param {string} sheetName - The sheet name targeted for deletion.
 * @param {Function} onConfirm - Invoked when the user confirms deletion.
 */
const showDeleteSheetDialog = (sheetName, onConfirm) => {
  // Remove any existing instance first
  const existing = document.getElementById('delete-sheet-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'delete-sheet-overlay';
  overlay.className = 'fixed inset-0 z-[2000] flex items-center justify-center bg-black/40 p-4';

  const modal = document.createElement('div');
  modal.className = 'bg-surface-container-lowest dark:bg-inverse-surface rounded-lg shadow-xl border border-outline-variant w-full max-w-[558px] overflow-hidden';
  modal.innerHTML = `
    <div class="flex justify-between items-start p-6 pb-2">
      <h2 class="text-headline-md font-headline-md font-bold text-on-surface dark:text-on-surface-variant tracking-wide">${t('sheet.deleteTitle')}</h2>
      <button type="button" data-role="close" aria-label="Close" class="text-outline hover:text-on-surface transition-colors">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div class="px-6 py-4">
      <p class="text-body-lg text-on-surface dark:text-on-surface-variant">${t('sheet.deleteBody', { name: sheetName })}</p>
    </div>
    <div class="flex justify-end items-center gap-4 p-6 pt-2">
      <button type="button" data-role="cancel" class="border border-outline-variant bg-transparent text-primary px-8 py-2 rounded-md text-label-lg font-label-lg hover:bg-surface-variant transition-colors">${t('dialog.cancel')}</button>
      <button type="button" data-role="confirm" class="bg-primary text-on-primary px-8 py-2 rounded-md text-label-lg font-label-lg hover:opacity-90 transition-opacity">${t('dialog.confirm')}</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  modal.querySelector('[data-role="close"]').addEventListener('click', close);
  modal.querySelector('[data-role="cancel"]').addEventListener('click', close);
  modal.querySelector('[data-role="confirm"]').addEventListener('click', () => {
    close();
    onConfirm();
  });
  // Dismiss on backdrop click or Escape
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
};

/**
 * Renders and displays the context actions menu for a sheet tab.
 * @param {string} sheetName - The sheet name to target.
 * @param {number} x - Click x coordinate.
 * @param {number} _y - Click y coordinate (unused; menu anchors on x only).
 */
const showSheetContextMenu = (sheetName, x, _y) => {
  // Dismiss any existing context menus first
  const existing = document.getElementById('sheet-context-menu');
  if (existing) existing.remove();
  
  const menu = document.createElement('div');
  menu.id = 'sheet-context-menu';
  menu.className = 'fixed bg-surface-container-lowest dark:bg-inverse-surface shadow-lg rounded py-1 z-[1000] border border-outline-variant text-label-lg text-on-surface dark:text-on-surface-variant w-48';
  
  const visibleSheets = sheetOrder.filter(s => !hiddenSheets.includes(s));
  const canDeleteOrHide = visibleSheets.length > 1;
  
  // 1. Delete Option
  const deleteOpt = document.createElement('div');
  deleteOpt.className = `px-4 py-2 hover:bg-surface-variant cursor-pointer ${!canDeleteOrHide ? 'opacity-40 cursor-not-allowed' : ''}`;
  deleteOpt.innerText = t('sheet.delete');
  if (canDeleteOrHide) {
    deleteOpt.addEventListener('click', () => {
      menu.remove();
      showDeleteSheetDialog(sheetName, () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'delete-sheet', payload: { sheetName } }));
        }
      });
    });
  }
  menu.appendChild(deleteOpt);
  
  // 2. Copy Option
  const copyOpt = document.createElement('div');
  copyOpt.className = 'px-4 py-2 hover:bg-surface-variant cursor-pointer';
  copyOpt.innerText = t('sheet.copy');
  copyOpt.addEventListener('click', () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'copy-sheet', payload: { sheetName } }));
    }
    menu.remove();
  });
  menu.appendChild(copyOpt);
  
  // 3. Rename Option
  const renameOpt = document.createElement('div');
  renameOpt.className = 'px-4 py-2 hover:bg-surface-variant cursor-pointer';
  renameOpt.innerText = t('sheet.rename');
  renameOpt.addEventListener('click', () => {
    menu.remove();
    // Switch to the sheet and start inline editing of its tab label.
    switchSheet(sheetName);
    renamingSheet = sheetName;
    renderSheetTabs();
  });
  menu.appendChild(renameOpt);
  
  // 4. Change Color Option — opens the full Google-Sheets-style colour palette
  // as a flyout to the right, the same picker used for text colour in the
  // toolbar. It opens on hover ("cursor moved to") or on click.
  const colorOpt = document.createElement('div');
  colorOpt.className = 'px-4 py-2 hover:bg-surface-variant cursor-pointer border-t border-outline-variant flex items-center justify-between';
  colorOpt.innerHTML = `<span>${t('sheet.changeColor')}</span><span class="material-symbols-outlined text-[18px]">chevron_right</span>`;
  const openSheetColorPalette = () => {
    const existing = document.getElementById('color-palette-popup');
    if (existing && existing.dataset.type === 'sheet') return; // already open
    window.CoSheet.colorPalette.open('sheet', colorOpt, { placement: 'right', sheetName });
  };
  colorOpt.addEventListener('mouseenter', openSheetColorPalette);
  colorOpt.addEventListener('click', (e) => { e.stopPropagation(); openSheetColorPalette(); });
  menu.appendChild(colorOpt);

  // Close the colour flyout when the pointer moves onto a different menu item.
  menu.addEventListener('mouseover', (e) => {
    if (colorOpt.contains(e.target)) return;
    const p = document.getElementById('color-palette-popup');
    if (p && p.dataset.type === 'sheet') window.CoSheet.colorPalette.close();
  });

  // 5. Hide Option
  const hideOpt = document.createElement('div');
  hideOpt.className = `px-4 py-2 hover:bg-surface-variant cursor-pointer border-t border-outline-variant ${!canDeleteOrHide ? 'opacity-40 cursor-not-allowed' : ''}`;
  hideOpt.innerText = t('sheet.hide');
  if (canDeleteOrHide) {
    hideOpt.addEventListener('click', () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'hide-sheet', payload: { sheetName } }));
      }
      menu.remove();
    });
  }
  menu.appendChild(hideOpt);
  
  // 6. Move Left Option
  const visibleIndex = visibleSheets.indexOf(sheetName);
  const moveLeftOpt = document.createElement('div');
  moveLeftOpt.className = `px-4 py-2 hover:bg-surface-variant cursor-pointer ${visibleIndex === 0 ? 'opacity-40 cursor-not-allowed' : ''}`;
  moveLeftOpt.innerText = t('sheet.moveLeft');
  if (visibleIndex > 0) {
    moveLeftOpt.addEventListener('click', () => {
      const prevVisible = visibleSheets[visibleIndex - 1];
      const newOrder = [...sheetOrder];
      const idx = newOrder.indexOf(sheetName);
      const prevIdx = newOrder.indexOf(prevVisible);
      
      const temp = newOrder[prevIdx];
      newOrder[prevIdx] = newOrder[idx];
      newOrder[idx] = temp;
      
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'reorder-sheets', payload: { sheetOrder: newOrder } }));
      }
      menu.remove();
    });
  }
  menu.appendChild(moveLeftOpt);

  // 7. Move Right Option
  const moveRightOpt = document.createElement('div');
  moveRightOpt.className = `px-4 py-2 hover:bg-surface-variant cursor-pointer ${visibleIndex === visibleSheets.length - 1 ? 'opacity-40 cursor-not-allowed' : ''}`;
  moveRightOpt.innerText = t('sheet.moveRight');
  if (visibleIndex < visibleSheets.length - 1) {
    moveRightOpt.addEventListener('click', () => {
      const nextVisible = visibleSheets[visibleIndex + 1];
      const newOrder = [...sheetOrder];
      const idx = newOrder.indexOf(sheetName);
      const nextIdx = newOrder.indexOf(nextVisible);
      
      const temp = newOrder[nextIdx];
      newOrder[nextIdx] = newOrder[idx];
      newOrder[idx] = temp;
      
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'reorder-sheets', payload: { sheetOrder: newOrder } }));
      }
      menu.remove();
    });
  }
  menu.appendChild(moveRightOpt);

  document.body.appendChild(menu);
  
  // Dynamically calculate the positioning of the sheet context menu
  // to prevent it from going off the right or bottom edges of the viewport.
  const menuWidth = menu.offsetWidth || 192;
  const menuHeight = menu.offsetHeight || 250;
  
  // Calculate horizontal position (stay within window bounds)
  let leftVal = x;
  if (leftVal + menuWidth > window.innerWidth) {
    leftVal = window.innerWidth - menuWidth - 8;
  }
  if (leftVal < 8) {
    leftVal = 8;
  }
  menu.style.left = `${leftVal}px`;
  
  // Calculate vertical position (position above footer, fit within window)
  const bottomVal = 50;
  if (window.innerHeight - bottomVal - menuHeight < 10) {
    menu.style.top = '10px';
    menu.style.bottom = 'auto';
  } else {
    menu.style.bottom = `${bottomVal}px`;
  }
  
  // Dismiss menu on click elsewhere
  const dismiss = () => {
    menu.remove();
    window.CoSheet.colorPalette.close();
    document.removeEventListener('click', dismiss);
  };
  // Timeout prevents triggering dismiss on this immediate click event
  setTimeout(() => document.addEventListener('click', dismiss), 50);
};

/**
 * Switches the active spreadsheet sheet and re-renders the grid.
 * @param {string} sheetName - The sheet name to switch to.
 */
// Persist the active sheet per file so a reload returns to it. The server doesn't
// track a per-user active sheet across connections (it resets to the first sheet),
// so this lives client-side in localStorage, keyed by file id.
const ACTIVE_SHEET_KEY = `co-sheet:active-sheet:${currentFileId || 'default'}`;
const saveActiveSheetPref = (sheetName) => {
  try { localStorage.setItem(ACTIVE_SHEET_KEY, sheetName); } catch (e) { /* storage unavailable */ }
};
const loadActiveSheetPref = () => {
  try { return localStorage.getItem(ACTIVE_SHEET_KEY); } catch (e) { return null; }
};

/** Records the current sheet's selection so it can be restored on return. */
const rememberSheetSelection = () => {
  if (!activeCellId) { deleteKey(sheetSelections, activeSheetName); return; }
  setKey(sheetSelections, activeSheetName, {
    activeCellId,
    startId: selectionStartCellId || activeCellId,
    endId: selectionEndCellId || activeCellId,
    isColumnSelection: !!isColumnSelection,
    isRowSelection: !!isRowSelection,
  });
};

/**
 * Re-applies the active sheet's last selection (outline + formula bar + toolbar),
 * if one was recorded this session and its cell is still on the grid. Returns the
 * restored active cell id, or null when there was nothing to restore. The cursor
 * broadcast is left to the caller so it can include the sheet name.
 */
const restoreSheetSelection = () => {
  const saved = sheetSelections[activeSheetName];
  if (!saved) return null;
  const cellEl = document.querySelector(`[data-cell-id="${saved.activeCellId}"]`);
  if (!cellEl) return null;
  isColumnSelection = saved.isColumnSelection;
  isRowSelection = !!saved.isRowSelection;
  selectionStartCellId = saved.startId;
  selectionEndCellId = saved.endId;
  handleCellSelect(saved.activeCellId, cellEl, true); // silent: switchSheet broadcasts below
  return saved.activeCellId;
};

const switchSheet = (sheetName) => {
  if (activeSheetName === sheetName) return;

  // Remember where we were on this sheet, then clear the selection state.
  rememberSheetSelection();
  if (activeCellId) {
    clearRangeSelection();
    activeCellId = null;
  }
  selectionStartCellId = null;
  selectionEndCellId = null;
  isColumnSelection = false;
  isRowSelection = false;
  extraSelectionRanges = [];

  activeSheetName = sheetName;
  saveActiveSheetPref(sheetName); // remember across reloads (client-side)
  renderSheetTabs();
  renderSpreadsheetGrid();

  if (isHistoryMode) return;

  // Restore this sheet's last selection; on a sheet not yet visited this session,
  // fall back to selecting A1 so the blue outline appears (as on first page load).
  const restored = restoreSheetSelection();
  if (!restored) {
    const a1El = document.querySelector('[data-cell-id="A1"]');
    if (a1El) handleCellSelect('A1', a1El, true); // silent: the broadcast below carries the sheet
  }

  // Tell peers the new sheet and the now-active cell in one cursor-move.
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'cursor-move',
      payload: { cellId: activeCellId || null, sheetName: activeSheetName }
    }));
  }

  // (Remote collaborator cursors for the now-active sheet were already re-rendered
  // by renderSpreadsheetGrid() above, which calls renderRemoteCursors().)

  // Reset the formatting bar only when nothing got selected (A1 missing); a
  // restore or the A1 fallback already synced the toolbar to its cell's style.
  if (!activeCellId) updateToolbarFormattingStates({});
};

/**
 * Adds a new sheet dynamically and notifies the server.
 * @param {string} [sheetName] - Optional custom name.
 */
const addSheet = (sheetName) => {
  let name = sheetName;
  if (!name) {
    // Localize the default base name based on the current UI language.
    let lang = 'zh';
    try { lang = localStorage.getItem('app-language') || 'zh'; } catch (err) {}
    const base = lang === 'en' ? 'Sheet' : '工作表';
    let n = Object.keys(localSheets).length + 1;
    name = `${base}${n}`;
    while (localSheets[name]) { n += 1; name = `${base}${n}`; }
  }
  if (localSheets[name]) return;

  setKey(localSheets, name, Object.create(null));
  if (!sheetOrder.includes(name)) sheetOrder.push(name);
  if (socket && socket.readyState === WebSocket.OPEN && !sheetName) {
    socket.send(JSON.stringify({
      type: 'add-sheet',
      payload: { sheetName: name }
    }));
  }
  switchSheet(name);
};

// Hook up add sheet button
const addSheetBtn = document.getElementById('add-sheet-btn');
if (addSheetBtn) {
  addSheetBtn.addEventListener('click', () => {
    addSheet();
  });
}

// Hook up hamburger sheets list menu
const hamburgerMenuBtn = document.querySelector('footer button.mr-2');
if (hamburgerMenuBtn) {
  hamburgerMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    
    const existing = document.getElementById('sheet-list-popup');
    if (existing) {
      existing.remove();
      return;
    }
    
    const popup = document.createElement('div');
    popup.id = 'sheet-list-popup';
    popup.className = 'fixed bottom-[45px] left-10 bg-surface-container-lowest dark:bg-inverse-surface shadow-lg rounded py-1 z-[1000] border border-outline-variant max-h-[250px] overflow-y-auto text-label-md text-on-surface dark:text-on-surface-variant w-48';
    
    sheetOrder.forEach(sheetName => {
      const isHidden = hiddenSheets.includes(sheetName);
      const item = document.createElement('div');
      item.className = 'pl-2 pr-4 py-2 hover:bg-surface-variant cursor-pointer flex items-center gap-2';

      // Leading checkmark column (visible only on the active sheet)
      const check = document.createElement('span');
      check.className = 'material-symbols-outlined text-[18px] w-[18px] shrink-0 text-primary';
      check.innerText = sheetName === activeSheetName ? 'check' : '';

      if (isHidden) {
        item.appendChild(check);
        item.insertAdjacentHTML('beforeend', `<span class="italic text-outline flex-grow">${sheetName}</span> <span class="text-[12px] text-outline italic">${t('sheet.hidden')}</span>`);
        item.addEventListener('click', () => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'unhide-sheet', payload: { sheetName } }));
          }
          popup.remove();
        });
      } else {
        const label = document.createElement('span');
        label.className = 'flex-grow';
        label.innerText = sheetName;
        item.appendChild(check);
        item.appendChild(label);
        if (sheetName === activeSheetName) {
          item.className += ' font-bold text-primary';
        }
        item.addEventListener('click', () => {
          switchSheet(sheetName);
          popup.remove();
        });
      }
      popup.appendChild(item);
    });
    
    document.body.appendChild(popup);
    
    const dismissPopup = () => {
      popup.remove();
      document.removeEventListener('click', dismissPopup);
    };
    setTimeout(() => document.addEventListener('click', dismissPopup), 50);
  });
}

/**
 * Render the shared user-avatar menu: a circular avatar that shows an account
 * info card on hover and an account dropdown (name + email + Sign out) on click.
 * The component (public/user-menu.js) fetches /api/me, populates itself, and
 * redirects to the login page on an unauthenticated (401) response.
 */
const userMenuMount = document.getElementById('user-menu');
if (userMenuMount && window.CoSheet && window.CoSheet.userMenu) {
  window.CoSheet.userMenu.init({ mount: userMenuMount, redirectOnUnauth: true });
}

// Stop range selection dragging when releasing mouse button anywhere
window.addEventListener('mouseup', () => {
  const endedCellSelection = isSelecting;
  isSelecting = false;
  if (isFillDragging) {
    applyFillDrag(); // write the base range's cells into the dragged extension
    isFillDragging = false;
    fillDragBaseRange = null;
    document.body.classList.remove('fill-dragging');
  }
  // An armed format painter fires on the mouseup that completes a grid
  // selection (a click or a drag), stamping the source style onto it. A
  // mouseup anywhere else (toolbar, menus) leaves the painter armed.
  if (endedCellSelection && paintFormatStyle) applyPaintFormat();
  endFormulaPick(); // freeze the formula pick range; the box stays until typed over
});

// File navigation dropdown. New / Make a copy / Share / Rename / Details are the
// interactive entries (the remaining items are greyed-out in the markup). Toggling
// follows the same click-to-open / click-to-close pattern as Edit/Insert/Format.
const menuFileBtn = document.getElementById('menu-file-btn');
const menuFileDropdown = document.getElementById('menu-file-dropdown');
if (menuFileBtn && menuFileDropdown) {
  const closeFileMenu = () => menuFileDropdown.classList.add('hidden');
  menuFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menuFileDropdown.classList.contains('hidden');
    closeAllMenus();
    if (willOpen) menuFileDropdown.classList.remove('hidden');
  });

  // The file this editor is bound to ('default' for the legacy workbook).
  const effectiveFileId = () => currentFileId || 'default';
  const currentFileNameValue = () => {
    const el = document.getElementById('file-name');
    const name = el && el.innerText ? el.innerText.trim() : '';
    return name || t('drive.untitled');
  };

  // --- New: create a fresh blank spreadsheet and open it in a new browser tab. ---
  const fileNewBtn = document.getElementById('file-new');
  if (fileNewBtn) fileNewBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeFileMenu();
    // Open the tab synchronously (within the click gesture) so popup blockers
    // don't block it after the async create; navigate it once the id is known.
    const win = window.open('', '_blank');
    try {
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: t('drive.untitled') })
      });
      if (res.status === 403) {
        const d = await res.json().catch(() => ({}));
        if (win) win.close();
        alert(d.error === 'file_limit' ? t('drive.fileLimit') : t('drive.noPermission'));
        return;
      }
      if (!res.ok) throw new Error('create failed');
      const data = await res.json();
      const url = data.url || `/sheet?file=${data.id}`;
      if (win) win.location = url; else window.open(url, '_blank');
    } catch (err) {
      if (win) win.close();
      alert(t('drive.loadError'));
    }
  });

  // --- Import: pick a local .xls/.xlsx file and create a new file from it. The
  // server enforces the per-role file quota and parses the workbook; an over-quota
  // user (or an unreadable/legacy file) gets a warning dialog instead of a new tab.
  const fileImportBtn = document.getElementById('file-import');
  const importInput = document.getElementById('import-file-input');
  if (fileImportBtn && importInput) {
    fileImportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFileMenu();
      importInput.value = ''; // let the same file be re-picked after a prior attempt
      importInput.click();
    });

    importInput.addEventListener('change', async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      const lower = file.name.toLowerCase();
      if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
        showMessageDialog(t('import.warningTitle'), t('import.badType'));
        return;
      }
      const baseName = file.name.replace(/\.(xlsx|xls)$/i, '').trim() || t('drive.untitled');
      // Open the tab synchronously (within the change gesture) so the post-upload
      // navigation isn't popup-blocked; close it on any failure.
      const win = window.open('', '_blank');
      try {
        const buf = await file.arrayBuffer();
        const res = await fetch(`/api/files/import?name=${encodeURIComponent(baseName)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          credentials: 'same-origin',
          body: buf
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          if (win) win.close();
          showMessageDialog(t('import.warningTitle'), importErrorMessage(res.status, d.error));
          return;
        }
        const data = await res.json();
        // Filters are browser-local view state (localStorage, never in the saved
        // document). Seed any imported auto-filters under the new file's key before
        // navigating so the new tab paints them on first render.
        if (data.filters && Object.keys(data.filters).length) {
          try {
            localStorage.setItem(`co-sheet-filters:${data.id}`, JSON.stringify(data.filters));
          } catch (e) { /* storage full/blocked: skip filter seeding */ }
        }
        const url = data.url || `/sheet?file=${data.id}`;
        if (win) win.location = url; else window.open(url, '_blank');
      } catch (err) {
        if (win) win.close();
        showMessageDialog(t('import.warningTitle'), t('import.failed'));
      }
    });
  }

  // Map an import failure (HTTP status + server error code) to a localized warning.
  function importErrorMessage(status, code) {
    if (status === 403 || code === 'file_limit') return t('import.fileLimit');
    if (code === 'legacy_xls') return t('import.legacyXls');
    if (code === 'unsupported') return t('import.unsupported');
    if (code === 'empty') return t('import.empty');
    return t('import.failed');
  }

  // --- Make a copy: open the copy dialog, prefilled with "<name> 的副本". ---
  const copyModal = document.getElementById('copy-file-modal');
  const copyNameInput = document.getElementById('copy-file-name');
  const copyShareChk = document.getElementById('copy-share-collaborators');
  const copyConfirmBtn = document.getElementById('copy-file-confirm');
  const copyCancelBtn = document.getElementById('copy-file-cancel');
  const closeCopyDialog = () => { if (copyModal) copyModal.classList.add('hidden'); };
  const openCopyDialog = () => {
    if (!copyModal) return;
    if (copyNameInput) copyNameInput.value = t('copy.namePattern', { name: currentFileNameValue() });
    if (copyShareChk) copyShareChk.checked = false;
    copyModal.classList.remove('hidden');
    if (copyNameInput) { copyNameInput.focus(); copyNameInput.select(); }
  };
  const fileMakeCopyBtn = document.getElementById('file-make-copy');
  if (fileMakeCopyBtn) fileMakeCopyBtn.addEventListener('click', (e) => {
    e.stopPropagation(); closeFileMenu(); openCopyDialog();
  });
  if (copyCancelBtn) copyCancelBtn.addEventListener('click', closeCopyDialog);
  if (copyConfirmBtn) copyConfirmBtn.addEventListener('click', async () => {
    const name = (copyNameInput && copyNameInput.value.trim()) ||
                 t('copy.namePattern', { name: currentFileNameValue() });
    const shareCollaborators = !!(copyShareChk && copyShareChk.checked);
    copyConfirmBtn.disabled = true;
    // Open the tab synchronously so the post-fetch navigation isn't popup-blocked.
    const win = window.open('', '_blank');
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(effectiveFileId())}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name, shareCollaborators })
      });
      if (res.status === 403) {
        const d = await res.json().catch(() => ({}));
        if (win) win.close();
        alert(d.error === 'file_limit' ? t('drive.fileLimit') : t('drive.noPermission'));
        return;
      }
      if (!res.ok) throw new Error('copy failed');
      const data = await res.json();
      closeCopyDialog();
      const url = data.url || `/sheet?file=${data.id}`;
      if (win) win.location = url; else window.open(url, '_blank');
    } catch (err) {
      if (win) win.close();
      alert(t('copy.failed'));
    } finally {
      copyConfirmBtn.disabled = false;
    }
  });
  if (copyModal) {
    let copyPress = null;
    copyModal.addEventListener('mousedown', (e) => { copyPress = e.target; });
    copyModal.addEventListener('click', (e) => {
      if (e.target === copyModal && copyPress === copyModal) closeCopyDialog();
    });
  }

  // --- Share: reuse the existing share dialog. ---
  const fileShareBtn = document.getElementById('file-share');
  if (fileShareBtn) fileShareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFileMenu();
    const sb = document.getElementById('share-btn');
    if (sb) sb.click();
  });

  // --- Rename: start inline editing of the file name (gated by edit access). ---
  const fileRenameBtn = document.getElementById('file-rename');
  if (fileRenameBtn) fileRenameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFileMenu();
    if (!canEditWorkbook) return;
    const el = document.getElementById('file-name');
    if (el) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });

  // --- Details: load and show read-only file metadata. ---
  const detailsModal = document.getElementById('details-modal');
  const detailsCloseBtn = document.getElementById('details-close');
  const fileDetailsBtn = document.getElementById('file-details');
  // Locale-aware date/time formatting for the timestamps.
  const fmtDetailDate = (iso, withTime) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const locale = getLang() === 'zh-TW' ? 'zh-TW' : 'en-US';
    const opts = withTime
      ? { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { year: 'numeric', month: 'long', day: 'numeric' };
    try { return new Intl.DateTimeFormat(locale, opts).format(d); }
    catch (e) { return d.toLocaleString(); }
  };
  const closeDetailsDialog = () => { if (detailsModal) detailsModal.classList.add('hidden'); };
  const openDetailsDialog = async () => {
    if (!detailsModal) return;
    const ownerEl = document.getElementById('details-owner');
    const modEl = document.getElementById('details-modified');
    const crEl = document.getElementById('details-created');
    if (ownerEl) ownerEl.textContent = '…';
    if (modEl) modEl.textContent = '…';
    if (crEl) crEl.textContent = '…';
    detailsModal.classList.remove('hidden');
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(effectiveFileId())}/details`, {
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('details failed');
      const d = await res.json();
      if (ownerEl) ownerEl.textContent = d.ownerIsSelf ? t('details.me') : (d.owner || t('drive.sharedSample'));
      if (modEl) modEl.textContent = fmtDetailDate(d.updatedAt, true);
      if (crEl) crEl.textContent = fmtDetailDate(d.createdAt, false);
    } catch (err) {
      if (ownerEl) ownerEl.textContent = t('details.failed');
      if (modEl) modEl.textContent = '—';
      if (crEl) crEl.textContent = '—';
    }
  };
  if (fileDetailsBtn) fileDetailsBtn.addEventListener('click', (e) => {
    e.stopPropagation(); closeFileMenu(); openDetailsDialog();
  });
  if (detailsCloseBtn) detailsCloseBtn.addEventListener('click', closeDetailsDialog);
  if (detailsModal) {
    let detPress = null;
    detailsModal.addEventListener('mousedown', (e) => { detPress = e.target; });
    detailsModal.addEventListener('click', (e) => {
      if (e.target === detailsModal && detPress === detailsModal) closeDetailsDialog();
    });
  }

  // --- Download ▸ Microsoft Excel (.xlsx): export every sheet to a real .xlsx
  // and download it named after the workbook (the file name shown top-left).
  // Other formats in the submenu are greyed-out and unwired. ---

  // Map a cell's internal style object onto the flat descriptor the xlsx writer
  // understands (fonts, fill, font color, alignment, borders). Returns null when
  // the cell has no styling worth exporting. Note: `style.color` is the cell's
  // background fill and `style.textColor` is the font color in this app's model.
  const normalizeStyleForExport = (style) => {
    if (!style) return null;
    const out = {};
    if (style.bold) out.bold = true;
    if (style.italic) out.italic = true;
    if (style.underline) out.underline = true;
    if (style.strikethrough) out.strike = true;
    if (style.fontFamily) out.fontName = style.fontFamily;
    if (style.fontSize) out.fontSize = style.fontSize;
    if (style.textColor) out.fontColor = style.textColor;
    if (style.color) out.bgColor = style.color;
    if (style.align) out.hAlign = style.align;
    if (style.verticalAlign) out.vAlign = style.verticalAlign;
    if (style.textWrap === 'wrap') out.wrap = true;
    // Borders: cellBorderSide normalises the legacy boolean `border` and the
    // structured `borders` map to a per-side { color, style } spec.
    const borders = {};
    let hasBorder = false;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const spec = cellBorderSide(style, side);
      if (spec) { borders[side] = { color: spec.color, style: spec.style }; hasBorder = true; }
    }
    if (hasBorder) out.borders = borders;
    return Object.keys(out).length ? out : null;
  };

  const collectWorkbookForExport = () => {
    const prevActive = activeSheetName;
    const out = [];
    try {
      for (const name of sheetOrder) {
        const sheetCells = localSheets[name] || {};
        // Evaluate formulas in the context of their own sheet (the formula
        // engine resolves references through the active sheet's cells).
        activeSheetName = name;
        const cells = [];
        for (const cellId of Object.keys(sheetCells)) {
          if (!/^[A-Z]+\d+$/.test(cellId)) continue;
          const { col, row } = parseCoordinates(cellId); // 0-based
          if (row < 0 || col < 0) continue;
          const cellData = sheetCells[cellId];
          const value = getCellValue(cellId);
          const style = normalizeStyleForExport(cellData && cellData.style);
          const hasVal = !(value === '' || value === null || value === undefined);
          // Keep styled-but-empty cells so fills/borders still export.
          if (!hasVal && !style) continue;
          cells.push({ row, col, value, style });
        }
        out.push({ name, cells });
      }
    } finally {
      activeSheetName = prevActive;
    }
    return out;
  };
  // The Download flyout is position:fixed so it isn't clipped by the File
  // menu's vertical scroll container. Place it just right of its trigger row on
  // hover (flipping to the left / clamping vertically near viewport edges).
  const dlGroup = document.getElementById('file-download-group');
  const dlFlyout = document.getElementById('file-download-flyout');
  if (dlGroup && dlFlyout) {
    const positionDownloadFlyout = () => {
      const trigger = dlGroup.querySelector(':scope > button');
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const fw = dlFlyout.offsetWidth || 288;   // w-72
      const fh = dlFlyout.offsetHeight || 220;
      let left = r.right - 1;
      if (left + fw > window.innerWidth - 4) left = r.left - fw + 1;
      let top = r.top;
      if (top + fh > window.innerHeight - 4) top = window.innerHeight - fh - 4;
      dlFlyout.style.left = `${Math.max(4, left)}px`;
      dlFlyout.style.top = `${Math.max(4, top)}px`;
    };
    dlGroup.addEventListener('mouseenter', positionDownloadFlyout);
  }

  const fileDownloadXlsxBtn = document.getElementById('file-download-xlsx');
  if (fileDownloadXlsxBtn) fileDownloadXlsxBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFileMenu();
    const exporter = window.CoSheet && window.CoSheet.xlsxExport;
    if (!exporter) return;
    try {
      exporter.downloadXlsx(collectWorkbookForExport(), currentFileNameValue());
    } catch (err) {
      alert(t('drive.loadError'));
    }
  });

  // Escape closes whichever File-menu dialog is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (copyModal && !copyModal.classList.contains('hidden')) closeCopyDialog();
    if (detailsModal && !detailsModal.classList.contains('hidden')) closeDetailsDialog();
  });
}

// Edit navigation dropdown button bindings to toggle display
const menuEditBtn = document.getElementById('menu-edit-btn');
const menuEditDropdown = document.getElementById('menu-edit-dropdown');
const searchReplaceModal = document.getElementById('search-replace-modal');

if (menuEditBtn && menuEditDropdown) {
  menuEditBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !menuEditDropdown.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) menuEditDropdown.classList.remove('hidden');
  });
}

// Insert menu: insert-cell (partial-range shift right/down) plus structural
// row/column inserts. Each option reuses the formula-reference adjuster so refs
// follow their data after the shift.
const menuInsertBtn = document.getElementById('menu-insert-btn');
const menuInsertDropdown = document.getElementById('menu-insert-dropdown');

// Bounding box of the current selection (falls back to the active cell).
const getInsertSelectionBounds = () => {
  const a = selectionStartCellId || activeCellId;
  if (!a) return null;
  const pa = parseCellCoord(a);
  if (!pa) return null;
  const pb = parseCellCoord(selectionEndCellId || a) || pa;
  return {
    minCol: Math.min(pa.colIndex, pb.colIndex),
    maxCol: Math.max(pa.colIndex, pb.colIndex),
    minRow: Math.min(pa.row, pb.row),
    maxRow: Math.max(pa.row, pb.row),
  };
};

// Fill the flyout option labels with the live selection size (e.g. "向下插入 3 列").
const refreshInsertLabels = () => {
  const b = getInsertSelectionBounds();
  const rows = b ? b.maxRow - b.minRow + 1 : 1;
  const cols = b ? b.maxCol - b.minCol + 1 : 1;
  const rowU = rows === 1 ? 'row' : 'rows';
  const colU = cols === 1 ? 'column' : 'columns';
  const set = (id, key, vars) => { const el = document.getElementById(id); if (el) el.textContent = t(key, vars); };
  set('ins-row-above-label', 'ins.rowAbove', { n: rows, u: rowU });
  set('ins-row-below-label', 'ins.rowBelow', { n: rows, u: rowU });
  set('ins-col-left-label',  'ins.colLeft',  { n: cols, u: colU });
  set('ins-col-right-label', 'ins.colRight', { n: cols, u: colU });
};

if (menuInsertBtn && menuInsertDropdown) {
  menuInsertBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menuInsertDropdown.classList.contains('hidden');
    closeAllMenus();
    if (willOpen) {
      menuInsertDropdown.classList.remove('hidden');
      refreshInsertLabels();
    }
  });

  const closeInsertMenu = () => menuInsertDropdown.classList.add('hidden');
  // Insert N blank rows/columns by replaying the single-line insert N times,
  // where N is the selection span (each call also adjusts formula references).
  const doInsertRows = (where) => {
    const b = getInsertSelectionBounds(); if (!b) return;
    const n = b.maxRow - b.minRow + 1;
    const at = where === 'above' ? b.minRow : b.maxRow + 1;
    for (let i = 0; i < n; i++) performStructuralInsert('row', at);
    closeInsertMenu();
  };
  const doInsertCols = (where) => {
    const b = getInsertSelectionBounds(); if (!b) return;
    const n = b.maxCol - b.minCol + 1;
    const at = where === 'left' ? b.minCol : b.maxCol + 1;
    for (let i = 0; i < n; i++) performStructuralInsert('col', at);
    closeInsertMenu();
  };
  const wireInsert = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  };
  const doInsertCells = (direction) => { performCellInsert(direction); closeInsertMenu(); };
  wireInsert('ins-cell-right', () => doInsertCells('right'));
  wireInsert('ins-cell-down',  () => doInsertCells('down'));
  wireInsert('ins-row-above', () => doInsertRows('above'));
  wireInsert('ins-row-below', () => doInsertRows('below'));
  wireInsert('ins-col-left',  () => doInsertCols('left'));
  wireInsert('ins-col-right', () => doInsertCols('right'));
  // Sheet: add a new sheet (same as the footer "+" button).
  wireInsert('ins-sheet', () => { addSheet(); closeInsertMenu(); });
  // Link: open the insert/edit-link dialog for the active cell.
  wireInsert('ins-link', () => { closeInsertMenu(); if (activeCellId) openLinkDialog(activeCellId); });
}

// Format menu: number formats, text styles, alignment, text wrapping and font
// size. Each implemented option delegates to the existing cell-style functions
// (so history/undo and live sync come for free). Options whose behaviour is
// uncertain are rendered greyed-out and non-interactive in the markup, so they
// intentionally have no handler here.
const menuFormatBtn = document.getElementById('menu-format-btn');
const menuFormatDropdown = document.getElementById('menu-format-dropdown');
if (menuFormatBtn && menuFormatDropdown) {
  const closeFormatMenu = () => menuFormatDropdown.classList.add('hidden');
  // Run an action against the active cell (the cell-style helpers expand it to
  // the full selection internally), then close the menu.
  const act = (fn) => { if (activeCellId) fn(activeCellId); closeFormatMenu(); };
  const wireFmt = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  };

  menuFormatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menuFormatDropdown.classList.contains('hidden');
    closeAllMenus();
    if (willOpen) {
      menuFormatDropdown.classList.remove('hidden');
      // Refresh the Merge-cells entry's enabled/greyed state for the current
      // selection each time the menu opens.
      updateMergeMenuState();
    }
  });

  // Fill the Number submenu's example previews from the SAME formatter the grid
  // uses, so the hints always match real output.
  if (typeof menuFormatDropdown.querySelectorAll === 'function') {
    menuFormatDropdown.querySelectorAll('[data-fmt-eg]').forEach((el) => {
      const fmt = el.getAttribute('data-fmt-eg');
      const out = formatNumberByType(fmt === 'percent' ? 0.1012 : 1000.12, fmt);
      if (out !== null) el.textContent = out;
    });
  }

  // Build the Font size submenu (same presets as the toolbar control). Each option
  // carries a fixed-width check slot that stays reserved when unchecked, so the
  // size labels line up (mirroring the Number submenu).
  const fontSizeList = document.getElementById('fmt-fontsize-list');
  if (fontSizeList && !fontSizeList.childElementCount) {
    FONT_SIZE_PRESETS.forEach((sz) => {
      const b = document.createElement('button');
      b.className = 'flex items-center gap-2 w-full px-4 py-1.5 text-left hover:bg-surface-variant text-label-md text-on-surface-variant';
      b.setAttribute('data-size', sz);
      const check = document.createElement('span');
      check.className = 'material-symbols-outlined text-[18px] w-[18px] shrink-0 fmt-size-check invisible';
      check.textContent = 'check';
      const label = document.createElement('span');
      label.textContent = sz;
      b.appendChild(check);
      b.appendChild(label);
      b.addEventListener('click', (e) => { e.stopPropagation(); act((id) => setCellFontSize(id, sz)); });
      fontSizeList.appendChild(b);
    });
    // The list is built after the first toolbar refresh, so seed the check mark here.
    const s = activeCellId && localCells[activeCellId] ? localCells[activeCellId].style : null;
    updateFontSizeMenuChecks(s);
  }

  // Number formats
  wireFmt('fmt-num-auto',             () => act((id) => setCellNumberFormat(id, null)));
  wireFmt('fmt-num-plain-text',       () => act((id) => setCellNumberFormat(id, 'text')));
  wireFmt('fmt-num-number',           () => act((id) => setCellNumberFormat(id, 'number')));
  wireFmt('fmt-num-percent',          () => act((id) => setCellNumberFormat(id, 'percent')));
  wireFmt('fmt-num-scientific',       () => act((id) => setCellNumberFormat(id, 'scientific')));
  wireFmt('fmt-num-accounting',       () => act((id) => setCellNumberFormat(id, 'accounting')));
  wireFmt('fmt-num-financial',        () => act((id) => setCellNumberFormat(id, 'financial')));
  wireFmt('fmt-num-currency',         () => act((id) => setCellNumberFormat(id, 'currency')));
  wireFmt('fmt-num-currency-rounded', () => act((id) => setCellNumberFormat(id, 'currencyRounded')));

  // Text styles
  wireFmt('fmt-text-bold',      () => act((id) => toggleFormat(id, 'bold')));
  wireFmt('fmt-text-italic',    () => act((id) => toggleFormat(id, 'italic')));
  wireFmt('fmt-text-underline', () => act((id) => toggleFormat(id, 'underline')));
  wireFmt('fmt-text-strike',    () => act((id) => toggleFormat(id, 'strikethrough')));

  // Clear formatting
  wireFmt('fmt-clear',          () => act((id) => clearFormatting(id)));

  // Alignment (horizontal + vertical)
  wireFmt('fmt-align-left',    () => act((id) => setCellAlignment(id, 'left')));
  wireFmt('fmt-align-center',  () => act((id) => setCellAlignment(id, 'center')));
  wireFmt('fmt-align-right',   () => act((id) => setCellAlignment(id, 'right')));
  wireFmt('fmt-valign-top',    () => act((id) => setCellVerticalAlignment(id, 'top')));
  wireFmt('fmt-valign-middle', () => act((id) => setCellVerticalAlignment(id, 'center')));
  wireFmt('fmt-valign-bottom', () => act((id) => setCellVerticalAlignment(id, 'bottom')));

  // Text wrapping
  wireFmt('fmt-wrap-overflow', () => act((id) => setCellTextWrap(id, 'overflow')));
  wireFmt('fmt-wrap-wrap',     () => act((id) => setCellTextWrap(id, 'wrap')));
  wireFmt('fmt-wrap-clip',     () => act((id) => setCellTextWrap(id, 'clip')));

  // Merge cells. Disabled entries carry pointer-events-none (see setMenuEnabled),
  // so these clicks only fire when the option is actually available; the merge
  // helpers re-validate the selection anyway.
  wireFmt('fmt-merge-all',          () => { mergeSelectedCells('all');        closeFormatMenu(); });
  wireFmt('fmt-merge-vertically',   () => { mergeSelectedCells('vertical');   closeFormatMenu(); });
  wireFmt('fmt-merge-horizontally', () => { mergeSelectedCells('horizontal'); closeFormatMenu(); });
  wireFmt('fmt-merge-unmerge',      () => { unmergeSelectedCells();           closeFormatMenu(); });
}

/** Greys out (and click-disables) a menu entry when `on` is false. */
const setMenuEnabled = (el, on) => {
  if (!el || !el.classList) return;
  el.classList.toggle('opacity-50', !on);
  el.classList.toggle('pointer-events-none', !on);
  el.classList.toggle('cursor-default', !on);
};

/**
 * Updates the Format ▸ Merge cells submenu for the current selection:
 *   • the whole group is greyed (which also suppresses the hover flyout) unless
 *     2+ cells are selected;
 *   • "Merge all" needs 2+ cells; "Merge vertically" needs 2+ rows; "Merge
 *     horizontally" needs 2+ columns; "Unmerge" needs the selection to already
 *     contain a merged cell.
 */
const updateMergeMenuState = () => {
  const group = document.getElementById('fmt-merge-group');
  if (!group) return;
  const coords = getSelectedCellIds({ activeRangeOnly: true }).map(parseCellCoord).filter(Boolean);
  let rows = 0, cols = 0;
  if (coords.length) {
    const rs = coords.map(c => c.row), cs = coords.map(c => c.colIndex);
    rows = Math.max(...rs) - Math.min(...rs) + 1;
    cols = Math.max(...cs) - Math.min(...cs) + 1;
  }
  const multi = coords.length >= 2;
  const hasMerge = coords.some(c => styleHasMerge((localCells[`${getColLetter(c.colIndex)}${c.row}`] || {}).style));
  const canEdit = canEditWorkbook && !isHistoryMode;

  setMenuEnabled(group, canEdit && multi);
  setMenuEnabled(document.getElementById('fmt-merge-all'),          canEdit && multi);
  setMenuEnabled(document.getElementById('fmt-merge-vertically'),   canEdit && rows >= 2);
  setMenuEnabled(document.getElementById('fmt-merge-horizontally'), canEdit && cols >= 2);
  setMenuEnabled(document.getElementById('fmt-merge-unmerge'),      canEdit && hasMerge);
};

/**
 * Shows the generic message dialog (#message-modal) with the given title/body.
 * Used for the "can't filter a range with merged cells" error. The OK/close
 * buttons and backdrop click are wired once below.
 */
const showMessageDialog = (title, body) => {
  const modal = document.getElementById('message-modal');
  if (!modal || !modal.classList) return;
  const titleEl = document.getElementById('message-modal-title');
  const bodyEl = document.getElementById('message-modal-body');
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.textContent = body;
  modal.classList.remove('hidden');
};

// Wire the message dialog's dismiss controls once.
(() => {
  const modal = document.getElementById('message-modal');
  if (!modal) return;
  const hide = () => modal.classList.add('hidden');
  const ok = document.getElementById('message-modal-ok');
  const close = document.getElementById('message-modal-close');
  if (ok) ok.addEventListener('click', hide);
  if (close) close.addEventListener('click', hide);
  // Backdrop click (but not clicks inside the dialog card) dismisses.
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
})();

// Data menu: only "Sort sheet" is wired. Its flyout offers ascending/descending
// sorts keyed on the column of the active cell; the two labels (and the bolded
// column letter) are rebuilt from that column each time the menu opens. The
// remaining entries are greyed-out placeholders in the markup with no handlers.
const menuDataBtn = document.getElementById('menu-data-btn');
const menuDataDropdown = document.getElementById('menu-data-dropdown');
if (menuDataBtn && menuDataDropdown) {
  // The column the sort keys on: the active cell's column (selection start as a
  // fallback), defaulting to A so the labels always read sensibly.
  const sortColIndex = () => {
    const coord = parseCellCoord(activeCellId || selectionStartCellId || 'A1');
    return coord ? coord.colIndex : 0;
  };

  // Refresh the two flyout labels (e.g. "Sort sheet by column F (A → Z)") with
  // the active column's letter in bold. Set as HTML so the <strong> renders.
  const updateDataSortMenu = () => {
    const colLetter = getColLetter(sortColIndex());
    const azBtn = document.getElementById('data-sort-az');
    const zaBtn = document.getElementById('data-sort-za');
    const azLabel = azBtn && azBtn.querySelector('.data-sort-label');
    const zaLabel = zaBtn && zaBtn.querySelector('.data-sort-label');
    if (azLabel) azLabel.innerHTML = t('data.sortSheet.az', { col: colLetter });
    if (zaLabel) zaLabel.innerHTML = t('data.sortSheet.za', { col: colLetter });
  };

  // Reorder every non-frozen data row by the chosen column (delegating to the
  // shared sortDataRows), then close the menu. Whole rows move together; cell
  // contents/styles are carried as-is.
  const performSheetSort = (colIndex, ascending) => {
    window.CoSheet.sortFilter.sortDataRows(colIndex, ascending, (frozenRows || 0) + 1);
    menuDataDropdown.classList.add('hidden');
  };

  menuDataBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menuDataDropdown.classList.contains('hidden');
    closeAllMenus();
    if (willOpen) {
      menuDataDropdown.classList.remove('hidden');
      updateDataSortMenu();
      window.CoSheet.sortFilter.updateDataLabel();
    }
  });

  // The Create-filter entry toggles a value filter on the active cell's column;
  // while one is active on the sheet it removes it instead.
  const createFilterBtn = document.getElementById('data-create-filter');
  if (createFilterBtn) createFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menuDataDropdown.classList.add('hidden');
    if (window.CoSheet.sortFilter.hasActiveFilter()) window.CoSheet.sortFilter.removeFilter();
    else window.CoSheet.sortFilter.createFilter(sortColIndex());
  });

  // The toolbar funnel button toggles the same per-sheet value filter as the
  // Data ▸ Create/Remove filter entry, on the active cell's column.
  const toolbarFilterBtn = document.getElementById('toolbar-filter');
  if (toolbarFilterBtn) toolbarFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.CoSheet.sortFilter.hasActiveFilter()) window.CoSheet.sortFilter.removeFilter();
    else window.CoSheet.sortFilter.createFilter(sortColIndex());
  });

  const azBtn = document.getElementById('data-sort-az');
  const zaBtn = document.getElementById('data-sort-za');
  if (azBtn) azBtn.addEventListener('click', (e) => { e.stopPropagation(); performSheetSort(sortColIndex(), true); });
  if (zaBtn) zaBtn.addEventListener('click', (e) => { e.stopPropagation(); performSheetSort(sortColIndex(), false); });
}

// ───────────────────────────────────────────────────────────────────────────
// Sorting & value filter live in sort-filter.js (window.CoSheet.sortFilter);
// wired via window.CoSheet.app near the bottom. The grid renderer calls
// applyFilter()/updateToolbarButton() and the Data menu / funnel drive it.
// ───────────────────────────────────────────────────────────────────────────

// Language switcher: toggle menu, apply selection, persist choice (Chinese default)
const langSwitchBtn = document.getElementById('lang-switch-btn');
const langSwitchMenu = document.getElementById('lang-switch-menu');
const langSwitchLabel = document.getElementById('lang-switch-label');
const LANG_LABELS = { zh: '中文', en: 'English' };

const applyLanguageSelection = (lang) => {
  if (!LANG_LABELS[lang]) lang = 'zh';
  if (langSwitchLabel) langSwitchLabel.textContent = LANG_LABELS[lang];
  // Show the check glyph only on the selected language. We toggle the icon's
  // text content (not a `hidden` class) because the Material Symbols stylesheet
  // sets `display:inline-block` on these spans, which would override `.hidden`
  // and leave the checkmark visible on both options.
  document.querySelectorAll('#lang-switch-menu .lang-option').forEach((opt) => {
    const check = opt.querySelector('.lang-check');
    if (check) check.textContent = opt.dataset.lang === lang ? 'check' : '';
  });
  translatePage(lang);
  // The "Last saved …" stamp is built dynamically (interpolated time), so
  // translatePage() can't swap it — re-render it for the new language.
  renderSavedTime();
  try { localStorage.setItem('app-language', lang); } catch (err) {}
  // Language is now applied — reveal the UI (see the FOUC guard in index.html).
  if (document.documentElement) document.documentElement.classList.add('i18n-ready');
};

if (langSwitchBtn && langSwitchMenu && typeof langSwitchMenu.querySelectorAll === 'function') {
  langSwitchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !langSwitchMenu.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) langSwitchMenu.classList.remove('hidden');
  });
  langSwitchMenu.querySelectorAll('.lang-option').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      applyLanguageSelection(opt.dataset.lang);
      langSwitchMenu.classList.add('hidden');
    });
  });
  // Restore saved language (default Chinese). Wait for the locale JSON files to
  // load first so translatePage() has data to apply; if fetch is unavailable
  // (non-browser test sandboxes) or the load fails, apply immediately.
  let savedLang = 'zh';
  try { savedLang = localStorage.getItem('app-language') || 'zh'; } catch (err) {}
  if (typeof fetch === 'function') {
    loadLocales().then(() => applyLanguageSelection(savedLang));
  } else {
    applyLanguageSelection(savedLang);
  }
}

// ---------------------------------------------------------------------------
// Menu-bar–style hover switching. Once any toolbar / menu-bar menu is open,
// moving the mouse onto a different opener auto-opens its menu (and closes the
// previous one). We reuse each opener's existing click handler — which already
// runs closeAllMenus() then opens — by synthesizing a click on hover, but only
// when some *other* menu is currently open. That way idle hovering never pops a
// menu, and hovering the already-open opener doesn't toggle it shut.
// ---------------------------------------------------------------------------
(() => {
  const menuHidden = (id) => {
    const el = document.getElementById(id);
    return !el || el.classList.contains('hidden');
  };
  const paletteOpen = (type) => {
    const p = document.getElementById('color-palette-popup');
    return !!p && p.dataset.type === type;
  };
  // Each opener button paired with a predicate reporting whether ITS own menu is
  // currently open.
  const openers = [
    { btn: 'toolbar-border',         isOpen: () => window.CoSheet.borderMenu.isOpen() },
    { btn: 'toolbar-align',          isOpen: () => !menuHidden('toolbar-align-menu') },
    { btn: 'toolbar-valign',         isOpen: () => !menuHidden('toolbar-valign-menu') },
    { btn: 'toolbar-zoom-arrow',     isOpen: () => !menuHidden('toolbar-zoom-menu') },
    { btn: 'toolbar-font-btn',       isOpen: () => !menuHidden('toolbar-font-menu') },
    { btn: 'toolbar-font-size-input',isOpen: () => !menuHidden('toolbar-font-size-menu') },
    { btn: 'toolbar-color-text',     isOpen: () => paletteOpen('text') },
    { btn: 'toolbar-color-fill',     isOpen: () => paletteOpen('fill') },
    { btn: 'menu-file-btn',          isOpen: () => !menuHidden('menu-file-dropdown') },
    { btn: 'menu-edit-btn',          isOpen: () => !menuHidden('menu-edit-dropdown') },
    { btn: 'menu-view-btn',          isOpen: () => !menuHidden('menu-view-dropdown') },
    { btn: 'menu-insert-btn',        isOpen: () => !menuHidden('menu-insert-dropdown') },
    { btn: 'menu-format-btn',        isOpen: () => !menuHidden('menu-format-dropdown') },
    { btn: 'menu-data-btn',          isOpen: () => !menuHidden('menu-data-dropdown') },
    { btn: 'lang-switch-btn',        isOpen: () => !menuHidden('lang-switch-menu') },
  ];
  const anyOpen = () => openers.some((o) => o.isOpen());
  openers.forEach((o) => {
    const el = document.getElementById(o.btn);
    if (!el) return;
    el.addEventListener('mouseenter', () => {
      // Switch only when a different menu is already open.
      if (anyOpen() && !o.isOpen()) el.click();
    });
  });
})();

// ---------------------------------------------------------------------------
// Menu-bar opener highlight. While a menu-bar dropdown is open its opener
// button keeps the same gray as its hover state so it reads as "active" (like
// Google Sheets). A MutationObserver watches each dropdown's `hidden` class so
// the highlight stays in sync no matter how the menu is opened or dismissed —
// click toggle, closeAllMenus(), outside-click, hover-switch, or Escape.
// ---------------------------------------------------------------------------
(() => {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
  const ACTIVE = 'bg-surface-container-high';
  const pairs = [
    ['menu-file-btn', 'menu-file-dropdown'],
    ['menu-edit-btn', 'menu-edit-dropdown'],
    ['menu-view-btn', 'menu-view-dropdown'],
    ['menu-insert-btn', 'menu-insert-dropdown'],
    ['menu-format-btn', 'menu-format-dropdown'],
    ['menu-data-btn', 'menu-data-dropdown'],
  ];
  pairs.forEach(([btnId, dropdownId]) => {
    const btn = document.getElementById(btnId);
    const dropdown = document.getElementById(dropdownId);
    if (!btn || !dropdown) return;
    const sync = () => btn.classList.toggle(ACTIVE, !dropdown.classList.contains('hidden'));
    new MutationObserver(sync).observe(dropdown, { attributes: true, attributeFilter: ['class'] });
    sync();
  });
})();

// ---------------------------------------------------------------------------
// Formula-bar resize: dragging the handle below the formula bar grows its
// height. The minimum is the bar's initial (current) height — it can only
// expand, never shrink below where it started.
// ---------------------------------------------------------------------------
(() => {
  if (typeof document === 'undefined') return;
  const bar = document.getElementById('formula-bar');
  const handle = document.getElementById('formula-resize-handle');
  if (!bar || !handle) return;
  const minHeight = Math.round(bar.getBoundingClientRect().height) || 32;
  let dragging = false;
  let startY = 0;
  let startH = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = bar.getBoundingClientRect().height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newH = Math.max(minHeight, startH + (e.clientY - startY));
    bar.style.height = `${newH}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// Custom styled tooltips: replace native `title` bubbles with a black,
// white-text, rounded tooltip. Reads each element's `title` at hover time so
// i18n updates (translatePage) are respected; the native title is temporarily
// removed while shown to suppress the OS tooltip, then restored on leave.
(() => {
  // Guard clause for non-browser/sandboxed test environments (e.g. Node vm context)
  if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') {
    return;
  }
  const tip = document.createElement('div');
  tip.id = 'app-tooltip';
  document.body.appendChild(tip);

  let current = null; // element whose tooltip is showing
  let stashed = null; // its original title text

  const position = (el) => {
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const margin = 6;
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - t.width - 4));
    // Elements that opt in (e.g. the bottom sheet-tab controls, where a tooltip
    // below would fall off-screen) are always placed above; everyone else shows
    // below and only flips up when there is no room.
    const preferAbove = el.getAttribute('data-tooltip-placement') === 'top';
    let top = preferAbove ? r.top - t.height - margin : r.bottom + margin;
    if (!preferAbove && top + t.height > window.innerHeight - 4) {
      top = r.top - t.height - margin; // flip above if no room below
    }
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };

  const hide = () => {
    if (current && stashed != null) {
      current.setAttribute('title', stashed);
    }
    current = null;
    stashed = null;
    tip.classList.remove('visible');
  };

  const show = (el) => {
    const text = el.getAttribute('title');
    if (!text) return;
    if (current === el) return;
    hide();
    current = el;
    stashed = text;
    el.removeAttribute('title'); // suppress native tooltip
    tip.textContent = text;
    tip.classList.add('visible');
    position(el);
  };

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[title]');
    if (el) show(el);
  });
  document.addEventListener('mouseout', (e) => {
    if (current && (e.target === current || (current.contains && current.contains(e.target)))) {
      hide();
    }
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[title]');
    if (el) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('mousedown', hide); // dismiss on click
  window.addEventListener('scroll', hide, true);
})();

// Bind redo action button
const editRedoBtn = document.getElementById('edit-redo');
if (editRedoBtn) {
  editRedoBtn.onclick = () => {
    performRedo();
    if (menuEditDropdown) menuEditDropdown.classList.add('hidden');
  };
}

// Bind undo action button
const editUndoBtn = document.getElementById('edit-undo');
if (editUndoBtn) {
  editUndoBtn.onclick = () => {
    performUndo();
    if (menuEditDropdown) menuEditDropdown.classList.add('hidden');
  };
}

// Bind cut action button
const editCutBtn = document.getElementById('edit-cut');
if (editCutBtn) {
  editCutBtn.onclick = () => {
    cutSelectedCells();
    if (menuEditDropdown) menuEditDropdown.classList.add('hidden');
  };
}

// Bind copy action button
const editCopyBtn = document.getElementById('edit-copy');
if (editCopyBtn) {
  editCopyBtn.onclick = () => {
    copySelectedCells();
    if (menuEditDropdown) menuEditDropdown.classList.add('hidden');
  };
}

// Bind paste action button
const editPasteBtn = document.getElementById('edit-paste');
if (editPasteBtn) {
  editPasteBtn.onclick = () => {
    pasteSelectedCells();
    if (menuEditDropdown) menuEditDropdown.classList.add('hidden');
  };
}

// Bind search and replace dialog trigger
const editSearchReplaceBtn = document.getElementById('edit-search-replace');
if (editSearchReplaceBtn) {
  editSearchReplaceBtn.onclick = () => {
    if (searchReplaceModal) searchReplaceModal.classList.remove('hidden');
    if (menuEditDropdown) menuEditDropdown.classList.add('hidden');
    const findInput = document.getElementById('find-input');
    if (findInput) findInput.focus();
  };
}

// Bind find and replace modal close button
const findCloseBtn = document.getElementById('find-close-btn');
if (findCloseBtn) {
  findCloseBtn.onclick = () => {
    if (searchReplaceModal) searchReplaceModal.classList.add('hidden');
  };
}

// Bind find and replace modal done button
const findDoneBtn = document.getElementById('find-done-btn');
if (findDoneBtn) {
  findDoneBtn.onclick = () => {
    if (searchReplaceModal) searchReplaceModal.classList.add('hidden');
  };
}

// The Find / Replace / Replace-all action buttons are wired by find-replace.js
// (window.CoSheet.findReplace) via its init() below.

/**
 * Share dialog. Only features backed by real server behavior are functional:
 * copying the file's shareable link, closing, and navigating between the main
 * view and the settings sub-view. "People with access" reflects the signed-in
 * user's real access level (owner / editor / viewer). Unsupported controls are
 * displayed disabled rather than faked.
 */
const shareModal = document.getElementById('share-modal');
if (shareModal) {
  const shareBtn = document.getElementById('share-btn');
  const shareMainView = document.getElementById('share-main-view');
  const shareSettingsView = document.getElementById('share-settings-view');
  const addInput = document.getElementById('share-add-input');
  const chipsEl = document.getElementById('share-chips');
  const resultsEl = document.getElementById('share-search-results');
  const defaultSection = document.getElementById('share-default-section');
  const composeRole = document.getElementById('share-compose-role');
  const actionsDefault = document.getElementById('share-actions-default');
  const actionsCompose = document.getElementById('share-actions-compose');
  const submitBtn = document.getElementById('share-submit');

  // Minimal HTML escaper for safe interpolation of user-controlled strings.
  const shareEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // The shareable URL for the current workbook (default has no ?file=).
  const shareUrl = () => currentFileId
    ? `${window.location.origin}/sheet?file=${currentFileId}`
    : `${window.location.origin}/sheet`;

  const currentFileName = () => {
    const el = document.getElementById('file-name');
    const name = el && el.innerText ? el.innerText.trim() : '';
    return name || t('drive.untitled');
  };

  // ----- module state for the share flow -----
  let shareFileRow = null;     // this file's row from /api/files ({ owner, canModify, ... })
  let selectedUsers = [];      // users picked but not yet shared: [{ id, username, email }]
  let searchTimer = null;
  let composeRoleValue = 'editor'; // role applied to newly added people (default Editor)

  // Compose-role dropdown elements (Editor/Viewer for people being added).
  const composeRoleBtn = document.getElementById('share-compose-role-btn');
  const composeRoleLabel = document.getElementById('share-compose-role-label');
  const composeRoleMenu = document.getElementById('share-compose-role-menu');
  const setComposeRole = (role) => {
    composeRoleValue = role === 'viewer' ? 'viewer' : 'editor';
    if (composeRoleLabel) composeRoleLabel.textContent = t('role.' + composeRoleValue);
  };

  // General-access dropdown elements (Restricted vs Anyone with the link).
  const accessTrigger = document.getElementById('share-access-trigger');
  const accessLabel = document.getElementById('share-access-label');
  const accessMenu = document.getElementById('share-access-menu');
  const accessDesc = document.getElementById('share-access-desc');
  const accessIcon = document.getElementById('share-access-icon');
  let accessValue = 'restricted';

  // Reflect a general-access value in the trigger label, description, icon, and the
  // menu checkmarks.
  const applyAccessUI = (value) => {
    accessValue = value === 'anyone' ? 'anyone' : 'restricted';
    if (accessLabel) accessLabel.textContent = t(accessValue === 'anyone' ? 'share.anyoneWithLink' : 'share.restricted');
    if (accessDesc) accessDesc.textContent = t(accessValue === 'anyone' ? 'share.anyoneDesc' : 'share.restrictedDesc');
    if (accessIcon) {
      const ic = accessIcon.querySelector('.material-symbols-outlined');
      if (ic) ic.textContent = accessValue === 'anyone' ? 'public' : 'lock';
    }
    if (accessMenu) {
      accessMenu.querySelectorAll('.share-access-item').forEach((item) => {
        const check = item.querySelector('[data-role="check"]');
        if (check) check.classList.toggle('invisible', item.getAttribute('data-access') !== accessValue);
      });
    }
  };

  // Sharing is available only to an owner/admin of a real (non-default) file.
  const canShare = () => !!(currentFileId && shareFileRow && shareFileRow.canModify);

  const fetchFileRow = async () => {
    shareFileRow = null;
    try {
      const list = await (await fetch('/api/files')).json();
      const id = currentFileId || 'default';
      shareFileRow = Array.isArray(list) ? list.find((f) => f.id === id) : null;
    } catch (e) { /* leave null */ }
  };

  // A single person row (used for "people with access").
  const personRow = (name, email, roleKey, picture) => {
    // 'system' is the seeded-sample sentinel, not a real user — show a friendly label.
    if (name === 'system') name = t('drive.sharedSample');
    const initial = (String(name).trim()[0] || '?').toUpperCase();
    const avatar = picture
      ? `<img src="${shareEsc(picture)}" alt="" class="w-9 h-9 rounded-full object-cover shrink-0"/>`
      : `<span class="w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center text-sm font-medium shrink-0">${shareEsc(initial)}</span>`;
    return `
      <div class="flex items-center gap-3">
        ${avatar}
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-on-surface truncate">${shareEsc(name)}</div>
          <div class="text-xs text-on-surface-variant truncate">${shareEsc(email || '')}</div>
        </div>
        <div class="text-sm text-on-surface-variant shrink-0">${shareEsc(t('role.' + roleKey))}</div>
      </div>`;
  };

  // An editable row for a collaborator the file is shared with: a Google-style role
  // menu (Viewer / Editor) followed by Transfer ownership / Remove access. Transfer
  // ownership grants the co-'owner' role — a file may have multiple owners, and any
  // owner can manage everyone's permissions.
  const sharedPersonRow = (u) => {
    const name = u.username || u.id;
    const role = ['owner', 'editor', 'viewer'].includes(u.role) ? u.role : 'viewer';
    const initial = (String(name).trim()[0] || '?').toUpperCase();
    // A selectable role row; the leading checkmark is shown for the current role.
    const roleItem = (value) => `
      <button type="button" class="share-role-item w-full flex items-center gap-2 px-3 py-2 text-sm text-on-surface hover:bg-surface-container" data-id="${shareEsc(u.id)}" data-role="${value}">
        <span class="material-symbols-outlined text-[18px] text-primary ${role === value ? '' : 'invisible'}">check</span>
        <span>${shareEsc(t('role.' + value))}</span>
      </button>`;
    return `
      <div class="flex items-center gap-3" data-share-user="${shareEsc(u.id)}">
        <span class="w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center text-sm font-medium shrink-0">${shareEsc(initial)}</span>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-on-surface truncate">${shareEsc(name)}</div>
          <div class="text-xs text-on-surface-variant truncate">${shareEsc(u.email || '')}</div>
        </div>
        <div class="relative shrink-0">
          <button type="button" class="share-role-trigger flex items-center gap-1 h-9 px-3 rounded-lg text-sm text-on-surface hover:bg-surface-container transition-colors" data-id="${shareEsc(u.id)}">
            <span>${shareEsc(t('role.' + role))}</span>
            <span class="material-symbols-outlined text-[18px]">arrow_drop_down</span>
          </button>
          <div class="share-role-menu hidden absolute right-0 mt-1 w-48 rounded-lg border border-outline-variant bg-surface-container-lowest shadow-md z-20 py-1">
            ${roleItem('viewer')}
            ${roleItem('editor')}
            <div class="h-px bg-outline-variant my-1"></div>
            <button type="button" class="share-owner-item w-full flex items-center gap-2 px-3 py-2 text-sm text-on-surface hover:bg-surface-container" data-id="${shareEsc(u.id)}">
              <span class="material-symbols-outlined text-[18px] text-primary ${role === 'owner' ? '' : 'invisible'}">check</span>
              <span>${shareEsc(t('share.transferOwnership'))}</span>
            </button>
            <button type="button" class="share-remove-item w-full flex items-center gap-2 px-3 py-2 text-sm text-on-surface hover:bg-surface-container" data-id="${shareEsc(u.id)}">
              <span class="material-symbols-outlined text-[18px] invisible">check</span>
              <span>${shareEsc(t('share.remove'))}</span>
            </button>
          </div>
        </div>
      </div>`;
  };

  // Render the people-with-access list: the signed-in user plus, for owners/admins,
  // everyone the file is currently shared with.
  const renderSharePeople = async () => {
    const container = document.getElementById('share-people');
    if (!container) return;
    let me = {};
    try { me = await (await fetch('/api/me')).json(); } catch (e) { /* leave blank */ }

    const access = shareFileRow
      ? (shareFileRow.owner ? 'owner' : (shareFileRow.canModify ? 'editor' : 'viewer'))
      : 'viewer';
    const myName = `${me.username || me.email || 'User'} (${t('perm.you')})`;
    let html = personRow(myName, me.email, access, me.picture);

    if (canShare()) {
      try {
        const shared = await (await fetch(`/api/files/${currentFileId}/shares`)).json();
        if (Array.isArray(shared)) {
          shared.forEach((u) => {
            html += sharedPersonRow(u);
          });
        }
      } catch (e) { /* show just the current user */ }
    }
    container.innerHTML = html;
  };

  // ----- compose mode (selecting people to share with) -----
  const renderChips = () => {
    if (!chipsEl) return;
    chipsEl.innerHTML = selectedUsers.map((u) => {
      const label = u.username || u.email || u.id;
      return `<span class="inline-flex items-center gap-1 pl-1 pr-2 py-1 rounded-full bg-surface-container text-sm text-on-surface" data-chip="${shareEsc(u.id)}">
        <span class="w-6 h-6 rounded-full bg-primary text-on-primary flex items-center justify-center text-xs font-medium">${shareEsc((String(label).trim()[0] || '?').toUpperCase())}</span>
        <span class="max-w-[12rem] truncate">${shareEsc(label)}</span>
        <button type="button" class="share-chip-x ml-0.5 text-on-surface-variant hover:text-on-surface" data-id="${shareEsc(u.id)}" aria-label="remove">
          <span class="material-symbols-outlined text-[16px] align-middle">close</span>
        </button>
      </span>`;
    }).join('');
    if (submitBtn) submitBtn.disabled = selectedUsers.length === 0;
  };

  const enterCompose = () => {
    if (!canShare()) return;
    if (defaultSection) defaultSection.classList.add('hidden');
    if (composeRole) composeRole.classList.remove('hidden');
    if (actionsDefault) actionsDefault.classList.add('hidden');
    if (actionsCompose) { actionsCompose.classList.remove('hidden'); actionsCompose.classList.add('flex'); }
  };

  const exitCompose = () => {
    selectedUsers = [];
    renderChips();
    if (addInput) addInput.value = '';
    hideResults();
    setComposeRole('editor'); // reset to the default for the next add
    if (composeRoleMenu) composeRoleMenu.classList.add('hidden');
    if (defaultSection) defaultSection.classList.remove('hidden');
    if (composeRole) composeRole.classList.add('hidden');
    if (actionsDefault) actionsDefault.classList.remove('hidden');
    if (actionsCompose) { actionsCompose.classList.add('hidden'); actionsCompose.classList.remove('flex'); }
  };

  const hideResults = () => {
    if (resultsEl) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; }
  };

  const renderResults = (users) => {
    if (!resultsEl) return;
    const pickable = users.filter((u) => !selectedUsers.some((s) => s.id === u.id));
    if (!pickable.length) { hideResults(); return; }
    resultsEl.innerHTML = pickable.map((u) => {
      const label = u.username || u.email || u.id;
      return `<button type="button" class="share-result w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-surface-container transition-colors"
        data-id="${shareEsc(u.id)}" data-username="${shareEsc(u.username || '')}" data-email="${shareEsc(u.email || '')}">
        <span class="w-8 h-8 rounded-full bg-primary text-on-primary flex items-center justify-center text-xs font-medium shrink-0">${shareEsc((String(label).trim()[0] || '?').toUpperCase())}</span>
        <span class="min-w-0">
          <span class="block text-sm text-on-surface truncate">${shareEsc(u.username || u.id)}</span>
          <span class="block text-xs text-on-surface-variant truncate">${shareEsc(u.email || '')}</span>
        </span>
      </button>`;
    }).join('');
    resultsEl.classList.remove('hidden');
  };

  const runSearch = async (q) => {
    if (!canShare()) return;
    try {
      const res = await fetch(`/api/users/search?file=${encodeURIComponent(currentFileId)}&q=${encodeURIComponent(q)}`);
      if (!res.ok) { hideResults(); return; }
      renderResults(await res.json());
    } catch (e) { hideResults(); }
  };

  const showShareMain = () => {
    if (shareSettingsView) shareSettingsView.classList.add('hidden');
    if (shareMainView) shareMainView.classList.remove('hidden');
  };
  const showShareSettings = () => {
    if (shareMainView) shareMainView.classList.add('hidden');
    if (shareSettingsView) shareSettingsView.classList.remove('hidden');
  };

  const openShareDialog = async () => {
    showShareMain();
    exitCompose();
    const name = currentFileName();
    const titleEl = document.getElementById('share-title');
    const setTitleEl = document.getElementById('share-settings-title');
    if (titleEl) titleEl.textContent = t('share.title', { name });
    if (setTitleEl) setTitleEl.textContent = t('share.settingsTitle', { name });
    shareModal.classList.remove('hidden');
    await fetchFileRow();
    if (addInput) {
      addInput.placeholder = t('share.addPeople');
      addInput.disabled = !canShare();
    }
    // Reflect the file's current general-access mode; only owners/admins may change it.
    applyAccessUI(shareFileRow && shareFileRow.linkAccess === 'anyone' ? 'anyone' : 'restricted');
    if (accessMenu) accessMenu.classList.add('hidden');
    if (accessTrigger) accessTrigger.disabled = !canShare();
    renderSharePeople();
  };
  const closeShareDialog = () => { hideResults(); shareModal.classList.add('hidden'); };

  if (shareBtn) shareBtn.addEventListener('click', openShareDialog);

  const shareDoneBtn = document.getElementById('share-done');
  if (shareDoneBtn) shareDoneBtn.addEventListener('click', closeShareDialog);

  const shareSettingsBtn = document.getElementById('share-settings-btn');
  if (shareSettingsBtn) shareSettingsBtn.addEventListener('click', showShareSettings);
  const shareBackBtn = document.getElementById('share-settings-back');
  if (shareBackBtn) shareBackBtn.addEventListener('click', showShareMain);

  // Search-as-you-type.
  if (addInput) {
    addInput.addEventListener('focus', () => { if (canShare()) { enterCompose(); runSearch(addInput.value.trim()); } });
    addInput.addEventListener('input', () => {
      if (!canShare()) return;
      enterCompose();
      if (searchTimer) clearTimeout(searchTimer);
      const q = addInput.value.trim();
      searchTimer = setTimeout(() => runSearch(q), 180);
    });
  }

  // Pick a search result → add a chip.
  if (resultsEl) {
    resultsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.share-result');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      if (!selectedUsers.some((s) => s.id === id)) {
        selectedUsers.push({ id, username: btn.getAttribute('data-username'), email: btn.getAttribute('data-email') });
        renderChips();
      }
      if (addInput) { addInput.value = ''; addInput.focus(); }
      hideResults();
    });
  }

  // Remove a chip.
  if (chipsEl) {
    chipsEl.addEventListener('click', (e) => {
      const x = e.target.closest('.share-chip-x');
      if (!x) return;
      const id = x.getAttribute('data-id');
      selectedUsers = selectedUsers.filter((u) => u.id !== id);
      renderChips();
    });
  }

  // Cancel composing.
  const cancelBtn = document.getElementById('share-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', exitCompose);

  // Compose-role dropdown: toggle the menu and pick Editor/Viewer for new people.
  if (composeRoleBtn && composeRoleMenu) {
    composeRoleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      composeRoleMenu.classList.toggle('hidden');
    });
    composeRoleMenu.addEventListener('click', (e) => {
      const opt = e.target.closest('.share-compose-role-opt');
      if (!opt) return;
      setComposeRole(opt.getAttribute('data-role'));
      composeRoleMenu.classList.add('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!composeRoleMenu.classList.contains('hidden') &&
          !composeRoleMenu.contains(e.target) && e.target !== composeRoleBtn) {
        composeRoleMenu.classList.add('hidden');
      }
    });
  }

  // General-access dropdown: toggle the menu and switch Restricted / Anyone-with-link.
  if (accessTrigger && accessMenu) {
    accessTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!canShare()) return;
      accessMenu.classList.toggle('hidden');
    });
    accessMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('.share-access-item');
      if (!item || !canShare()) return;
      const value = item.getAttribute('data-access') === 'anyone' ? 'anyone' : 'restricted';
      accessMenu.classList.add('hidden');
      if (value === accessValue) return;
      const prev = accessValue;
      applyAccessUI(value); // optimistic
      try {
        const res = await fetch(`/api/files/${currentFileId}/access`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkAccess: value })
        });
        if (!res.ok) throw new Error('access update failed');
        if (shareFileRow) shareFileRow.linkAccess = value;
      } catch (err) {
        applyAccessUI(prev); // revert on failure
      }
    });
    document.addEventListener('click', (e) => {
      if (!accessMenu.classList.contains('hidden') &&
          !accessMenu.contains(e.target) && e.target !== accessTrigger) {
        accessMenu.classList.add('hidden');
      }
    });
  }

  // People-with-access list: a per-collaborator role menu (open on the trigger,
  // pick a role, or remove access). Close any open menu before opening another.
  const peopleContainer = document.getElementById('share-people');
  const closeRoleMenus = (except) => {
    if (!peopleContainer) return;
    peopleContainer.querySelectorAll('.share-role-menu').forEach((m) => {
      if (m !== except) m.classList.add('hidden');
    });
  };
  if (peopleContainer) {
    peopleContainer.addEventListener('click', async (e) => {
      // Toggle this row's role menu.
      const trigger = e.target.closest('.share-role-trigger');
      if (trigger) {
        if (!canShare()) return;
        const menu = trigger.parentElement.querySelector('.share-role-menu');
        const willOpen = menu && menu.classList.contains('hidden');
        closeRoleMenus(willOpen ? menu : null);
        if (menu) menu.classList.toggle('hidden');
        return;
      }
      // Change a collaborator's role.
      const roleItem = e.target.closest('.share-role-item');
      if (roleItem) {
        if (!canShare()) return;
        const id = roleItem.getAttribute('data-id');
        const role = roleItem.getAttribute('data-role') === 'editor' ? 'editor' : 'viewer';
        closeRoleMenus(null);
        try {
          await fetch(`/api/files/${currentFileId}/shares/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role })
          });
        } catch (err) { /* ignore */ }
        await renderSharePeople();
        return;
      }
      // Transfer ownership: grant the co-'owner' role (multiple owners allowed).
      const ownerItem = e.target.closest('.share-owner-item');
      if (ownerItem) {
        if (!canShare()) return;
        const id = ownerItem.getAttribute('data-id');
        closeRoleMenus(null);
        try {
          await fetch(`/api/files/${currentFileId}/shares/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'owner' })
          });
        } catch (err) { /* ignore */ }
        await renderSharePeople();
        return;
      }
      // Remove a collaborator's access.
      const removeItem = e.target.closest('.share-remove-item');
      if (removeItem) {
        if (!canShare()) return;
        const id = removeItem.getAttribute('data-id');
        closeRoleMenus(null);
        try {
          await fetch(`/api/files/${currentFileId}/shares/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch (err) { /* ignore */ }
        await renderSharePeople();
      }
    });
    // Close role menus when clicking elsewhere (outside any trigger/menu).
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.share-role-trigger') && !e.target.closest('.share-role-menu')) {
        closeRoleMenus(null);
      }
    });
  }

  // Submit the share.
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      if (!selectedUsers.length || !canShare()) return;
      submitBtn.disabled = true;
      try {
        const res = await fetch(`/api/files/${currentFileId}/shares`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIds: selectedUsers.map((u) => u.id), role: composeRoleValue })
        });
        if (!res.ok) throw new Error('share failed');
        exitCompose();
        await renderSharePeople();
      } catch (e) {
        submitBtn.disabled = false;
      }
    });
  }

  // Copy link: write the shareable URL to the clipboard, with brief feedback.
  const shareCopyBtn = document.getElementById('share-copy-link');
  if (shareCopyBtn) {
    let copyResetTimer = null;
    shareCopyBtn.addEventListener('click', async () => {
      const url = shareUrl();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
        } else {
          const ta = document.createElement('textarea');
          ta.value = url;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
      } catch (e) { /* ignore; still show confirmation */ }
      const label = document.getElementById('share-copy-link-label');
      if (label) {
        label.textContent = t('share.linkCopied');
        if (copyResetTimer) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => { label.textContent = t('share.copyLink'); }, 1800);
      }
    });
  }

  // ----- Header "Share" split button: the right-hand caret opens a small menu
  // with "Copy link" and a read-only count of how many users the file is shared
  // with. Reuses shareUrl()/currentFileId from the share-dialog scope above. -----
  const writeClipboard = async (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch (e) { /* ignore; still show confirmation */ }
  };

  const shareMenuBtn = document.getElementById('share-menu-btn');
  const shareMenuEl = document.getElementById('share-menu');
  const shareMenuCountEl = document.getElementById('share-menu-count');
  const shareCopyMenuItem = document.getElementById('share-copy-link-menu');

  // Reflect the live sharer count in the menu's read-only line. The /shares
  // endpoint requires modify permission; viewers (or the legacy default file)
  // fall back to 0 rather than surfacing an error.
  const refreshShareMenuCount = async () => {
    let count = 0;
    if (currentFileId && currentFileId !== 'default') {
      try {
        const res = await fetch(`/api/files/${currentFileId}/shares`);
        if (res.ok) {
          const arr = await res.json();
          if (Array.isArray(arr)) count = arr.length;
        }
      } catch (e) { /* leave count at 0 */ }
    }
    if (shareMenuCountEl) shareMenuCountEl.textContent = t('share.sharedCount', { count });
  };

  if (shareMenuBtn && shareMenuEl) {
    shareMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = !shareMenuEl.classList.contains('hidden');
      if (typeof closeAllMenus === 'function') closeAllMenus();
      if (wasOpen) {
        shareMenuBtn.setAttribute('aria-expanded', 'false');
      } else {
        shareMenuEl.classList.remove('hidden');
        shareMenuBtn.setAttribute('aria-expanded', 'true');
        refreshShareMenuCount();
      }
    });
  }

  if (shareCopyMenuItem) {
    let menuCopyResetTimer = null;
    shareCopyMenuItem.addEventListener('click', async () => {
      await writeClipboard(shareUrl());
      const label = document.getElementById('share-copy-link-menu-label');
      if (label) {
        label.textContent = t('share.linkCopied');
        if (menuCopyResetTimer) clearTimeout(menuCopyResetTimer);
        menuCopyResetTimer = setTimeout(() => { label.textContent = t('share.copyLink'); }, 1800);
      }
    });
  }

  // Backdrop click-to-close. Track where the press started: focusing the add-people
  // input collapses the layout (enterCompose hides the default section), so the
  // dialog re-centers and the *release* can land on the backdrop even though the
  // press was on the input. Only treat it as "click outside" when both the press
  // and the release land on the backdrop itself.
  let sharePressTarget = null;
  shareModal.addEventListener('mousedown', (e) => { sharePressTarget = e.target; });
  shareModal.addEventListener('click', (e) => {
    if (e.target === shareModal && sharePressTarget === shareModal) { closeShareDialog(); return; }
    if (resultsEl && !resultsEl.contains(e.target) && e.target !== addInput) hideResults();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !shareModal.classList.contains('hidden')) closeShareDialog();
  });
}

// ---------------------------------------------------------------------------
// Version history. The sidebar controller lives in version-history.js
// (window.CoSheet.history): it owns the versions list and drives the preview.
// isHistoryMode / selectedVersionState / previousVersionState stay here because
// the grid renderer reads them for diff highlighting; the module mirrors them
// back on every change via syncState.
// ---------------------------------------------------------------------------
window.CoSheet.history.init({
  renderGrid: renderSpreadsheetGrid,
  renderSheetTabs: () => { if (typeof renderSheetTabs === "function") renderSheetTabs(); },
  syncState: (s) => {
    isHistoryMode = s.mode;
    selectedVersionState = s.selected;
    previousVersionState = s.previous;
  },
  // Scope version-history API calls to the workbook currently open in the editor.
  getFileId: () => currentFileId,
});

// ---------------------------------------------------------------------------
// Shared core services. A small bag of live state getters and cell mutators
// that extracted feature modules (find-replace.js, …) consume instead of the
// module-scoped bindings they used to close over. Getters keep the reassignable
// state (activeCellId, activeSheetName, sheetOrder, localSheets, socket) live;
// localCells is a stable proxy passed by reference. Grow this as more domains
// are extracted.
// ---------------------------------------------------------------------------
window.CoSheet.app = {
  TOTAL_ROWS,
  // Current rendered column count for a sheet (grows past A-Z with data).
  getColCount,
  get activeCellId() { return activeCellId; },
  get activeSheetName() { return activeSheetName; },
  get sheetOrder() { return sheetOrder; },
  get localSheets() { return localSheets; },
  localCells,
  get socket() { return socket; },
  switchSheet,
  handleCellSelect,
  revealCell,
  recordHistoryAction,
  updateGridDOMCell,
  getCellValue,
  recalculateSheet,
  getSelectedCellIds,
  changeCellTextColor,
  changeCellColor,
  closeAllMenus,
  // Set the border pen color (kept in app.js as the border menu / applyBorders
  // read it) and reflect it on the menu swatch. Used by the color palette's
  // 'border' pen type.
  setBorderColor: (hex) => {
    currentBorderColor = hex;
    const swatch = document.getElementById('border-color-swatch');
    if (swatch) swatch.style.backgroundColor = hex;
  },
  // Border pen state (read by applyBordersToSelection's mkSpec) + the line-style
  // CSS map. The border menu module reads these to render and sets the style.
  BORDER_STYLE_CSS,
  get borderColor() { return currentBorderColor; },
  get borderStyle() { return currentBorderStyle; },
  setBorderStyle: (style) => { currentBorderStyle = style; },
  applyBordersToSelection,
  // Used by sort-filter.js (sorting/value filters).
  get isHistoryMode() { return isHistoryMode; },
  get canEditWorkbook() { return canEditWorkbook; },
  get frozenRows() { return frozenRows; },
  get currentFileId() { return currentFileId; },
  renderGrid: renderSpreadsheetGrid,
  getActiveSheetMerges,
  showMessageDialog,
};

window.CoSheet.findReplace.init(window.CoSheet.app);
window.CoSheet.colorPalette.init(window.CoSheet.app);
window.CoSheet.borderMenu.init(window.CoSheet.app);
window.CoSheet.sortFilter.init(window.CoSheet.app);

// ---------------------------------------------------------------------------
// Synthetic grid scrollbars.
//
// The grid viewport scrolls, but a native scrollbar spans the viewport's full
// client box, so its track runs alongside the sticky column header (top) and
// the sticky row gutter (left). To make each bar begin at the frozen header
// edge instead, the native bars are hidden (see .grid-scrollbar in index.html)
// and these two synthetic bars are drawn over the viewport: the vertical bar
// starts at the column header's bottom, the horizontal bar at the row gutter's
// right. The header size is measured each full layout so the offsets track the
// CSS `zoom` applied to #grid-root. The viewport stays natively scrollable
// (wheel, trackpad, keyboard, scrollIntoView), and those scrolls drive the
// thumbs via the scroll listener; dragging a thumb drives the viewport.
// ---------------------------------------------------------------------------
function initGridScrollbars() {
  const viewport = document.getElementById('grid-viewport');
  const vbar = document.getElementById('grid-vscroll');
  const hbar = document.getElementById('grid-hscroll');
  if (!viewport || !vbar || !hbar) return;
  const vthumb = vbar.firstElementChild;
  const hthumb = hbar.firstElementChild;
  if (!vthumb || !hthumb) return;
  const vcap = document.getElementById('grid-vscroll-cap'); // dummy column header
  const hcap = document.getElementById('grid-hscroll-cap'); // dummy row header
  const cornerEl = document.getElementById('grid-scroll-corner'); // shared far corner
  const vup = document.getElementById('grid-vscroll-up');
  const vdown = document.getElementById('grid-vscroll-down');
  const hleft = document.getElementById('grid-hscroll-left');
  const hright = document.getElementById('grid-hscroll-right');

  const BAR = 14;        // bar thickness, px — matches the CSS width/height
  const MIN_THUMB = 24;  // smallest thumb length, px
  const ARROW = 20;       // stepper-arrow length along its scroll axis (cross axis = BAR)
  const ARROWS = ARROW * 2; // space the two stepper arrows take at the bar's end
  const STEP = DEFAULT_ROW_HEIGHT * 3; // px scrolled per arrow click / repeat tick

  // Cached track/thumb/scrollable metrics from the last full layout(), used by
  // position() so scrolling doesn't re-measure the header on every event.
  let vMetrics = null; // { track, thumb, scrollable }
  let hMetrics = null;

  // The sticky corner (first grid child): its height is the column-header band,
  // its width the row gutter. Measured live so it follows zoom.
  function headerSize() {
    const corner = document.querySelector('#grid-root > .grid-header');
    if (corner) {
      const r = corner.getBoundingClientRect();
      if (r.width && r.height) return { w: r.width, h: r.height };
    }
    return { w: GUTTER_WIDTH, h: 21 };
  }

  // Reposition the thumbs from the viewport's current scroll offset only.
  function position() {
    if (vMetrics) {
      const maxTop = vMetrics.track - vMetrics.thumb;
      const top = vMetrics.scrollable > 0 ? (viewport.scrollTop / vMetrics.scrollable) * maxTop : 0;
      vthumb.style.top = `${Math.max(0, Math.min(maxTop, top))}px`;
    }
    if (hMetrics) {
      const maxLeft = hMetrics.track - hMetrics.thumb;
      const left = hMetrics.scrollable > 0 ? (viewport.scrollLeft / hMetrics.scrollable) * maxLeft : 0;
      hthumb.style.left = `${Math.max(0, Math.min(maxLeft, left))}px`;
    }
  }

  // Full layout: set each bar's start offset to the header edge, recompute thumb
  // sizes and visibility from the scrollable extent, then reposition.
  function layout() {
    const { w: gw, h: hh } = headerSize();
    vbar.style.top = `${hh}px`;
    hbar.style.left = `${gw}px`;

    const vScrollable = viewport.scrollHeight - viewport.clientHeight;
    const hScrollable = viewport.scrollWidth - viewport.clientWidth;
    const vVisible = vScrollable > 1;
    const hVisible = hScrollable > 1;

    // Reserve the shared far corner only when the perpendicular bar is present;
    // otherwise a lone bar runs the full span. (BAR matches the CSS thickness.)
    const vCorner = hVisible ? BAR : 0;
    const hCorner = vVisible ? BAR : 0;
    // The stepper arrows always sit between the thumb track and the corner, so
    // the track ends ARROWS px earlier than the corner reservation.
    vbar.style.bottom = `${vCorner + ARROWS}px`;
    hbar.style.right = `${hCorner + ARROWS}px`;

    // Track length from the viewport span (not the bar's own box, so a hidden
    // display:none bar still measures correctly when content reappears).
    const vTrack = viewport.clientHeight - hh - vCorner - ARROWS;
    const vShown = vVisible && vTrack > MIN_THUMB;
    if (vShown) {
      const thumb = Math.max(MIN_THUMB, vTrack * (viewport.clientHeight / viewport.scrollHeight));
      vMetrics = { track: vTrack, thumb, scrollable: vScrollable };
      vthumb.style.height = `${thumb}px`;
      vbar.classList.remove('hidden');
    } else {
      vMetrics = null;
      vbar.classList.add('hidden');
    }

    const hTrack = viewport.clientWidth - gw - hCorner - ARROWS;
    const hShown = hVisible && hTrack > MIN_THUMB;
    if (hShown) {
      const thumb = Math.max(MIN_THUMB, hTrack * (viewport.clientWidth / viewport.scrollWidth));
      hMetrics = { track: hTrack, thumb, scrollable: hScrollable };
      hthumb.style.width = `${thumb}px`;
      hbar.classList.remove('hidden');
    } else {
      hMetrics = null;
      hbar.classList.add('hidden');
    }

    // Dummy header caps: a column header (BAR wide × header tall) above the
    // vertical bar, a row header (gutter wide × BAR tall) left of the horizontal
    // bar. Shown only alongside their bar.
    if (vcap) {
      vcap.style.width = `${BAR}px`;
      vcap.style.height = `${hh}px`;
      vcap.classList.toggle('hidden', !vShown);
    }
    if (hcap) {
      hcap.style.width = `${gw}px`;
      hcap.style.height = `${BAR}px`;
      hcap.classList.toggle('hidden', !hShown);
    }
    // The shared corner is only reserved (and only makes sense) when both bars
    // are present; otherwise the lone bar runs the full span to the edge.
    if (cornerEl) cornerEl.classList.toggle('hidden', !(vShown && hShown));

    // Stepper arrows occupy the bar's end, just inside the corner reservation:
    // down sits at the corner edge, up stacks above it; right at the corner
    // edge, left to its inside. Shown only alongside their bar.
    if (vup && vdown) {
      vdown.style.bottom = `${vCorner}px`;
      vup.style.bottom = `${vCorner + ARROW}px`;
      vup.classList.toggle('hidden', !vShown);
      vdown.classList.toggle('hidden', !vShown);
    }
    if (hleft && hright) {
      hright.style.right = `${hCorner}px`;
      hleft.style.right = `${hCorner + ARROW}px`;
      hleft.classList.toggle('hidden', !hShown);
      hright.classList.toggle('hidden', !hShown);
    }

    position();
  }

  // Drag a thumb: translate pointer travel along the track into a scroll offset.
  function startDrag(e, isV) {
    const m = isV ? vMetrics : hMetrics;
    if (!m || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // don't let the bar's page-scroll handler also fire
    const startPos = isV ? e.clientY : e.clientX;
    const startScroll = isV ? viewport.scrollTop : viewport.scrollLeft;
    const maxTravel = m.track - m.thumb;
    const onMove = (ev) => {
      const delta = (isV ? ev.clientY : ev.clientX) - startPos;
      const ratio = maxTravel > 0 ? delta / maxTravel : 0;
      const next = startScroll + ratio * m.scrollable;
      if (isV) viewport.scrollTop = next; else viewport.scrollLeft = next;
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  // Click the track (not the thumb): jump one page toward the click.
  function pageScroll(e, isV) {
    if ((isV && e.target !== vbar) || (!isV && e.target !== hbar)) return;
    const m = isV ? vMetrics : hMetrics;
    if (!m || e.button !== 0) return;
    const rect = (isV ? vbar : hbar).getBoundingClientRect();
    const thumbStart = isV ? vthumb.offsetTop : hthumb.offsetLeft;
    const clickPos = isV ? (e.clientY - rect.top) : (e.clientX - rect.left);
    const page = isV ? viewport.clientHeight : viewport.clientWidth;
    if (clickPos < thumbStart) {
      if (isV) viewport.scrollTop -= page; else viewport.scrollLeft -= page;
    } else if (clickPos > thumbStart + m.thumb) {
      if (isV) viewport.scrollTop += page; else viewport.scrollLeft += page;
    }
  }

  vthumb.addEventListener('pointerdown', (e) => startDrag(e, true));
  hthumb.addEventListener('pointerdown', (e) => startDrag(e, false));
  vbar.addEventListener('pointerdown', (e) => pageScroll(e, true));
  hbar.addEventListener('pointerdown', (e) => pageScroll(e, false));

  // Wire a stepper arrow: nudge once on press, then auto-repeat while held
  // (after a short delay), like a native scrollbar arrow. `step()` performs one
  // increment; 'scroll' on the viewport repositions the thumbs.
  function bindArrow(btn, step) {
    if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      step();
      let repeat = null;
      const delay = setTimeout(() => { repeat = setInterval(step, 40); }, 300);
      const onUp = () => {
        clearTimeout(delay);
        if (repeat) clearInterval(repeat);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
      };
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  }
  bindArrow(vup, () => { viewport.scrollTop -= STEP; });
  bindArrow(vdown, () => { viewport.scrollTop += STEP; });
  bindArrow(hleft, () => { viewport.scrollLeft -= STEP; });
  bindArrow(hright, () => { viewport.scrollLeft += STEP; });
  viewport.addEventListener('scroll', position, { passive: true });
  // Windowed rendering: a scroll or viewport resize can move the visible row
  // window, which rebuilds the grid to the new span (no-op when not windowing).
  viewport.addEventListener('scroll', onGridScrollWindow, { passive: true });
  window.addEventListener('resize', () => { layout(); onGridScrollWindow(); });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { layout(); onGridScrollWindow(); });
    ro.observe(viewport);
    const gr = document.getElementById('grid-root');
    if (gr) ro.observe(gr);
  }

  gridScrollbarLayout = layout;
  layout();
}

initGridScrollbars();


