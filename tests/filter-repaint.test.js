process.env.NODE_ENV = 'test';

/**
 * @file filter-repaint.test.js
 * @description The grid renderer calls `applyFilter()` on every render, so with
 * windowing that is every time a scroll rebuilds the row band. It used to walk the
 * whole data range and ask the DOM for each row and each of that row's cells —
 * queries that, for the ~95% of rows windowing had not built, found nothing.
 * Scrolling with a filter active cost 1,704 ms of long-task blocking against 12 ms
 * without one, measured in a browser (#220).
 *
 * These tests load `sort-filter.js` directly against a stub grid, which is what
 * lets them count the DOM work rather than only checking the result. Follows the
 * AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const read = (f) => fs.readFileSync(path.resolve('public', f), 'utf8');

/**
 * Boot sort-filter.js with a stub grid holding exactly `renderedRows`, and a model
 * whose column A holds `values` (row -> value) for rows 2..dataRows.
 */
function createSandbox({ renderedRows, dataRows, colCount = 4 }) {
  const counts = { querySelector: 0, querySelectorAll: 0, getCellEl: 0 };
  const store = new Map();

  const makeEl = (attrs = {}) => {
    const classes = new Set();
    return {
      style: {}, textContent: '', title: '', _attrs: attrs, children: [],
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      getAttribute: (n) => (attrs[n] != null ? String(attrs[n]) : null),
      setAttribute: (n, v) => { attrs[n] = v; },
      addEventListener() {}, appendChild(c) { this.children.push(c); return c; },
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); }
    };
  };

  // The rendered band: a row header per rendered row, plus a cell per (row, column).
  const rowHeaders = renderedRows.map((r) => makeEl({ 'data-row-id': r }));
  const cellEls = new Map();
  for (const r of renderedRows) {
    for (let c = 0; c < colCount; c++) {
      const id = `${String.fromCharCode(65 + c)}${r}`;
      cellEls.set(id, makeEl({ 'data-cell-id': id }));
    }
  }

  const gridRoot = {
    querySelector(sel) {
      counts.querySelector++;
      const cell = sel.match(/\[data-cell-id="([^"]+)"\]/);
      if (cell) return cellEls.get(cell[1]) || null;
      if (/data-col-id/.test(sel)) return makeEl({ 'data-col-id': 'A' });
      return null;
    },
    querySelectorAll(sel) {
      counts.querySelectorAll++;
      if (/^\[data-row-id\]$/.test(sel)) return rowHeaders;
      const prefix = sel.match(/\[data-cell-id\^="([^"]+)"\]/);
      if (prefix) return [...cellEls.entries()].filter(([id]) => id.startsWith(prefix[1])).map(([, el]) => el);
      return [];
    }
  };

  const localCells = Object.create(null);
  for (let r = 2; r <= dataRows; r++) {
    localCells[`A${r}`] = { formula: '', value: ['alpha', 'beta', 'gamma', 'delta'][r % 4], style: {} };
  }
  localCells.A1 = { formula: '', value: 'Category', style: {} };

  const sandbox = {
    window: {},
    document: {
      getElementById: (id) => (id === 'grid-root' ? gridRoot : null),
      createElement: () => makeEl(),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k)
    },
    console, Math, JSON, Object, Array, String, Number, Set, Map, RegExp, parseInt, parseFloat, isNaN
  };
  vm.createContext(sandbox);
  vm.runInContext(`${read('sheet-utils.js')}\n;\n${read('sort-filter.js')}`, sandbox);

  const sf = sandbox.window.CoSheet.sortFilter;
  sf.init({
    isHistoryMode: false,
    activeSheetName: 'Sheet1',
    currentFileId: 'f1',
    frozenRows: 0,
    localCells,
    getColCount: () => colCount,
    getCellValue: (id) => (localCells[id] ? localCells[id].value : ''),
    getCellEl: (id) => { counts.getCellEl++; return cellEls.get(id) || null; },
    getActiveSheetMerges: () => [],
    showMessageDialog() {}
  });

  return { sf, counts, rowHeaders, cellEls, store, localCells };
}

/** Install a filter on column A hiding the given values. */
function setFilter(s, hidden) {
  s.store.set('co-sheet-filters:f1', JSON.stringify({ Sheet1: { colIndex: 0, hidden } }));
  s.sf.loadFilters();
}

test('only rendered rows are touched, whatever the data range', () => {
  // --- Arrange: a band of 40 rows over a sheet of 800 ---
  const renderedRows = Array.from({ length: 40 }, (_, i) => 401 + i);
  const s = createSandbox({ renderedRows, dataRows: 800 });
  setFilter(s, ['beta', 'gamma', 'delta']);

  // --- Act ---
  s.counts.querySelector = 0;
  s.counts.getCellEl = 0;
  s.sf.applyFilter();

  // --- Assert ---
  const hidden = s.rowHeaders.filter((h) => h.style.display === 'none');
  assert.ok(hidden.length > 20, `most of the band is hidden (${hidden.length} of 40)`);
  // The old version issued a query per data row plus one per column of it: for 800
  // rows and 4 columns that is ~4,000. Bounded by the band, it cannot exceed a
  // handful — and must not grow with the sheet.
  assert.ok(s.counts.querySelector < 20,
    `document queries stay bounded by the band, not the data range (${s.counts.querySelector})`);
  // Cells are collapsed through the render's O(1) index instead.
  assert.strictEqual(s.counts.getCellEl, hidden.length * 4, 'one index lookup per cell of a hidden row');
});

test('the same rows are hidden as before, and their cells collapsed', () => {
  const renderedRows = Array.from({ length: 12 }, (_, i) => i + 1); // rows 1..12
  const s = createSandbox({ renderedRows, dataRows: 800 });
  setFilter(s, ['beta', 'gamma', 'delta']);

  s.sf.applyFilter();

  // Row 1 is the header row and is never hidden; of 2..12, only `alpha` survives.
  const hiddenRows = s.rowHeaders
    .filter((h) => h.style.display === 'none')
    .map((h) => Number(h.getAttribute('data-row-id')));
  const expected = [];
  for (let r = 2; r <= 12; r++) if (['beta', 'gamma', 'delta'].includes(s.localCells[`A${r}`].value)) expected.push(r);
  assert.deepStrictEqual(hiddenRows.sort((a, b) => a - b), expected, 'exactly the excluded rows');
  assert.ok(!hiddenRows.includes(1), 'the header row is never hidden');

  // A hidden row collapses its cells too, or the row would leave a gap of content.
  const r = hiddenRows[0];
  for (const c of ['A', 'B', 'C', 'D']) {
    assert.strictEqual(s.cellEls.get(`${c}${r}`).style.display, 'none', `${c}${r} collapsed`);
  }
});

test('rows past the used range are left alone when blanks are excluded', () => {
  // The bound the old loop got from iterating up to the used range. Rendered rows
  // beyond the data are blank, and a filter excluding blanks must not swallow the
  // empty remainder of the sheet.
  const renderedRows = Array.from({ length: 20 }, (_, i) => i + 1); // rows 1..20
  const s = createSandbox({ renderedRows, dataRows: 10 });          // data ends at row 10
  setFilter(s, ['__BLANK__']);

  s.sf.applyFilter();

  const hiddenRows = s.rowHeaders
    .filter((h) => h.style.display === 'none')
    .map((h) => Number(h.getAttribute('data-row-id')));
  assert.deepStrictEqual(hiddenRows, [], 'no row past the used range is hidden');
});

test('with nothing excluded the sheet is only tinted, never hidden', () => {
  const renderedRows = Array.from({ length: 20 }, (_, i) => i + 1);
  const s = createSandbox({ renderedRows, dataRows: 800 });
  setFilter(s, []);

  s.counts.getCellEl = 0;
  s.sf.applyFilter();

  assert.strictEqual(s.rowHeaders.filter((h) => h.style.display === 'none').length, 0, 'nothing hidden');
  assert.strictEqual(s.counts.getCellEl, 0, 'and no per-cell work at all');
  assert.ok(s.rowHeaders.every((h) => h.className.includes('filter-row-header')), 'the scope is still tinted');
});
