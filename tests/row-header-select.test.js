/**
 * @file row-header-select.test.js
 * @description Clicking a row header must select the entire row, mirroring the
 * column-header click: the anchor lands on the row's first cell, the range
 * runs to the last column, the row header takes the solid-blue selected style,
 * and the Name Box reads Google-Sheets-style "5:5". A later plain cell click
 * must drop the row-selection state so the Name Box shows the cell id again.
 *
 * Runs the real client bundle in a vm sandbox (same approach as
 * full-selection-header-style.test.js) with a DOM stub rich enough for the
 * delegated grid mouse handlers and the headers' own mousedown listeners.
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
  // The Name Box lives in the static toolbar HTML, so the bundle never creates
  // it; pre-register one so updateRangeSelectionUI can write to it.
  const nameBox = makeEl();
  nameBox.id = 'name-box';

  const windowListeners = {};
  const documentListeners = {};
  const parseCellSel = (sel) => {
    const m = /\[data-cell-id="([^"]+)"\]/.exec(sel);
    return m ? m[1] : null;
  };

  const sandbox = {
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    },
    document: {
      getElementById: (id) => (id === 'grid-root' ? gridRoot : (elById.get(id) || null)),
      createElement: () => makeEl(),
      createDocumentFragment: () => makeEl(),
      querySelector: (sel) => { const c = parseCellSel(sel); return c ? (cellById.get(c) || null) : null; },
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (documentListeners[type] = documentListeners[type] || []).push(fn); },
      activeElement: null,
      body: {
        classList: { add: () => {}, remove: () => {}, contains: () => false },
      },
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
  /** Fires a listener bound directly on `el` (headers bind their own mousedown). */
  const fireOn = (el, type, props = {}) => {
    const e = { button: 0, target: el, preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of el._listeners[type] || []) fn(e);
  };
  /** Depth-first search of the rendered tree for an element carrying attr=val. */
  const findByAttr = (key, val) => {
    const stack = [gridRoot];
    while (stack.length) {
      const n = stack.pop();
      if (n._attrs && String(n._attrs[key]) === String(val)) return n;
      for (const c of n._children || []) stack.push(c);
    }
    return null;
  };
  const colHeader = (letter) => findByAttr('data-col-id', letter);
  const rowHeader = (row) => findByAttr('data-row-id', row);

  return { sandbox, cellById, nameBox, fire, fireWindow, fireOn, colHeader, rowHeader };
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
  return ctx;
}

test('clicking a row header selects the entire row', () => {
  const { sandbox, fireOn, colHeader, rowHeader, cellById } = setUpGrid();

  fireOn(rowHeader(5), 'mousedown');

  assert.strictEqual(sandbox.selectionStartCellId, 'A5');
  assert.strictEqual(sandbox.selectionEndCellId, 'Z5');
  assert.strictEqual(sandbox.activeCellId, 'A5');

  assert.ok(rowHeader(5).classList.contains('header-selected'),
    'the clicked row header must take the solid-blue selected style');
  assert.ok(colHeader('B').classList.contains('active-header'),
    'column headers stay lightly tinted — their columns are only partially selected');
  assert.ok(!colHeader('B').classList.contains('header-selected'));
  assert.ok(cellById.get('M5').classList.contains('grid-cell-selected'),
    'cells across the row must take the range fill');
});

test('a row-header selection shows "5:5" in the Name Box; a cell click restores the cell id', () => {
  const { sandbox, nameBox, fire, fireWindow, fireOn, rowHeader, cellById } = setUpGrid();

  fireOn(rowHeader(5), 'mousedown');
  assert.strictEqual(nameBox.innerText, '5:5',
    'a full-row selection reads Google-Sheets-style, e.g. "5:5"');

  fire('mousedown', cellById.get('B2'));
  fireWindow('mouseup');
  assert.strictEqual(nameBox.innerText, 'B2',
    'a plain cell click must clear the row-selection Name Box format');
  assert.strictEqual(sandbox.selectionEndCellId, 'B2');
});
