/**
 * @file fill-handle-drag.test.js
 * @description Behavior of dragging the selection's fill handle (the dot at the
 * bottom-right corner). A mousedown on the dot must start an axis-locked extend
 * drag: as the pointer crosses cells, the selection becomes the original range
 * grown toward the pointer along the dominant axis only — horizontally or
 * vertically, never diagonally (ties prefer vertical, the common fill-down
 * case). The anchor/active cell must not move, and mouseup ends the drag.
 *
 * Runs the real client bundle in a vm sandbox (same approach as
 * presence-tags.test.js) with a DOM stub rich enough for the delegated grid
 * mouse handlers: elements support closest()/classList, and listeners bound on
 * #grid-root and window are captured so the test can fire synthetic events.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

function createSandbox() {
  let gridRoot = null;
  const cellById = new Map(); // data-cell-id -> element
  const elById = new Map();   // element id -> element
  const bodyClasses = new Set();

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
      // Enough of closest() for the delegated handlers: '[data-cell-id]' and '#id'.
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
      querySelectorAll: () => [], addEventListener: () => {},
      body: {
        classList: {
          add: (...cs) => cs.forEach((c) => bodyClasses.add(c)),
          remove: (...cs) => cs.forEach((c) => bodyClasses.delete(c)),
          contains: (c) => bodyClasses.has(c),
        },
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

  // The post-render value-filter pass is DOM-heavy and irrelevant here.
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

  return { sandbox, cellById, elById, fire, fireWindow, bodyClasses };
}

/** Establishes a B2:C3 selection by simulated drag, then mousedowns the fill
 *  handle, returning the drive helpers. */
function setUpFillDrag() {
  const ctx = createSandbox();
  const { sandbox, cellById, elById, fire, fireWindow } = ctx;
  sandbox.localSheets = { Sheet1: {} };
  sandbox.activeSheetName = 'Sheet1';
  sandbox.renderSpreadsheetGrid();

  // Base selection B2:C3 via a normal drag.
  fire('mousedown', cellById.get('B2'));
  fire('mouseover', cellById.get('C3'));
  fireWindow('mouseup');
  assert.strictEqual(sandbox.selectionStartCellId, 'B2');
  assert.strictEqual(sandbox.selectionEndCellId, 'C3');

  // The selection overlay exists now; the fill handle is its child in the real
  // DOM (built via innerHTML, which the stub doesn't parse), so fabricate it.
  const overlay = elById.get('selection-range-overlay');
  assert.ok(overlay, 'selection overlay should exist after selecting a range');
  const handle = sandbox.document.createElement();
  handle.className = 'fill-handle';
  overlay.appendChild(handle);

  fire('mousedown', handle);
  return { ...ctx, handle };
}

test('dragging the fill handle extends the selection vertically when the drag is mostly vertical', () => {
  const { sandbox, cellById, fire, bodyClasses } = setUpFillDrag();

  assert.ok(bodyClasses.has('fill-dragging'), 'the fill drag should pin the crosshair cursor via body.fill-dragging');

  // Pointer at E7: 4 rows below the base (B2:C3) but only 2 columns right of
  // it — vertical wins, columns stay B..C.
  fire('mouseover', cellById.get('E7'));
  assert.strictEqual(sandbox.selectionStartCellId, 'B2');
  assert.strictEqual(sandbox.selectionEndCellId, 'C7',
    'a mostly-vertical drag must extend rows only (B2:C3 → B2:C7), never diagonally');
  assert.strictEqual(sandbox.activeCellId, 'B2', 'the active cell must not move during a fill drag');
});

test('the fill drag re-locks horizontally when the pointer moves mostly sideways', () => {
  const { sandbox, cellById, fire } = setUpFillDrag();

  fire('mouseover', cellById.get('E7')); // vertical first (B2:C7)
  // H4 is 5 columns right of the base but only 1 row below it — the lock
  // flips to horizontal, measured from the ORIGINAL base range B2:C3.
  fire('mouseover', cellById.get('H4'));
  assert.strictEqual(sandbox.selectionStartCellId, 'B2');
  assert.strictEqual(sandbox.selectionEndCellId, 'H3',
    'a mostly-horizontal drag must extend columns only from the original base (B2:C3 → B2:H3)');
});

test('a fill drag extends upward and leftward too, and mouseup ends it', () => {
  const { sandbox, cellById, fire, fireWindow, bodyClasses } = setUpFillDrag();

  // A3 is 1 column LEFT of the base range B2:C3 and 0 rows outside it, so the
  // extension goes leftward along the horizontal axis.
  fire('mouseover', cellById.get('A3'));
  assert.strictEqual(sandbox.selectionStartCellId, 'A2');
  assert.strictEqual(sandbox.selectionEndCellId, 'C3', 'dragging left of the base extends columns leftward (A2:C3)');

  fireWindow('mouseup');
  assert.ok(!bodyClasses.has('fill-dragging'), 'mouseup must clear the body.fill-dragging cursor pin');

  // After the drag ended, crossing more cells must not change the selection.
  fire('mouseover', cellById.get('J9'));
  assert.strictEqual(sandbox.selectionStartCellId, 'A2');
  assert.strictEqual(sandbox.selectionEndCellId, 'C3', 'the selection must freeze once the fill drag ends');
});

test('a pointer inside the base range restores the original selection', () => {
  const { sandbox, cellById, fire } = setUpFillDrag();

  fire('mouseover', cellById.get('C7')); // extend down to B2:C7
  assert.strictEqual(sandbox.selectionEndCellId, 'C7');
  fire('mouseover', cellById.get('B2')); // back inside the base range
  assert.strictEqual(sandbox.selectionStartCellId, 'B2');
  assert.strictEqual(sandbox.selectionEndCellId, 'C3',
    'retreating into the base range must restore the original B2:C3, not keep the extension');
});
