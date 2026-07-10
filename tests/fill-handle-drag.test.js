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
 *  handle, returning the drive helpers. `cells` seeds the sheet's cell data. */
function setUpFillDrag(cells = {}) {
  const ctx = createSandbox();
  const { sandbox, cellById, elById, fire, fireWindow } = ctx;
  sandbox.localSheets = { Sheet1: cells };
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

test('releasing a fill drag tiles the base range\'s values into the extension', () => {
  const { sandbox, cellById, fire, fireWindow } = setUpFillDrag({
    B2: { value: '1', formula: '', style: {} }, C2: { value: 'a', formula: '', style: {} },
    B3: { value: '2', formula: '', style: {} }, C3: { value: 'b', formula: '', style: {} },
  });

  fire('mouseover', cellById.get('C7')); // extend B2:C3 down to B2:C7
  fireWindow('mouseup');

  const s = sandbox.localSheets.Sheet1;
  // The 2-row base pattern repeats downward: rows 4/6 copy row 2, rows 5/7 copy row 3.
  assert.strictEqual(s.B4.value, '1');
  assert.strictEqual(s.C4.value, 'a');
  assert.strictEqual(s.B5.value, '2');
  assert.strictEqual(s.C5.value, 'b');
  assert.strictEqual(s.B6.value, '1');
  assert.strictEqual(s.C7.value, 'b');
  // The base cells themselves are untouched.
  assert.strictEqual(s.B2.value, '1');
  assert.strictEqual(s.C3.value, 'b');
});

test('a fill drag copies formulas and styles and recalculates them', () => {
  const { sandbox, cellById, fire, fireWindow } = setUpFillDrag({
    B2: { value: '3', formula: '=SUM(1,2)', style: { fontWeight: 'bold' } },
    C2: { value: '', formula: '', style: {} },
    B3: { value: '3', formula: '=SUM(1,2)', style: { fontWeight: 'bold' } },
    C3: { value: '', formula: '', style: {} },
  });

  fire('mouseover', cellById.get('C4')); // extend down one row
  fireWindow('mouseup');

  const b4 = sandbox.localSheets.Sheet1.B4;
  assert.strictEqual(b4.formula, '=SUM(1,2)', 'a formula with no cell references must be copied unchanged');
  assert.strictEqual(b4.value, '3', 'the copied formula must be recalculated in the target cell');
  assert.strictEqual(b4.style.fontWeight, 'bold', 'the source style must be copied too');
  assert.notStrictEqual(b4.style, sandbox.localSheets.Sheet1.B2.style,
    'the copied style must be a clone, not a shared object');
});

test('an upward fill tiles from the base\'s bottom edge, and leftward from its right edge', () => {
  const { sandbox, cellById, fire, fireWindow } = setUpFillDrag({
    B2: { value: 'top', formula: '', style: {} }, C2: { value: 'x', formula: '', style: {} },
    B3: { value: 'bottom', formula: '', style: {} }, C3: { value: 'y', formula: '', style: {} },
  });

  fire('mouseover', cellById.get('B1')); // extend up one row
  fireWindow('mouseup');

  const s = sandbox.localSheets.Sheet1;
  assert.strictEqual(s.B1.value, 'bottom', 'the row above the base must repeat the base\'s LAST row (aligned tiling)');
  assert.strictEqual(s.C1.value, 'y');
});

test('filling a formula down rewrites its relative references (C1 =A1+B1 → C2 =A2+B2)', () => {
  const { sandbox, cellById, elById, fire, fireWindow } = createSandbox();
  sandbox.localSheets = { Sheet1: {
    A1: { value: '1', formula: '', style: {} }, B1: { value: '2', formula: '', style: {} },
    C1: { value: '3', formula: '=A1+B1', style: {} },
    A2: { value: '4', formula: '', style: {} }, B2: { value: '5', formula: '', style: {} },
    A3: { value: '7', formula: '', style: {} }, B3: { value: '1', formula: '', style: {} },
  } };
  sandbox.activeSheetName = 'Sheet1';
  sandbox.renderSpreadsheetGrid();

  // Select the single formula cell, then grab its fill handle (fabricated, as
  // in setUpFillDrag — the stub doesn't parse the overlay's innerHTML).
  fire('mousedown', cellById.get('C1'));
  fireWindow('mouseup');
  const overlay = elById.get('selection-range-overlay');
  assert.ok(overlay, 'the selection overlay should exist for a single selected cell');
  const handle = sandbox.document.createElement();
  handle.className = 'fill-handle';
  overlay.appendChild(handle);
  fire('mousedown', handle);

  fire('mouseover', cellById.get('C3')); // drag down two rows
  fireWindow('mouseup');

  const s = sandbox.localSheets.Sheet1;
  assert.strictEqual(s.C2.formula, '=A2+B2', 'the copy one row down must shift each relative reference down one row');
  assert.strictEqual(s.C2.value, '9', 'the shifted formula must be re-evaluated in the target cell (4+5)');
  assert.strictEqual(s.C3.formula, '=A3+B3');
  assert.strictEqual(s.C3.value, '8', 'each fill row shifts from the SOURCE cell by its own offset (7+1)');
  assert.strictEqual(s.C1.formula, '=A1+B1', 'the source cell must be untouched');
});

test('filling a formula sideways shifts its column references', () => {
  const { sandbox, cellById, fire, fireWindow } = setUpFillDrag({
    B2: { value: '1', formula: '', style: {} },
    C2: { value: '', formula: '=B2', style: {} },
  });

  fire('mouseover', cellById.get('E3')); // extend B2:C3 right to column E
  fireWindow('mouseup');

  const s = sandbox.localSheets.Sheet1;
  // E2 copies C2 two columns over, so its reference shifts B2 → D2; D2 itself
  // was tiled from B2 (plain value '1'), so the formula evaluates to '1'.
  assert.strictEqual(s.E2.formula, '=D2');
  assert.strictEqual(s.E2.value, '1');
});

test('"$"-pinned reference axes stay fixed while relative ones shift, and quoted text is untouched', () => {
  const { sandbox, cellById, fire, fireWindow } = setUpFillDrag({
    A1: { value: '10', formula: '', style: {} },
    A4: { value: '2', formula: '', style: {} },
    B2: { value: '', formula: '=$A$1+A2', style: {} },
    B3: { value: '', formula: '=CONCATENATE("A1",$A3)', style: {} },
  });

  fire('mouseover', cellById.get('C5')); // extend B2:C3 down two rows
  fireWindow('mouseup');

  const s = sandbox.localSheets.Sheet1;
  assert.strictEqual(s.B4.formula, '=$A$1+A4', 'a fully pinned $A$1 must not move; the relative A2 shifts with the copy');
  assert.strictEqual(s.B4.value, '12', 'the re-evaluated result must use the shifted reference (10+2)');
  assert.strictEqual(s.B5.formula, '=CONCATENATE("A1",$A5)',
    '"A1" inside a string literal must not be rewritten; $A3 pins its column but its row still shifts');
});

test('a reference pushed above row 1 by an upward fill becomes #REF!', () => {
  const { sandbox, cellById, fire, fireWindow } = setUpFillDrag({
    B2: { value: 'x', formula: '', style: {} },
    B3: { value: 'x', formula: '=B2', style: {} },
  });

  fire('mouseover', cellById.get('B1')); // extend up one row
  fireWindow('mouseup');

  // B1 tiles from the base's LAST row (B3), a -2 row offset: B2 → B0, which
  // does not exist, so the reference dies — same marker the row-delete
  // rewriter uses.
  assert.strictEqual(sandbox.localSheets.Sheet1.B1.formula, '=#REF!');
  assert.strictEqual(sandbox.localSheets.Sheet1.B1.value, '#REF!',
    'the dead reference must display as #REF!, not keep the source cell\'s stale value');
});

test('releasing a fill drag inside the base range writes nothing and records no undo entry', () => {
  const { sandbox, cellById, fire, fireWindow } = setUpFillDrag({
    B2: { value: '1', formula: '', style: {} },
  });

  fire('mouseover', cellById.get('C7')); // out…
  fire('mouseover', cellById.get('C2')); // …and back inside the base
  fireWindow('mouseup');

  const s = sandbox.localSheets.Sheet1;
  assert.strictEqual(s.B4, undefined, 'no cells outside the base range may be written');
  assert.strictEqual(s.B2.value, '1');
});
