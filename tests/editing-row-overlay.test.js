process.env.NODE_ENV = 'test';

/**
 * @file editing-row-overlay.test.js
 * @description While a cell is being edited its box grows with the lines the editor
 * shows, and the row track grows with it -- growth the model cannot predict, because
 * the model is built from stored values and an open edit has stored nothing yet. The
 * selection frame is sized from the model, so it stayed at the height the row had
 * before the break and no longer enclosed the cell (#244).
 *
 * That one row is measured instead for as long as the edit is open. These tests
 * drive resolvedRowHeight, which is the seam: everything the frame is built from
 * goes through it. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** A DOM element stub with a settable measured height. */
function el() {
  const classes = new Set();
  return {
    nodeName: 'DIV', nodeType: 1,
    children: [], childNodes: [], attributes: {}, style: {},
    className: '', value: '', textContent: '', innerText: '', innerHTML: '',
    offsetHeight: 21, offsetWidth: 100,
    scrollWidth: 0, scrollHeight: 0, clientWidth: 0, clientHeight: 600,
    scrollTop: 0, scrollLeft: 0,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : force; if (on) classes.add(c); else classes.delete(c); return on; }
    },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return this.attributes[n] != null ? this.attributes[n] : null; },
    removeAttribute(n) { delete this.attributes[n]; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    append(...c) { c.forEach((x) => this.appendChild(x)); },
    remove() {}, addEventListener() {}, focus() {}, blur() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelectorAll: () => [], querySelector: () => null,
    get firstElementChild() { return this.children[0] || null; },
  };
}

function createSandbox() {
  const byId = {};
  for (const id of ['grid-vscroll', 'grid-hscroll']) {
    byId[id] = el();
    byId[id].appendChild(el());
  }
  const sandbox = {
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {},
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el())),
      createElement: () => el(),
      createDocumentFragment: () => el(),
      createRange: () => ({ selectNodeContents() {}, collapse() {}, setStart() {}, setEnd() {} }),
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {},
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: () => ({ color: '' }),
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i ? i.detail : null; } },
    requestAnimationFrame: () => {},
    setTimeout: () => {}, clearTimeout: () => {}, queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    globalThis.render = renderSpreadsheetGrid;
    globalThis.seedCells = (cells) => { for (const id in cells) localCells[id] = cells[id]; };
    globalThis.startEdit = startCellInlineEdit;
    globalThis.measuredRowHeight = (r) => resolvedRowHeight(r);
    globalThis.modelRowHeight = (r) => getRowHeight(r);
    globalThis.rowHeaderEl = (r) => getRowHeaderEl(r);
    globalThis.isWindowed = () => activeSheetWindowed;
  `, sandbox);
  sandbox.byId = byId;
  return sandbox;
}

/** Opens an edit on a cell, the way a double-click does. */
function openEdit(s, cellId) {
  const cellEl = el();
  cellEl.setAttribute('data-cell-id', cellId);
  s.startEdit(cellId, cellEl);
  return cellEl;
}

test('the row under an open edit is measured, not modelled', () => {
  // --- Arrange: a windowed sheet, where every other row comes from the model ---
  const s = createSandbox();
  s.render();
  assert.strictEqual(s.isWindowed(), true, 'precondition: the sheet is windowed');
  const header = s.rowHeaderEl(5);
  assert.ok(header, 'precondition: row 5 has a header to measure');

  // --- Act: open an edit on row 5, and let the browser grow the track ---
  openEdit(s, 'B5');
  header.offsetHeight = 34;

  // --- Assert ---
  assert.strictEqual(s.measuredRowHeight(5), 34, 'row 5 reports what it is drawn at');
  assert.strictEqual(s.modelRowHeight(5), 21, 'while the model still says the default');
});

test('every other row still comes from the model', () => {
  // Measuring is a per-row exception, not a mode: reading a row's height must not
  // start costing a layout read again (#236, #234).
  const s = createSandbox();
  s.render();
  openEdit(s, 'B5');
  const other = s.rowHeaderEl(6);
  other.offsetHeight = 99;   // a height only a measurement could see

  // --- Assert ---
  assert.strictEqual(s.measuredRowHeight(6), 21, 'row 6 is modelled, so 99 is not read');
});

test('the row goes back to the model when the edit ends', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.render();
  const cellEl = openEdit(s, 'B5');
  const header = s.rowHeaderEl(5);
  header.offsetHeight = 34;
  assert.strictEqual(s.measuredRowHeight(5), 34, 'precondition: measured while editing');

  // --- Act: commit, the way clicking away does ---
  cellEl.onblur();

  // --- Assert: the committed value decides the height now, and it has no break ---
  assert.strictEqual(s.measuredRowHeight(5), 21, 'back to the modelled height');
});

test('a committed break is modelled, so the row stays tall without measuring', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ B5: { formula: '', value: 'alpha\nbeta', style: {} } });

  // --- Act ---
  s.render();

  // --- Assert: no edit is open, and the row is still two lines tall ---
  assert.ok(s.modelRowHeight(5) > 21, 'the model holds the height a break needs');
  assert.strictEqual(s.measuredRowHeight(5), s.modelRowHeight(5),
    'and that is what the frame is built from');
});
