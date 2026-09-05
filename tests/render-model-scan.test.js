process.env.NODE_ENV = 'test';

/**
 * @file render-model-scan.test.js
 * @description A render derives three things from the active sheet's cells — the
 * rightmost populated column, the font-driven row heights, and whether any cell
 * wraps — and a scroll that moves the row window re-renders, so those walks ran on
 * every scroll frame. They are now one pass (scanActiveSheetModel), the column
 * count is published for the consumers that describe the rendered grid, the
 * grid-template is only assigned when it actually changed, and the text-overflow
 * pass iterates whichever of the model / rendered-cell collections is smaller.
 * These tests pin the behaviour each of those depends on. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/**
 * DOM element stub with the surface renderSpreadsheetGrid touches. A cell whose
 * id is in `overflowing` reports a scrollWidth wider than its box, which is how
 * the render decides to spill it across empty neighbours.
 */
function el(styleWrites, overflowing) {
  const style = {};
  const node = {
    children: [], attributes: {}, textContent: '', innerText: '', className: '', value: '',
    offsetHeight: 21, offsetWidth: 100, clientWidth: 100,
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
  Object.defineProperty(node, 'scrollWidth', {
    get() { return overflowing && overflowing.has(this.attributes['data-cell-id']) ? 400 : 10; },
    configurable: true
  });
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; }, set(_v) { this.children.length = 0; }, configurable: true
  });
  return node;
}

function createSandbox() {
  const styleWrites = {};
  const overflowing = new Set();
  const byId = {};
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el(id === 'grid-root' ? styleWrites : null, overflowing))),
      createElement: () => el(null, overflowing), createDocumentFragment: () => el(),
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
    globalThis.getCellEl = getCellEl;
    // Size of the index the last render built, so a test can assert WHICH
    // collection was the smaller one and therefore which branch ran.
    Object.defineProperty(globalThis, 'renderedCellCount', { get: () => gridCellIndex.size, configurable: true });
  `, sandbox);

  sandbox.styleWrites = styleWrites;
  // Cell ids the stub DOM should report as too wide for their box.
  sandbox.overflowing = overflowing;
  sandbox.gridRoot = byId['grid-root'] || (byId['grid-root'] = el(styleWrites, overflowing));
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

test('the overflow pass finds the same spill either way round', () => {
  // A spill candidate needs both an element and model content, so it can be found
  // from either collection; the render walks the smaller one. Both branches have
  // to reach the same cell, which is the whole point of being able to choose — so
  // each case here is sized to force a different branch.

  // --- Arrange: a sheet far bigger than one window, so the RENDERED set is the
  // smaller collection ---
  const windowed = createSandbox();
  const many = {};
  for (let r = 1; r <= 1000; r++) {
    for (const col of ['C', 'D', 'E']) many[`${col}${r}`] = { formula: '', value: 'x', style: {} };
  }
  many.A1 = { formula: '', value: 'a very long label', style: {} };
  windowed.setCells(many);
  windowed.overflowing.add('A1');

  // --- Act ---
  windowed.renderSpreadsheetGrid();

  // --- Assert ---
  assert.strictEqual(windowed.activeSheetWindowed, true, 'the sheet is windowed');
  assert.ok(
    windowed.renderedCellCount < Object.keys(windowed.localCells).length,
    `the rendered set is the smaller collection (${windowed.renderedCellCount} of 3001)`
  );
  assert.match(
    windowed.getCellEl('A1').style.clipPath || '', /inset/,
    'the overflowing cell spilled across its empty neighbours'
  );

  // --- Arrange: a wrapped cell forces the full render, so every row is built and
  // the MODEL becomes the smaller collection instead ---
  const full = createSandbox();
  full.setCells({
    A1: { formula: '', value: 'a very long label', style: {} },
    Z9: { formula: '', value: 'wrapped', style: { textWrap: 'wrap' } }
  });
  full.overflowing.add('A1');

  full.renderSpreadsheetGrid();

  assert.strictEqual(full.activeSheetWindowed, false, 'the full render built every row');
  assert.ok(
    full.renderedCellCount > Object.keys(full.localCells).length,
    `the model is the smaller collection (${full.renderedCellCount} rendered, 2 in the model)`
  );
  assert.match(
    full.getCellEl('A1').style.clipPath || '', /inset/,
    'and the same cell still spills'
  );
});

test('a wrap or clip cell never becomes a spill candidate, either way round', () => {
  // The filter has to survive the change of direction: wrapped and clipped cells
  // keep their text inside their own box.
  const s = createSandbox();
  s.setCells({
    A1: { formula: '', value: 'long but wrapped', style: { textWrap: 'wrap' } },
    A2: { formula: '', value: 'long but clipped', style: { textWrap: 'clip' } }
  });
  s.overflowing.add('A1').add('A2');

  s.renderSpreadsheetGrid();

  assert.ok(!s.getCellEl('A1').style.clipPath, 'a wrapped cell does not spill');
  assert.ok(!s.getCellEl('A2').style.clipPath, 'nor does a clipped one');
});
