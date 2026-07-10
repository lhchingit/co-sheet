/**
 * @file clear-formatting-merge.test.js
 * @description Covers clearFormatting's treatment of merged cells (#149). Google
 * Sheets' Ctrl+\ splits merged blocks, so a merge anchored on a cleared cell must
 * be dropped — while a hyperlink, which carries content rather than formatting,
 * survives. Also pins the render path: un-merging changes grid geometry and needs a
 * full renderSpreadsheetGrid(), but the common no-merge clear must stay on the cheap
 * per-cell updateGridDOMCell() path. renderSpreadsheetGrid() opens by looking up
 * '#grid-root' and nothing else on this path does, so counting that lookup tells us
 * which branch ran.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

function createSandbox() {
  const counts = { gridRoot: 0 };
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => {
        if (id === 'grid-root') counts.gridRoot++;
        return null; // renderSpreadsheetGrid bails out; updateGridDOMCell no-ops
      },
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { classList: { add() {}, remove() {} } },
    },
    WebSocket: class { constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    setTimeout: () => 0, clearTimeout: () => {}, queueMicrotask: (fn) => fn(), requestAnimationFrame: () => 0,
    console, Math, parseFloat, parseInt, isNaN, isFinite, String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Proxy, Reflect, Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    globalThis.__h = {
      clearFormatting,
      styleHasMerge,
      seed(cells) { localSheets[activeSheetName] = cells; },
      // Serialized: the style object lives in the VM realm, so handing it back
      // directly makes deepStrictEqual fail on prototype identity alone.
      style(id) { const c = localCells[id]; return JSON.stringify(c ? c.style : null); },
    };
  `, sandbox);
  const h = sandbox.__h;
  return { ...h, counts, style: (id) => JSON.parse(h.style(id)) };
}

test('clearing a merged anchor drops the merge, unmerging the block', () => {
  const h = createSandbox();
  h.seed({
    B1: { formula: 'hi', value: 'hi', style: { merge: { rows: 1, cols: 2 }, bold: true, fontSize: 18 } },
    C1: { formula: '', value: '', style: {} },
  });

  h.clearFormatting('B1');

  const st = h.style('B1');
  assert.ok(!('merge' in st), 'the merge span must be dropped');
  assert.strictEqual(h.styleHasMerge(st), false, 'B1 must no longer be a merge anchor');
  assert.ok(!('bold' in st), 'bold must still be cleared');
  assert.ok(!('fontSize' in st), 'fontSize must still be cleared');
});

test('a cell whose only style is a merge is still unmerged', () => {
  const h = createSandbox();
  // Regression guard: the "nothing to clear" early-return counts preserved keys, so
  // a merge-only style must not be mistaken for a cell with no clearable formatting.
  h.seed({ A1: { formula: '', value: '', style: { merge: { rows: 2, cols: 2 } } } });

  h.clearFormatting('A1');

  assert.deepStrictEqual(h.style('A1'), {}, 'the merge-only style must be emptied');
});

test('a hyperlink survives clearing, a merge on the same cell does not', () => {
  const h = createSandbox();
  h.seed({
    A1: { formula: '', value: '', style: { link: 'https://example.com', merge: { rows: 2, cols: 1 }, italic: true } },
  });

  h.clearFormatting('A1');

  assert.deepStrictEqual(h.style('A1'), { link: 'https://example.com' });
});

test('un-merging triggers a full grid render', () => {
  const h = createSandbox();
  h.seed({ A1: { formula: '', value: '', style: { merge: { rows: 2, cols: 2 }, bold: true } } });

  h.clearFormatting('A1');

  assert.strictEqual(h.counts.gridRoot, 1, 'geometry changed, so the whole grid must re-render');
});

test('clearing without a merge stays on the cheap per-cell render path', () => {
  const h = createSandbox();
  h.seed({ A1: { formula: '', value: '', style: { bold: true, italic: true } } });

  h.clearFormatting('A1');

  assert.deepStrictEqual(h.style('A1'), {});
  assert.strictEqual(h.counts.gridRoot, 0, 'a plain clear must not force a full grid re-render');
});

test('a degenerate 1x1 merge marker clears without forcing a full render', () => {
  const h = createSandbox();
  // rows*cols === 1 is not a real merge, so there is no geometry to rebuild.
  h.seed({ A1: { formula: '', value: '', style: { merge: { rows: 1, cols: 1 }, bold: true } } });

  h.clearFormatting('A1');

  assert.deepStrictEqual(h.style('A1'), {});
  assert.strictEqual(h.counts.gridRoot, 0);
});
