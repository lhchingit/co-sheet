/**
 * @file format-recalc.test.js
 * @description Regression guard for #98: style-only formatting operations must
 * NOT trigger a full-sheet formula recalculation.
 *
 * recalculateSheet() walks every formula cell in the active sheet and re-runs
 * evaluateFormula. A style change (bold, colour, number format, alignment, font
 * size, link, …) never alters a cell value — formulas read referenced cells'
 * *values*, not their styles — so a recalc on those paths is pure wasted work
 * whose cost scales with the sheet's formula count.
 *
 * recalculateSheet captures evaluateFormula via destructuring at module load, so
 * it can't be spied from outside. Instead we use a "stale value" probe: a formula
 * cell is seeded with a deliberately wrong stored value. A recalc would recompute
 * it to the correct value; if the op leaves it stale, no recalc ran.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

function stubEl() {
  return {
    nodeType: 1, style: {}, className: '', _attrs: {}, firstElementChild: null,
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { return c; }, removeChild(c) { return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    contains() { return false; }, focus() {}, select() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    get parentNode() { return null; },
    set innerHTML(v) {}, get innerHTML() { return ''; },
    set innerText(v) {}, get innerText() { return ''; },
    set textContent(v) {}, get textContent() { return ''; },
  };
}

/** A minimal DOM sandbox running the real client bundle. We only assert on
 *  localSheets state, so DOM mutations are no-ops (getCellEl resolves nothing). */
function createSandbox() {
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: () => stubEl(),
      createElement: () => stubEl(),
      createDocumentFragment: () => stubEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { classList: { add() {}, remove() {} } },
    },
    WebSocket: class { constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    setTimeout: () => 0, clearTimeout: () => {}, queueMicrotask: (fn) => fn(), requestAnimationFrame: () => 0,
    console, Math, parseFloat, parseInt, isNaN, isFinite, String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Proxy, Reflect,
  };
  vm.createContext(sandbox);

  const exportSuffix = `
    globalThis.toggleFormat = toggleFormat;
    globalThis.toggleBorder = toggleBorder;
    globalThis.changeCellColor = changeCellColor;
    globalThis.changeCellTextColor = changeCellTextColor;
    globalThis.setCellNumberFormat = setCellNumberFormat;
    globalThis.adjustCellDecimals = adjustCellDecimals;
    globalThis.setCellTextWrap = setCellTextWrap;
    globalThis.setCellFont = setCellFont;
    globalThis.setCellFontSize = setCellFontSize;
    globalThis.setCellAlignment = setCellAlignment;
    globalThis.setCellVerticalAlignment = setCellVerticalAlignment;
    globalThis.changeCellLink = changeCellLink;
    globalThis.saveCellUpdate = saveCellUpdate;
    globalThis.clearCell = clearCell;
    Object.defineProperty(globalThis, 'localSheets', { get: () => localSheets, set: (v) => { localSheets = v; }, configurable: true });
    Object.defineProperty(globalThis, 'activeSheetName', { get: () => activeSheetName, set: (v) => { activeSheetName = v; }, configurable: true });
    Object.defineProperty(globalThis, 'activeCellId', { get: () => activeCellId, set: (v) => { activeCellId = v; }, configurable: true });
    Object.defineProperty(globalThis, 'canEditWorkbook', { get: () => canEditWorkbook, set: (v) => { canEditWorkbook = v; }, configurable: true });
  `;
  vm.runInContext(readAppBundle() + exportSuffix, sandbox);
  if (sandbox.window.CoSheet && sandbox.window.CoSheet.sortFilter) {
    sandbox.window.CoSheet.sortFilter.applyFilter = () => {};
    sandbox.window.CoSheet.sortFilter.updateToolbarButton = () => {};
  }
  return sandbox;
}

/** A1 = 5 (data); B1 = =A1 but seeded STALE; C1 = a plain styling target. */
function seedStaleSheet(sandbox) {
  sandbox.localSheets = {
    Sheet1: Object.assign(Object.create(null), {
      A1: { formula: '', value: '5', style: {} },
      B1: { formula: '=A1', value: 'STALE', style: {} },
      C1: { formula: '', value: 'hi', style: {} },
    }),
  };
  sandbox.activeSheetName = 'Sheet1';
  sandbox.activeCellId = null; // skip the toolbar-sync branch (DOM-only)
  sandbox.canEditWorkbook = true;
}

const styleOnlyOps = [
  ['toggleFormat', (s) => s.toggleFormat('C1', 'bold')],
  ['toggleBorder', (s) => s.toggleBorder('C1')],
  ['changeCellColor', (s) => s.changeCellColor('C1', '#ff0000')],
  ['changeCellTextColor', (s) => s.changeCellTextColor('C1', '#00ff00')],
  ['setCellNumberFormat', (s) => s.setCellNumberFormat('C1', 'percent')],
  ['adjustCellDecimals', (s) => s.adjustCellDecimals('A1', 1)],
  ['setCellTextWrap', (s) => s.setCellTextWrap('C1', 'wrap')],
  ['setCellFont', (s) => s.setCellFont('C1', 'Arial')],
  ['setCellFontSize', (s) => s.setCellFontSize('C1', 18)],
  ['setCellAlignment', (s) => s.setCellAlignment('C1', 'center')],
  ['setCellVerticalAlignment', (s) => s.setCellVerticalAlignment('C1', 'bottom')],
  ['changeCellLink', (s) => s.changeCellLink('C1', 'https://example.com')],
];

for (const [name, run] of styleOnlyOps) {
  test(`${name} does not trigger a sheet recalc`, () => {
    const sandbox = createSandbox();
    seedStaleSheet(sandbox);
    run(sandbox);
    assert.strictEqual(
      sandbox.localSheets.Sheet1.B1.value, 'STALE',
      `${name} must not recalc the sheet — the stale dependent formula value would have been recomputed`,
    );
  });
}

test('a value change still recalculates dependent formulas (control)', () => {
  const sandbox = createSandbox();
  seedStaleSheet(sandbox);
  sandbox.saveCellUpdate('A1', '42'); // changes A1's value
  assert.notStrictEqual(
    sandbox.localSheets.Sheet1.B1.value, 'STALE',
    'saveCellUpdate must recalc so the dependent =A1 follows its dependency',
  );
  assert.strictEqual(
    String(sandbox.localSheets.Sheet1.B1.value), '42',
    'the recomputed =A1 must equal A1\'s new value',
  );
});

test('clearing a cell still recalculates dependent formulas (control)', () => {
  const sandbox = createSandbox();
  seedStaleSheet(sandbox);
  sandbox.clearCell('A1'); // wipes A1's value
  assert.notStrictEqual(
    sandbox.localSheets.Sheet1.B1.value, 'STALE',
    'clearCell must recalc so the dependent =A1 reflects the cleared source',
  );
});
