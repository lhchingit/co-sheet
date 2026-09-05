process.env.NODE_ENV = 'test';

/**
 * @file grid-element-lookup.test.js
 * @description The cell/row/column element indexes are the only source a lookup
 * needs once a render has run: the three data attributes are written in exactly
 * one place, by the same pass that fills the maps. Before #197 a miss fell through
 * to a full-document querySelector, which windowing turned from "never happens"
 * into "happens for every off-window row" — rowTop walks every row above its
 * target and runs on each mousemove of a drag-select. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** A DOM element stub with the surface renderSpreadsheetGrid touches. */
function el() {
  const node = {
    children: [], attributes: {}, style: {}, textContent: '', innerText: '',
    className: '', value: '', offsetHeight: 21, offsetWidth: 100,
    scrollWidth: 10, clientWidth: 100, scrollTop: 0, scrollLeft: 0,
    clientHeight: 600, clientWidth_: 800,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return this.attributes[n] != null ? this.attributes[n] : null; },
    removeAttribute(n) { delete this.attributes[n]; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    remove() {}, addEventListener() {}, focus() {}, blur() {},
    querySelectorAll: () => [], querySelector: () => null,
    get firstElementChild() { return this.children[0] || null; }
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; },
    set(_v) { this.children.length = 0; },   // the render clears grid-root this way
    configurable: true
  });
  return node;
}

/** Boots the bundle with a counting document.querySelector and a usable grid root. */
function createSandbox() {
  const counters = { querySelector: 0 };
  const byId = { 'grid-root': el(), 'grid-viewport': el() };

  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el())),
      createElement: () => el(),
      createDocumentFragment: () => el(),
      querySelectorAll: () => [],
      querySelector() { counters.querySelector++; return null; },
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
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells, set: (v) => { localCells = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'activeSheetWindowed', { get: () => activeSheetWindowed, configurable: true });
    globalThis.renderSpreadsheetGrid = renderSpreadsheetGrid;
    globalThis.rowTop = rowTop;
    globalThis.getCellEl = getCellEl;
    globalThis.getRowHeaderEl = getRowHeaderEl;
    globalThis.resolvedRowHeight = resolvedRowHeight;
    globalThis.DEFAULT_ROW_HEIGHT = DEFAULT_ROW_HEIGHT;
  `, sandbox);

  // Ignore anything the bundle's own start-up looked up; only what a test does.
  counters.querySelector = 0;
  sandbox.counters = counters;
  return sandbox;
}

test('before any render a lookup still resolves through the document', () => {
  // --- Arrange: the index is legitimately empty, so the scan is the only source ---
  const s = createSandbox();

  // --- Act ---
  s.getCellEl('A1');
  s.getRowHeaderEl(5);

  // --- Assert ---
  assert.strictEqual(s.counters.querySelector, 2, 'the pre-render fallback is intact');
});

test('after a render, geometry over a windowed sheet issues no document queries', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.localCells = { A1: { formula: '', value: '1', style: {} } };
  s.renderSpreadsheetGrid();
  assert.strictEqual(s.activeSheetWindowed, true, 'the sheet is windowed (the case that regressed)');
  s.counters.querySelector = 0;

  // --- Act: the drag-select path, at a row far below the rendered window ---
  const top = s.rowTop(800);

  // --- Assert ---
  assert.strictEqual(
    s.counters.querySelector, 0,
    'rowTop scans the document zero times (it issued 799 full-document scans before #197)'
  );
  // 799 rows above it, all at the default height, below the column-header band.
  assert.strictEqual(top, s.DEFAULT_ROW_HEIGHT + 799 * s.DEFAULT_ROW_HEIGHT, 'and still returns the model offset');
});

test('after a render, a lookup for an unbuilt cell returns null without scanning', () => {
  // Windowing means most cells are legitimately absent; a miss is an answer, not
  // a reason to search. The data attributes are written only by the render that
  // fills the index, so nothing the index lacks can be in the DOM.
  const s = createSandbox();
  s.localCells = { A1: { formula: '', value: '1', style: {} } };
  s.renderSpreadsheetGrid();
  s.counters.querySelector = 0;

  assert.strictEqual(s.getCellEl('A900'), null, 'an off-window cell resolves to null');
  assert.strictEqual(s.getRowHeaderEl(900), null, 'so does its row header');
  assert.strictEqual(s.counters.querySelector, 0, 'and neither scanned the document');
});

test('a bulk update over off-window cells scans nothing', () => {
  // updateGridDOMCell looks a cell up per edited cell; a 500-cell paste used to
  // mean 500 full-document scans.
  const s = createSandbox();
  s.localCells = { A1: { formula: '', value: '1', style: {} } };
  s.renderSpreadsheetGrid();
  s.counters.querySelector = 0;

  for (let r = 1; r <= 500; r++) s.getCellEl(`A${r}`);

  assert.strictEqual(s.counters.querySelector, 0, '500 lookups, zero document scans');
});
