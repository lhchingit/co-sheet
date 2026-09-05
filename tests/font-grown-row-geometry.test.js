process.env.NODE_ENV = 'test';

/**
 * @file font-grown-row-geometry.test.js
 * @description The selection overlay is drawn from the model (colLeft / rowTop /
 * getRowHeight), not from a measured cell box, so the model has to know how tall a
 * large-font row is. Two things broke that (#224): autoFontRowHeights was rebuilt
 * only inside renderSpreadsheetGrid, which a font-size change never reaches, and
 * getCellMinHeight modelled the cell box with a flat 10px padding while the CSS
 * uses 0.2em — so above ~17pt the track grew past what the model believed. Either
 * one leaves the frame the wrong height and every selection below the edited row
 * drawn too high. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** A DOM element stub with the surface renderSpreadsheetGrid touches. */
function el() {
  const node = {
    children: [], attributes: {}, style: {}, textContent: '', innerText: '',
    className: '', value: '', offsetHeight: 21, offsetWidth: 100,
    scrollWidth: 10, clientWidth: 100, scrollTop: 0, scrollLeft: 0, clientHeight: 600,
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

function createSandbox() {
  const byId = {};
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el())),
      createElement: () => el(),
      createDocumentFragment: () => el(),
      querySelectorAll: () => [],
      querySelector: () => null,
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
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Function
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    // localCells is a Proxy onto localSheets[activeSheetName], so cells have to be
    // written THROUGH it — replacing the binding would cut the sheet model that
    // scanActiveSheetModel (and so the row-height map) reads from.
    globalThis.seedCells = (cells) => { for (const id in cells) localCells[id] = cells[id]; };
    globalThis.selectCell = (id) => {
      activeCellId = id;
      selectionStartCellId = id;
      selectionEndCellId = null;
      updateRangeSelectionUI();
    };
    globalThis.isWindowed = () => activeSheetWindowed;
    globalThis.renderSpreadsheetGrid = renderSpreadsheetGrid;
    globalThis.setCellFontSize = setCellFontSize;
    globalThis.getCellMinHeight = getCellMinHeight;
    globalThis.getRowHeight = getRowHeight;
    globalThis.rowTop = rowTop;
    globalThis.DEFAULT_ROW_HEIGHT = DEFAULT_ROW_HEIGHT;
    globalThis.PT_TO_PX = PT_TO_PX;
    globalThis.CELL_LINE_HEIGHT_FACTOR = CELL_LINE_HEIGHT_FACTOR;
    globalThis.CELL_VERTICAL_PADDING_EM = CELL_VERTICAL_PADDING_EM;
    globalThis.CELL_GRIDLINE_HEIGHT = CELL_GRIDLINE_HEIGHT;
  `, sandbox);

  sandbox.byId = byId;
  return sandbox;
}

/** Boots a windowed sheet holding one text cell at C5, with C5 selected. */
function sheetWithTextAtC5() {
  const s = createSandbox();
  s.seedCells({ C5: { formula: '', value: 'Hello', style: {} } });
  s.renderSpreadsheetGrid();
  assert.strictEqual(s.isWindowed(), true, 'the sheet is windowed (the case that regressed)');
  s.selectCell('C5');
  return s;
}

const overlayStyle = (s) => s.byId['selection-range-overlay'].style;

test('the modelled cell height matches the .grid-cell rule it stands for', () => {
  // --- Arrange: the CSS is the authority; the constants only mirror it ---
  const s = createSandbox();
  const css = fs.readFileSync(path.resolve('private/index.html'), 'utf8');
  const rule = css.slice(css.indexOf('.grid-cell {'));
  const lineHeight = /line-height:\s*([\d.]+);/.exec(rule);
  const padding = /padding:\s*([\d.]+)em\s/.exec(rule);

  // --- Assert: a unitless line-height and an em padding, both as modelled ---
  assert.ok(lineHeight, '.grid-cell pins a unitless line-height (not `normal`, which is font-dependent)');
  assert.strictEqual(Number(lineHeight[1]), s.CELL_LINE_HEIGHT_FACTOR, 'CELL_LINE_HEIGHT_FACTOR tracks the CSS');
  assert.ok(padding, '.grid-cell sets its vertical padding in em');
  assert.strictEqual(Number(padding[1]) * 2, s.CELL_VERTICAL_PADDING_EM, 'CELL_VERTICAL_PADDING_EM is the top + bottom padding');
});

test('the modelled height is never below the box the cell actually renders', () => {
  // --- Arrange ---
  const s = createSandbox();
  const box = (pt) => pt * s.PT_TO_PX * (s.CELL_LINE_HEIGHT_FACTOR + s.CELL_VERTICAL_PADDING_EM) + s.CELL_GRIDLINE_HEIGHT;

  for (const pt of [11, 12, 14, 16, 18, 20, 24, 36, 48, 72, 400]) {
    // --- Act ---
    const modelled = s.getCellMinHeight(pt);

    // --- Assert: at or above the real box, so the `auto` half of the row track
    //     never grows past the model — the residual the flat +10px padding left ---
    assert.ok(modelled >= box(pt), `${pt}pt: modelled ${modelled} < rendered ${box(pt).toFixed(2)}`);
    assert.ok(modelled - box(pt) < 1, `${pt}pt: modelled ${modelled} overshoots the rendered box`);
  }
});

test('a size whose box still fits the default row keeps the base height', () => {
  // --- Arrange ---
  const s = createSandbox();

  // --- Act & Assert ---
  assert.strictEqual(s.getCellMinHeight(9), null, '9pt fits the 21px default');
  assert.ok(s.getCellMinHeight(11) > s.DEFAULT_ROW_HEIGHT, '11pt does not, so it grows the row');
});

test('raising a font size updates the row model without waiting for a render', () => {
  // --- Arrange ---
  const s = sheetWithTextAtC5();
  assert.strictEqual(s.getRowHeight(5), s.DEFAULT_ROW_HEIGHT, 'row 5 starts at the default height');

  // --- Act: the toolbar path, which never re-renders the grid ---
  s.setCellFontSize('C5', 36);

  // --- Assert ---
  assert.strictEqual(s.getRowHeight(5), s.getCellMinHeight(36), 'the model knows row 5 grew');
});

test('the selection frame follows the row it just grew', () => {
  // --- Arrange ---
  const s = sheetWithTextAtC5();

  // --- Act ---
  s.setCellFontSize('C5', 36);

  // --- Assert: setCellFontSize re-measures the selection as its last step ---
  assert.strictEqual(overlayStyle(s).height, `${s.getCellMinHeight(36)}px`,
    'the frame is as tall as the cell (it stayed 21px before #224)');
  assert.strictEqual(overlayStyle(s).top, `${5 * s.DEFAULT_ROW_HEIGHT}px`,
    'and still sits on row 5 (the header band plus the four rows above it)');
});

test('a selection below a grown row is not drawn too high', () => {
  // --- Arrange ---
  const s = sheetWithTextAtC5();
  s.setCellFontSize('C5', 36);

  // --- Act: select a cell further down the same column ---
  s.selectCell('C10');

  // --- Assert: the header band, rows 1-9 above it, one of them grown ---
  const expectedTop = 9 * s.DEFAULT_ROW_HEIGHT + s.getCellMinHeight(36);
  assert.strictEqual(s.rowTop(10), expectedTop,
    'rowTop counts the grown row (it was short by that row growth before #224)');
  assert.strictEqual(overlayStyle(s).top, `${expectedTop}px`, 'and the frame lands on the cell');
});

test('clearing the larger font gives the row its default height back', () => {
  // --- Arrange ---
  const s = sheetWithTextAtC5();
  s.setCellFontSize('C5', 36);
  assert.strictEqual(s.getRowHeight(5), s.getCellMinHeight(36), 'row 5 is grown');

  // --- Act: back to a size whose box fits the base row again ---
  s.setCellFontSize('C5', 9);

  // --- Assert: a shrink is picked up too, not just a growth ---
  assert.strictEqual(s.getRowHeight(5), s.DEFAULT_ROW_HEIGHT, 'row 5 is back to the default height');
  assert.strictEqual(s.rowTop(10), 10 * s.DEFAULT_ROW_HEIGHT, 'and so is everything below it');
});
