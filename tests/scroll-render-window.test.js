process.env.NODE_ENV = 'test';

/**
 * @file scroll-render-window.test.js
 * @description A scroll used to rebuild the grid whenever the ideal row window
 * moved — and the window is derived from scrollTop, so that was once per row
 * scrolled: 100 rebuilds and ~136,000 element creations over a 100-row scroll.
 *
 * The overscan already builds rows either side of the viewport. The scroll handler
 * now spends that slack and rebuilds only as it runs out, which is what these tests
 * pin: no rebuild while the viewport has room, a rebuild before the edge is
 * actually reached, an immediate rebuild on a jump, and no rebuild loop at the ends
 * of the sheet where there is nothing left to build. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

const ROW_H = 21;

/** DOM element stub with the surface renderSpreadsheetGrid touches. */
function el() {
  const node = {
    children: [], attributes: {}, style: {}, textContent: '', innerText: '', className: '', value: '',
    offsetHeight: ROW_H, offsetWidth: 100, scrollWidth: 10, clientWidth: 100,
    scrollTop: 0, scrollLeft: 0, clientHeight: 30 * ROW_H,
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
    get() { return ''; }, set(_v) { this.children.length = 0; }, configurable: true
  });
  return node;
}

/** Boots the bundle with a hand-driven rAF and a render counter. */
function createSandbox() {
  const byId = {};
  const rafQueue = [];
  const counters = { created: 0 };

  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el())),
      createElement: () => { counters.created++; return el(); },
      createDocumentFragment: () => el(),
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: () => ({ color: '' }),
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i ? i.detail : null; } },
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    setTimeout: () => {}, clearTimeout: () => {}, queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells, set: (v) => { localCells = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'localSheets', {
      get: () => localSheets, set: (v) => { localSheets = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'renderedRowStart', { get: () => renderedRowStart, configurable: true });
    Object.defineProperty(globalThis, 'renderedRowEnd', { get: () => renderedRowEnd, configurable: true });
    globalThis.renderSpreadsheetGrid = renderSpreadsheetGrid;
    globalThis.onGridScrollWindow = onGridScrollWindow;
    globalThis.computeVisibleRows = computeVisibleRows;
    globalThis.WINDOW_OVERSCAN = WINDOW_OVERSCAN;
    globalThis.TOTAL_ROWS = TOTAL_ROWS;
  `, sandbox);

  sandbox.viewport = sandbox.document.getElementById('grid-viewport');
  sandbox.localCells = { A1: { formula: '', value: 'x', style: {} } };
  sandbox.localSheets.Sheet1 = sandbox.localCells;

  /**
   * Scroll to a row and run the frame the handler scheduled.
   * @returns {boolean} whether it rebuilt the grid.
   */
  sandbox.scrollToRow = (row) => {
    sandbox.viewport.scrollTop = row * ROW_H;
    const before = counters.created;
    sandbox.onGridScrollWindow();
    rafQueue.splice(0, rafQueue.length).forEach((fn) => fn());
    return counters.created > before;
  };
  sandbox.counters = counters;
  return sandbox;
}

test('scrolling within the built band does not rebuild the grid', () => {
  // --- Arrange: render once, somewhere with slack in both directions ---
  const s = createSandbox();
  s.viewport.scrollTop = 200 * ROW_H;
  s.renderSpreadsheetGrid();
  const { renderedRowStart: start, renderedRowEnd: end } = s;
  assert.ok(end - start > 30, 'the band covers the viewport with room either side');

  // --- Act: creep forward a row at a time, staying inside the band ---
  let rebuilds = 0;
  for (let row = 201; row <= 205; row++) if (s.scrollToRow(row)) rebuilds++;

  // --- Assert ---
  assert.strictEqual(rebuilds, 0, 'the rows were already built, so nothing was rebuilt');
  assert.strictEqual(s.renderedRowStart, start, 'and the band is unchanged');
});

test('a 100-row scroll rebuilds a handful of times, not once per row', () => {
  // The behaviour the change is for: this was 100 rebuilds and ~136,000 element
  // creations, one rebuild for every row scrolled.
  const s = createSandbox();
  s.viewport.scrollTop = 0;
  s.renderSpreadsheetGrid();
  s.counters.created = 0;

  let rebuilds = 0;
  for (let row = 1; row <= 100; row++) if (s.scrollToRow(row)) rebuilds++;

  assert.ok(rebuilds > 0, 'it does keep up with the viewport');
  assert.ok(rebuilds <= 10, `a 100-row scroll rebuilds ${rebuilds} times, not 100`);
});

test('the rebuild happens before the viewport reaches the edge of the band', () => {
  // The margin is what stops a blank edge appearing: the grid is rebuilt while
  // there are still rows built beyond the viewport, not once one is needed.
  const s = createSandbox();
  s.viewport.scrollTop = 200 * ROW_H;
  s.renderSpreadsheetGrid();

  let row = 201;
  while (row < 400 && !s.scrollToRow(row)) row++;

  const visible = s.computeVisibleRows();
  assert.ok(row < 400, 'a rebuild did happen as the viewport advanced');
  assert.ok(
    visible.end <= s.renderedRowEnd,
    'at the moment of the rebuild the viewport was still within what had been built'
  );
});

test('a jump far outside the band rebuilds immediately', () => {
  // A scrollbar drag or revealCell can land anywhere; the margins are irrelevant
  // when the viewport is not in the band at all.
  const s = createSandbox();
  s.viewport.scrollTop = 0;
  s.renderSpreadsheetGrid();

  const rebuilt = s.scrollToRow(700);

  assert.ok(rebuilt, 'the jump rebuilt the grid');
  const visible = s.computeVisibleRows();
  assert.ok(
    s.renderedRowStart <= visible.start && visible.end <= s.renderedRowEnd,
    `the new band covers the viewport (${s.renderedRowStart}-${s.renderedRowEnd} vs ${visible.start}-${visible.end})`
  );
});

test('the ends of the sheet do not rebuild on every scroll event', () => {
  // There is nothing above row 1 or below the last row, so the margin can never be
  // satisfied there. Requiring it anyway would rebuild on every scroll event for as
  // long as the user sat at either end.
  const s = createSandbox();
  s.viewport.scrollTop = 0;
  s.renderSpreadsheetGrid();
  assert.strictEqual(s.renderedRowStart, 1, 'the band starts at the top of the sheet');

  let rebuilds = 0;
  for (let i = 0; i < 5; i++) if (s.scrollToRow(1)) rebuilds++;
  assert.strictEqual(rebuilds, 0, 'sitting at the top rebuilds nothing');

  // And the same at the bottom.
  s.scrollToRow(s.TOTAL_ROWS - 5);
  rebuilds = 0;
  for (let i = 0; i < 5; i++) if (s.scrollToRow(s.TOTAL_ROWS - 5)) rebuilds++;
  assert.strictEqual(s.renderedRowEnd, s.TOTAL_ROWS, 'the band reaches the last row');
  assert.strictEqual(rebuilds, 0, 'sitting at the bottom rebuilds nothing');
});
