process.env.NODE_ENV = 'test';

/**
 * @file col-count-derived.test.js
 * @description A sheet's rendered width now follows its data (#282).
 *
 * `getColCount` used to seed its scan at `DEFAULT_COLS - 1`, so every sheet rendered
 * at least 26 columns whatever it held. On a 14-column import that made 46% of every
 * rendered cell an empty column, and 69% on an 8-column one — measured while
 * investigating #278.
 *
 * The floor was doing two jobs: giving an EMPTY sheet a grid to start on, and
 * standing in for the append-columns control the grid did not have. With that control
 * built (#283) only the first job is left, and it only applies to a sheet with no
 * data at all.
 *
 * What has to keep holding: an empty sheet still shows the full default width; a
 * sheet's own data is never cut off; there is room to type past the last column
 * without reaching for a control; and an explicit count still wins. Follows the AAA
 * pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';
import { createMockElement } from './helpers/cell-editor-sandbox.js';

/** Boot the bundle and expose the width model. */
function boot() {
  const sandbox = {
    document: {
      getElementById: () => createMockElement(),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      createElement: () => createMockElement(),
      createDocumentFragment: () => createMockElement(),
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: () => ({ color: '' }),
    window: {
      location: { protocol: 'http:', host: 'localhost:3000', search: '', origin: 'http://localhost:3000' },
      addEventListener() {}
    },
    navigator: { clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') } },
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 1; } send() {} close() {} },
    URLSearchParams,
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    setTimeout: () => {}, clearTimeout: () => {}, queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite, encodeURIComponent,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Promise, Error
  };
  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    globalThis.getColCount = getColCount;
    globalThis.setActiveColCount = setActiveColCount;
    globalThis.localSheets = localSheets;
    globalThis.activeSheetName = activeSheetName;
    globalThis.DEFAULT_COLS = DEFAULT_COLS;
    globalThis.MAX_COLS = MAX_COLS;
    globalThis.COL_MARGIN = COL_MARGIN;
  `, sandbox);
  return sandbox;
}

/** Replace the active sheet's cells with one entry per given id. */
function seed(s, ids) {
  const cells = Object.create(null);
  for (const id of ids) cells[id] = { formula: '', value: 'x', style: {} };
  s.localSheets[s.activeSheetName] = cells;
}

test('an empty sheet still opens at the full default width', () => {
  // --- Arrange ---
  const s = boot();
  seed(s, []);

  // --- Assert ---
  // Nothing to derive a width from, and a blank grid has to show somewhere to
  // start. This is the one job the old flat floor still has.
  assert.strictEqual(s.getColCount(), s.DEFAULT_COLS);
});

test('a narrow sheet renders its data plus room to type, not a flat 26', () => {
  // --- Arrange: the shape that prompted this — 14 populated columns (A..N). ---
  const s = boot();
  const ids = [];
  for (let c = 0; c < 14; c++) ids.push(`${String.fromCharCode(65 + c)}1`);
  seed(s, ids);

  // --- Act ---
  const count = s.getColCount();

  // --- Assert ---
  assert.strictEqual(count, 14 + s.COL_MARGIN, 'the width follows the data');
  assert.ok(count < s.DEFAULT_COLS, 'and is genuinely narrower than the old flat floor');
});

test('a sheet\'s own data is never cut off', () => {
  // --- Arrange: one cell far to the right, nothing between. ---
  const s = boot();
  seed(s, ['A1', 'BZ400']);

  // --- Act ---
  const count = s.getColCount();

  // --- Assert: BZ is index 77, so the sheet must reach at least 78 columns. The
  //     margin sits PAST the rightmost populated column, never inside the data. ---
  assert.ok(count >= 78, `BZ must stay addressable, got ${count}`);
  assert.strictEqual(count, 78 + s.COL_MARGIN);
});

test('there is always somewhere to type past the last column', () => {
  // --- Arrange: a single cell in column A. ---
  const s = boot();
  seed(s, ['A1']);

  // --- Act ---
  const count = s.getColCount();

  // --- Assert: without a margin a one-column sheet would render exactly one
  //     column, and the only way to widen it would be the control. The margin is
  //     what keeps ordinary typing from needing one. ---
  assert.strictEqual(count, 1 + s.COL_MARGIN);
  assert.ok(s.COL_MARGIN > 0, 'the margin is the affordance for the common case');
});

test('an explicit count still wins over the derived width', () => {
  // --- Arrange: a narrow sheet the user has deliberately widened. ---
  const s = boot();
  seed(s, ['A1', 'B1']);
  assert.ok(s.getColCount() < s.DEFAULT_COLS, 'it starts narrow');

  // --- Act: the add-columns control and the right-click insert both land here. ---
  s.setActiveColCount(40);

  // --- Assert ---
  assert.strictEqual(s.getColCount(), 40, 'the width the user asked for is kept');
});

test('the width is capped at the grid ceiling', () => {
  // --- Arrange: data in the very last addressable column. ---
  const s = boot();
  seed(s, ['ZZ1']);

  // --- Act ---
  const count = s.getColCount();

  // --- Assert: the margin must not push the sheet past what can be addressed. ---
  assert.strictEqual(count, s.MAX_COLS, 'ZZ is the last column, margin or not');
});
