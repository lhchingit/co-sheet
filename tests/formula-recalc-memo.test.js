process.env.NODE_ENV = 'test';

/**
 * @file formula-recalc-memo.test.js
 * @description A recalc pass evaluates each formula cell once (see the memo in
 * getCellValue), and circular references are detected by the coords on the
 * evaluation stack rather than by a recursion-depth counter. Before that, a cell
 * referencing two others doubled the work per level — 30 rows of =A(n-1)+A(n-2)
 * cost 2.18M evaluations and five seconds per keystroke — and the counter's cap of
 * 50 reported #REF! for a plain chain from its 53rd cell down. Follows the AAA
 * pattern. See #191.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';
import { createMockElement } from './helpers/cell-editor-sandbox.js';

/** Boots the bundle and counts every cell lookup the formula engine performs. */
function createSandbox() {
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: () => createMockElement(),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
      createElement: () => createMockElement(),
      body: { appendChild() {}, classList: { add() {}, remove() {} } }
    },
    getComputedStyle: () => ({ color: '' }),
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    setTimeout: () => {}, clearTimeout: () => {}, queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells, set: (v) => { localCells = v; }, configurable: true
    });
    globalThis.getCellValue = getCellValue;
    globalThis.recalculateSheet = recalculateSheet;
  `, sandbox);

  // Count the lookups the engine makes back into the sheet — the quantity that
  // used to grow exponentially. Wrapping the resolver leaves the memo (which
  // lives inside getCellValue) in play, so this measures real work done.
  sandbox.resolves = 0;
  const appResolver = sandbox.getCellValue;
  sandbox.window.CoSheet.formula.setCellResolver((coord, depth, sheet) => {
    sandbox.resolves++;
    return appResolver(coord, depth, sheet);
  });
  return sandbox;
}

test('a fan-out sheet recalculates in work proportional to its size, not exponential', () => {
  // --- Arrange: 30 rows of =A(n-1)+A(n-2), the shape that took five seconds ---
  const s = createSandbox();
  const cells = { A1: { formula: '', value: '1', style: {} }, A2: { formula: '', value: '1', style: {} } };
  for (let r = 3; r <= 30; r++) cells[`A${r}`] = { formula: `=A${r - 1}+A${r - 2}`, value: '', style: {} };
  s.localCells = cells;

  // --- Act ---
  s.recalculateSheet();

  // --- Assert ---
  assert.strictEqual(s.localCells.A30.value, '832040', 'the chain still computes the right answer');
  // Two references per formula, 28 formulas: ~56 lookups. The bound is loose
  // enough not to be brittle and tight enough that a return of the exponential
  // blow-up (2,178,278 lookups for this sheet) fails loudly.
  assert.ok(
    s.resolves < 500,
    `each cell is evaluated about once (${s.resolves} lookups for 28 formulas)`
  );
});

test('a long chain of references keeps its values instead of turning into #REF!', () => {
  // --- Arrange: a plain 80-long chain; nothing circular anywhere in it ---
  const s = createSandbox();
  const cells = { B1: { formula: '', value: '1', style: {} } };
  for (let r = 2; r <= 80; r++) cells[`B${r}`] = { formula: `=B${r - 1}+1`, value: '', style: {} };
  s.localCells = cells;

  // --- Act ---
  s.recalculateSheet();

  // --- Assert ---
  // B53 was the first cell the old depth counter (capped at 50) gave up on.
  assert.strictEqual(s.localCells.B53.value, '53', 'the 53rd link is a value, not #REF!');
  assert.strictEqual(s.localCells.B80.value, '80', 'and so is the last');
  const broken = Object.keys(s.localCells).filter((id) => s.localCells[id].value === '#REF!');
  assert.deepStrictEqual(broken, [], 'no cell in a legal chain reports a circular reference');
});

test('a genuine circular reference still reports #REF!', () => {
  // The behaviour the depth counter was standing in for has to survive its removal.
  const s = createSandbox();
  s.localCells = {
    A1: { formula: '=B1', value: '', style: {} },
    B1: { formula: '=A1', value: '', style: {} },
    C1: { formula: '=C1+1', value: '', style: {} },   // self-reference
    D1: { formula: '=A1+1', value: '', style: {} }    // depends on the cycle
  };

  s.recalculateSheet();

  assert.strictEqual(s.localCells.A1.value, '#REF!', 'a two-cell cycle is caught');
  assert.strictEqual(s.localCells.B1.value, '#REF!');
  assert.strictEqual(s.localCells.C1.value, '#REF!', 'a self-reference is caught');
  assert.strictEqual(s.localCells.D1.value, '#REF!', 'and the error propagates to dependents');
});

test('the value memo does not outlive its pass', () => {
  // Between passes the sheet can change under us, so a cached value would be a
  // correctness bug rather than an optimisation.
  const s = createSandbox();
  s.localCells = {
    A1: { formula: '', value: '5', style: {} },
    B1: { formula: '=A1*2', value: '', style: {} }
  };

  s.recalculateSheet();
  assert.strictEqual(s.localCells.B1.value, '10');

  // A later edit to the precedent must be reflected, not served from the memo.
  s.localCells.A1.value = '7';
  assert.strictEqual(s.getCellValue('B1'), '14', 'a read after the pass re-evaluates');
  s.recalculateSheet();
  assert.strictEqual(s.localCells.B1.value, '14', 'and so does the next pass');
});
