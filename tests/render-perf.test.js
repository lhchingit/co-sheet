/**
 * @file render-perf.test.js
 * @description Regression guards for the cost of a full grid rebuild
 * (renderSpreadsheetGrid in public/app.js). The grid is not virtualised, so every
 * render walks TOTAL_ROWS (1000) × colCount cells. Two structural properties keep
 * that affordable and must not regress:
 *
 *   1. Event delegation — cell mouse interactions are handled by ONE listener per
 *      event type on #grid-root, not four on every cell. Per-cell listeners meant
 *      ~100k addEventListener calls (and as many retained closures) on every
 *      rebuild. The listener count must stay bounded by the header count, not the
 *      cell count.
 *   2. Single attach — the grid is built into a DocumentFragment and added in ONE
 *      appendChild to #grid-root, so the browser lays out once rather than after
 *      each of the tens of thousands of element insertions.
 *
 * These are asserted with deterministic operation counts (no wall-clock timing),
 * via an instrumented DOM stub that loads the real client bundle.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** Build a vm sandbox whose DOM stub counts createElement / addEventListener /
 *  live appendChild, and expose renderSpreadsheetGrid + the sheet state. */
function createRenderSandbox() {
  const counters = { createElement: 0, addEventListener: 0, appendToGridRoot: 0 };
  let gridRoot = null;

  const makeEl = (counts) => {
    if (counts) counters.createElement++;
    const el = {
      nodeType: 1, tagName: 'div', style: {}, className: '', _children: [], _attrs: {},
      scrollWidth: 0, clientWidth: 100, clientHeight: 21,
      offsetWidth: 100, offsetHeight: 21, offsetLeft: 0, offsetTop: 0, scrollHeight: 0,
      firstElementChild: null,
      set innerHTML(v) { this._children.length = 0; this._ih = v; },
      get innerHTML() { return this._ih || ''; },
      set innerText(v) { this._it = v; }, get innerText() { return this._it || ''; },
      set textContent(v) { this._tc = v; }, get textContent() { return this._tc || ''; },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      removeAttribute(k) { delete this._attrs[k]; },
      addEventListener() { counters.addEventListener++; },
      removeEventListener() {},
      appendChild(c) { if (this === gridRoot) counters.appendToGridRoot++; this._children.push(c); c._parent = this; return c; },
      removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      contains() { return false; },
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
      get parentNode() { return this._parent || null; },
    };
    return el;
  };

  gridRoot = makeEl(false);

  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => (id === 'grid-root' ? gridRoot : null),
      createElement: () => makeEl(true),
      createDocumentFragment: () => makeEl(false), // not a node — don't count it
      querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
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
  `;
  vm.runInContext(readAppBundle() + exportSuffix, sandbox);

  // The post-render value-filter pass is DOM-heavy and unrelated to what we count.
  if (sandbox.window.CoSheet && sandbox.window.CoSheet.sortFilter) {
    sandbox.window.CoSheet.sortFilter.applyFilter = () => {};
    sandbox.window.CoSheet.sortFilter.updateToolbarButton = () => {};
  }

  return { sandbox, counters, reset: () => { counters.createElement = 0; counters.addEventListener = 0; counters.appendToGridRoot = 0; } };
}

const colLetterFor = (c) => {
  let s = ''; c += 1;
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
};

/** Render a fully data-filled, fully-bordered ROWS×COLS sheet once and report counts. */
function renderAndCount(rows, cols) {
  const { sandbox, counters, reset } = createRenderSandbox();
  const border = { color: '#000000', style: 'thick' };
  const cells = Object.create(null);
  for (let r = 1; r <= rows; r++)
    for (let c = 0; c < cols; c++)
      cells[`${colLetterFor(c)}${r}`] = { value: `${r}-${c}`, style: { borders: { top: border, right: border, bottom: border, left: border } } };
  sandbox.localSheets = { Sheet1: cells };
  sandbox.activeSheetName = 'Sheet1';

  sandbox.renderSpreadsheetGrid(); // warm
  reset();
  sandbox.renderSpreadsheetGrid(); // measured
  return { ...counters };
}

test('a full grid rebuild attaches in a single appendChild (DocumentFragment)', () => {
  const counts = renderAndCount(200, 26);
  assert.strictEqual(counts.appendToGridRoot, 1,
    `the whole grid must attach in one append, got ${counts.appendToGridRoot} — has it regressed to per-element live appends?`);
});

test('cell mouse listeners are delegated, not attached per cell', () => {
  // 26 columns over the full 1000-row grid: ~26k cells. With per-cell listeners
  // (4 each) this was ~104k addEventListener calls; delegation makes it constant
  // in the cell count — only the headers carry per-element listeners. Guard well
  // below the old figure so a reintroduced per-cell listener trips it immediately.
  const counts = renderAndCount(1000, 26);
  assert.ok(counts.addEventListener < 5000,
    `expected delegated listeners (~hundreds), got ${counts.addEventListener} — a per-cell listener has likely crept back in`);
});

test('listener count is bounded by headers, not cell count (delegation invariant)', () => {
  // Doubling the data-bearing rows must not increase the listener count: data
  // cells add no listeners under delegation. (Both render the same 1000-row grid;
  // only the populated-cell count differs.)
  const few = renderAndCount(50, 26).addEventListener;
  const many = renderAndCount(900, 26).addEventListener;
  assert.strictEqual(few, many,
    `listener count must not grow with cell count (got ${few} vs ${many}) — delegation has regressed`);
});
