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
const { escapeHtml, getColLetter, getColNumber, parseCellCoord, parseCoordinates } = window.CoSheet.utils;
const { evaluateFormula } = window.CoSheet.formula;
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
  document.createElement = function(tagName) {
    let el = {};
    if (typeof origCreateElement === 'function') {
      try { el = origCreateElement.apply(this, arguments) || {}; } catch(e) {}
    }
    return decorateElement(el);
  };

  // Decorate document.getElementById to return safely decorated elements
  const origGetElementById = document.getElementById;
  document.getElementById = function(id) {
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

// Global state variables
let localSheets = Object.create(null);
let activeSheetName = 'Sheet1';
let sheetOrder = ['Sheet1', 'Sheet2'];
let sheetColors = Object.create(null);
let hiddenSheets = [];
// Name of the sheet currently being renamed inline (null when not editing).
let renamingSheet = null;

// Global spreadsheet grid zoom level percentage
let currentZoom = 100;

// Default sheet dimensions: 26 columns (A-Z) and 1000 rows.
const TOTAL_ROWS = 1000;

// Initialize with a default sheet
localSheets[activeSheetName] = Object.create(null);

// Define a localCells proxy for backward compatibility with existing codebase functions
let localCells = new Proxy({}, {
  get(target, prop) {
    if (!localSheets[activeSheetName]) localSheets[activeSheetName] = Object.create(null);
    return localSheets[activeSheetName][prop];
  },
  set(target, prop, value) {
    if (!localSheets[activeSheetName]) localSheets[activeSheetName] = Object.create(null);
    localSheets[activeSheetName][prop] = value;
    return true;
  },
  deleteProperty(target, prop) {
    if (localSheets[activeSheetName]) {
      delete localSheets[activeSheetName][prop];
    }
    return true;
  },
  has(target, prop) {
    return !!(localSheets[activeSheetName] && prop in localSheets[activeSheetName]);
  },
  ownKeys(target) {
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
let activeCellId = null; // Currently selected cell ID
let isSelecting = false; // Whether selection drag is active
let isColumnSelection = false; // Whether the current selection is a full-column header click
let selectionStartCellId = null; // Start cell of range selection
let selectionEndCellId = null; // End cell of range selection
let socket = null; // WebSocket connection
let clipboardData = null; // Stores copied cell data offset details
let frozenRows = 0; // Number of top rows frozen via View > Freeze (0 = none)
let frozenCols = 0; // Number of left columns frozen via View > Freeze (0 = none)

// Per-sheet column widths / row heights (px), keyed by sheet name then column
// letter / row number. Populated from the server `init` payload and kept in sync
// via `resize-update` broadcasts; an absent entry falls back to the defaults below.
let colWidths = Object.create(null); // { [sheetName]: { [colLetter]: px } }
let rowHeights = Object.create(null); // { [sheetName]: { [rowNumber]: px } }

// Default track sizes — must match the base grid-template-columns / row min-height
// in private/index.html (46px gutter + 100px columns, 21px rows).
const DEFAULT_COL_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 21;
// Smallest size a column/row may be dragged to (mirrors dimensionService.MIN_SIZE).
const MIN_DIMENSION = 20;

/** Resolved width (px) of a column letter on the active sheet. */
const getColWidth = (colLetter, sheetName = activeSheetName) => {
  const m = colWidths[sheetName];
  const w = m && m[colLetter];
  return (typeof w === 'number' && isFinite(w)) ? w : DEFAULT_COL_WIDTH;
};
/** Resolved height (px) of a row number on the active sheet. */
const getRowHeight = (row, sheetName = activeSheetName) => {
  const m = rowHeights[sheetName];
  const h = m && m[row];
  return (typeof h === 'number' && isFinite(h)) ? h : DEFAULT_ROW_HEIGHT;
};
/** Whether the active sheet has any custom (non-default) row heights. */
const sheetHasCustomRowHeights = (sheetName = activeSheetName) => {
  const m = rowHeights[sheetName];
  return !!(m && Object.keys(m).length);
};

// Per-sheet value filter (Data ▸ Create a filter). Keyed by sheet name; an entry
// means a filter is active on that sheet's column. `hidden` holds the set of
// value keys (the literal string '__BLANK__' for empty cells) that are currently
// excluded — anything not listed stays visible, so new values default to shown.
// This is a local view concern (like gridlines/freeze) and is not broadcast.
let sheetFilters = Object.create(null); // sheetName -> { colIndex, hidden: Set<string> }

// Set by initGridScrollbars() to its layout() function; called after any change
// that affects the grid's scrollable extent (render, zoom, freeze) to resync the
// synthetic scrollbars. Null until the controller initializes.
let gridScrollbarLayout = null;

// History stacks for local cell edits (snapshot based)
const undoStack = [];
const redoStack = [];

// Version History state variables
let isHistoryMode = false;
let selectedVersionState = null;
let previousVersionState = null;
let versionsList = []; // Array of retrieved versions



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
  'color-sheet', 'hide-sheet', 'unhide-sheet', 'reorder-sheets', 'resize'
];

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
      return originalSend.call(this, JSON.stringify(msg));
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

      if (payload.sheets && Object.keys(payload.sheets).length > 0) {
        Object.assign(localSheets, payload.sheets);
        if (payload.activeSheet && localSheets[payload.activeSheet]) {
          activeSheetName = payload.activeSheet;
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
        localSheets[activeSheetName] = Object.create(null);
      }

      // Restore any persisted value filters so they paint on the first render.
      loadSheetFilters();

      renderSheetTabs();
      renderSpreadsheetGrid();

      // Auto-select the top-left cell on first load so the toolbar (font size,
      // formatting, etc.) always has an active target to act on.
      if (!activeCellId) {
        const defaultCellEl = document.querySelector('[data-cell-id="A1"]');
        if (defaultCellEl) {
          handleCellSelect('A1', defaultCellEl);
        }
      }

      // Position active users' cursors
      if (payload.users) {
        payload.users.forEach(user => {
          if (user.activeCell) {
            const sheet = user.activeSheet || 'Sheet1';
            user.activeSheet = sheet;
            remoteCursors[user.userId] = user;
            if (sheet === activeSheetName) {
              renderCursorBorder(user);
            }
          }
        });
      }
    }

    // Dynamic cursor presence update from other peers
    if (type === 'cursor-update') {
      const { userId, username, color, activeCell, activeSheet } = payload;
      removeCursorBorder(userId);
      const sheet = activeSheet || 'Sheet1';
      payload.activeSheet = sheet;
      
      if (activeCell) {
        remoteCursors[userId] = payload;
        if (sheet === activeSheetName) {
          renderCursorBorder(payload);
        }
      } else {
        delete remoteCursors[userId];
      }
    }

    // Cell updates propagated from other peers
    if (type === 'cell-update') {
      const { cellId, formula, value, style, sheetName } = payload;
      const sheet = sheetName || 'Sheet1';
      if (!localSheets[sheet]) {
        localSheets[sheet] = Object.create(null);
      }
      localSheets[sheet][cellId] = { formula, value, style: style || {} };
      
      if (sheet === activeSheetName) {
        // Recalculate sheet to propagate dependencies
        recalculateSheet();
        updateGridDOMCell(cellId, getCellValue(cellId), style);
        // Borders are drawn neighbour-aware (shared edges drawn once): refresh the
        // left/top neighbours so a remote border edit doesn't leave a doubled edge.
        const coord = parseCellCoord(cellId);
        if (coord) {
          const leftId = coord.colIndex - 1 >= 0 ? `${getColLetter(coord.colIndex - 1)}${coord.row}` : null;
          const topId = coord.row - 1 >= 1 ? `${getColLetter(coord.colIndex)}${coord.row - 1}` : null;
          [leftId, topId].forEach((nId) => {
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
        localSheets[sheetName] = cells ? Object.assign(Object.create(null), cells) : Object.create(null);
      }
      if (newOrder) sheetOrder = newOrder;
      else if (!sheetOrder.includes(sheetName)) sheetOrder.push(sheetName);
      renderSheetTabs();
    }

    // Handle sheet deletion broadcast
    if (type === 'delete-sheet') {
      const { sheetName } = payload;
      delete localSheets[sheetName];
      sheetOrder = sheetOrder.filter(s => s !== sheetName);
      hiddenSheets = hiddenSheets.filter(s => s !== sheetName);
      if (sheetColors[sheetName]) delete sheetColors[sheetName];
      
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
      localSheets[newName] = localSheets[oldName];
      delete localSheets[oldName];
      
      sheetOrder = sheetOrder.map(s => s === oldName ? newName : s);
      hiddenSheets = hiddenSheets.map(s => s === oldName ? newName : s);
      if (sheetColors[oldName]) {
        sheetColors[newName] = sheetColors[oldName];
        delete sheetColors[oldName];
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
        delete sheetColors[sheetName];
      } else {
        sheetColors[sheetName] = color;
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
      if (!map[sheet]) map[sheet] = Object.create(null);
      const key = dimension === 'col' ? col : row;
      if (key != null) map[sheet][key] = size;
      // Re-render only when the change lands on the sheet currently in view.
      if (sheet === activeSheetName) renderSpreadsheetGrid();
    }

    // User leaving connection event
    if (type === 'user-leave') {
      const { userId } = payload;
      removeCursorBorder(userId);
      delete remoteCursors[userId];
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
  };

  socket.onclose = () => {
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

/**
 * Resets range selection variables and clears selection UI components.
 */
const clearRangeSelection = () => {
  selectionStartCellId = null;
  selectionEndCellId = null;
  isColumnSelection = false;
  const overlay = document.getElementById('selection-range-overlay');
  if (overlay) overlay.remove();
  document.querySelectorAll('.grid-cell-selected').forEach(el => el.classList.remove('grid-cell-selected'));
  document.querySelectorAll('.grid-cell-active').forEach(el => el.classList.remove('grid-cell-active'));
  document.querySelectorAll('.grid-header.active-header').forEach(el => el.classList.remove('active-header'));
  document.querySelectorAll('.grid-header.header-selected').forEach(el => el.classList.remove('header-selected'));
};

/**
 * Helper to get all cell IDs within the currently selected range.
 * @returns {string[]} List of cell IDs.
 */
const getSelectedCellIds = () => {
  if (!selectionStartCellId) return activeCellId ? [activeCellId] : [];
  const endId = selectionEndCellId || selectionStartCellId;
  const start = parseCellCoord(selectionStartCellId);
  const end = parseCellCoord(endId);
  if (!start || !end) return activeCellId ? [activeCellId] : [];
  
  const minCol = Math.min(start.colIndex, end.colIndex);
  const maxCol = Math.max(start.colIndex, end.colIndex);
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  
  const cellIds = [];
  for (let c = minCol; c <= maxCol; c++) {
    const colLetter = getColLetter(c);
    for (let r = minRow; r <= maxRow; r++) {
      cellIds.push(`${colLetter}${r}`);
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

  const minColIndex = Math.min(startCoord.colIndex, endCoord.colIndex);
  const maxColIndex = Math.max(startCoord.colIndex, endCoord.colIndex);
  const minRow = Math.min(startCoord.row, endCoord.row);
  const maxRow = Math.max(startCoord.row, endCoord.row);
  // True when the selection spans more than one cell. Used both for the Name Box
  // label and to decide whether the anchor cell also takes the range fill below.
  const isRange = minColIndex !== maxColIndex || minRow !== maxRow;

  // Update the Name Box (top-left of the formula bar). A single cell shows
  // e.g. "A1"; a multi-cell range shows "topLeft:bottomRight" e.g. "E2:F2".
  const nameBox = document.getElementById('name-box');
  if (nameBox) {
    const topLeft = `${getColLetter(minColIndex)}${minRow}`;
    // A full-column selection reads like Google Sheets, e.g. "A:A" / "A:C".
    if (isColumnSelection) {
      nameBox.innerText = `${getColLetter(minColIndex)}:${getColLetter(maxColIndex)}`;
    } else {
      nameBox.innerText = isRange ? `${topLeft}:${getColLetter(maxColIndex)}${maxRow}` : topLeft;
    }
  }

  // Clear previous highlighted cells and active headers
  document.querySelectorAll('.grid-cell-selected').forEach(el => el.classList.remove('grid-cell-selected'));
  document.querySelectorAll('.grid-cell-active').forEach(el => el.classList.remove('grid-cell-active'));
  document.querySelectorAll('.grid-header.active-header').forEach(el => el.classList.remove('active-header'));
  document.querySelectorAll('.grid-header.header-selected').forEach(el => el.classList.remove('header-selected'));

  // Highlight cells and headers in range
  for (let c = minColIndex; c <= maxColIndex; c++) {
    const colLetter = getColLetter(c);
    const colHeader = document.querySelector(`[data-col-id="${colLetter}"]`);
    // A column-header selection gives the column header a solid-blue highlight
    // and leaves the row headers un-highlighted; a normal range lightly
    // highlights both the spanned column and row headers.
    if (colHeader) colHeader.classList.add(isColumnSelection ? 'header-selected' : 'active-header');

    for (let r = minRow; r <= maxRow; r++) {
      const cellId = `${colLetter}${r}`;
      if (c === minColIndex) {
        const rowHeader = document.querySelector(`[data-row-id="${r}"]`);
        if (rowHeader) rowHeader.classList.add('active-header');
      }

      // The primary active cell (first cell clicked) gets a thick border;
      // every other cell in the range gets the lighter range fill. In a
      // multi-cell selection the anchor also takes the fill class so a blank
      // anchor reflects the blue tint and a colored one keeps its background,
      // just like the rest of the range; a single-cell selection keeps the
      // border only and leaves the cell its natural color.
      const cellEl = document.querySelector(`[data-cell-id="${cellId}"]`);
      if (cellEl) {
        if (cellId === activeCellId) {
          cellEl.classList.add('grid-cell-active');
          if (isRange) cellEl.classList.add('grid-cell-selected');
        } else {
          cellEl.classList.add('grid-cell-selected');
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

  // Coordinates offsets: columns header A-Z starts at 46px, cells 100px wide, rows 21px high (fallback)
  let left = 46 + minColIndex * 100;
  let width = (maxColIndex - minColIndex + 1) * 100;
  let top = minRow * 21;
  let height = (maxRow - minRow + 1) * 21;

  // Measure actual DOM elements if present in the browser environment
  const minColLetter = getColLetter(minColIndex);
  const maxColLetter = getColLetter(maxColIndex);
  const topLeftEl = document.querySelector(`[data-cell-id="${minColLetter}${minRow}"]`);
  const bottomRightEl = document.querySelector(`[data-cell-id="${maxColLetter}${maxRow}"]`);

  if (topLeftEl && bottomRightEl && typeof topLeftEl.offsetLeft === 'number' && typeof bottomRightEl.offsetLeft === 'number') {
    left = topLeftEl.offsetLeft;
    top = topLeftEl.offsetTop;
    width = (bottomRightEl.offsetLeft + bottomRightEl.offsetWidth) - left;
    height = (bottomRightEl.offsetTop + bottomRightEl.offsetHeight) - top;
  }

  // Position the overlay exactly on the range bounds. With box-sizing:border-box
  // the 1px outer border is drawn inside this rect, so along the anchor cell's
  // top/left edges it overlaps the anchor's 2px border (same colour) instead of
  // stacking beside it — keeping the anchor's border a uniform width.
  overlay.style.left = `${left}px`;
  overlay.style.width = `${width}px`;
  overlay.style.top = `${top}px`;
  overlay.style.height = `${height}px`;
};

/* ---------------------------------------------------------------------------
 * Formula point mode — referenced-range highlights
 * ---------------------------------------------------------------------------
 * While a formula is being edited (in a cell or the formula bar), every cell/
 * range reference in the text is outlined with a colored dashed box on the grid.
 * Colors come from window.CoSheet.formulaRefs; identical references share one.
 * ------------------------------------------------------------------------- */

/** Converts '#rrggbb' to an rgba() string at the given alpha. */
const hexToRgba = (hex, alpha) => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Returns (creating if needed) the absolute layer that holds highlight boxes. */
const ensureRefHighlightLayer = () => {
  let layer = document.getElementById('formula-ref-highlights');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'formula-ref-highlights';
    const gridRoot = document.getElementById('grid-root');
    if (gridRoot) gridRoot.appendChild(layer);
  }
  return layer;
};

/** Removes all highlight boxes (called when a formula edit ends). */
const clearFormulaRefHighlights = () => {
  const layer = document.getElementById('formula-ref-highlights');
  if (layer) layer.innerHTML = '';
};

/** Draws a dashed colored box over each distinct in-grid reference in `text`. */
const renderFormulaRefHighlights = (text) => {
  const layer = ensureRefHighlightLayer();
  layer.innerHTML = '';
  const api = window.CoSheet && window.CoSheet.formulaRefs;
  if (!api || typeof text !== 'string' || text[0] !== '=') return;
  const refs = api.assignColors(api.scanReferences(text));
  const seen = new Set();
  for (const r of refs) {
    const key = `${r.r1},${r.c1},${r.r2},${r.c2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Skip references outside the 26-column grid (text is still tinted in-cell).
    if (r.r1 < 0 || r.c1 < 0 || r.c2 > 25) continue;
    const tl = document.querySelector(`[data-cell-id="${getColLetter(r.c1)}${r.r1 + 1}"]`);
    const br = document.querySelector(`[data-cell-id="${getColLetter(r.c2)}${r.r2 + 1}"]`);
    if (!tl || !br || typeof tl.offsetLeft !== 'number') continue;
    const box = document.createElement('div');
    box.className = 'formula-ref-highlight';
    box.style.left = `${tl.offsetLeft}px`;
    box.style.top = `${tl.offsetTop}px`;
    box.style.width = `${br.offsetLeft + br.offsetWidth - tl.offsetLeft}px`;
    box.style.height = `${br.offsetTop + br.offsetHeight - tl.offsetTop}px`;
    box.style.borderColor = r.color;
    box.style.backgroundColor = hexToRgba(r.color, 0.1);
    layer.appendChild(box);
  }
};

/* ---------------------------------------------------------------------------
 * Formula edit sessions
 * ---------------------------------------------------------------------------
 * A FormulaEditSession is a thin adapter over whichever editor is active — the
 * contenteditable cell or the formula-bar <input> — exposing a uniform text +
 * caret interface so the point-mode controller and autocomplete can drive both.
 * ------------------------------------------------------------------------- */

let activeFormulaSession = null;  // the session currently being edited, or null
let pointAnchorCellId = null;     // drag anchor cell during a point-mode drag
let pointPending = null;          // { start, end } offsets of the last point-inserted ref
let pointInserting = false;       // guard: true while we mutate text programmatically

/** Linear plain-text caret offset within a contenteditable element. */
const getCellCaretOffset = (el) => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return el.innerText.length;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
};

/** Places the caret at a linear plain-text offset within a contenteditable element. */
const setCellCaretOffset = (el, offset) => {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let remaining = offset;
  let target = null;
  let targetOff = 0;
  const walk = (node) => {
    if (target) return;
    if (node.nodeType === 3) {
      const len = node.textContent.length;
      if (remaining <= len) { target = node; targetOff = remaining; }
      else remaining -= len;
    } else {
      for (const child of node.childNodes) { walk(child); if (target) return; }
    }
  };
  walk(el);
  if (target) { range.setStart(target, targetOff); range.collapse(true); }
  else { range.selectNodeContents(el); range.collapse(false); }
  sel.removeAllRanges();
  sel.addRange(range);
};

/** Re-renders a cell editor's content with reference substrings tinted by color. */
const renderCellFormulaHtml = (el, text) => {
  const api = window.CoSheet && window.CoSheet.formulaRefs;
  const esc = window.CoSheet.utils.escapeHtml;
  const refs = (api && text[0] === '=') ? api.assignColors(api.scanReferences(text)) : [];
  if (!refs.length) { el.textContent = text; return; }
  let html = '';
  let i = 0;
  for (const r of refs) {
    html += esc(text.slice(i, r.start));
    html += `<span style="color:${r.color}">${esc(r.ref)}</span>`;
    i = r.end;
  }
  html += esc(text.slice(i));
  el.innerHTML = html;
};

/** Builds a session for the formula-bar input. */
const makeBarSession = () => ({
  kind: 'bar',
  el: formulaBarInput,
  getText: () => formulaBarInput.value,
  setText: (s) => { formulaBarInput.value = s; },
  getCaret: () => formulaBarInput.selectionStart,
  setCaret: (i) => formulaBarInput.setSelectionRange(i, i),
  focus: () => formulaBarInput.focus()
});

/** Builds a session for an inline (contenteditable) cell editor. */
const makeCellSession = (cellEl) => ({
  kind: 'cell',
  el: cellEl,
  getText: () => cellEl.innerText,
  setText: (s) => renderCellFormulaHtml(cellEl, s),
  getCaret: () => getCellCaretOffset(cellEl),
  setCaret: (i) => setCellCaretOffset(cellEl, i),
  focus: () => cellEl.focus()
});

/** Sets a session's text + caret and refreshes grid highlights in one shot. */
const applySessionText = (session, text, caret) => {
  session.setText(text);
  session.setCaret(caret);
  renderFormulaRefHighlights(text);
};

/** Called on every input/commit-change for the active session: tint + highlight. */
const refreshFormulaEditing = (session) => {
  const text = session.getText();
  renderFormulaRefHighlights(text);
  if (session.kind === 'cell') {
    const caret = session.getCaret();
    renderCellFormulaHtml(session.el, text);
    session.setCaret(caret);
  }
};

/** Ends the active formula session: clears highlights and the active pointer. */
const endFormulaSession = () => {
  clearFormulaRefHighlights();
  activeFormulaSession = null;
  pointAnchorCellId = null;
  pointPending = null;
  pointInserting = false;
};

/* ---------------------------------------------------------------------------
 * Point mode — insert references by clicking/dragging cells
 * ------------------------------------------------------------------------- */

/** True when a formula editor is active and its text is in formula mode. */
const isPointModeActive = () =>
  !!activeFormulaSession && activeFormulaSession.getText()[0] === '=';

/** Inserts (or replaces the pending) single-cell reference for a mousedown. */
const pointInsertReference = (cellId) => {
  const s = activeFormulaSession;
  if (!s) return;
  pointAnchorCellId = cellId;
  const text = s.getText();
  const start = pointPending ? pointPending.start : s.getCaret();
  const end = pointPending ? pointPending.end : s.getCaret();
  const newText = text.slice(0, start) + cellId + text.slice(end);
  pointPending = { start, end: start + cellId.length };
  pointInserting = true;
  applySessionText(s, newText, start + cellId.length);
  pointInserting = false;
};

/** Rewrites the pending reference to the anchor:hover range during a drag. */
const pointExtendRange = (hoverId) => {
  const s = activeFormulaSession;
  if (!s || !pointAnchorCellId || !pointPending) return;
  const a = parseCellCoord(pointAnchorCellId);
  const b = parseCellCoord(hoverId);
  if (!a || !b) return;
  const c1 = Math.min(a.colIndex, b.colIndex);
  const c2 = Math.max(a.colIndex, b.colIndex);
  const r1 = Math.min(a.row, b.row);
  const r2 = Math.max(a.row, b.row);
  const single = c1 === c2 && r1 === r2;
  const ref = single
    ? `${getColLetter(c1)}${r1}`
    : `${getColLetter(c1)}${r1}:${getColLetter(c2)}${r2}`;
  const text = s.getText();
  const newText = text.slice(0, pointPending.start) + ref + text.slice(pointPending.end);
  pointInserting = true;
  applySessionText(s, newText, pointPending.start + ref.length);
  pointPending = { start: pointPending.start, end: pointPending.start + ref.length };
  pointInserting = false;
};

/**
 * Copies values, formulas, and styles of the currently selected range of cells.
 */
const copySelectedCells = () => {
  const cellIds = getSelectedCellIds();
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
};

/**
 * Copies the current selection and clears the source cells.
 */
const cutSelectedCells = () => {
  const cellIds = getSelectedCellIds();
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
    if (newRow < 1 || newRow > TOTAL_ROWS || newColIndex < 0 || newColIndex > 25) return;

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
    if (localCells[activeCellId]) {
      const formulaBar = document.getElementById('formula-bar-input');
      if (formulaBar) {
        formulaBar.value = localCells[activeCellId].formula ? localCells[activeCellId].formula : localCells[activeCellId].value;
      }
    }
  }
};

/**
 * Helper to check if a cell matches the search string based on options.
 * @param {string} cellId - The cell coordinate.
 * @param {string} sheetName - The sheet containing the cell.
 * @param {string} findStr - The string to find.
 * @param {boolean} matchCase - Case sensitivity flag.
 * @param {boolean} matchEntire - Exact match flag.
 * @param {boolean} useRegex - Regular expression flag.
 * @param {boolean} searchFormulas - Search inside formulas flag.
 * @param {boolean} searchLinks - Search inside hyperlinks flag.
 * @returns {boolean} True if matching.
 */
const matchesCell = (cellId, sheetName, findStr, matchCase, matchEntire, useRegex, searchFormulas, searchLinks) => {
  const sheetCells = localSheets[sheetName];
  if (!sheetCells) return false;
  const cell = sheetCells[cellId];
  if (!cell) return false;

  const textsToCheck = [];
  // Check cellular raw value
  if (cell.value !== undefined && cell.value !== null) {
    textsToCheck.push(cell.value.toString());
  }
  // Check formula if option enabled
  if (searchFormulas && cell.formula) {
    textsToCheck.push(cell.formula.toString());
  }
  // Check hyperlink style if option enabled
  if (searchLinks && cell.style && cell.style.link) {
    textsToCheck.push(cell.style.link.toString());
  }

  if (textsToCheck.length === 0) return false;

  // Verify if any of the target texts match the search criteria
  return textsToCheck.some(text => {
    if (useRegex) {
      try {
        const flags = matchCase ? '' : 'i';
        const regex = new RegExp(matchEntire ? `^${findStr}$` : findStr, flags);
        return regex.test(text);
      } catch (e) {
        // Fallback on invalid regex patterns
        return false;
      }
    } else {
      let t = text;
      let f = findStr;
      if (!matchCase) {
        t = t.toLowerCase();
        f = f.toLowerCase();
      }
      if (matchEntire) {
        return t === f;
      } else {
        return t.includes(f);
      }
    }
  });
};

/**
 * Generates cell sequence row-by-row, col-by-col for searching.
 * @returns {string[]} List of cell coordinate IDs.
 */
const getSortedCellSequence = () => {
  const sequence = [];
  // Standard grid dimensions: 1000 rows, 26 columns (A-Z)
  for (let r = 1; r <= TOTAL_ROWS; r++) {
    for (let c = 0; c < 26; c++) {
      const colLetter = getColLetter(c);
      sequence.push(`${colLetter}${r}`);
    }
  }
  return sequence;
};

let lastFoundCellId = null;
let lastFoundSheetName = null;

/**
 * Finds the next matching cell based on Find inputs.
 * @returns {Object|null} Sheet name and cell ID coordinate.
 */
const findNextMatch = () => {
  const findStr = document.getElementById('find-input').value;
  if (!findStr) return null;
  const matchCase = document.getElementById('find-match-case').checked;
  const matchEntire = document.getElementById('find-match-entire').checked;
  const useRegex = document.getElementById('find-use-regex').checked;
  const searchFormulas = document.getElementById('find-search-formulas').checked;
  const searchLinks = document.getElementById('find-search-links').checked;
  const scope = document.getElementById('find-scope-select').value;

  // Determine search sheets scope: current sheet or all sheets
  let sheets = [];
  if (scope === '此工作表') {
    sheets = [activeSheetName];
  } else {
    // Traverse sheets starting from the active sheet in order
    const curIdx = sheetOrder.indexOf(activeSheetName);
    for (let i = 0; i < sheetOrder.length; i++) {
      sheets.push(sheetOrder[(curIdx + i) % sheetOrder.length]);
    }
  }

  // Create the combined search sequence
  const cellSeq = getSortedCellSequence();
  const searchSpace = [];
  sheets.forEach(sheetName => {
    cellSeq.forEach(cellId => {
      searchSpace.push({ sheetName, cellId });
    });
  });

  // Start matching from the cell after the currently active selection
  let startIdx = 0;
  if (activeCellId) {
    const spaceIdx = searchSpace.findIndex(item => item.sheetName === activeSheetName && item.cellId === activeCellId);
    if (spaceIdx !== -1) {
      startIdx = (spaceIdx + 1) % searchSpace.length;
    }
  }

  // Iterate search space looking for first match
  for (let i = 0; i < searchSpace.length; i++) {
    const idx = (startIdx + i) % searchSpace.length;
    const { sheetName, cellId } = searchSpace[idx];
    if (matchesCell(cellId, sheetName, findStr, matchCase, matchEntire, useRegex, searchFormulas, searchLinks)) {
      lastFoundCellId = cellId;
      lastFoundSheetName = sheetName;
      
      // Auto-switch sheet and select cell upon finding match
      if (sheetName !== activeSheetName) {
        switchSheet(sheetName);
      }
      const cellEl = document.querySelector(`[data-cell-id="${cellId}"]`);
      if (cellEl) {
        handleCellSelect(cellId, cellEl);
        cellEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return { sheetName, cellId };
    }
  }

  alert('找不到相符的內容');
  return null;
};

/**
 * Replaces the find string with replace string in the active cell.
 */
const replaceCurrentMatch = () => {
  const findStr = document.getElementById('find-input').value;
  const replaceStr = document.getElementById('replace-input').value;
  if (!findStr || !activeCellId) return;

  const matchCase = document.getElementById('find-match-case').checked;
  const matchEntire = document.getElementById('find-match-entire').checked;
  const useRegex = document.getElementById('find-use-regex').checked;
  const searchFormulas = document.getElementById('find-search-formulas').checked;
  const searchLinks = document.getElementById('find-search-links').checked;

  // Make sure the active cell matches before applying replacement
  if (matchesCell(activeCellId, activeSheetName, findStr, matchCase, matchEntire, useRegex, searchFormulas, searchLinks)) {
    const before = localCells[activeCellId] ? JSON.parse(JSON.stringify(localCells[activeCellId])) : { formula: '', value: '', style: {} };
    const cell = localCells[activeCellId] || { formula: '', value: '', style: {} };
    
    let modified = false;
    // Replace text inside formula first, or fallback to cell value
    if (cell.formula && cell.formula.includes(findStr)) {
      cell.formula = cell.formula.replaceAll(findStr, replaceStr);
      modified = true;
    } else if (cell.value !== undefined && cell.value !== null) {
      const valStr = cell.value.toString();
      if (valStr.includes(findStr)) {
        cell.value = valStr.replaceAll(findStr, replaceStr);
        modified = true;
      }
    }

    if (modified) {
      localCells[activeCellId] = cell;
      // Record undo-redo history
      recordHistoryAction(activeCellId, before, cell);
      
      // Dispatch WebSocket cell update
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'cell-edit',
          payload: { cellId: activeCellId, formula: cell.formula, value: cell.value, style: cell.style }
        }));
      }
      updateGridDOMCell(activeCellId, getCellValue(activeCellId), cell.style);
      recalculateSheet();
      const formulaBar = document.getElementById('formula-bar-input');
      if (formulaBar) {
        formulaBar.value = cell.formula ? cell.formula : cell.value;
      }
    }
  }

  // Auto-find next match
  findNextMatch();
};

/**
 * Replaces all matches in the selected scope sheet(s) with replace string.
 */
const replaceAllMatches = () => {
  const findStr = document.getElementById('find-input').value;
  const replaceStr = document.getElementById('replace-input').value;
  if (!findStr) return;

  const matchCase = document.getElementById('find-match-case').checked;
  const matchEntire = document.getElementById('find-match-entire').checked;
  const useRegex = document.getElementById('find-use-regex').checked;
  const searchFormulas = document.getElementById('find-search-formulas').checked;
  const searchLinks = document.getElementById('find-search-links').checked;
  const scope = document.getElementById('find-scope-select').value;

  let sheets = [];
  if (scope === '此工作表') {
    sheets = [activeSheetName];
  } else {
    sheets = sheetOrder;
  }

  const historyChanges = [];
  let totalReplaced = 0;

  // Scan and replace within all selected sheets
  sheets.forEach(sheetName => {
    const sheetCells = localSheets[sheetName];
    if (!sheetCells) return;
    
    Object.keys(sheetCells).forEach(cellId => {
      if (matchesCell(cellId, sheetName, findStr, matchCase, matchEntire, useRegex, searchFormulas, searchLinks)) {
        const cell = sheetCells[cellId];
        const before = JSON.parse(JSON.stringify(cell));
        let modified = false;

        // Perform replacement in formula or cell value
        if (cell.formula && cell.formula.includes(findStr)) {
          cell.formula = cell.formula.replaceAll(findStr, replaceStr);
          modified = true;
        } else if (cell.value !== undefined && cell.value !== null) {
          const valStr = cell.value.toString();
          if (valStr.includes(findStr)) {
            cell.value = valStr.replaceAll(findStr, replaceStr);
            modified = true;
          }
        }

        if (modified) {
          sheetCells[cellId] = cell;
          totalReplaced++;
          historyChanges.push({ cellId, before, after: JSON.parse(JSON.stringify(cell)) });

          if (sheetName === activeSheetName) {
            updateGridDOMCell(cellId, getCellValue(cellId), cell.style);
          }
          
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'cell-edit',
              payload: { cellId, formula: cell.formula, value: cell.value, style: cell.style, sheetName }
            }));
          }
        }
      }
    });
  });

  if (totalReplaced > 0) {
    // Record composite undo/redo action
    recordHistoryAction({ type: 'multi', changes: historyChanges });
    recalculateSheet();
    if (activeCellId && localCells[activeCellId]) {
      const formulaBar = document.getElementById('formula-bar-input');
      if (formulaBar) {
        formulaBar.value = localCells[activeCellId].formula ? localCells[activeCellId].formula : localCells[activeCellId].value;
      }
    }
    alert(`已完成取代！共取代了 ${totalReplaced} 處。`);
  } else {
    alert('找不到相符的內容，未進行任何取代。');
  }
};

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
  
  if (undoBtn) {
    if (undoStack.length > 0) {
      undoBtn.removeAttribute('disabled');
      undoBtn.classList.remove('opacity-40', 'cursor-not-allowed');
    } else {
      undoBtn.setAttribute('disabled', 'true');
      undoBtn.classList.add('opacity-40', 'cursor-not-allowed');
    }
  }
  
  if (redoBtn) {
    if (redoStack.length > 0) {
      redoBtn.removeAttribute('disabled');
      redoBtn.classList.remove('opacity-40', 'cursor-not-allowed');
    } else {
      redoBtn.setAttribute('disabled', 'true');
      redoBtn.classList.add('opacity-40', 'cursor-not-allowed');
    }
  }
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
 * Reverts the last recorded cell state modification from the undo stack.
 */
const performUndo = () => {
  if (undoStack.length === 0) return;
  const action = undoStack.pop();
  
  if (action.type === 'multi') {
    const redoChanges = [];
    let touchesBorders = false;
    action.changes.forEach(change => {
      const currentState = localCells[change.cellId] ? JSON.parse(JSON.stringify(localCells[change.cellId])) : { formula: '', value: '', style: {} };
      redoChanges.push({ cellId: change.cellId, before: change.before, after: currentState });
      if (styleHasBorders(currentState.style) || styleHasBorders(change.before.style)) touchesBorders = true;
      localCells[change.cellId] = JSON.parse(JSON.stringify(change.before));
      syncCellState(change.cellId);
    });
    // Border edges are drawn neighbour-aware; a full re-render avoids the
    // doubled inner-border artifact that per-cell restore order can leave.
    if (touchesBorders) renderSpreadsheetGrid();
    redoStack.push({ type: 'multi', changes: redoChanges });
  } else {
    const cellId = action.cellId;
    const currentState = localCells[cellId] ? JSON.parse(JSON.stringify(localCells[cellId])) : { formula: '', value: '', style: {} };
    redoStack.push({ type: 'single', cellId, before: action.before, after: currentState });
    localCells[cellId] = JSON.parse(JSON.stringify(action.before));
    syncCellState(cellId);
  }
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
    action.changes.forEach(change => {
      const currentState = localCells[change.cellId] ? JSON.parse(JSON.stringify(localCells[change.cellId])) : { formula: '', value: '', style: {} };
      undoChanges.push({ cellId: change.cellId, before: currentState, after: change.after });
      if (styleHasBorders(currentState.style) || styleHasBorders(change.after.style)) touchesBorders = true;
      localCells[change.cellId] = JSON.parse(JSON.stringify(change.after));
      syncCellState(change.cellId);
    });
    if (touchesBorders) renderSpreadsheetGrid();
    undoStack.push({ type: 'multi', changes: undoChanges });
  } else {
    const cellId = action.cellId;
    const currentState = localCells[cellId] ? JSON.parse(JSON.stringify(localCells[cellId])) : { formula: '', value: '', style: {} };
    undoStack.push({ type: 'single', cellId, before: currentState, after: action.after });
    localCells[cellId] = JSON.parse(JSON.stringify(action.after));
    syncCellState(cellId);
  }
  updateUndoRedoButtonsState();
};

/**
 * Gets cell display value, evaluating formulas if present.
 * @param {string} coord - Cell coordinates.
 * @param {number} [depth=0] - Current recursion depth to prevent infinite loops.
 * @returns {string} Evaluated text display value.
 */
const getCellValue = (coord, depth = 0) => {
  const cell = localCells[coord];
  if (!cell) return '';
  if (cell.formula) return evaluateFormula(cell.formula, depth, coord);
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
  if (!style || !style.numberFormat) return rawValue;
  // Only numeric values are reformatted; text/blank pass through untouched.
  const str = String(rawValue).trim();
  if (str === '' || isNaN(str) || !isFinite(Number(str))) return rawValue;
  const out = formatNumberByType(Number(str), style.numberFormat);
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
const formatNumberByType = (num, fmt) => {
  const grouped = (n, dec) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const abs = Math.abs(num);
  switch (fmt) {
    case 'percent':         return `${(num * 100).toFixed(2)}%`;
    case 'number':          return grouped(num, 2);
    case 'scientific':      return num.toExponential(2).replace(/e([+-])(\d+)/i, (m, s, d) => `E${s}${d.padStart(2, '0')}`);
    case 'currency':        return `${num < 0 ? '-' : ''}NT$${grouped(abs, 2)}`;
    case 'currencyRounded': return `${num < 0 ? '-' : ''}NT$${grouped(abs, 0)}`;
    case 'accounting':      return num < 0 ? `(NT$${grouped(abs, 2)})` : `NT$${grouped(abs, 2)}`;
    case 'financial':       return num < 0 ? `(${grouped(abs, 2)})` : grouped(abs, 2);
    default:                return null;
  }
};

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
      const newVal = evaluateFormula(cell.formula, 0, coord);
      if (newVal !== cell.value) {
        cell.value = newVal;
        updateGridDOMCell(coord, newVal, cell.style);
      }
    }
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
  for (let c = 0; c < 26; c++) {
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
 * Lets a cell whose text is wider than the column spill across consecutive empty
 * neighbour cells (like Google Sheets / Excel) instead of being clipped by them.
 * Text is still clipped at the first neighbour that has content. Spill direction
 * follows text alignment: left/default spills right, right spills left, centre both.
 * @param {HTMLElement} cellEl - The cell DOM element.
 * @param {string} cellId - The cell ID (e.g. "A1").
 */
const updateCellOverflow = (cellEl, cellId) => {
  if (!cellEl || typeof cellEl.scrollWidth !== 'number') return;

  // Reset any previous spill styling before re-evaluating.
  cellEl.style.clipPath = '';
  cellEl.style.zIndex = '';

  // Cells set to wrap or clip never spill into neighbours.
  const wrapMode = localCells[cellId] && localCells[cellId].style && localCells[cellId].style.textWrap;
  if (wrapMode === 'wrap' || wrapMode === 'clip') return;

  // Nothing to do when the content fits within the cell.
  if (cellEl.scrollWidth <= cellEl.clientWidth + 1) return;

  const coord = parseCellCoord(cellId);
  if (!coord) return;

  const align = (localCells[cellId] && localCells[cellId].style && localCells[cellId].style.align) || 'left';
  const spillRight = align !== 'right';            // left & centre spill right
  const spillLeft = align === 'right' || align === 'center'; // right & centre spill left

  // Count consecutive empty neighbours available for the text to spill over.
  let rightCols = 0;
  if (spillRight) {
    for (let c = coord.colIndex + 1; c < 26; c++) {
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

/**
 * Dynamically builds and renders the interactive spreadsheet grid inside the DOM.
 */
const renderSpreadsheetGrid = () => {
  const gridRoot = document.getElementById('grid-root');
  if (!gridRoot) return;

  // Preserve the sticky top-left corner header
  gridRoot.innerHTML = '<div class="grid-header sticky top-0 left-0 z-30"></div>';

  // Render Column Headers A-Z
  for (let c = 0; c < 26; c++) {
    const colLetter = getColLetter(c);
    const colHeader = document.createElement('div');
    colHeader.className = 'grid-header sticky top-0 z-20 cursor-pointer';
    colHeader.innerText = colLetter;
    // Store column identifier for selection highlighting
    colHeader.setAttribute('data-col-id', colLetter);
    // Clicking a column header selects the entire column: the cells fill with
    // the selection colour, the active anchor is the top cell, and the header
    // is highlighted in solid blue.
    colHeader.addEventListener('mousedown', (e) => {
      if (isHistoryMode) return;
      if (e.button !== 0) return;
      e.preventDefault();
      selectColumn(colLetter);
    });

    // Dropdown button shown on hover at the far right of the header. Clicking it
    // opens the same context menu as right-clicking the sheet, anchored to the
    // column. It auto-hides 0.2s after the cursor leaves the header.
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
      selectColumn(colLetter);
      const r = menuBtn.getBoundingClientRect();
      showContextMenu(`${colLetter}1`, r.left, r.bottom);
    });
    colHeader.appendChild(menuBtn);

    // Drag handle on the column's right boundary. Hovering it shows a col-resize
    // cursor; dragging resizes the whole column (see startDimensionResize).
    if (!isHistoryMode) {
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

    gridRoot.appendChild(colHeader);
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

  // Render Grid Rows and Cells
  for (let r = 1; r <= TOTAL_ROWS; r++) {
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
      gridRoot.appendChild(uneditedBar);

      r = endRow; // Skip to the end of collapsed sequence
      continue;
    }

    // Row Header
    const rowHeader = document.createElement('div');
    rowHeader.className = 'grid-header sticky left-0 z-20';
    rowHeader.innerText = r;
    // Store row identifier for selection highlighting
    rowHeader.setAttribute('data-row-id', r);

    // Drag handle on the row's bottom boundary (mirrors the column handle).
    if (!isHistoryMode) {
      const rowNum = r;
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

    gridRoot.appendChild(rowHeader);

    // Cells A-Z for row
    for (let c = 0; c < 26; c++) {
      const colLetter = getColLetter(c);
      const cellId = `${colLetter}${r}`;
      
      const cellData = isHistoryMode
        ? (selectedVersionState?.sheets?.[sheetName]?.[cellId])
        : localCells[cellId];

      const cellEl = document.createElement('div');
      cellEl.className = 'grid-cell text-body-sm font-body-sm select-none cursor-default';
      cellEl.setAttribute('data-cell-id', cellId);

      // Display evaluated cell value
      const rawVal = isHistoryMode
        ? (cellData?.value || '')
        : getCellValue(cellId);
      const val = formatCellDisplay(rawVal, cellData && cellData.style);

      if (cellData && cellData.style && cellData.style.link) {
        const escapedValue = escapeHtml(val);
        const escapedLink = escapeHtml(cellData.style.link);
        cellEl.innerHTML = `<a href="${escapedLink}" target="_blank" class="text-blue-600 underline cursor-pointer hover:text-blue-800" onclick="event.stopPropagation();">${escapedValue}</a>`;
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
        applyCellBorders(cellEl, cellData.style, cellId);
        // Apply vertical alignment style if present
        if (cellData.style.verticalAlign) {
          cellEl.style.justifyContent = cellData.style.verticalAlign === 'top' ? 'flex-start' :
                                        (cellData.style.verticalAlign === 'center' ? 'center' : 'flex-end');
        }
      }

      // Horizontal alignment: explicit style wins, else numbers right-align
      const cellAlign = resolveCellAlign(rawVal, cellData && cellData.style);
      if (cellAlign) cellEl.style.textAlign = cellAlign;

      // Highlight cell changes in history mode
      if (isHistoryMode && highlightChangesChecked && isCellChanged(cellId, sheetName)) {
        cellEl.classList.add('grid-cell-history-highlight');
      }

      // Hook up cell mouse interactions for drag/range selection
      cellEl.addEventListener('mousedown', (e) => {
        if (isHistoryMode) return; // Disable selection in history mode
        if (e.button !== 0) return; // Only trigger selection on left mouse click
        // Formula point mode: while editing a formula, a click inserts the cell's
        // reference into the formula instead of changing the grid selection.
        if (isPointModeActive()) {
          e.preventDefault(); // keep focus/caret in the editor
          pointInsertReference(cellId);
          return;
        }
        isSelecting = true;
        isColumnSelection = false; // a cell click is never a full-column selection
        selectionStartCellId = cellId;
        selectionEndCellId = cellId;
        handleCellSelect(cellId, cellEl);
      });

      cellEl.addEventListener('mouseenter', () => {
        if (isHistoryMode) return; // Disable selection in history mode
        if (isPointModeActive() && pointAnchorCellId) { pointExtendRange(cellId); return; }
        if (isSelecting) {
          selectionEndCellId = cellId;
          updateRangeSelectionUI();
        }
      });

      // Hook up cell double-click interactions for inline edits
      cellEl.addEventListener('dblclick', (e) => {
        if (isHistoryMode) return; // Disable editing in history mode
        handleCellInlineEdit(cellId, cellEl);
      });

      gridRoot.appendChild(cellEl);
    }
  }

  // Apply per-sheet column widths / row heights to the freshly built grid.
  applyGridTemplate(gridRoot);

  // Re-apply the selection highlight (cell fill, overlay and header styling)
  // after the grid is rebuilt, so it survives re-renders — including a
  // full-column selection.
  if (selectionStartCellId && !isHistoryMode) {
    updateRangeSelectionUI();
  }

  // After layout, let cells with overflowing text spill across empty neighbours.
  // Only data-bearing cells can overflow, so iterate those rather than all cells.
  if (!isHistoryMode) {
    Object.keys(localCells).forEach(id => {
      updateCellOverflow(document.querySelector(`[data-cell-id="${id}"]`), id);
    });
  }

  // Re-apply frozen rows/columns (if any) on the freshly built DOM.
  applyFreeze();

  // Re-apply the active value filter (scope tint, funnel icon, hidden rows) on
  // the freshly built DOM, so it survives re-renders and remote edits.
  applyFilter();

  // The content height/width just changed; resync the synthetic scrollbars.
  if (gridScrollbarLayout) gridScrollbarLayout();
};

// Width of the row-index gutter (the first grid column: `46px repeat(26, 100px)`).
const GUTTER_WIDTH = 46;
// Darker line drawn along the freeze boundary, matching Google Sheets.
const FREEZE_BORDER = '2px solid #919191';

/**
 * Apply the active sheet's column widths (and any custom row heights) to the grid
 * by writing explicit CSS grid templates. Columns are always written from the
 * per-sheet widths (defaulting to 100px); row heights are only written when the
 * sheet has custom heights — otherwise the base `grid-auto-rows: minmax(21px,auto)`
 * rule is kept so rows still auto-grow with tall content. Skipped in history mode,
 * where collapsed "unedited" bars break the 1-row-per-grid-track mapping.
 * @param {HTMLElement} gridRoot
 */
function applyGridTemplate(gridRoot) {
  if (isHistoryMode) {
    gridRoot.style.gridTemplateColumns = '';
    gridRoot.style.gridTemplateRows = '';
    return;
  }
  // Columns: gutter + each column's resolved width.
  const cols = [`${GUTTER_WIDTH}px`];
  for (let c = 0; c < 26; c++) cols.push(`${getColWidth(getColLetter(c))}px`);
  gridRoot.style.gridTemplateColumns = cols.join(' ');

  // Rows: only override when custom heights exist (keeps the common case on the
  // cheap auto-rows path). The header band is the first track.
  if (sheetHasCustomRowHeights()) {
    const rows = ['minmax(21px, auto)'];
    for (let r = 1; r <= TOTAL_ROWS; r++) {
      const m = rowHeights[activeSheetName];
      const h = m && m[r];
      rows.push((typeof h === 'number' && isFinite(h)) ? `${h}px` : 'minmax(21px, auto)');
    }
    gridRoot.style.gridTemplateRows = rows.join(' ');
  } else {
    gridRoot.style.gridTemplateRows = '';
  }
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
      if (!map[activeSheetName]) map[activeSheetName] = Object.create(null);
      map[activeSheetName][key] = newSize;
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

  // Cumulative sticky `top` for each frozen row (rows can have variable height).
  const rowTop = {};
  if (frozenRows > 0) {
    let off = headerH;
    for (let r = 1; r <= frozenRows; r++) {
      rowTop[r] = off;
      const rh = gridRoot.querySelector(`[data-row-id="${r}"]`);
      off += rh ? rh.offsetHeight : 21;
    }
  }
  // Sticky `left` for a frozen column index, summing the (possibly resized)
  // widths of all columns before it (after the row-index gutter).
  const colLeft = (colIndex) => {
    let x = GUTTER_WIDTH;
    for (let c = 0; c < colIndex; c++) x += getColWidth(getColLetter(c));
    return x;
  };

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
    rh.style.top = `${rowTop[r]}px`;
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
      el.style.top = `${rowTop[coord.row]}px`;
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
  const cellEl = document.querySelector(`[data-cell-id="${cellId}"]`);
  if (!cellEl) return;

  // Check and preserve whether the cell is currently selected to retain the highlight class
  const hasClass = cellEl.classList && typeof cellEl.classList.contains === 'function';
  const isSelected = hasClass ? cellEl.classList.contains('grid-cell-selected') : false;
  const isActive = hasClass ? cellEl.classList.contains('grid-cell-active') : false;

  // Preserve collaborator cursors currently positioned on this cell
  const cursorBorders = cellEl.querySelectorAll('.active-cell-border');
  const presenceTags = cellEl.querySelectorAll('.presence-tag');

  // Display evaluated cell value (render as anchor element if link exists, otherwise plain text)
  const val = formatCellDisplay(value || '', style);
  if (style && style.link) {
    const escapedValue = escapeHtml(val);
    const escapedLink = escapeHtml(style.link);
    cellEl.innerHTML = `<a href="${escapedLink}" target="_blank" class="text-blue-600 underline cursor-pointer hover:text-blue-800" onclick="event.stopPropagation();">${escapedValue}</a>`;
  } else {
    cellEl.innerText = val;
  }

  // Re-append cursors
  cursorBorders.forEach(border => cellEl.appendChild(border));
  presenceTags.forEach(tag => cellEl.appendChild(tag));

  // Reset standard styling classes
  cellEl.className = 'grid-cell text-body-sm font-body-sm select-none cursor-pointer';
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
  if (!isHistoryMode) {
    const coord = parseCellCoord(cellId);
    if (coord) {
      for (let c = 0; c < 26; c++) {
        const id = `${getColLetter(c)}${coord.row}`;
        updateCellOverflow(document.querySelector(`[data-cell-id="${id}"]`), id);
      }
    }
  }
};

/**
 * Focuses selection on a spreadsheet cell and triggers cursor events.
 * @param {string} cellId - The selected cell identifier.
 * @param {HTMLElement} cellEl - The selected DOM element.
 */
const handleCellSelect = (cellId, cellEl) => {
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

  // For a full-column selection the Name Box already shows "A:A" (set by
  // updateRangeSelectionUI); don't overwrite it with the anchor cell ID.
  if (coordDisplay && !isColumnSelection) coordDisplay.innerText = cellId;
  if (formulaBar) {
    formulaBar.value = cellData && cellData.formula ? cellData.formula : (cellData && cellData.value ? cellData.value : '');
  }

  // Notify server of active cell cursor movement
  if (socket.readyState === WebSocket.OPEN) {
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
  const nextCellEl = document.querySelector(`[data-cell-id="${nextCellId}"]`);
  if (!nextCellEl) return;
  // Reset any range/column selection so this becomes a single-cell selection,
  // matching what a plain click on the cell would do.
  isColumnSelection = false;
  selectionStartCellId = nextCellId;
  selectionEndCellId = nextCellId;
  handleCellSelect(nextCellId, nextCellEl);
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
  // Pre-set the range end to the bottom of the column; handleCellSelect keeps it
  // because it only defaults the end when none is set.
  selectionEndCellId = `${colLetter}${TOTAL_ROWS}`;
  const topCellEl = document.querySelector(`[data-cell-id="${colLetter}1"]`);
  handleCellSelect(`${colLetter}1`, topCellEl);
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

  // Formula editing: enable autocomplete, point mode and reference highlighting
  // for this cell so it behaves like the formula bar.
  const cellSession = makeCellSession(cellEl);
  const syncFormulaState = () => {
    const text = cellEl.innerText;
    if (text[0] === '=') {
      activeFormulaSession = cellSession;
      if (!pointInserting) pointPending = null;
      refreshFormulaEditing(cellSession);
      updateFnAutocomplete(cellSession);
    } else {
      if (activeFormulaSession === cellSession) endFormulaSession();
      closeFnAutocomplete();
    }
  };
  cellEl.oninput = syncFormulaState;
  // If editing started with '=' (typed or an existing formula), arm immediately.
  syncFormulaState();

  // Handle saving inline edits on blur
  const saveInlineEdit = () => {
    if (activeFormulaSession === cellSession) endFormulaSession();
    closeFnAutocomplete();
    cellEl.removeAttribute('contenteditable');
    const text = cellEl.innerText.trim();
    saveCellUpdate(cellId, text);
  };

  let cancelled = false;
  cellEl.onblur = () => { if (!cancelled) saveInlineEdit(); };
  cellEl.onkeydown = (e) => {
    // Let the function autocomplete consume navigation/accept keys first.
    if (isFnAutocompleteOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFnAutocomplete(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveFnAutocomplete(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptFnAutocomplete(cellSession); return; }
      if (e.key === 'Escape')    { e.preventDefault(); closeFnAutocomplete(); return; }
    }
    if (e.key === 'Escape') {
      // Cancel the edit: restore the cell to its stored value, discard changes.
      e.preventDefault();
      e.stopPropagation();
      cancelled = true;
      if (activeFormulaSession === cellSession) endFormulaSession();
      closeFnAutocomplete();
      cellEl.removeAttribute('contenteditable');
      const cellData = localCells[cellId] || { formula: '', value: '', style: {} };
      cellEl.innerText = cellData.formula ? cellData.formula : cellData.value;
      updateGridDOMCell(cellId, getCellValue(cellId), cellData.style);
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
  } else {
    cell.formula = '';
    cell.value = text;
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
    if (isFnAutocompleteOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFnAutocomplete(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveFnAutocomplete(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptFnAutocomplete(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); closeFnAutocomplete(); return; }
    }
    if (e.key === 'Enter' && activeCellId) {
      e.preventDefault(); // Prevent default enter key behavior
      closeFnAutocomplete();
      saveCellUpdate(activeCellId, formulaBarInput.value); // Save cell update
      endFormulaSession();
      formulaBarInput.blur(); // Remove focus from the formula bar
    }
  });

  // The formula bar's edit session: drives reference highlights + point mode +
  // autocomplete the same way the in-cell editor does.
  const barSession = makeBarSession();
  formulaBarInput.addEventListener('focus', () => {
    activeFormulaSession = barSession;
    refreshFormulaEditing(barSession);
  });
  // Recompute suggestions / highlights as the user types or moves the caret.
  formulaBarInput.addEventListener('input', () => {
    activeFormulaSession = barSession;
    if (!pointInserting) pointPending = null; // user typed -> pending no longer valid
    refreshFormulaEditing(barSession);
    updateFnAutocomplete(barSession);
  });
  formulaBarInput.addEventListener('click', () => { pointPending = null; updateFnAutocomplete(barSession); });
  // Close when leaving the field (delayed so a click on a suggestion still
  // registers via its mousedown handler before blur tears the popup down). A
  // point-mode mousedown preventDefaults, so a real blur means editing ended.
  formulaBarInput.addEventListener('blur', () => {
    setTimeout(closeFnAutocomplete, 120);
    if (activeFormulaSession === barSession) endFormulaSession();
  });
}

/* ---------------------------------------------------------------------------
 * Formula-bar function autocomplete
 * ---------------------------------------------------------------------------
 * When the user types "=" followed by letters in the formula bar, a dropdown
 * suggests matching spreadsheet function names (from window.SHEET_FUNCTIONS).
 * Tab/Enter inserts the highlighted function as "NAME(" with the caret placed
 * inside the parentheses; ↑↓ browse; Esc dismisses. This is a typing aid only
 * (see sheet-functions.js) — it does not change what the formula engine can
 * actually evaluate.
 * ------------------------------------------------------------------------- */
let fnAcEl = null;          // dropdown DOM element (null when closed)
let fnAcMatches = [];       // current matching function entries
let fnAcIndex = 0;          // highlighted index within fnAcMatches
let fnAcTokenStart = -1;    // caret-relative start of the typed function token
const FN_AC_MAX = 50;       // cap suggestions to keep the list manageable

const isFnAutocompleteOpen = () => fnAcEl !== null;

/**
 * Extracts the function-name token immediately to the left of the caret.
 * Only triggers in formula mode (value starts with "="). Returns null when the
 * caret is not at the end of a letter-led identifier.
 * @returns {{ word: string, start: number } | null}
 */
const getFnToken = () => {
  if (!formulaBarInput) return null;
  const value = formulaBarInput.value;
  if (!value.startsWith('=')) return null;
  const caret = formulaBarInput.selectionStart;
  // Caret must be a collapsed cursor (no selection) for predictable insertion.
  if (caret !== formulaBarInput.selectionEnd) return null;
  const left = value.slice(0, caret);
  const m = left.match(/([A-Za-z][A-Za-z0-9_.]*)$/);
  if (!m) return null;
  return { word: m[1], start: caret - m[1].length };
};

/** Recomputes matches from the current token and shows/hides the dropdown. */
const updateFnAutocomplete = () => {
  const catalog = window.SHEET_FUNCTIONS;
  if (!Array.isArray(catalog) || catalog.length === 0) { closeFnAutocomplete(); return; }
  const token = getFnToken();
  if (!token) { closeFnAutocomplete(); return; }
  const prefix = token.word.toUpperCase();
  const matches = catalog.filter(fn => fn.n.startsWith(prefix)).slice(0, FN_AC_MAX);
  if (matches.length === 0) { closeFnAutocomplete(); return; }
  fnAcMatches = matches;
  fnAcTokenStart = token.start;
  fnAcIndex = 0;
  renderFnAutocomplete();
};

/** Builds (or rebuilds) the dropdown DOM and positions it under the input. */
const renderFnAutocomplete = () => {
  const lang = getLang();
  if (!fnAcEl) {
    fnAcEl = document.createElement('div');
    fnAcEl.id = 'fn-autocomplete';
    fnAcEl.className = 'fixed z-[1000] bg-surface-container-lowest dark:bg-inverse-surface ' +
      'border border-outline-variant rounded-lg shadow-lg overflow-hidden select-none ' +
      'text-on-surface dark:text-on-surface-variant text-label-md';
    document.body.appendChild(fnAcEl);
  }

  const rows = fnAcMatches.map((fn, i) => {
    const active = i === fnAcIndex;
    const desc = (fn[lang] || fn.en || '').replace(/</g, '&lt;');
    const descHtml = active && desc
      ? `<div class="text-xs text-on-surface-variant/80 mt-0.5">${desc}</div>`
      : '';
    return `
      <div class="fn-ac-item px-3 py-1.5 cursor-pointer ${active ? 'bg-surface-variant' : 'hover:bg-surface-variant/60'}" data-idx="${i}">
        <div class="font-mono-data text-on-surface dark:text-on-surface-variant">${fn.n}</div>
        ${descHtml}
      </div>`;
  }).join('');

  fnAcEl.innerHTML = `
    <div class="fn-ac-list max-h-72 overflow-y-auto py-1">${rows}</div>
    <div class="px-3 py-1.5 border-t border-outline-variant text-xs text-on-surface-variant/70">
      ${t('fn.hint')}
    </div>`;

  // Insert the highlighted suggestion on click. mousedown (not click) fires
  // before the input's blur handler, so the popup is still alive.
  fnAcEl.querySelectorAll('.fn-ac-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      fnAcIndex = parseInt(item.dataset.idx, 10) || 0;
      acceptFnAutocomplete();
    });
  });

  positionFnAutocomplete();
};

/** Positions the dropdown beneath the formula bar input, clamped to viewport. */
const positionFnAutocomplete = () => {
  if (!fnAcEl || !formulaBarInput) return;
  const rect = formulaBarInput.getBoundingClientRect();
  const width = Math.min(380, Math.max(220, rect.width));
  let left = rect.left;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
  if (left < 8) left = 8;
  fnAcEl.style.width = `${width}px`;
  fnAcEl.style.left = `${left}px`;
  fnAcEl.style.top = `${rect.bottom + 2}px`;
};

/** Moves the highlight by delta (wrapping) and re-renders. */
const moveFnAutocomplete = (delta) => {
  if (!isFnAutocompleteOpen() || fnAcMatches.length === 0) return;
  const n = fnAcMatches.length;
  fnAcIndex = (fnAcIndex + delta + n) % n;
  renderFnAutocomplete();
  // Keep the active row visible within the scroll area.
  const activeRow = fnAcEl.querySelector(`.fn-ac-item[data-idx="${fnAcIndex}"]`);
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
};

/** Replaces the typed token with "NAME(" and places the caret inside. */
const acceptFnAutocomplete = () => {
  if (!isFnAutocompleteOpen() || !formulaBarInput) return;
  const fn = fnAcMatches[fnAcIndex];
  if (!fn) { closeFnAutocomplete(); return; }
  const value = formulaBarInput.value;
  const caret = formulaBarInput.selectionStart;
  const before = value.slice(0, fnAcTokenStart);
  const after = value.slice(caret);
  const insert = `${fn.n}(`;
  formulaBarInput.value = before + insert + after;
  const newCaret = before.length + insert.length;
  formulaBarInput.setSelectionRange(newCaret, newCaret);
  formulaBarInput.focus();
  closeFnAutocomplete();
};

/** Tears down the dropdown and resets state. */
const closeFnAutocomplete = () => {
  if (fnAcEl) { fnAcEl.remove(); fnAcEl = null; }
  fnAcMatches = [];
  fnAcIndex = 0;
  fnAcTokenStart = -1;
};

// Reposition on viewport changes; close on outside interaction.
window.addEventListener('resize', () => { if (isFnAutocompleteOpen()) positionFnAutocomplete(); });
document.addEventListener('mousedown', (e) => {
  if (!isFnAutocompleteOpen()) return;
  if (fnAcEl.contains(e.target) || e.target === formulaBarInput) return;
  closeFnAutocomplete();
});

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
  recalculateSheet();
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
};

/**
 * Compatibility wrapper to toggle border styling for selection range.
 * @param {string} cellId - The target cell ID.
 */
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
  recalculateSheet();
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
  recalculateSheet();
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
  recalculateSheet();
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
  recalculateSheet();
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
  recalculateSheet();
  if (activeCellId) {
    updateToolbarFormattingStates(localCells[activeCellId] ? localCells[activeCellId].style : null);
  }
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
  recalculateSheet();
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
  recalculateSheet();
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
 * Applies a cell's stored borders to its DOM element (per-side CSS).
 *
 * Shared interior edges are drawn only once: a cell yields its right/bottom
 * edge to the neighbour's left/top edge when that neighbour also has one.
 * Without this, two coincident 1px borders stack and inner lines render twice
 * as thick as the outer perimeter.
 * @param {HTMLElement} cellEl - The grid cell element.
 * @param {Object} [style] - The cell's style object.
 * @param {string} [cellId] - The cell ID, enabling neighbour-aware de-duping.
 */
const applyCellBorders = (cellEl, style, cellId) => {
  if (!cellEl || !style) return;
  const top = cellBorderSide(style, 'top');
  const left = cellBorderSide(style, 'left');
  let right = cellBorderSide(style, 'right');
  let bottom = cellBorderSide(style, 'bottom');

  // De-dupe shared edges against live neighbours (skipped in history mode,
  // which renders from a snapshot rather than localCells).
  if (cellId && !isHistoryMode) {
    const coord = parseCellCoord(cellId);
    if (coord) {
      if (right) {
        const rId = `${getColLetter(coord.colIndex + 1)}${coord.row}`;
        if (cellBorderSide(localCells[rId] && localCells[rId].style, 'left')) right = null;
      }
      if (bottom) {
        const bId = `${getColLetter(coord.colIndex)}${coord.row + 1}`;
        if (cellBorderSide(localCells[bId] && localCells[bId].style, 'top')) bottom = null;
      }
    }
  }

  const applySide = (side, spec) => {
    if (!spec) return;
    const fn = BORDER_STYLE_CSS[spec.style] || BORDER_STYLE_CSS.thin;
    const prop = 'border' + side.charAt(0).toUpperCase() + side.slice(1);
    cellEl.style[prop] = fn(spec.color || '#000000');
  };
  applySide('top', top);
  applySide('left', left);
  applySide('right', right);
  applySide('bottom', bottom);
};

/**
 * Applies a border mode to the current selection, using the current pen
 * color/style. Edge-aware: "outer" hits the selection perimeter, "inner"/
 * "horizontal"/"vertical" hit interior edges, "clear" removes all borders.
 * @param {('all'|'inner'|'horizontal'|'vertical'|'outer'|'left'|'top'|'right'|'bottom'|'clear')} mode
 */
const applyBordersToSelection = (mode) => {
  const ids = getSelectedCellIds();
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
  const historyChanges = [];

  ids.forEach((id) => {
    const coord = parseCellCoord(id);
    if (!coord) return;
    const before = localCells[id] ? JSON.parse(JSON.stringify(localCells[id])) : { formula: '', value: '', style: {} };
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
  });

  // Render only after every cell is mutated, so neighbour-aware edge de-duping
  // reads final state. Also refresh the cells just outside the top/left edges,
  // whose right/bottom edges may now coincide with the selection's borders.
  const renderIds = new Set(ids);
  for (let r = minRow; r <= maxRow; r++) {
    if (minCol - 1 >= 0) renderIds.add(`${getColLetter(minCol - 1)}${r}`);
  }
  for (let c = minCol; c <= maxCol; c++) {
    if (minRow - 1 >= 1) renderIds.add(`${getColLetter(c)}${minRow - 1}`);
  }
  renderIds.forEach((id) => {
    const st = localCells[id] ? localCells[id].style : {};
    updateGridDOMCell(id, getCellValue(id), st);
  });

  recordHistoryAction({ type: 'multi', changes: historyChanges });
  recalculateSheet();
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
  recalculateSheet();
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
  recalculateSheet();
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
  recalculateSheet();
  updateToolbarFormattingStates(cell.style);
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
};

/* ---------------------------------------------------------------------------
 * Row / column insertion
 * ---------------------------------------------------------------------------
 * The grid is a fixed 26 columns (A-Z) x TOTAL_ROWS. Inserting a blank row or
 * column shifts existing cell data down/right (content pushed off the far edge
 * is dropped) and rewrites cell references inside every formula so they keep
 * pointing at the same data. The change is recorded as one multi-cell history
 * action and broadcast per-cell, reusing the existing edit/undo/sync plumbing.
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
    if (newRow > TOTAL_ROWS - 1 || newCol > 25) return; // shifted off-grid -> dropped
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

  if (changes.length) recordHistoryAction({ type: 'multi', changes });
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
    if (newCol > 25 || newRow > TOTAL_ROWS) return; // shifted off-grid -> dropped
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

/** Inserts a blank row above the given cell's row, shifting rows down. */
const insertRowAbove = (cellId) => {
  const m = String(cellId).match(/^[A-Z]+(\d+)$/);
  if (!m) return;
  performStructuralInsert('row', parseInt(m[1], 10));
};

/** Inserts a blank column to the left of the given cell's column. */
const insertColumnLeft = (cellId) => {
  const coord = parseCoordinates(cellId);
  performStructuralInsert('col', coord.col);
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

  if (changes.length) recordHistoryAction({ type: 'multi', changes });
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
  menu.className = 'fixed bg-surface-container-lowest dark:bg-inverse-surface shadow-lg rounded-lg py-1.5 z-[1000] border border-outline-variant text-label-md text-on-surface dark:text-on-surface-variant w-60 select-none';

  // Shared class strings for the menu rows.
  const itemCls = 'w-full flex items-center gap-3 px-3 py-1.5 hover:bg-surface-variant cursor-pointer text-left';
  const iconCls = 'material-symbols-outlined text-[20px] leading-none text-on-surface-variant';
  const shortcutCls = 'text-xs text-on-surface-variant/70';
  const dividerCls = 'h-px bg-outline-variant my-1.5';
  // Rows whose backing feature does not yet exist are shown greyed-out rather
  // than guessed at, per the project's "don't guess — gray it out" rule.
  const disabledCls = 'w-full flex items-center gap-3 px-3 py-1.5 cursor-not-allowed opacity-40 text-left';

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
      <span class="flex-grow">${t('ctx.insertRowAbove')}</span>
    </button>
    <button class="${itemCls}" id="menu-insert-col">
      <span class="${iconCls}">add</span>
      <span class="flex-grow">${t('ctx.insertColLeft')}</span>
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
    <div class="${disabledCls}">
      <span class="${iconCls}">filter_alt</span>
      <span class="flex-grow">${t('ctx.createFilter')}</span>
    </div>
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
  document.getElementById('menu-insert-row').onclick = () => { insertRowAbove(cellId); menu.remove(); };
  document.getElementById('menu-insert-col').onclick = () => { insertColumnLeft(cellId); menu.remove(); };
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
  document.getElementById('menu-history').onclick = () => { toggleHistoryMode(true); menu.remove(); };
  document.getElementById('menu-link').onclick = () => {
    const cell = localCells[cellId] || { formula: '', value: '', style: {} };
    const currentLink = cell.style && cell.style.link ? cell.style.link : '';
    const url = prompt('Enter link URL (e.g. https://google.com):', currentLink);
    if (url !== null) changeCellLink(cellId, url);
    menu.remove();
  };
  // Note: paste-special, convert-to-table, create-filter, comment, note,
  // pre-built table, dropdown, smart chips and "more actions" are rendered
  // greyed-out and intentionally left unwired until those features exist — see
  // the reference mock-up (images/right_click_menu.png).
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

  if (toolbarBold) {
    if (style && style.bold) {
      toolbarBold.classList.add('bg-surface-variant');
    } else {
      toolbarBold.classList.remove('bg-surface-variant');
    }
  }

  if (toolbarItalic) {
    if (style && style.italic) {
      toolbarItalic.classList.add('bg-surface-variant');
    } else {
      toolbarItalic.classList.remove('bg-surface-variant');
    }
  }

  if (toolbarStrikethrough) {
    if (style && style.strikethrough) {
      toolbarStrikethrough.classList.add('bg-surface-variant');
    } else {
      toolbarStrikethrough.classList.remove('bg-surface-variant');
    }
  }

  if (toolbarBorder) {
    if (styleHasBorders(style)) {
      toolbarBorder.classList.add('bg-surface-variant');
    } else {
      toolbarBorder.classList.remove('bg-surface-variant');
    }
  }

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
  if (alignLeftBtn) {
    if (currentAlign === 'left') {
      alignLeftBtn.classList.add('bg-surface-variant');
    } else {
      alignLeftBtn.classList.remove('bg-surface-variant');
    }
  }
  if (alignCenterBtn) {
    if (currentAlign === 'center') {
      alignCenterBtn.classList.add('bg-surface-variant');
    } else {
      alignCenterBtn.classList.remove('bg-surface-variant');
    }
  }
  if (alignRightBtn) {
    if (currentAlign === 'right') {
      alignRightBtn.classList.add('bg-surface-variant');
    } else {
      alignRightBtn.classList.remove('bg-surface-variant');
    }
  }

  // Set the default vertical alignment icon based on style (fallback to vertical_align_bottom)
  const currentValign = style && style.verticalAlign ? style.verticalAlign : 'bottom';
  if (toolbarValignIcon) {
    toolbarValignIcon.textContent = `vertical_align_${currentValign}`;
  }

  // Update active state highlight classes for each vertical alignment option button
  if (valignTopBtn) {
    if (currentValign === 'top') {
      valignTopBtn.classList.add('bg-surface-variant');
    } else {
      valignTopBtn.classList.remove('bg-surface-variant');
    }
  }
  if (valignCenterBtn) {
    if (currentValign === 'center') {
      valignCenterBtn.classList.add('bg-surface-variant');
    } else {
      valignCenterBtn.classList.remove('bg-surface-variant');
    }
  }
  if (valignBottomBtn) {
    if (currentValign === 'bottom') {
      valignBottomBtn.classList.add('bg-surface-variant');
    } else {
      valignBottomBtn.classList.remove('bg-surface-variant');
    }
  }

  if (toolbarLink) {
    if (style && style.link) {
      toolbarLink.classList.add('bg-surface-variant');
    } else {
      toolbarLink.classList.remove('bg-surface-variant');
    }
  }

  if (toolbarColorTextInput) {
    const textColor = style && style.textColor ? style.textColor : '#000000';
    toolbarColorTextInput.value = textColor;
    setToolbarColorSwatch('text', textColor);
  }

  if (toolbarColorFillInput) {
    const fillColor = style && style.color ? style.color : '#ffffff';
    toolbarColorFillInput.value = fillColor;
    setToolbarColorSwatch('fill', fillColor);
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
    const name = fileNameEl.innerText.replace(/\s+/g, ' ').trim();
    // Revert to the previous name if left blank.
    const finalName = name || fileNameBeforeEdit;
    fileNameEl.innerText = finalName;
    // The browser tab stays branded "Co-Sheet"; the file name lives in the header.
    // Persist only when the name actually changed.
    if (finalName && finalName !== fileNameBeforeEdit) {
      persistFileName(finalName);
    }
  };

  fileNameEl.addEventListener('blur', commitFileName);
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

// Hook up toolbar border, alignment, and link buttons
const toolbarBorderBtn = document.getElementById('toolbar-border');
if (toolbarBorderBtn) {
  toolbarBorderBtn.addEventListener('click', (e) => {
    if (e) e.stopPropagation();
    const wasOpen = !!borderMenuEl;
    closeAllMenus();
    if (!wasOpen) openBorderMenu(toolbarBorderBtn);
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
  if (typeof closeBorderMenu === 'function') closeBorderMenu();
  if (typeof closeColorPalette === 'function') closeColorPalette();
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
    if (activeCellId) {
      const cell = localCells[activeCellId] || { formula: '', value: '', style: {} };
      const currentLink = cell.style && cell.style.link ? cell.style.link : '';
      const url = prompt('Enter link URL (e.g. https://google.com):', currentLink);
      if (url !== null) {
        changeCellLink(activeCellId, url);
      }
    }
  });
}

// Update the colored indicator bar shown under a color toolbar button.
const setToolbarColorSwatch = (which, hex) => {
  const swatch = document.getElementById(`toolbar-color-${which}-swatch`);
  if (swatch && swatch.style) swatch.style.backgroundColor = hex;
};

// Live-preview a color on the currently selected cell(s) without committing
// (no socket/history). Lets inline color pickers show the change as it's chosen.
const previewCellColor = (cssProp, hex) => {
  const selectedIds = getSelectedCellIds();
  const ids = selectedIds.length ? selectedIds : (activeCellId ? [activeCellId] : []);
  ids.forEach(id => {
    const el = document.querySelector(`[data-cell-id="${id}"]`);
    if (el) el.style[cssProp] = hex;
  });
};

// Hook up toolbar color pickers
const toolbarColorTextInput = document.getElementById('toolbar-color-text-input');
if (toolbarColorTextInput) {
  // Live feedback while the picker is open (immediate, no commit yet).
  toolbarColorTextInput.addEventListener('input', (e) => {
    setToolbarColorSwatch('text', e.target.value);
    if (activeCellId) previewCellColor('color', e.target.value);
  });
  // Commit the chosen color (syncs + records history).
  toolbarColorTextInput.addEventListener('change', (e) => {
    setToolbarColorSwatch('text', e.target.value);
    if (activeCellId) {
      changeCellTextColor(activeCellId, e.target.value);
    }
  });
}

const toolbarColorFillInput = document.getElementById('toolbar-color-fill-input');
if (toolbarColorFillInput) {
  toolbarColorFillInput.addEventListener('input', (e) => {
    setToolbarColorSwatch('fill', e.target.value);
    if (activeCellId) previewCellColor('backgroundColor', e.target.value);
  });
  toolbarColorFillInput.addEventListener('change', (e) => {
    setToolbarColorSwatch('fill', e.target.value);
    if (activeCellId) {
      changeCellColor(activeCellId, e.target.value);
    }
  });
}

// ---------------------------------------------------------------------------
// Google Sheets–style color palette popup (text & fill color).
// Clicking a toolbar color button opens a standard-color grid. "Reset"/"No fill"
// restores the default, and "Custom color" delegates to the hidden native
// <input type="color"> above — so custom colors still flow through the existing
// preview/commit listeners. Each swatch maps to changeCellTextColor / changeCellColor.
// ---------------------------------------------------------------------------
const STANDARD_COLORS = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
  ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
  ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
  ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
  ['#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47'],
  ['#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'],
];

let colorPaletteOutsideHandler = null;
let colorPaletteSheetTarget = null; // sheet name when the palette is opened for a tab color
const onColorPaletteKeydown = (e) => { if (e.key === 'Escape') closeColorPalette(); };

const closeColorPalette = () => {
  const existing = document.getElementById('color-palette-popup');
  if (existing) existing.remove();
  document.removeEventListener('keydown', onColorPaletteKeydown, true);
  if (colorPaletteOutsideHandler) {
    document.removeEventListener('click', colorPaletteOutsideHandler, true);
    colorPaletteOutsideHandler = null;
  }
};

// Commit a chosen color: update the toolbar indicator and apply to the selection.
const applyChosenColor = (type, hex) => {
  // Border pen color: store it for the next border action and update its swatch.
  if (type === 'border') {
    currentBorderColor = hex;
    const swatch = document.getElementById('border-color-swatch');
    if (swatch) swatch.style.backgroundColor = hex;
    return;
  }
  // Sheet-tab color: broadcast the change (hex === null clears it).
  if (type === 'sheet') {
    if (colorPaletteSheetTarget && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'color-sheet', payload: { sheetName: colorPaletteSheetTarget, color: hex } }));
    }
    return;
  }
  setToolbarColorSwatch(type, hex);
  if (!activeCellId) return;
  if (type === 'text') changeCellTextColor(activeCellId, hex);
  else changeCellColor(activeCellId, hex);
};

const openColorPalette = (type, anchorEl, options = {}) => {
  // Toggle closed if the same button's palette is already open.
  const existing = document.getElementById('color-palette-popup');
  const sameType = existing && existing.dataset.type === type;
  closeColorPalette();
  if (sameType) return;

  if (type === 'sheet') colorPaletteSheetTarget = options.sheetName || null;

  const popup = document.createElement('div');
  popup.id = 'color-palette-popup';
  popup.dataset.type = type;
  popup.className = 'fixed z-[1000] bg-surface-container-lowest dark:bg-inverse-surface border border-outline-variant rounded-lg shadow-lg p-3 select-none text-on-surface dark:text-on-surface-variant';

  // Reset semantics differ per target: fill -> white (no fill), sheet -> null
  // (clears the tab colour), text/border -> black.
  let resetLabel = t('color.reset');
  let resetHex = '#000000';
  if (type === 'fill') { resetLabel = t('color.noFill'); resetHex = '#ffffff'; }
  else if (type === 'sheet') { resetLabel = t('sheet.reset'); resetHex = null; }

  let gridHtml = '';
  STANDARD_COLORS.forEach((row) => {
    row.forEach((hex) => {
      gridHtml += `<button type="button" class="w-5 h-5 rounded-sm border border-black/10 hover:ring-2 hover:ring-primary hover:ring-offset-1" style="background-color:${hex}" data-hex="${hex}" title="${hex}"></button>`;
    });
  });

  popup.innerHTML = `
    <button type="button" id="color-reset" class="w-full flex items-center gap-2 px-2 py-1.5 mb-2 rounded hover:bg-surface-variant text-label-md">
      <span class="material-symbols-outlined text-[18px]">format_color_reset</span>
      <span>${resetLabel}</span>
    </button>
    <div class="text-xs font-medium text-on-surface-variant mb-1.5">${t('color.standard')}</div>
    <div class="grid grid-cols-10 gap-1">${gridHtml}</div>
    <div class="text-xs font-medium text-on-surface-variant mt-3 mb-1.5">${t('color.custom')}</div>
    <button type="button" id="color-custom" class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-variant text-label-md">
      <span class="material-symbols-outlined text-[18px]">add</span>
      <span>${t('color.customColor')}</span>
    </button>
  `;

  document.body.appendChild(popup);

  // Position relative to the anchor, clamped to the viewport. 'right' placement
  // (used by the sheet-tab menu) flies out to the side like a submenu; the
  // default drops down beneath the anchor button.
  const r = anchorEl.getBoundingClientRect();
  const pr = popup.getBoundingClientRect();
  if (options.placement === 'right') {
    // Side flyout: align the palette's bottom with the menu item so it grows
    // upward — the sheet-tab menu sits at the bottom of the screen, so a
    // downward popup would fall below the fold. Then clamp within the viewport.
    popup.style.left = `${r.right + 4}px`;
    let top = r.bottom - pr.height;
    top = Math.min(top, window.innerHeight - pr.height - 8);
    top = Math.max(8, top);
    popup.style.top = `${top}px`;
    // Flip to the left of the anchor if it would overflow the right edge.
    if (r.right + 4 + pr.width > window.innerWidth) {
      popup.style.left = `${Math.max(4, r.left - pr.width - 4)}px`;
    }
  } else {
    popup.style.left = `${r.left}px`;
    popup.style.top = `${r.bottom + 4}px`;
    if (r.left + pr.width > window.innerWidth) popup.style.left = `${Math.max(4, window.innerWidth - pr.width - 4)}px`;
    if (r.bottom + 4 + pr.height > window.innerHeight) popup.style.top = `${Math.max(4, window.innerHeight - pr.height - 4)}px`;
  }

  popup.querySelector('#color-reset').onclick = () => { applyChosenColor(type, resetHex); closeColorPalette(); };
  popup.querySelectorAll('[data-hex]').forEach((btn) => {
    btn.onclick = () => { applyChosenColor(type, btn.dataset.hex); closeColorPalette(); };
  });
  popup.querySelector('#color-custom').onclick = () => {
    closeColorPalette();
    let input = document.getElementById(`toolbar-color-${type}-input`);
    // text/fill have a hidden native input in the toolbar; create one on demand
    // for any other pen type (e.g. border) so custom colors still flow through.
    if (!input) {
      input = document.createElement('input');
      input.type = 'color';
      input.id = `toolbar-color-${type}-input`;
      input.style.display = 'none';
      input.addEventListener('input', (e) => applyChosenColor(type, e.target.value));
      document.body.appendChild(input);
    }
    input.click();
  };

  // Dismiss on Escape or click outside (deferred so the opening click doesn't close it).
  document.addEventListener('keydown', onColorPaletteKeydown, true);
  colorPaletteOutsideHandler = (ev) => {
    if (!popup.contains(ev.target) && !anchorEl.contains(ev.target)) closeColorPalette();
  };
  setTimeout(() => {
    if (colorPaletteOutsideHandler) document.addEventListener('click', colorPaletteOutsideHandler, true);
  }, 0);
};

const toolbarColorTextBtn = document.getElementById('toolbar-color-text');
if (toolbarColorTextBtn) {
  toolbarColorTextBtn.addEventListener('click', (e) => {
    if (e.target.closest('input')) return; // ignore the hidden native input
    e.preventDefault();
    const existing = document.getElementById('color-palette-popup');
    const wasOpenSame = !!existing && existing.dataset.type === 'text';
    closeAllMenus();
    if (!wasOpenSame) openColorPalette('text', toolbarColorTextBtn);
  });
}
const toolbarColorFillBtn = document.getElementById('toolbar-color-fill');
if (toolbarColorFillBtn) {
  toolbarColorFillBtn.addEventListener('click', (e) => {
    if (e.target.closest('input')) return;
    e.preventDefault();
    const existing = document.getElementById('color-palette-popup');
    const wasOpenSame = !!existing && existing.dataset.type === 'fill';
    closeAllMenus();
    if (!wasOpenSame) openColorPalette('fill', toolbarColorFillBtn);
  });
}

// ---------------------------------------------------------------------------
// Border menu (toolbar border button). A grid of border-application modes plus
// a border-color picker (reuses the color palette, pen type 'border') and a
// line-style submenu (thin/medium/thick/dashed/dotted/double). The chosen color
// + style are applied by applyBordersToSelection() when a mode button is clicked.
// ---------------------------------------------------------------------------
const BORDER_MENU_MODES = [
  { mode: 'all',        icon: 'border_all',        key: 'border.all' },
  { mode: 'inner',      icon: 'border_inner',      key: 'border.inner' },
  { mode: 'horizontal', icon: 'border_horizontal', key: 'border.horizontal' },
  { mode: 'vertical',   icon: 'border_vertical',   key: 'border.vertical' },
  { mode: 'outer',      icon: 'border_outer',      key: 'border.outer' },
  { mode: 'left',       icon: 'border_left',       key: 'border.left' },
  { mode: 'top',        icon: 'border_top',        key: 'border.top' },
  { mode: 'right',      icon: 'border_right',      key: 'border.right' },
  { mode: 'bottom',     icon: 'border_bottom',     key: 'border.bottom' },
  { mode: 'clear',      icon: 'border_clear',      key: 'border.clear' },
];
const BORDER_STYLE_OPTIONS = [
  { style: 'thin',   key: 'border.thin' },
  { style: 'medium', key: 'border.medium' },
  { style: 'thick',  key: 'border.thick' },
  { style: 'dashed', key: 'border.dashed' },
  { style: 'dotted', key: 'border.dotted' },
  { style: 'double', key: 'border.double' },
];

let borderMenuEl = null;
let borderMenuOutsideHandler = null;
let borderMenuKeydownHandler = null;
let borderStyleSubmenuEl = null;

const closeBorderStyleSubmenu = () => {
  if (borderStyleSubmenuEl) { borderStyleSubmenuEl.remove(); borderStyleSubmenuEl = null; }
};

const closeBorderMenu = () => {
  closeColorPalette();
  closeBorderStyleSubmenu();
  if (borderMenuOutsideHandler) {
    document.removeEventListener('click', borderMenuOutsideHandler, true);
    borderMenuOutsideHandler = null;
  }
  if (borderMenuKeydownHandler) {
    document.removeEventListener('keydown', borderMenuKeydownHandler, true);
    borderMenuKeydownHandler = null;
  }
  if (borderMenuEl) { borderMenuEl.remove(); borderMenuEl = null; }
};

// Clamp a popup to the viewport, anchored under (or above) the given rect.
const positionPopupUnder = (popup, anchorRect) => {
  popup.style.left = `${anchorRect.left}px`;
  popup.style.top = `${anchorRect.bottom + 4}px`;
  const pr = popup.getBoundingClientRect();
  if (pr.right > window.innerWidth) popup.style.left = `${Math.max(4, window.innerWidth - pr.width - 4)}px`;
  if (pr.bottom > window.innerHeight) popup.style.top = `${Math.max(4, anchorRect.top - pr.height - 4)}px`;
};

const openBorderStyleSubmenu = (anchorEl) => {
  const existing = borderStyleSubmenuEl;
  closeBorderStyleSubmenu();
  if (existing) return; // toggle closed

  const sub = document.createElement('div');
  borderStyleSubmenuEl = sub;
  sub.id = 'border-style-submenu';
  sub.className = 'fixed z-[1001] bg-surface-container-lowest dark:bg-inverse-surface border border-outline-variant rounded-lg shadow-lg py-1 select-none text-on-surface dark:text-on-surface-variant';

  let html = '';
  BORDER_STYLE_OPTIONS.forEach((o) => {
    const lineCss = BORDER_STYLE_CSS[o.style]('currentColor');
    const checkVis = o.style === currentBorderStyle ? 'visible' : 'hidden';
    html += `<button type="button" class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-variant text-label-md" data-style="${o.style}">
        <span class="material-symbols-outlined text-[16px]" style="visibility:${checkVis}">check</span>
        <span class="block w-12" style="border-top:${lineCss}"></span>
        <span class="flex-1 text-left whitespace-nowrap">${t(o.key)}</span>
      </button>`;
  });
  sub.innerHTML = html;
  document.body.appendChild(sub);
  positionPopupUnder(sub, anchorEl.getBoundingClientRect());

  sub.querySelectorAll('[data-style]').forEach((btn) => {
    btn.onclick = () => {
      currentBorderStyle = btn.dataset.style;
      const preview = document.getElementById('border-style-preview');
      if (preview) preview.style.borderTop = BORDER_STYLE_CSS[currentBorderStyle]('currentColor');
      closeBorderStyleSubmenu();
    };
  });
};

const openBorderMenu = (anchorEl) => {
  const existing = borderMenuEl;
  closeBorderMenu();
  if (existing) return; // toggle closed when re-clicking the toolbar button

  const menu = document.createElement('div');
  borderMenuEl = menu;
  menu.id = 'border-menu-popup';
  menu.className = 'fixed z-[1000] bg-surface-container-lowest dark:bg-inverse-surface border border-outline-variant rounded-lg shadow-lg p-2 select-none text-on-surface dark:text-on-surface-variant';

  const btnCls = 'flex items-center justify-center w-9 h-9 rounded hover:bg-surface-variant cursor-pointer';
  let gridHtml = '';
  BORDER_MENU_MODES.forEach((m) => {
    gridHtml += `<button type="button" class="${btnCls}" data-mode="${m.mode}" title="${t(m.key)}"><span class="material-symbols-outlined text-[20px]">${m.icon}</span></button>`;
  });
  const styleLineCss = BORDER_STYLE_CSS[currentBorderStyle]('currentColor');

  menu.innerHTML = `
    <div class="flex items-stretch gap-2">
      <div class="grid grid-cols-5 gap-0.5">${gridHtml}</div>
      <div class="w-px bg-outline-variant self-stretch"></div>
      <div class="flex flex-col justify-center gap-1">
        <button type="button" id="border-color-btn" class="flex items-center gap-1 px-2 h-9 rounded hover:bg-surface-variant cursor-pointer" title="${t('border.color')}">
          <span class="material-symbols-outlined text-[20px]">border_color</span>
          <span id="border-color-swatch" class="block w-4 h-1 rounded-sm" style="background-color:${currentBorderColor}"></span>
          <span class="material-symbols-outlined text-[18px] ml-auto">arrow_drop_down</span>
        </button>
        <button type="button" id="border-style-btn" class="flex items-center gap-1 px-2 h-9 rounded hover:bg-surface-variant cursor-pointer" title="${t('border.style')}">
          <span class="material-symbols-outlined text-[20px]">line_weight</span>
          <span id="border-style-preview" class="block w-6" style="border-top:${styleLineCss}"></span>
          <span class="material-symbols-outlined text-[18px] ml-auto">arrow_drop_down</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(menu);
  positionPopupUnder(menu, anchorEl.getBoundingClientRect());

  menu.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.onclick = () => { applyBordersToSelection(btn.dataset.mode); closeBorderMenu(); };
  });
  menu.querySelector('#border-color-btn').onclick = (e) => {
    e.stopPropagation();
    closeBorderStyleSubmenu();
    openColorPalette('border', menu.querySelector('#border-color-btn'));
  };
  menu.querySelector('#border-style-btn').onclick = (e) => {
    e.stopPropagation();
    closeColorPalette();
    openBorderStyleSubmenu(menu.querySelector('#border-style-btn'));
  };

  borderMenuKeydownHandler = (ev) => { if (ev.key === 'Escape') closeBorderMenu(); };
  document.addEventListener('keydown', borderMenuKeydownHandler, true);
  // Close when clicking outside the menu and its child popups (color palette / style submenu).
  borderMenuOutsideHandler = (ev) => {
    const palette = document.getElementById('color-palette-popup');
    if (menu.contains(ev.target)) return;
    if (anchorEl.contains(ev.target)) return;
    if (palette && palette.contains(ev.target)) return;
    if (borderStyleSubmenuEl && borderStyleSubmenuEl.contains(ev.target)) return;
    closeBorderMenu();
  };
  setTimeout(() => {
    if (borderMenuOutsideHandler) document.addEventListener('click', borderMenuOutsideHandler, true);
  }, 0);
};

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
      arrowSpan.className = 'material-symbols-outlined text-[16px] ml-1 cursor-pointer select-none';
      arrowSpan.innerText = 'arrow_drop_down';
      arrowSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        switchSheet(sheetName);
        showSheetContextMenu(sheetName, e.clientX, e.clientY);
      });
      tab.appendChild(arrowSpan);
    }

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
 * @param {number} y - Click y coordinate.
 */
const showSheetContextMenu = (sheetName, x, y) => {
  // Dismiss any existing context menus first
  const existing = document.getElementById('sheet-context-menu');
  if (existing) existing.remove();
  
  const menu = document.createElement('div');
  menu.id = 'sheet-context-menu';
  menu.className = 'fixed bg-surface-container-lowest dark:bg-inverse-surface shadow-lg rounded py-1 z-[1000] border border-outline-variant text-label-md text-on-surface dark:text-on-surface-variant w-48';
  
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
    openColorPalette('sheet', colorOpt, { placement: 'right', sheetName });
  };
  colorOpt.addEventListener('mouseenter', openSheetColorPalette);
  colorOpt.addEventListener('click', (e) => { e.stopPropagation(); openSheetColorPalette(); });
  menu.appendChild(colorOpt);

  // Close the colour flyout when the pointer moves onto a different menu item.
  menu.addEventListener('mouseover', (e) => {
    if (colorOpt.contains(e.target)) return;
    const p = document.getElementById('color-palette-popup');
    if (p && p.dataset.type === 'sheet') closeColorPalette();
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
    closeColorPalette();
    document.removeEventListener('click', dismiss);
  };
  // Timeout prevents triggering dismiss on this immediate click event
  setTimeout(() => document.addEventListener('click', dismiss), 50);
};

/**
 * Switches the active spreadsheet sheet and re-renders the grid.
 * @param {string} sheetName - The sheet name to switch to.
 */
const switchSheet = (sheetName) => {
  if (activeSheetName === sheetName) return;
  
  // Clear selection state
  if (activeCellId) {
    clearRangeSelection();
    activeCellId = null;
  }
  
  activeSheetName = sheetName;
  renderSheetTabs();
  renderSpreadsheetGrid();
  
  if (isHistoryMode) return;

  // Send cursor movement update with new sheet name
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'cursor-move',
      payload: { cellId: null, sheetName: activeSheetName }
    }));
  }
  
  // Render remote collaborator cursors for the active sheet
  Object.keys(remoteCursors).forEach(id => {
    const cursor = remoteCursors[id];
    if (cursor.activeSheet === activeSheetName) {
      renderCursorBorder(cursor);
    }
  });

  // Reset formatting bar UI
  updateToolbarFormattingStates({});
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

  localSheets[name] = Object.create(null);
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
  isSelecting = false;
  pointAnchorCellId = null; // stop point-mode drag extension; pending ref is kept
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
    if (willOpen) menuFormatDropdown.classList.remove('hidden');
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

  // Build the Font size submenu (same presets as the toolbar control).
  const fontSizeList = document.getElementById('fmt-fontsize-list');
  if (fontSizeList && !fontSizeList.childElementCount) {
    [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36].forEach((sz) => {
      const b = document.createElement('button');
      b.className = 'block w-full px-4 py-1.5 text-left hover:bg-surface-variant text-label-md text-on-surface-variant';
      b.textContent = sz;
      b.addEventListener('click', (e) => { e.stopPropagation(); act((id) => setCellFontSize(id, sz)); });
      fontSizeList.appendChild(b);
    });
  }

  // Number formats
  wireFmt('fmt-num-auto',             () => act((id) => setCellNumberFormat(id, null)));
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
}

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
    sortDataRows(colIndex, ascending, (frozenRows || 0) + 1);
    menuDataDropdown.classList.add('hidden');
  };

  menuDataBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menuDataDropdown.classList.contains('hidden');
    closeAllMenus();
    if (willOpen) {
      menuDataDropdown.classList.remove('hidden');
      updateDataSortMenu();
      updateDataFilterLabel();
    }
  });

  // The Create-filter entry toggles a value filter on the active cell's column;
  // while one is active on the sheet it removes it instead.
  const createFilterBtn = document.getElementById('data-create-filter');
  if (createFilterBtn) createFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menuDataDropdown.classList.add('hidden');
    if (sheetFilters[activeSheetName]) removeSheetFilter();
    else createSheetFilter(sortColIndex());
  });

  const azBtn = document.getElementById('data-sort-az');
  const zaBtn = document.getElementById('data-sort-za');
  if (azBtn) azBtn.addEventListener('click', (e) => { e.stopPropagation(); performSheetSort(sortColIndex(), true); });
  if (zaBtn) zaBtn.addEventListener('click', (e) => { e.stopPropagation(); performSheetSort(sortColIndex(), false); });
}

// ───────────────────────────────────────────────────────────────────────────
// Sorting & value filter (Data ▸ Sort sheet / Create a filter).
//
// These are module-scope function declarations (hoisted) so renderSpreadsheetGrid
// can call applyFilter() before this point in source order, and so the Data menu
// block above and the funnel-icon menu below can share the same sort core.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compares two sort keys: numeric when both parse as numbers, otherwise a
 * locale-aware string compare. Blanks always sink to the bottom regardless of
 * direction (matching spreadsheet "Sort sheet" behaviour).
 */
function compareSortKeys(a, b, ascending) {
  const aEmpty = a === '' || a == null;
  const bEmpty = b === '' || b == null;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const aStr = String(a), bStr = String(b);
  const aNum = Number(aStr), bNum = Number(bStr);
  let cmp;
  if (aStr.trim() !== '' && bStr.trim() !== '' && !isNaN(aNum) && !isNaN(bNum)) {
    cmp = aNum - bNum;
  } else {
    cmp = aStr.localeCompare(bStr);
  }
  return ascending ? cmp : -cmp;
}

/**
 * Reorders the populated data rows from `startRow` downward by the given column,
 * packing them contiguously from `startRow` (blank rows fall to the bottom).
 * Whole rows move together; cell contents/styles are carried verbatim. Diffs
 * against the current state and uses the same apply/broadcast/undo path as the
 * Insert menu, so collaborators and the undo stack stay in sync.
 * @returns {boolean} whether anything changed.
 */
function sortDataRows(colIndex, ascending, startRow) {
  if (!canEditWorkbook || isHistoryMode) return false;

  // Group the populated cells of each sortable row, keyed by row number.
  const rowMap = new Map(); // row -> { [colLetter]: cellCopy }
  Object.keys(localCells).forEach((id) => {
    const coord = parseCellCoord(id);
    if (!coord || coord.row < startRow) return;
    const cell = localCells[id];
    const blank = !cell || (!cell.formula && (cell.value === '' || cell.value == null) &&
      (!cell.style || Object.keys(cell.style).length === 0));
    if (blank) return;
    if (!rowMap.has(coord.row)) rowMap.set(coord.row, {});
    rowMap.get(coord.row)[coord.colLetter] = JSON.parse(JSON.stringify(cell));
  });
  if (rowMap.size === 0) return false;

  // Sort the rows by the chosen column's evaluated value.
  const sortColLetter = getColLetter(colIndex);
  const rows = [...rowMap.entries()].map(([row, cells]) => ({
    cells,
    key: getCellValue(`${sortColLetter}${row}`)
  }));
  rows.sort((a, b) => compareSortKeys(a.key, b.key, ascending));

  // Lay the sorted rows out contiguously starting at startRow.
  const newState = {};
  rows.forEach((r, i) => {
    const targetRow = startRow + i;
    Object.keys(r.cells).forEach((colLetter) => {
      newState[`${colLetter}${targetRow}`] = r.cells[colLetter];
    });
  });

  // Diff against the current state.
  const EMPTY = { formula: '', value: '', style: {} };
  const oldIds = Object.keys(localCells).filter((id) => {
    const coord = parseCellCoord(id);
    return coord && coord.row >= startRow;
  });
  const before = {};
  oldIds.forEach((id) => { before[id] = JSON.parse(JSON.stringify(localCells[id])); });
  const affected = new Set([...oldIds, ...Object.keys(newState)]);
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
  return changes.length > 0;
}

// The filter's first ("header") row is the first non-frozen row: it hosts the
// funnel and is never hidden or sorted. Data rows are everything below it.
function filterHeaderRow() { return (frozenRows || 0) + 1; }

// The bottom of the filter's scope: the last row holding any populated cell on
// the active sheet (the used range), clamped to at least the header row.
function filterLastRow() {
  let max = filterHeaderRow();
  Object.keys(localCells).forEach((id) => {
    const coord = parseCellCoord(id);
    if (!coord) return;
    const cell = localCells[id];
    const blank = !cell || (!cell.formula && (cell.value === '' || cell.value == null) &&
      (!cell.style || Object.keys(cell.style).length === 0));
    if (!blank && coord.row > max) max = coord.row;
  });
  return max;
}

// Stable per-cell value key: '__BLANK__' for empties, the string value otherwise.
function filterValueKey(val) {
  return (val === '' || val == null) ? '__BLANK__' : String(val);
}

// Swap the Create-filter menu label to "Remove filter" while a filter is active.
function updateDataFilterLabel() {
  const label = document.getElementById('data-create-filter-label');
  if (!label) return;
  const active = !!sheetFilters[activeSheetName];
  label.textContent = t(active ? 'data.removeFilter' : 'data.createFilter');
}

// Filters are local view state (never broadcast), so they survive reloads via
// localStorage rather than the workbook. Key by file id so each spreadsheet
// keeps its own filters; the hidden Set is stored as an array (Sets don't
// survive JSON).
const FILTERS_STORAGE_KEY = `co-sheet-filters:${currentFileId || 'default'}`;

function saveSheetFilters() {
  try {
    const out = Object.create(null);
    for (const name of Object.keys(sheetFilters)) {
      const f = sheetFilters[name];
      out[name] = { colIndex: f.colIndex, hidden: Array.from(f.hidden) };
    }
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(out));
  } catch (err) {}
}

// Restore persisted filters into sheetFilters. Called once on init before the
// first render so applyFilter() can paint them.
function loadSheetFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    sheetFilters = Object.create(null);
    for (const name of Object.keys(parsed)) {
      const f = parsed[name];
      if (!f || typeof f.colIndex !== 'number') continue;
      sheetFilters[name] = {
        colIndex: f.colIndex,
        hidden: new Set(Array.isArray(f.hidden) ? f.hidden : [])
      };
    }
  } catch (err) {}
}

// Create a value filter on the given column (all values initially shown), then
// re-render so the funnel/scope tint appear.
function createSheetFilter(colIndex) {
  if (isHistoryMode) return;
  sheetFilters[activeSheetName] = { colIndex, hidden: new Set() };
  saveSheetFilters();
  closeFilterMenu();
  renderSpreadsheetGrid();
}

// Remove the active sheet's filter and re-render (rows reappear, tint/funnel go).
function removeSheetFilter() {
  delete sheetFilters[activeSheetName];
  saveSheetFilters();
  closeFilterMenu();
  renderSpreadsheetGrid();
}

// Sort only the filter's data rows (header row stays put) by the filtered column.
function performFilterSort(colIndex, ascending) {
  sortDataRows(colIndex, ascending, filterHeaderRow() + 1);
}

/**
 * Paints the active sheet's value filter onto the freshly rendered grid: tints
 * the filtered column header and the row headers across the filter scope, drops
 * the funnel icon on the column's first cell, and hides rows whose value in the
 * filtered column is currently excluded. No-op in history mode or with no filter.
 */
function applyFilter() {
  if (isHistoryMode) return;
  const f = sheetFilters[activeSheetName];
  if (!f) return;
  const gridRoot = document.getElementById('grid-root');
  if (!gridRoot) return;

  const colLetter = getColLetter(f.colIndex);
  const headerRow = filterHeaderRow();
  const lastRow = filterLastRow();

  // Scope tint: the filtered column header plus EVERY row header from the filter
  // header row down. The filter was created from a full-column selection, so it
  // covers the whole column — tint all rendered row headers (not just the
  // populated range) so the scope reads as the entire column.
  const colHeader = gridRoot.querySelector(`[data-col-id="${colLetter}"]`);
  if (colHeader) colHeader.classList.add('filter-col-header');
  gridRoot.querySelectorAll('[data-row-id]').forEach((rh) => {
    const r = parseInt(rh.getAttribute('data-row-id'), 10);
    if (r >= headerRow) rh.classList.add('filter-row-header');
  });

  // Green left/right edges on every cell of the filtered column (from the header
  // row down), so the column is easy to identify. Columns are single letters, so
  // the cell-id prefix matches exactly that column; the coord check is a guard.
  gridRoot.querySelectorAll(`[data-cell-id^="${colLetter}"]`).forEach((cellEl) => {
    const coord = parseCellCoord(cellEl.getAttribute('data-cell-id'));
    if (coord && coord.colIndex === f.colIndex && coord.row >= headerRow) {
      cellEl.classList.add('filter-col-cell');
    }
  });

  // Funnel icon on the column's first cell; click opens the filter menu.
  const headerCell = gridRoot.querySelector(`[data-cell-id="${colLetter}${headerRow}"]`);
  if (headerCell) {
    const icon = document.createElement('span');
    icon.className = 'filter-icon material-symbols-outlined';
    icon.textContent = 'filter_alt';
    icon.title = t('filter.byValue');
    icon.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    icon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFilterMenu(f.colIndex, icon);
    });
    headerCell.appendChild(icon);
  }

  // Hide data rows whose filtered-column value is excluded. A row is hidden by
  // collapsing its row header and all 26 cells, so the remaining rows reflow
  // cleanly within the fixed 27-track grid (row numbers stay as gaps).
  if (f.hidden.size) {
    for (let r = headerRow + 1; r <= lastRow; r++) {
      const key = filterValueKey(getCellValue(`${colLetter}${r}`));
      if (!f.hidden.has(key)) continue;
      const rh = gridRoot.querySelector(`[data-row-id="${r}"]`);
      if (rh) rh.style.display = 'none';
      for (let c = 0; c < 26; c++) {
        const cellEl = gridRoot.querySelector(`[data-cell-id="${getColLetter(c)}${r}"]`);
        if (cellEl) cellEl.style.display = 'none';
      }
    }
  }
}

// The currently-open filter menu element and its outside-click handler, so we
// can tear them down cleanly. Only one filter menu is ever open at a time.
let filterMenuEl = null;
let filterMenuDismiss = null;

function closeFilterMenu() {
  if (filterMenuDismiss) {
    document.removeEventListener('mousedown', filterMenuDismiss, true);
    document.removeEventListener('keydown', filterMenuDismiss, true);
    filterMenuDismiss = null;
  }
  if (filterMenuEl && filterMenuEl.parentNode) filterMenuEl.parentNode.removeChild(filterMenuEl);
  filterMenuEl = null;
}

/**
 * Builds and shows the filter dropdown (matching images/data/filter_setting.png)
 * for the given column, anchored under `anchorEl`. Wired: A→Z / Z→A sort and the
 * "Filter by values" checklist (with search, select-all/clear, OK/Cancel).
 * Sort-by-color, filter-by-color and filter-by-condition are greyed out.
 */
function showFilterMenu(colIndex, anchorEl) {
  closeFilterMenu();
  const f = sheetFilters[activeSheetName];
  if (!f) return;

  const colLetter = getColLetter(colIndex);
  const headerRow = filterHeaderRow();
  const lastRow = filterLastRow();

  // Distinct values across the data rows, with occurrence counts.
  const seen = new Map(); // key -> { key, display, count }
  for (let r = headerRow + 1; r <= lastRow; r++) {
    const val = getCellValue(`${colLetter}${r}`);
    const key = filterValueKey(val);
    if (!seen.has(key)) {
      seen.set(key, { key, display: key === '__BLANK__' ? t('filter.blank') : String(val), count: 0 });
    }
    seen.get(key).count++;
  }
  const values = [...seen.values()].sort((a, b) => {
    if (a.key === '__BLANK__') return 1;
    if (b.key === '__BLANK__') return -1;
    return compareSortKeys(a.display, b.display, true);
  });

  const menu = document.createElement('div');
  menu.id = 'filter-menu';
  menu.className = 'fixed bg-surface-container-lowest dark:bg-inverse-surface border border-outline-variant rounded-lg shadow-xl py-1 w-72 z-[1100] text-on-surface dark:text-on-surface-variant';
  const itemCls = 'flex items-center gap-3 w-full px-4 py-2 text-left text-label-lg hover:bg-surface-variant';
  const disabledCls = 'flex items-center justify-between gap-3 w-full px-4 py-2 text-label-lg text-outline opacity-50 cursor-default select-none';
  const iconCls = 'material-symbols-outlined text-[18px]';

  menu.innerHTML = `
    <button class="${itemCls}" data-act="sort-az">
      <span class="${iconCls}">arrow_downward</span><span>${escapeHtml(t('filter.sortAsc'))}</span>
    </button>
    <button class="${itemCls}" data-act="sort-za">
      <span class="${iconCls}">arrow_upward</span><span>${escapeHtml(t('filter.sortDesc'))}</span>
    </button>
    <div class="${disabledCls}">
      <span class="flex items-center gap-3"><span class="${iconCls}">palette</span><span>${escapeHtml(t('filter.sortByColor'))}</span></span>
      <span class="${iconCls}">chevron_right</span>
    </div>
    <div class="border-t border-outline-variant my-1"></div>
    <div class="${disabledCls}">
      <span class="flex items-center gap-3"><span class="${iconCls}">format_color_fill</span><span>${escapeHtml(t('filter.filterByColor'))}</span></span>
      <span class="${iconCls}">chevron_right</span>
    </div>
    <div class="${disabledCls}">
      <span class="flex items-center gap-3"><span class="${iconCls}">arrow_right</span><span>${escapeHtml(t('filter.byCondition'))}</span></span>
    </div>
    <div class="flex items-center gap-3 w-full px-4 py-2 text-label-lg text-on-surface-variant">
      <span class="${iconCls}">arrow_drop_down</span><span>${escapeHtml(t('filter.byValue'))}</span>
    </div>
    <div class="flex items-center justify-between px-4 pb-1 text-body-sm">
      <span><a href="#" data-act="select-all" class="text-blue-600 hover:underline">${escapeHtml(t('filter.selectAll', { n: values.length }))}</a> · <a href="#" data-act="clear" class="text-blue-600 hover:underline">${escapeHtml(t('filter.clear'))}</a></span>
      <span class="text-on-surface-variant" data-role="showing"></span>
    </div>
    <div class="px-4 py-1">
      <div class="flex items-center gap-2 border border-outline-variant rounded px-2 py-1">
        <input type="text" data-role="search" placeholder="${escapeHtml(t('filter.search'))}" class="flex-grow bg-transparent outline-none text-body-md" />
        <span class="${iconCls} text-on-surface-variant">search</span>
      </div>
    </div>
    <div data-role="list" class="max-h-44 overflow-y-auto px-2 py-1"></div>
    <div class="border-t border-outline-variant my-1"></div>
    <div class="flex items-center justify-end gap-2 px-4 py-2">
      <button data-act="cancel" class="px-4 py-1.5 rounded-full text-label-lg text-blue-600 hover:bg-surface-variant">${escapeHtml(t('filter.cancel'))}</button>
      <button data-act="ok" class="px-4 py-1.5 rounded-full text-label-lg bg-green-700 text-white hover:bg-green-800">${escapeHtml(t('filter.ok'))}</button>
    </div>
  `;

  // Populate the value checklist. A value starts checked unless it is in the
  // filter's current hidden set.
  const list = menu.querySelector('[data-role="list"]');
  values.forEach((v) => {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-variant cursor-pointer text-label-lg';
    label.setAttribute('data-display', v.display.toLowerCase());
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'filter-val accent-green-700';
    cb.setAttribute('data-key', v.key);
    cb.checked = !f.hidden.has(v.key);
    const span = document.createElement('span');
    span.className = 'flex-grow truncate';
    span.textContent = v.display;
    label.appendChild(cb);
    label.appendChild(span);
    list.appendChild(label);
  });

  const showingEl = menu.querySelector('[data-role="showing"]');
  const checkboxes = () => [...menu.querySelectorAll('.filter-val')];
  const refreshShowing = () => {
    let shown = 0;
    checkboxes().forEach((cb) => {
      if (cb.checked) {
        const entry = seen.get(cb.getAttribute('data-key'));
        shown += entry ? entry.count : 0;
      }
    });
    showingEl.textContent = t('filter.showing', { n: shown });
  };
  refreshShowing();

  // Position under the funnel, clamped to the viewport.
  document.body.appendChild(menu);
  const a = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = a.left;
  let top = a.bottom + 4;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, a.top - mh - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  filterMenuEl = menu;

  // Interactions.
  menu.addEventListener('change', (e) => {
    if (e.target && e.target.classList.contains('filter-val')) refreshShowing();
  });
  menu.addEventListener('input', (e) => {
    if (!e.target || e.target.getAttribute('data-role') !== 'search') return;
    const q = e.target.value.trim().toLowerCase();
    list.querySelectorAll('label').forEach((lbl) => {
      lbl.style.display = lbl.getAttribute('data-display').includes(q) ? '' : 'none';
    });
  });
  menu.addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.getAttribute('data-act');
    if (act === 'select-all' || act === 'clear') {
      e.preventDefault();
      // Only toggle the rows currently visible under the search filter.
      list.querySelectorAll('label').forEach((lbl) => {
        if (lbl.style.display === 'none') return;
        const cb = lbl.querySelector('.filter-val');
        if (cb) cb.checked = (act === 'select-all');
      });
      refreshShowing();
    } else if (act === 'sort-az') {
      closeFilterMenu();
      performFilterSort(colIndex, true);
    } else if (act === 'sort-za') {
      closeFilterMenu();
      performFilterSort(colIndex, false);
    } else if (act === 'cancel') {
      closeFilterMenu();
    } else if (act === 'ok') {
      const hidden = new Set();
      checkboxes().forEach((cb) => { if (!cb.checked) hidden.add(cb.getAttribute('data-key')); });
      f.hidden = hidden;
      saveSheetFilters();
      closeFilterMenu();
      renderSpreadsheetGrid();
    }
  });

  // Dismiss on outside click or Escape (treated as Cancel).
  filterMenuDismiss = (e) => {
    if (e.type === 'keydown') { if (e.key === 'Escape') closeFilterMenu(); return; }
    if (!menu.contains(e.target) && e.target !== anchorEl) closeFilterMenu();
  };
  document.addEventListener('mousedown', filterMenuDismiss, true);
  document.addEventListener('keydown', filterMenuDismiss, true);

  const search = menu.querySelector('[data-role="search"]');
  if (search) search.focus();
}

// Language switcher: toggle menu, apply selection, persist choice (Chinese default)
const langSwitchBtn = document.getElementById('lang-switch-btn');
const langSwitchMenu = document.getElementById('lang-switch-menu');
const langSwitchLabel = document.getElementById('lang-switch-label');
const LANG_LABELS = { zh: '中文', en: 'English' };

const applyLanguageSelection = (lang) => {
  if (!LANG_LABELS[lang]) lang = 'zh';
  if (langSwitchLabel) langSwitchLabel.textContent = LANG_LABELS[lang];
  document.querySelectorAll('#lang-switch-menu .lang-option').forEach((opt) => {
    const check = opt.querySelector('.lang-check');
    if (check) check.classList.toggle('hidden', opt.dataset.lang !== lang);
  });
  translatePage(lang);
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
    { btn: 'toolbar-border',         isOpen: () => !!borderMenuEl },
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
    let top = r.bottom + margin;
    if (top + t.height > window.innerHeight - 4) {
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

// Bind find next button
const findBtn = document.getElementById('find-btn');
if (findBtn) {
  findBtn.onclick = findNextMatch;
}

// Bind replace current button
const replaceBtn = document.getElementById('replace-btn');
if (replaceBtn) {
  replaceBtn.onclick = replaceCurrentMatch;
}

// Bind replace all button
const replaceAllBtn = document.getElementById('replace-all-btn');
if (replaceAllBtn) {
  replaceAllBtn.onclick = replaceAllMatches;
}

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

/**
 * Localized date formatter for version grouping.
 * @param {string|Date} dateStr - Timestamp.
 * @returns {string} The group header.
 */
const formatVersionGroup = (dateStr) => {
  const date = new Date(dateStr);
  const now = new Date();
  
  const dMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  
  const diffDays = Math.round((nowMidnight - dMidnight) / oneDay);
  
  if (diffDays === 0) {
    return '今天';
  } else if (diffDays === 1) {
    return '昨天';
  } else if (diffDays > 1 && diffDays < 7) {
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return weekdays[date.getDay()];
  } else {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
};

/**
 * Localized time formatter for individual version entries.
 * @param {string|Date} dateStr - Timestamp.
 * @returns {string} Formatted localized time string.
 */
const formatVersionTime = (dateStr) => {
  const date = new Date(dateStr);
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  
  let period = '';
  let displayHours = hours;
  
  if (hours >= 0 && hours < 5) {
    period = '凌晨';
  } else if (hours >= 5 && hours < 8) {
    period = '清晨';
  } else if (hours >= 8 && hours < 11) {
    period = '早上';
  } else if (hours >= 11 && hours < 13) {
    period = '中午';
  } else if (hours >= 13 && hours < 17) {
    period = '下午';
    if (hours > 12) displayHours = hours - 12;
  } else if (hours >= 17 && hours < 19) {
    period = '傍晚';
    if (hours > 12) displayHours = hours - 12;
  } else {
    period = '晚上';
    if (hours > 12) displayHours = hours - 12;
  }
  
  if (displayHours === 0) displayHours = 12;
  
  return `${date.getMonth() + 1}月${date.getDate()}日，${period}${displayHours}:${minutes}`;
};

/**
 * Renders the versions list in the right sidebar panel, grouped by date.
 */
const renderVersionsList = () => {
  const listContainer = document.getElementById('history-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  const groups = {};
  versionsList.forEach((version, index) => {
    const groupName = formatVersionGroup(version.created_at);
    if (!groups[groupName]) {
      groups[groupName] = [];
    }
    groups[groupName].push({ version, index });
  });

  Object.keys(groups).forEach(groupName => {
    const headerEl = document.createElement('div');
    headerEl.className = 'px-4 py-2 bg-gray-50 dark:bg-surface-variant text-[11px] font-bold text-gray-500 dark:text-outline uppercase tracking-wider select-none';
    headerEl.innerText = groupName;
    listContainer.appendChild(headerEl);

    groups[groupName].forEach(({ version, index }) => {
      const itemEl = document.createElement('div');
      
      const isSelected = selectedVersionState && selectedVersionState.id === version.id;
      const isActiveVersion = index === 0;
      
      itemEl.className = `p-4 border-l-4 cursor-pointer relative transition-colors ${
        isSelected
          ? 'bg-blue-50/50 dark:bg-secondary/10 border-primary'
          : 'hover:bg-gray-50 dark:hover:bg-surface-variant border-transparent'
      }`;

      const timeStr = formatVersionTime(version.created_at);
      
      itemEl.innerHTML = `
        <div class="flex items-start justify-between">
          <div class="flex items-center space-x-2">
            <span class="material-symbols-outlined text-gray-400 text-sm">chevron_right</span>
            <div class="text-sm ${isSelected ? 'font-semibold text-gray-900 dark:text-inverse-on-surface' : 'text-gray-700 dark:text-outline'}">${timeStr}</div>
          </div>
        </div>
        ${isActiveVersion ? '<div class="ml-6 mt-1 text-xs text-gray-500 dark:text-outline">目前版本</div>' : ''}
        <div class="ml-6 mt-2 flex items-center space-x-2">
          <span class="w-2 h-2 rounded-full bg-[#009688]"></span>
          <span class="text-xs text-gray-600 dark:text-outline">${escapeHtml(version.created_by)}</span>
        </div>
      `;

      itemEl.addEventListener('click', () => {
        selectVersion(version.id);
      });

      listContainer.appendChild(itemEl);
    });
  });
};

/**
 * Loads details for a selected version from the API, fetches its preceding version to compute diffs,
 * and triggers grid re-rendering.
 * @param {number} versionId - The version ID.
 */
const selectVersion = async (versionId) => {
  try {
    const res = await fetch(`/api/versions/${versionId}`);
    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }
    const versionData = await res.json();
    selectedVersionState = versionData;
    
    const index = versionsList.findIndex(v => v.id === versionId);
    
    if (index !== -1 && index + 1 < versionsList.length) {
      const prevVersion = versionsList[index + 1];
      const prevRes = await fetch(`/api/versions/${prevVersion.id}`);
      previousVersionState = await prevRes.json();
    } else {
      previousVersionState = null;
    }
    
    const selectedVersionInfo = versionsList[index];
    if (selectedVersionInfo) {
      const titleDateEl = document.getElementById('history-title-date');
      if (titleDateEl) {
        titleDateEl.innerText = formatVersionTime(selectedVersionInfo.created_at);
      }
    }
    
    const restoreBtn = document.getElementById('history-restore-btn');
    if (restoreBtn) {
      if (index === 0) {
        restoreBtn.classList.add('hidden');
      } else {
        restoreBtn.classList.remove('hidden');
      }
    }
    
    renderVersionsList();
    renderSpreadsheetGrid();
  } catch (err) {
    console.error('Failed to load version details:', err);
  }
};

/**
 * Restores the active workbook state to the currently previewed history version.
 */
const restoreVersion = async () => {
  if (!selectedVersionState || !selectedVersionState.id) return;
  try {
    const res = await fetch(`/api/versions/${selectedVersionState.id}/restore`, {
      method: 'POST'
    });
    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }
    const data = await res.json();
    if (data.success) {
      toggleHistoryMode(false);
    } else {
      alert('無法還原此版本');
    }
  } catch (err) {
    console.error('Error during version restoration:', err);
    alert('還原版本時發生錯誤');
  }
};

/**
 * Toggles the application between edit mode and read-only history preview mode.
 * @param {boolean} enabled - True to enable history mode, false to disable.
 */
const toggleHistoryMode = async (enabled) => {
  isHistoryMode = enabled;

  const normalHeader = document.querySelector('header');
  const utilityShelf = document.querySelector('aside:not(#history-sidebar)');
  const bottomFooter = document.querySelector('footer');
  const mainContent = document.querySelector('main');
  
  const historyTopBar = document.getElementById('history-top-bar');
  const historySidebar = document.getElementById('history-sidebar');

  if (enabled) {
    if (normalHeader) normalHeader.classList.add('hidden');
    if (utilityShelf) utilityShelf.classList.add('hidden');
    
    if (historyTopBar) historyTopBar.classList.remove('hidden');
    if (historySidebar) historySidebar.classList.remove('hidden');

    if (mainContent) {
      mainContent.classList.remove('mr-[48px]');
      mainContent.classList.add('mr-[320px]');
    }

    try {
      const res = await fetch('/api/versions');
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      versionsList = await res.json();
      
      if (versionsList.length > 0) {
        await selectVersion(versionsList[0].id);
      } else {
        selectedVersionState = null;
        previousVersionState = null;
        renderSpreadsheetGrid();
      }
    } catch (err) {
      console.error('Failed to fetch version history:', err);
    }
  } else {
    if (normalHeader) normalHeader.classList.remove('hidden');
    if (utilityShelf) utilityShelf.classList.remove('hidden');
    
    if (historyTopBar) historyTopBar.classList.add('hidden');
    if (historySidebar) historySidebar.classList.add('hidden');

    if (mainContent) {
      mainContent.classList.remove('mr-[320px]');
      mainContent.classList.add('mr-[48px]');
    }

    selectedVersionState = null;
    previousVersionState = null;

    renderSpreadsheetGrid();
    if (typeof renderSheetTabs === 'function') {
      renderSheetTabs();
    }
  }
};

// Bind Version History UI interaction event triggers
const headerHistoryBtn = document.getElementById('header-history-btn');
if (headerHistoryBtn) {
  headerHistoryBtn.addEventListener('click', () => toggleHistoryMode(true));
}

const historyExitBtn = document.getElementById('history-exit-btn');
if (historyExitBtn) {
  historyExitBtn.addEventListener('click', () => toggleHistoryMode(false));
}

const highlightChangesCheckbox = document.getElementById('highlightChanges');
if (highlightChangesCheckbox) {
  highlightChangesCheckbox.addEventListener('change', () => renderSpreadsheetGrid());
}

const showUneditedCheckbox = document.getElementById('showUnedited');
if (showUneditedCheckbox) {
  showUneditedCheckbox.addEventListener('change', () => renderSpreadsheetGrid());
}

const historyRestoreBtn = document.getElementById('history-restore-btn');
if (historyRestoreBtn) {
  historyRestoreBtn.onclick = restoreVersion;
}

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

  const BAR = 14;        // bar thickness, px — matches the CSS width/height
  const MIN_THUMB = 24;  // smallest thumb length, px

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
    vbar.style.bottom = `${vCorner}px`;
    hbar.style.right = `${hCorner}px`;

    // Track length from the viewport span (not the bar's own box, so a hidden
    // display:none bar still measures correctly when content reappears).
    const vTrack = viewport.clientHeight - hh - vCorner;
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

    const hTrack = viewport.clientWidth - gw - hCorner;
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
  viewport.addEventListener('scroll', position, { passive: true });
  window.addEventListener('resize', layout);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => layout());
    ro.observe(viewport);
    const gr = document.getElementById('grid-root');
    if (gr) ro.observe(gr);
  }

  gridScrollbarLayout = layout;
  layout();
}

initGridScrollbars();


