process.env.NODE_ENV = 'test';

/**
 * @file row-offset-prefix.test.js
 * @description rowTop and computeVisibleRows used to answer by adding row heights up
 * from row 1, so both cost O(rows above the answer) — the last per-row work on the
 * scroll and drag paths (#234). They now read a cached prefix-sum array, keyed on the
 * same signal as the row template so one rule invalidates both.
 *
 * The load-bearing property is that the fast paths are *indistinguishable* from the
 * loops they replaced, so most of this file compares them against a reference
 * implementation of the original walk over sheets with resized rows, font-grown rows
 * and neither. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** A DOM element stub with a real classList and settable box metrics. */
function el() {
  const classes = new Set();
  const node = {
    children: [], attributes: {}, style: {}, textContent: '', innerText: '',
    className: '', value: '', offsetHeight: 21, offsetWidth: 100,
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
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    remove() {}, addEventListener() {}, focus() {}, blur() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelectorAll: () => [], querySelector: () => null,
    get firstElementChild() { return this.children[0] || null; }
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; }, set(_v) { this.children.length = 0; }, configurable: true
  });
  return node;
}

function createSandbox() {
  const byId = {};
  for (const id of ['grid-vscroll', 'grid-hscroll']) {
    byId[id] = el();
    byId[id].appendChild(el());
  }
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el())),
      createElement: () => el(),
      createDocumentFragment: () => el(),
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
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Proxy, Reflect
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    globalThis.render = renderSpreadsheetGrid;
    globalThis.rowTop = rowTop;
    globalThis.computeVisibleRows = computeVisibleRows;
    globalThis.resolvedRowHeight = resolvedRowHeight;
    globalThis.getRowHeight = (r) => getRowHeight(r);
    globalThis.getRowCount = getRowCount;
    globalThis.addRows = (n) => setActiveRowCount(getRowCount() + n);
    globalThis.setRowHeights = (v) => { rowHeights = v; };
    globalThis.setAutoFontRowHeights = (v) => { autoFontRowHeights = v; };
    globalThis.setSheet = (v) => { activeSheetName = v; };
    globalThis.sheetName = () => activeSheetName;
    globalThis.isWindowed = () => activeSheetWindowed;
    globalThis.seedCells = (cells) => { for (const id in cells) localCells[id] = cells[id]; };
    globalThis.DEFAULT_ROW_HEIGHT = DEFAULT_ROW_HEIGHT;
  `, sandbox);

  sandbox.byId = byId;
  sandbox.viewport = byId['grid-viewport'] || (byId['grid-viewport'] = el());

  /** The original walk, kept here as the answer the fast path has to reproduce. */
  sandbox.referenceRowTop = (row) => {
    let y = sandbox.DEFAULT_ROW_HEIGHT;
    for (let r = 1; r < row; r++) y += sandbox.resolvedRowHeight(r);
    return y;
  };
  sandbox.referenceVisibleRows = () => {
    const top = sandbox.viewport.scrollTop;
    const bottom = top + sandbox.viewport.clientHeight;
    let y = sandbox.DEFAULT_ROW_HEIGHT;
    let start = 1, end = sandbox.getRowCount();
    for (let r = 1; r <= sandbox.getRowCount(); r++) {
      const h = sandbox.getRowHeight(r);
      if (y + h <= top) start = r + 1;
      else if (y >= bottom) { end = r - 1; break; }
      y += h;
    }
    return { start, end: Math.max(start, end) };
  };

  /** Sets explicit row heights on the active sheet. */
  sandbox.resizeRows = (heights) => {
    const map = Object.create(null);
    map[sandbox.sheetName()] = heights;
    sandbox.setRowHeights(map);
  };
  return sandbox;
}

/** The range as a plain local object: values that cross the vm realm boundary carry
 *  that realm's prototype, which deepStrictEqual compares. */
const range = (r) => ({ start: r.start, end: r.end });

/** Sheets whose row heights are shaped differently, to run the comparisons over. */
const shapes = {
  'a uniform sheet': () => {},
  'a sheet with resized rows': (s) => s.resizeRows({ 1: 60, 2: 40, 500: 120, 999: 33, 1000: 80 }),
  'a sheet with font-grown rows': (s) => s.setAutoFontRowHeights({ 3: 78, 250: 155, 1000: 45 }),
  'a sheet with both, overlapping': (s) => {
    s.resizeRows({ 5: 60, 250: 30 });
    s.setAutoFontRowHeights({ 5: 200, 250: 155, 700: 90 });
  },
};

test('rowTop returns exactly what the walk it replaced returned', () => {
  for (const [what, shape] of Object.entries(shapes)) {
    // --- Arrange ---
    const s = createSandbox();
    s.seedCells({ A1: { formula: '', value: '1', style: {} } });
    s.render();
    assert.strictEqual(s.isWindowed(), true, 'the fast path is the windowed one');
    shape(s);

    // --- Act & Assert: the boundaries, the sized rows, and a spread between ---
    for (const row of [1, 2, 3, 4, 5, 6, 250, 251, 499, 500, 501, 700, 999, 1000, 1001]) {
      assert.strictEqual(s.rowTop(row), s.referenceRowTop(row), `${what}: rowTop(${row})`);
    }
  }
});

test('rowTop past the last row keeps counting default-height rows, as the walk did', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ A1: { formula: '', value: '1', style: {} } });
  s.render();
  const n = s.getRowCount();

  // --- Act & Assert ---
  for (const row of [n, n + 1, n + 2, n + 10]) {
    assert.strictEqual(s.rowTop(row), s.referenceRowTop(row), `rowTop(${row}) past the end`);
  }
});

test('computeVisibleRows returns exactly what the walk it replaced returned', () => {
  for (const [what, shape] of Object.entries(shapes)) {
    // --- Arrange ---
    const s = createSandbox();
    s.seedCells({ A1: { formula: '', value: '1', style: {} } });
    s.render();
    shape(s);
    s.viewport.clientHeight = 600;

    // --- Act & Assert: the top, the end, and a sweep between — plus positions that
    //     land exactly on a row boundary, where the <= / >= comparisons decide ---
    const boundary = s.referenceRowTop(500) - s.DEFAULT_ROW_HEIGHT;
    const positions = [0, 1, 20, 21, 22, 100, boundary - 1, boundary, boundary + 1, 5000, 12345, 20979, 21000];
    for (const scrollTop of positions) {
      s.viewport.scrollTop = scrollTop;
      assert.deepStrictEqual(range(s.computeVisibleRows()), range(s.referenceVisibleRows()),
        `${what}: scrollTop ${scrollTop}`);
    }
  }
});

test('a viewport taller than the sheet still ends on the last row', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ A1: { formula: '', value: '1', style: {} } });
  s.render();
  s.viewport.clientHeight = 10_000_000;
  s.viewport.scrollTop = 0;

  // --- Act & Assert ---
  assert.deepStrictEqual(range(s.computeVisibleRows()), range(s.referenceVisibleRows()),
    'nothing is below the viewport, so the range runs to the end');
  assert.strictEqual(s.computeVisibleRows().end, s.getRowCount());
});

test('the offsets follow a resize, added rows and a sheet switch', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ A1: { formula: '', value: '1', style: {} } });
  s.render();
  const before = s.rowTop(600);

  // --- Act & Assert: a resize above the target moves it ---
  s.resizeRows({ 100: 200 });
  assert.strictEqual(s.rowTop(600), before + (200 - s.DEFAULT_ROW_HEIGHT), 'a resized row above shifts it down');
  assert.strictEqual(s.rowTop(600), s.referenceRowTop(600), 'and matches the walk');

  // --- Act & Assert: rows added below do not move it, but extend the range ---
  s.addRows(500);
  assert.strictEqual(s.rowTop(600), s.referenceRowTop(600), 'rows added below leave it where it was');
  assert.strictEqual(s.rowTop(1400), s.referenceRowTop(1400), 'and the new rows have offsets of their own');

  // --- Act & Assert: another sheet has its own heights ---
  s.setSheet('Sheet2');
  assert.strictEqual(s.rowTop(600), s.referenceRowTop(600), 'the other sheet is measured on its own');
});

test('nothing is recomputed while nothing changes', () => {
  // --- Arrange: count row-number lookups in the sheet's height map, which both the
  //     offsets build and the template build make one of per row ---
  const s = createSandbox();
  s.seedCells({ A1: { formula: '', value: '1', style: {} } });
  s.render();
  const counter = { reads: 0 };
  const map = Object.create(null);
  map[s.sheetName()] = new Proxy(Object.create(null), {
    get(t, k) {
      if (typeof k === 'string' && /^[0-9]+$/.test(k)) counter.reads++;
      return t[k];
    }
  });
  s.setRowHeights(map);
  s.rowTop(500);            // settle on the counting map
  counter.reads = 0;

  // --- Act: the drag-select and scroll paths, repeatedly ---
  for (let i = 0; i < 5; i++) {
    s.rowTop(900);
    s.viewport.scrollTop = 1000 + i;
    s.computeVisibleRows();
  }

  // --- Assert: the walk that used to run on each of these is gone entirely ---
  assert.strictEqual(counter.reads, 0, 'no row was walked');
});

test('without windowing the rendered box is still measured, not the model', () => {
  // --- Arrange: wrapped text forces the full render, where a row can grow in ways
  //     the model cannot predict — so the sums must not be used there ---
  const s = createSandbox();
  s.seedCells({ A1: { formula: '', value: 'wrapped', style: { textWrap: 'wrap' } } });
  s.render();
  assert.strictEqual(s.isWindowed(), false, 'a wrapped sheet is not windowed');

  // --- Act: give row 2's header a box taller than any modelled height ---
  const header = [...(function* walk(n) {
    for (const c of n.children || []) { yield c; yield* walk(c); }
  })(s.byId['grid-root'])].find((n) => n.getAttribute('data-row-id') === '2');
  assert.ok(header, 'row 2 is rendered');
  header.offsetHeight = 90;

  // --- Assert ---
  assert.strictEqual(s.rowTop(3), s.referenceRowTop(3), 'rowTop measures the box');
  assert.ok(s.rowTop(3) >= 90, 'and so picks up growth the model never saw');
});
