process.env.NODE_ENV = 'test';

/**
 * @file render-model-scan.test.js
 * @description A render derives three things from the active sheet's cells — the
 * rightmost populated column, the font-driven row heights, and whether any cell
 * wraps — and a scroll that moves the row window re-renders, so those walks ran on
 * every scroll frame. They are now one pass (scanActiveSheetModel), the column
 * count is published for the consumers that describe the rendered grid, and the
 * grid-template is only assigned when it actually changed. These tests pin the
 * behaviour each of those depends on. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** DOM element stub with the surface renderSpreadsheetGrid touches. */
function el(styleWrites) {
  const style = {};
  const node = {
    children: [], attributes: {}, textContent: '', innerText: '', className: '', value: '',
    offsetHeight: 21, offsetWidth: 100, scrollWidth: 10, clientWidth: 100,
    scrollTop: 0, scrollLeft: 0, clientHeight: 600,
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
  // Count assignments to the grid-template axes so an identical rewrite is visible.
  for (const axis of ['gridTemplateRows', 'gridTemplateColumns']) {
    let value = '';
    Object.defineProperty(style, axis, {
      get: () => value,
      set: (v) => { value = v; if (styleWrites) styleWrites[axis] = (styleWrites[axis] || 0) + 1; },
      configurable: true, enumerable: true
    });
  }
  node.style = style;
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; }, set(_v) { this.children.length = 0; }, configurable: true
  });
  return node;
}

function createSandbox() {
  const styleWrites = {};
  const byId = {};
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el(id === 'grid-root' ? styleWrites : null))),
      createElement: () => el(), createDocumentFragment: () => el(),
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: () => ({ color: '' }),
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i ? i.detail : null; } },
    requestAnimationFrame: () => {}, setTimeout: () => {}, clearTimeout: () => {},
    queueMicrotask: (fn) => fn(),
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
    Object.defineProperty(globalThis, 'renderedColCount', { get: () => renderedColCount, configurable: true });
    Object.defineProperty(globalThis, 'activeSheetWindowed', { get: () => activeSheetWindowed, configurable: true });
    globalThis.renderSpreadsheetGrid = renderSpreadsheetGrid;
    globalThis.scanActiveSheetModel = scanActiveSheetModel;
    globalThis.getRowHeight = getRowHeight;
    globalThis.getColCount = getColCount;
  `, sandbox);

  sandbox.styleWrites = styleWrites;
  sandbox.gridRoot = byId['grid-root'] || (byId['grid-root'] = el(styleWrites));
  // Replace the active sheet's cells (both views of them stay in sync).
  sandbox.setCells = (cells) => { sandbox.localCells = cells; sandbox.localSheets.Sheet1 = cells; };
  return sandbox;
}

test('one pass reports the rightmost column, font row heights and wrapped text', () => {
  // --- Arrange: data past Z, a large-font cell, and a wrapped cell ---
  const s = createSandbox();
  s.setCells({
    A1: { formula: '', value: 'plain', style: {} },
    AB4: { formula: '', value: 'far right', style: {} },
    B7: { formula: '', value: 'big', style: { fontSize: 36 } },
    C9: { formula: '', value: 'wrapped', style: { textWrap: 'wrap' } }
  });

  // --- Act ---
  const model = s.scanActiveSheetModel();

  // --- Assert ---
  assert.strictEqual(model.maxColIndex, 27, 'AB is column index 27');
  assert.ok(model.fontRowHeights[7] > 21, 'row 7 grows for its 36pt cell');
  assert.strictEqual(model.fontRowHeights[4], undefined, 'a default-font row does not grow');
  assert.strictEqual(model.hasWrappedRows, true, 'the wrapped cell is seen');
});

test('the scan skips ids that are not cell coordinates, as the old regex did', () => {
  const s = createSandbox();
  s.setCells({
    A1: { formula: '', value: '1', style: {} },
    ZZZ: { formula: '', value: 'no row number', style: {} },
    '9A': { formula: '', value: 'digits first', style: {} }
  });

  const model = s.scanActiveSheetModel();

  assert.strictEqual(model.maxColIndex, 25, 'only A1 counts, so the grid keeps its default width');
});

test('a render publishes the rendered column count and the font row heights', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.setCells({
    A1: { formula: '', value: 'x', style: {} },
    AA2: { formula: '', value: 'past Z', style: {} },
    A5: { formula: '', value: 'big', style: { fontSize: 36 } }
  });

  // --- Act ---
  s.renderSpreadsheetGrid();

  // --- Assert ---
  assert.strictEqual(s.renderedColCount, 27, 'the grid was built 27 columns wide (A..AA)');
  assert.ok(s.getRowHeight(5) > 21, 'the large-font row height is authoritative after the render');
  assert.strictEqual(s.getColCount(), 27, 'and agrees with the model-derived count');
});

test('the rendered column count describes the grid, not a model that has since grown', () => {
  // The selection highlight and the overflow spill read this: a column the model
  // has grown but no render has built is not on screen to highlight or spill into.
  const s = createSandbox();
  s.setCells({ A1: { formula: '', value: 'x', style: {} } });
  s.renderSpreadsheetGrid();
  assert.strictEqual(s.renderedColCount, 26, 'the default grid width');

  // The model grows, with no render yet.
  s.localCells.BA9 = { formula: '', value: 'way out', style: {} };
  assert.strictEqual(s.renderedColCount, 26, 'still describes what was rendered');

  s.renderSpreadsheetGrid();
  assert.strictEqual(s.renderedColCount, 53, 'and catches up on the next render');
});

test('a wrapped cell turns windowing off, so its rows are all rendered', () => {
  const s = createSandbox();
  s.setCells({ A1: { formula: '', value: 'x', style: {} } });
  s.renderSpreadsheetGrid();
  assert.strictEqual(s.activeSheetWindowed, true, 'a plain sheet is windowed');

  s.localCells.B2 = { formula: '', value: 'wrapped', style: { textWrap: 'wrap' } };
  s.renderSpreadsheetGrid();
  assert.strictEqual(s.activeSheetWindowed, false, 'wrapped text falls back to the full render');
});

test('an unchanged re-render does not rewrite the grid template', () => {
  // A scroll re-renders, and the row template is a 1000-track string identical
  // across all of those renders; assigning it anyway invalidates style and layout
  // for the whole grid on every scroll frame.
  const s = createSandbox();
  s.setCells({ A1: { formula: '', value: 'x', style: {} } });

  s.renderSpreadsheetGrid();
  const afterFirst = { ...s.styleWrites };
  assert.ok(afterFirst.gridTemplateRows >= 1, 'the first render writes the template');

  s.renderSpreadsheetGrid();
  s.renderSpreadsheetGrid();

  assert.strictEqual(s.styleWrites.gridTemplateRows, afterFirst.gridTemplateRows,
    'further renders with the same model do not touch the row template');
  assert.strictEqual(s.styleWrites.gridTemplateColumns, afterFirst.gridTemplateColumns,
    'nor the column template');
});
