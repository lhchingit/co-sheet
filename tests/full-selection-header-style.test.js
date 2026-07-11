/**
 * @file full-selection-header-style.test.js
 * @description Row/column headers must take the solid-blue "selected" style
 * (`header-selected`) whenever their whole track lies inside the selection —
 * decided by the selection's geometry, not by which gesture created it. Ctrl+A
 * darkens every header; a full-height drag darkens that column's header; a
 * full-width drag darkens that row's header; the classic column-header click
 * keeps working. Partial ranges keep the light `active-header` tint.
 * (Regression test for issue #158.)
 *
 * Runs the real client bundle in a vm sandbox (same approach as
 * select-all-shortcut.test.js) with a DOM stub rich enough for the delegated
 * grid mouse handlers and the document-level keydown shortcut handler.
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
  const fireKeydown = (props) => {
    const e = {
      key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      preventDefault() {}, stopPropagation() {},
      ...props,
    };
    for (const fn of documentListeners.keydown || []) fn(e);
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

  return { sandbox, cellById, fire, fireWindow, fireKeydown, fireOn, colHeader, rowHeader };
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

test('Ctrl+A gives every row and column header the solid-blue selected style', () => {
  const { fireKeydown, colHeader, rowHeader } = setUpGrid();

  fireKeydown({ key: 'a', ctrlKey: true });

  for (const letter of ['A', 'M', 'Z']) {
    assert.ok(colHeader(letter).classList.contains('header-selected'),
      `column header ${letter} must be solid blue when the whole grid is selected`);
    assert.ok(!colHeader(letter).classList.contains('active-header'));
  }
  for (const row of [1, 500, 1000]) {
    assert.ok(rowHeader(row).classList.contains('header-selected'),
      `row header ${row} must be solid blue when the whole grid is selected`);
    assert.ok(!rowHeader(row).classList.contains('active-header'));
  }
});

test('a partial range keeps the light active-header tint on its headers', () => {
  const { cellById, fire, fireWindow, colHeader, rowHeader } = setUpGrid();

  fire('mousedown', cellById.get('B2'));
  fire('mouseover', cellById.get('C3'));
  fireWindow('mouseup');

  for (const letter of ['B', 'C']) {
    assert.ok(colHeader(letter).classList.contains('active-header'));
    assert.ok(!colHeader(letter).classList.contains('header-selected'),
      'a partial selection must not darken column headers');
  }
  assert.ok(rowHeader(2).classList.contains('active-header'));
  assert.ok(!rowHeader(2).classList.contains('header-selected'),
    'a partial selection must not darken row headers');
  assert.ok(!colHeader('D').classList.contains('active-header'), 'columns outside the range stay unhighlighted');
});

test('a full-height drag darkens that column header (geometry, not gesture)', () => {
  const { sandbox, cellById, fire, fireWindow, colHeader, rowHeader } = setUpGrid();

  fire('mousedown', cellById.get('B1'));
  fire('mouseover', cellById.get('B1000'));
  fireWindow('mouseup');
  assert.strictEqual(sandbox.selectionStartCellId, 'B1');
  assert.strictEqual(sandbox.selectionEndCellId, 'B1000');

  assert.ok(colHeader('B').classList.contains('header-selected'),
    'dragging B1:B1000 selects the whole column, so its header must be solid blue');
  assert.ok(rowHeader(5).classList.contains('active-header'),
    'row headers stay lightly tinted — their rows are only partially selected');
  assert.ok(!rowHeader(5).classList.contains('header-selected'));
});

test('a full-width drag darkens that row header', () => {
  const { cellById, fire, fireWindow, colHeader, rowHeader } = setUpGrid();

  fire('mousedown', cellById.get('A5'));
  fire('mouseover', cellById.get('Z5'));
  fireWindow('mouseup');

  assert.ok(rowHeader(5).classList.contains('header-selected'),
    'dragging A5:Z5 selects the whole row, so its header must be solid blue');
  assert.ok(colHeader('B').classList.contains('active-header'),
    'column headers stay lightly tinted — their columns are only partially selected');
  assert.ok(!colHeader('B').classList.contains('header-selected'));
});

test('the classic column-header click still darkens its header', () => {
  const { sandbox, fireOn, colHeader, rowHeader } = setUpGrid();

  fireOn(colHeader('C'), 'mousedown');
  assert.strictEqual(sandbox.selectionStartCellId, 'C1');
  assert.strictEqual(sandbox.selectionEndCellId, 'C1000');

  assert.ok(colHeader('C').classList.contains('header-selected'),
    'the column-header click path must keep its solid-blue highlight');
  assert.ok(rowHeader(3).classList.contains('active-header'));
});
