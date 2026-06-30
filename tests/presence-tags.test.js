/**
 * @file presence-tags.test.js
 * @description Regression guard for collaborator presence tags surviving a full
 * grid rebuild (#105). renderSpreadsheetGrid() resets gridRoot.innerHTML and
 * rebuilds the grid from scratch, discarding the cursor/presence borders that
 * renderCursorBorder() appends to individual cells. It must re-apply the remote
 * cursors in `remoteCursors` afterwards (via renderRemoteCursors), otherwise a
 * peer's name tag silently disappears on every full re-render — e.g. when another
 * user resizes a column or adds a sheet — until that peer next moves their cursor.
 *
 * Uses the real client bundle in a vm sandbox with a DOM stub that resolves cells
 * by their data-cell-id, so renderCursorBorder can find the target cell and append
 * the tag exactly as it does in the browser.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** Build a vm sandbox whose DOM stub registers cells by data-cell-id and elements
 *  by id, so document.querySelector('[data-cell-id="X"]') and getElementById work
 *  against the freshly rendered grid. */
function createSandbox() {
  let gridRoot = null;
  const cellById = new Map(); // data-cell-id -> element (cleared each render)
  const elById = new Map();   // element id -> element

  const makeEl = () => {
    const el = {
      nodeType: 1, tagName: 'div', style: {}, className: '', _children: [], _attrs: {},
      scrollWidth: 0, clientWidth: 100, clientHeight: 21,
      offsetWidth: 100, offsetHeight: 21, offsetLeft: 0, offsetTop: 0, scrollHeight: 0,
      firstElementChild: null,
      set id(v) { this._id = v; if (v) elById.set(v, this); },
      get id() { return this._id || ''; },
      set innerHTML(v) {
        this._children.length = 0; this._ih = v;
        // Clearing gridRoot (the rebuild) invalidates the previous render's cells.
        if (this === gridRoot) cellById.clear();
      },
      get innerHTML() { return this._ih || ''; },
      set innerText(v) { this._it = v; }, get innerText() { return this._it || ''; },
      set textContent(v) { this._tc = v; }, get textContent() { return this._tc || ''; },
      setAttribute(k, v) {
        this._attrs[k] = v;
        if (k === 'data-cell-id') cellById.set(v, this);
      },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      removeAttribute(k) { delete this._attrs[k]; },
      addEventListener() {}, removeEventListener() {},
      appendChild(c) { this._children.push(c); c._parent = this; return c; },
      removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; },
      remove() { if (this._parent) this._parent.removeChild(this); if (this._id) elById.delete(this._id); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      contains() { return false; },
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
      get parentNode() { return this._parent || null; },
    };
    return el;
  };

  gridRoot = makeEl();

  const parseCellId = (sel) => {
    const m = /\[data-cell-id="([^"]+)"\]/.exec(sel);
    return m ? m[1] : null;
  };

  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => (id === 'grid-root' ? gridRoot : (elById.get(id) || null)),
      createElement: () => makeEl(),
      createDocumentFragment: () => makeEl(),
      querySelector: (sel) => { const c = parseCellId(sel); return c ? (cellById.get(c) || null) : null; },
      querySelectorAll: () => [], addEventListener: () => {},
      body: { classList: { add() {}, remove() {} } },
    },
    WebSocket: class { constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    setTimeout: () => 0, clearTimeout: () => {}, queueMicrotask: () => {}, requestAnimationFrame: () => 0,
    console, Math, parseFloat, parseInt, isNaN, isFinite, String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Proxy, Reflect,
  };
  vm.createContext(sandbox);

  const exportSuffix = `
    globalThis.renderSpreadsheetGrid = renderSpreadsheetGrid;
    Object.defineProperty(globalThis, 'localSheets', { get: () => localSheets, set: (v) => { localSheets = v; }, configurable: true });
    Object.defineProperty(globalThis, 'activeSheetName', { get: () => activeSheetName, set: (v) => { activeSheetName = v; }, configurable: true });
    Object.defineProperty(globalThis, 'remoteCursors', { get: () => remoteCursors, set: (v) => { remoteCursors = v; }, configurable: true });
  `;
  vm.runInContext(readAppBundle() + exportSuffix, sandbox);

  // The post-render value-filter pass is DOM-heavy and irrelevant here.
  if (sandbox.window.CoSheet && sandbox.window.CoSheet.sortFilter) {
    sandbox.window.CoSheet.sortFilter.applyFilter = () => {};
    sandbox.window.CoSheet.sortFilter.updateToolbarButton = () => {};
  }

  return { sandbox, cellById };
}

test('a full grid rebuild re-renders remote collaborators\' presence tags (#105)', () => {
  // --- Arrange ---
  const { sandbox, cellById } = createSandbox();
  sandbox.localSheets = { Sheet1: { B2: { value: 'x', style: {} } } };
  sandbox.activeSheetName = 'Sheet1';
  // A peer ("Alice") has cell B2 active on the current sheet.
  sandbox.remoteCursors = {
    alice123: { userId: 'alice123', username: 'Alice', color: '#ff0000', activeCell: 'B2', activeSheet: 'Sheet1' },
  };

  // --- Act ---
  // A full rebuild (as triggered by a remote resize, sheet change, etc.).
  sandbox.renderSpreadsheetGrid();

  // --- Assert ---
  const cellB2 = cellById.get('B2');
  assert.ok(cellB2, 'B2 should exist in the rebuilt grid');
  const tag = cellB2._children.find((c) => c.id === 'cursor-alice123');
  assert.ok(tag, "Alice's presence tag must be re-applied after a full grid rebuild — without re-rendering remote cursors it vanishes until she next moves");
  assert.match(tag.innerHTML, /Alice/, 'the presence tag should carry the collaborator name');
});

test('a remote cursor on another sheet is not rendered on the active sheet', () => {
  // --- Arrange ---
  const { sandbox, cellById } = createSandbox();
  sandbox.localSheets = { Sheet1: { B2: { value: 'x', style: {} } }, Sheet2: {} };
  sandbox.activeSheetName = 'Sheet1';
  // Alice is active on Sheet2, so her tag must not appear while we view Sheet1.
  sandbox.remoteCursors = {
    alice123: { userId: 'alice123', username: 'Alice', color: '#ff0000', activeCell: 'B2', activeSheet: 'Sheet2' },
  };

  // --- Act ---
  sandbox.renderSpreadsheetGrid();

  // --- Assert ---
  const cellB2 = cellById.get('B2');
  assert.ok(cellB2, 'B2 should exist in the rebuilt grid');
  const tag = cellB2._children.find((c) => c.id === 'cursor-alice123');
  assert.strictEqual(tag, undefined, 'a tag for a peer on a different sheet must not be rendered on the active sheet');
});
