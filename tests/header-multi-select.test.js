/**
 * @file header-multi-select.test.js
 * @description Ctrl+clicking column/row headers adds whole columns/rows to the
 * selection (A, Ctrl+B, Ctrl+C → A, B and C selected — contiguous or not);
 * Shift+clicking selects the whole span from the anchor to the clicked header
 * (A, Shift+C → A:C). The extra Ctrl ranges join getSelectedCellIds() so
 * formatting-style operations cover them, and a plain cell click drops them.
 *
 * Runs the real client bundle in a vm sandbox (same approach as
 * row-header-select.test.js) with a DOM stub rich enough for the delegated
 * grid mouse handlers and the headers' own mousedown listeners.
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
    globalThis.getSelectedCellIds = getSelectedCellIds;
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

test('Ctrl+clicking column headers adds each whole column to the selection', () => {
  const { sandbox, fireOn, colHeader, cellById } = setUpGrid();

  fireOn(colHeader('A'), 'mousedown');
  fireOn(colHeader('B'), 'mousedown', { ctrlKey: true });
  fireOn(colHeader('C'), 'mousedown', { ctrlKey: true });

  for (const letter of ['A', 'B', 'C']) {
    assert.ok(colHeader(letter).classList.contains('header-selected'),
      `column header ${letter} must be solid blue in the multi-selection`);
    assert.ok(cellById.get(`${letter}5`).classList.contains('grid-cell-selected'),
      `cells of column ${letter} must carry the range fill`);
  }
  assert.ok(!colHeader('D').classList.contains('header-selected'));
  assert.ok(!cellById.get('D5').classList.contains('grid-cell-selected'));

  // The active range is the last-clicked column.
  assert.strictEqual(sandbox.selectionStartCellId, 'C1');
  assert.strictEqual(sandbox.selectionEndCellId, 'C1000');

  const ids = new Set(sandbox.getSelectedCellIds());
  assert.ok(ids.has('A7') && ids.has('B7') && ids.has('C7'),
    'operations must see every Ctrl-selected column');
  assert.ok(!ids.has('D7'));
});

test('Ctrl+click supports disjoint columns and a plain cell click drops the extras', () => {
  const { sandbox, fireOn, fire, fireWindow, colHeader, cellById } = setUpGrid();

  fireOn(colHeader('A'), 'mousedown');
  fireOn(colHeader('C'), 'mousedown', { metaKey: true }); // Cmd works like Ctrl

  assert.ok(colHeader('A').classList.contains('header-selected'));
  assert.ok(colHeader('C').classList.contains('header-selected'));
  assert.ok(!colHeader('B').classList.contains('header-selected'),
    'the skipped column must stay unselected');
  assert.ok(!cellById.get('B5').classList.contains('grid-cell-selected'));

  const ids = new Set(sandbox.getSelectedCellIds());
  assert.ok(ids.has('A5') && ids.has('C5') && !ids.has('B5'));

  fire('mousedown', cellById.get('D4'));
  fireWindow('mouseup');
  assert.ok(!colHeader('A').classList.contains('header-selected'),
    'a plain cell click must clear the multi-selection');
  assert.ok(!cellById.get('A5').classList.contains('grid-cell-selected'));
  // Spread into a host-realm array: the sandbox's Array prototype differs.
  assert.deepStrictEqual([...sandbox.getSelectedCellIds()], ['D4']);
});

test('Shift+clicking a column header selects the whole span from the anchor', () => {
  const { sandbox, nameBox, fireOn, colHeader } = setUpGrid();

  fireOn(colHeader('A'), 'mousedown');
  fireOn(colHeader('C'), 'mousedown', { shiftKey: true });

  assert.strictEqual(sandbox.selectionStartCellId, 'A1');
  assert.strictEqual(sandbox.selectionEndCellId, 'C1000');
  assert.strictEqual(nameBox.innerText, 'A:C');
  for (const letter of ['A', 'B', 'C']) {
    assert.ok(colHeader(letter).classList.contains('header-selected'),
      `column ${letter} must be inside the shift-extended span`);
  }
  assert.ok(!colHeader('D').classList.contains('header-selected'));
});

test('Ctrl+clicking row headers adds each whole row to the selection', () => {
  const { sandbox, fireOn, rowHeader, cellById } = setUpGrid();

  fireOn(rowHeader(2), 'mousedown');
  fireOn(rowHeader(4), 'mousedown', { ctrlKey: true });

  assert.ok(rowHeader(2).classList.contains('header-selected'));
  assert.ok(rowHeader(4).classList.contains('header-selected'));
  assert.ok(!rowHeader(3).classList.contains('header-selected'),
    'the skipped row must stay unselected');
  assert.ok(cellById.get('E2').classList.contains('grid-cell-selected'));
  assert.ok(cellById.get('E4').classList.contains('grid-cell-selected'));
  assert.ok(!cellById.get('E3').classList.contains('grid-cell-selected'));

  const ids = new Set(sandbox.getSelectedCellIds());
  assert.ok(ids.has('M2') && ids.has('M4') && !ids.has('M3'));
});

test('Shift+clicking a row header selects the whole span from the anchor', () => {
  const { sandbox, nameBox, fireOn, rowHeader, cellById } = setUpGrid();

  fireOn(rowHeader(2), 'mousedown');
  fireOn(rowHeader(4), 'mousedown', { shiftKey: true });

  assert.strictEqual(sandbox.selectionStartCellId, 'A2');
  assert.strictEqual(sandbox.selectionEndCellId, 'Z4');
  assert.strictEqual(nameBox.innerText, '2:4');
  for (const row of [2, 3, 4]) {
    assert.ok(rowHeader(row).classList.contains('header-selected'),
      `row ${row} must be inside the shift-extended span`);
    assert.ok(cellById.get(`H${row}`).classList.contains('grid-cell-selected'));
  }
  assert.ok(!rowHeader(5).classList.contains('header-selected'));
});
