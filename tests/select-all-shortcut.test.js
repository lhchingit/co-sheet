/**
 * @file select-all-shortcut.test.js
 * @description Ctrl+A (or Cmd+A) pressed over the grid must select every row
 * and column of the sheet — A1 through the last rendered column and TOTAL_ROWS
 * — instead of the browser's page-wide select-all, without moving the active
 * cell. When a text field (formula bar, dialog input, cell editor) has focus,
 * the shortcut must be left alone so the browser's own text select-all runs.
 *
 * Runs the real client bundle in a vm sandbox (same approach as
 * fill-handle-drag.test.js) with a DOM stub rich enough for the delegated grid
 * mouse handlers and the document-level keydown shortcut handler.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

function createSandbox() {
  let gridRoot = null;
  const cellById = new Map(); // data-cell-id -> element
  const elById = new Map();   // element id -> element

  const makeEl = () => {
    const classes = new Set();
    const el = {
      nodeType: 1, tagName: 'div', style: {}, _children: [], _attrs: {},
      scrollWidth: 0, clientWidth: 100, clientHeight: 21,
      offsetWidth: 100, offsetHeight: 21, offsetLeft: 0, offsetTop: 0, scrollHeight: 0,
      firstElementChild: null,
      _listeners: {},
      set id(v) { this._id = v; if (v) elById.set(v, this); },
      get id() { return this._id || ''; },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get className() { return [...classes].join(' '); },
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c),
        toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      },
      set innerHTML(v) {
        this._children.length = 0; this._ih = v;
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
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      removeEventListener() {},
      appendChild(c) { this._children.push(c); c._parent = this; return c; },
      removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; },
      remove() { if (this._parent) this._parent.removeChild(this); if (this._id) elById.delete(this._id); },
      closest(sel) {
        for (let n = this; n; n = n._parent || null) {
          if (sel === '[data-cell-id]' && n._attrs && 'data-cell-id' in n._attrs) return n;
          if (sel.startsWith('#') && n._id === sel.slice(1)) return n;
        }
        return null;
      },
      querySelector() { return null; }, querySelectorAll() { return []; },
      contains() { return false; },
      scrollIntoView() {}, focus() {}, blur() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
      get parentNode() { return this._parent || null; },
    };
    return el;
  };

  gridRoot = makeEl();

  const windowListeners = {};
  const documentListeners = {};
  const parseCellSel = (sel) => {
    const m = /\[data-cell-id="([^"]+)"\]/.exec(sel);
    return m ? m[1] : null;
  };

  const documentStub = {
    activeElement: null, // tests point this at an input stub to simulate focus
    getElementById: (id) => (id === 'grid-root' ? gridRoot : (elById.get(id) || null)),
    createElement: () => makeEl(),
    createDocumentFragment: () => makeEl(),
    querySelector: (sel) => { const c = parseCellSel(sel); return c ? (cellById.get(c) || null) : null; },
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    body: {
      classList: { add: () => {}, remove: () => {}, contains: () => false },
    },
  };

  const sandbox = {
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    },
    document: documentStub,
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
    Object.defineProperty(globalThis, 'selectionStartCellId', { get: () => selectionStartCellId, configurable: true });
    Object.defineProperty(globalThis, 'selectionEndCellId', { get: () => selectionEndCellId, configurable: true });
    Object.defineProperty(globalThis, 'activeCellId', { get: () => activeCellId, configurable: true });
  `;
  vm.runInContext(readAppBundle() + exportSuffix, sandbox);

  if (sandbox.window.CoSheet && sandbox.window.CoSheet.sortFilter) {
    sandbox.window.CoSheet.sortFilter.applyFilter = () => {};
    sandbox.window.CoSheet.sortFilter.updateToolbarButton = () => {};
  }

  const fire = (type, target, props = {}) => {
    const e = { button: 0, target, preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of gridRoot._listeners[type] || []) fn(e);
  };
  const fireWindow = (type) => {
    for (const fn of windowListeners[type] || []) fn({});
  };
  /** Dispatches a keydown to the document-level handlers, returning whether
   *  any of them called preventDefault. */
  const fireKeydown = (props) => {
    let prevented = false;
    const e = {
      key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      preventDefault() { prevented = true; }, stopPropagation() {},
      ...props,
    };
    for (const fn of documentListeners.keydown || []) fn(e);
    return prevented;
  };

  return { sandbox, cellById, fire, fireWindow, fireKeydown, documentStub };
}

/** Renders an empty sheet and clicks B2 so there is an active cell. */
function setUpGrid() {
  const ctx = createSandbox();
  const { sandbox, cellById, fire, fireWindow } = ctx;
  sandbox.localSheets = { Sheet1: {} };
  sandbox.activeSheetName = 'Sheet1';
  sandbox.renderSpreadsheetGrid();
  fire('mousedown', cellById.get('B2'));
  fireWindow('mouseup');
  assert.strictEqual(sandbox.activeCellId, 'B2');
  return ctx;
}

test('Ctrl+A selects every row and column of the grid without moving the active cell', () => {
  const { sandbox, fireKeydown } = setUpGrid();

  const prevented = fireKeydown({ key: 'a', ctrlKey: true });

  assert.strictEqual(prevented, true, 'the browser\'s page-wide select-all must be suppressed');
  assert.strictEqual(sandbox.selectionStartCellId, 'A1');
  assert.strictEqual(sandbox.selectionEndCellId, 'Z1000',
    'the selection must span the whole grid (26 default columns × TOTAL_ROWS rows)');
  assert.strictEqual(sandbox.activeCellId, 'B2', 'the active cell must stay where it was');
});

test('Cmd+A (metaKey) works the same way', () => {
  const { sandbox, fireKeydown } = setUpGrid();

  const prevented = fireKeydown({ key: 'a', metaKey: true });

  assert.strictEqual(prevented, true);
  assert.strictEqual(sandbox.selectionStartCellId, 'A1');
  assert.strictEqual(sandbox.selectionEndCellId, 'Z1000');
});

test('the full-grid selection tracks columns added beyond Z', () => {
  const ctx = createSandbox();
  const { sandbox, cellById, fire, fireWindow, fireKeydown } = ctx;
  // Data in column AB grows the rendered grid past the default A–Z.
  sandbox.localSheets = { Sheet1: { AB3: { value: 'x', formula: '', style: {} } } };
  sandbox.activeSheetName = 'Sheet1';
  sandbox.renderSpreadsheetGrid();
  fire('mousedown', cellById.get('B2'));
  fireWindow('mouseup');

  fireKeydown({ key: 'a', ctrlKey: true });

  assert.strictEqual(sandbox.selectionStartCellId, 'A1');
  assert.strictEqual(sandbox.selectionEndCellId, 'AB1000',
    'the selection must reach the last rendered column, not stop at Z');
});

test('a second Ctrl+A collapses the selection back to the active cell', () => {
  const { sandbox, fireKeydown } = setUpGrid();

  fireKeydown({ key: 'a', ctrlKey: true }); // select all
  assert.strictEqual(sandbox.selectionEndCellId, 'Z1000');

  const prevented = fireKeydown({ key: 'a', ctrlKey: true }); // toggle off
  assert.strictEqual(prevented, true, 'the browser select-all must stay suppressed on the second press');
  assert.strictEqual(sandbox.selectionStartCellId, 'B2',
    'the second press must deselect all rows and columns, leaving only the active cell');
  assert.strictEqual(sandbox.selectionEndCellId, 'B2');
  assert.strictEqual(sandbox.activeCellId, 'B2');

  fireKeydown({ key: 'a', ctrlKey: true }); // a third press selects all again
  assert.strictEqual(sandbox.selectionStartCellId, 'A1', 'the toggle must keep cycling');
  assert.strictEqual(sandbox.selectionEndCellId, 'Z1000');
});

test('Ctrl+A after a partial range still selects all (only a FULL selection toggles off)', () => {
  const { sandbox, cellById, fire, fireWindow, fireKeydown } = setUpGrid();

  fire('mousedown', cellById.get('B2'));
  fire('mouseover', cellById.get('C3'));
  fireWindow('mouseup');
  assert.strictEqual(sandbox.selectionEndCellId, 'C3');

  fireKeydown({ key: 'a', ctrlKey: true });
  assert.strictEqual(sandbox.selectionStartCellId, 'A1');
  assert.strictEqual(sandbox.selectionEndCellId, 'Z1000',
    'a partial selection must grow to the whole grid, not collapse');
});

test('Ctrl+A inside a text input is left to the browser', () => {
  const { sandbox, fireKeydown, documentStub } = setUpGrid();
  documentStub.activeElement = { tagName: 'INPUT', getAttribute: () => null };

  const prevented = fireKeydown({ key: 'a', ctrlKey: true });

  assert.strictEqual(prevented, false, 'a focused input must keep the native text select-all');
  assert.strictEqual(sandbox.selectionStartCellId, 'B2', 'the grid selection must not change');
  assert.strictEqual(sandbox.selectionEndCellId, 'B2');
});

test('Ctrl+A inside a contenteditable cell editor is left to the browser', () => {
  const { sandbox, fireKeydown, documentStub } = setUpGrid();
  documentStub.activeElement = { tagName: 'DIV', getAttribute: (k) => (k === 'contenteditable' ? 'true' : null) };

  const prevented = fireKeydown({ key: 'a', ctrlKey: true });

  assert.strictEqual(prevented, false);
  assert.strictEqual(sandbox.selectionEndCellId, 'B2');
});

test('Ctrl+Shift+A and Ctrl+Alt+A are not intercepted', () => {
  const { sandbox, fireKeydown } = setUpGrid();

  const p1 = fireKeydown({ key: 'A', ctrlKey: true, shiftKey: true });
  const p2 = fireKeydown({ key: 'a', ctrlKey: true, altKey: true });

  assert.strictEqual(p1, false);
  assert.strictEqual(p2, false);
  assert.strictEqual(sandbox.selectionEndCellId, 'B2', 'modified variants must not touch the selection');
});
