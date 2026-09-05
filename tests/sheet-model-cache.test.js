process.env.NODE_ENV = 'test';

/**
 * @file sheet-model-cache.test.js
 * @description A band-moving scroll frame used to walk every cell in the sheet twice
 * — once in getActiveSheetMerges, which built an Object.keys array of every id first,
 * and once in scanActiveSheetModel — to re-derive answers a scroll cannot change. At
 * 160,000 cells that was ~37ms per frame (#236). The merge collection now rides along
 * with the model scan, and the scan is cached against the cell map it walked and a
 * counter bumped by every cell write.
 *
 * A cache hit hands back the very same model object, so identity is the observable
 * throughout: `===` means "not rescanned", `!==` means "rescanned". The half that
 * matters is the second one — a missed invalidation would leave the grid not growing
 * a column when data lands past Z, or a font-grown row without its height — so every
 * path that can change a cell is driven here rather than reasoned about.
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** A DOM element stub with the surface renderSpreadsheetGrid touches. */
function el() {
  const classes = new Set();
  const node = {
    children: [], attributes: {}, style: {}, textContent: '', innerText: '',
    className: '', value: '', offsetHeight: 21, offsetWidth: 100,
    scrollWidth: 0, scrollHeight: 0, clientWidth: 0, clientHeight: 600,
    scrollTop: 0, scrollLeft: 0,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : force; if (on) classes.add(c); else classes.delete(c); return on; }
    },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return this.attributes[n] != null ? this.attributes[n] : null; },
    removeAttribute(n) { delete this.attributes[n]; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    remove() {}, addEventListener() {}, focus() {}, blur() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelectorAll: () => [], querySelector: () => null,
    get firstElementChild() { return this.children[0] || null; }
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; }, set(_v) { this.children.length = 0; }, configurable: true
  });
  return node;
}

function createSandbox() {
  const byId = {};
  for (const id of ['grid-vscroll', 'grid-hscroll']) {
    byId[id] = el();
    byId[id].appendChild(el());
  }
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el())),
      createElement: () => el(),
      createDocumentFragment: () => el(),
      querySelectorAll: () => [], querySelector: () => null,
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
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Proxy, Reflect
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    globalThis.scan = scanActiveSheetModel;
    globalThis.merges = getActiveSheetMerges;
    globalThis.render = renderSpreadsheetGrid;
    globalThis.applyRemote = applyRemoteCellUpdate;
    globalThis.writeCell = (id, cell) => { localCells[id] = cell; };
    globalThis.deleteCell = (id) => { delete localCells[id]; };
    globalThis.readCell = (id) => localCells[id];
    globalThis.putSheet = (name, cells) => { setKey(localSheets, name, cells || Object.create(null)); };
    globalThis.dropSheet = (name) => { deleteKey(localSheets, name); };
    globalThis.mergeSheets = (sheets) => { Object.assign(localSheets, sheets); };
    globalThis.setSheet = (name) => { activeSheetName = name; };
    globalThis.sheetName = () => activeSheetName;
    globalThis.sheetCells = () => localSheets[activeSheetName];
    globalThis.styleHasMerge = styleHasMerge;
    globalThis.parseCellCoord = parseCellCoord;
  `, sandbox);

  sandbox.byId = byId;
  sandbox.viewport = byId['grid-viewport'] || (byId['grid-viewport'] = el());
  /** The walk getActiveSheetMerges used to do, kept as the answer to reproduce. */
  sandbox.referenceMerges = () => {
    const out = [];
    const cells = sandbox.sheetCells();
    if (!cells) return out;
    for (const id of Object.keys(cells)) {
      const cell = cells[id];
      if (cell && sandbox.styleHasMerge(cell.style)) {
        const co = sandbox.parseCellCoord(id);
        if (co) out.push({ anchorId: id, r: co.row, c: co.colIndex, rows: cell.style.merge.rows, cols: cell.style.merge.cols });
      }
    }
    return out;
  };
  return sandbox;
}

const cell = (value = 'x', style = {}) => ({ formula: '', value, style });

/** Merge anchors as plain local values, ordered: what crosses the vm realm boundary
 *  carries that realm's prototypes, which deepStrictEqual compares. */
const normalise = (list) => Array.from(list, (m) => ({
  anchorId: m.anchorId, r: m.r, c: m.c, rows: m.rows, cols: m.cols
})).sort((a, b) => a.anchorId.localeCompare(b.anchorId));

test('asking twice without touching a cell hands back the same model', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.writeCell('A1', cell());

  // --- Act ---
  const first = s.scan();

  // --- Assert: identity, so nothing was walked the second and third time ---
  assert.strictEqual(s.scan(), first);
  assert.strictEqual(s.scan(), first);
});

test('a scroll that re-renders does not rescan the sheet', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.writeCell('A1', cell());
  s.render();
  const model = s.scan();

  // --- Act: the band-moving path — scroll, render again ---
  s.viewport.scrollTop = 4000;
  s.render();
  s.viewport.scrollTop = 8000;
  s.render();

  // --- Assert ---
  assert.strictEqual(s.scan(), model, 'the same model, scrolled twice and rendered twice');
});

test('every path that changes a cell invalidates the model', () => {
  // Each entry mutates the sheet through a real path and says what the model must
  // then report. A missed invalidation shows up here as a stale answer, not as a
  // subtle rendering bug found much later.
  const paths = {
    'writing a cell': {
      act: (s) => s.writeCell('AB9', cell()),
      then: (m) => assert.strictEqual(m.maxColIndex, 27, 'the grid grew to column AB'),
    },
    'deleting a cell': {
      setup: (s) => s.writeCell('AB9', cell()),
      act: (s) => s.deleteCell('AB9'),
      then: (m) => assert.strictEqual(m.maxColIndex, 25, 'and shrank back to Z'),
    },
    'a remote cell-update': {
      act: (s) => s.applyRemote({ cellId: 'AC1', formula: '', value: 'v', style: {}, sheetName: s.sheetName() }),
      then: (m) => assert.strictEqual(m.maxColIndex, 28, 'a peer growing the sheet is seen'),
    },
    'a font size': {
      act: (s) => s.writeCell('B4', cell('big', { fontSize: 36 })),
      then: (m) => assert.ok(m.fontRowHeights[4] > 21, 'row 4 is grown'),
    },
    'a merge': {
      act: (s) => s.writeCell('C5', cell('m', { merge: { rows: 2, cols: 2 } })),
      then: (m) => assert.strictEqual(m.merges.length, 1, 'the anchor is in the model'),
    },
    'wrapping text': {
      act: (s) => s.writeCell('D6', cell('w', { textWrap: 'wrap' })),
      then: (m) => assert.strictEqual(m.hasWrappedRows, true, 'the sheet falls back to the full render'),
    },
    'switching sheet': {
      setup: (s) => s.putSheet('Sheet2', Object.assign(Object.create(null), { BB2: cell() })),
      act: (s) => s.setSheet('Sheet2'),
      then: (m) => assert.strictEqual(m.maxColIndex, 53, 'the other sheet is measured, not the old one'),
    },
    'the init payload replacing the sheets': {
      act: (s) => s.mergeSheets({ Sheet1: Object.assign(Object.create(null), { BA1: cell() }) }),
      then: (m) => assert.strictEqual(m.maxColIndex, 52, 'the replacement map is measured'),
    },
  };

  for (const [what, { setup, act, then }] of Object.entries(paths)) {
    // --- Arrange ---
    const s = createSandbox();
    s.writeCell('A1', cell());
    if (setup) setup(s);
    const before = s.scan();

    // --- Act ---
    act(s);

    // --- Assert ---
    const after = s.scan();
    assert.notStrictEqual(after, before, `${what} must invalidate the model`);
    then(after);
  }
});

test('a cell rewritten in place through the proxy still invalidates', () => {
  // The file's convention is read -> mutate a local copy -> assign it back, so the
  // proxy trap is what every style change goes through. Check the assignment is
  // what counts, not a change in the value.
  const s = createSandbox();
  s.writeCell('A1', cell('v', {}));
  const before = s.scan();

  // --- Act: the shape every formatting command uses ---
  const c = s.readCell('A1');
  c.style.fontSize = 36;
  s.writeCell('A1', c);

  // --- Assert ---
  const after = s.scan();
  assert.notStrictEqual(after, before, 'the write-back invalidates');
  assert.ok(after.fontRowHeights[1] > 21, 'and the row height follows');
});

test('merges read from the model match the walk they replaced', () => {
  const sheets = {
    'no merges': (s) => { s.writeCell('A1', cell()); s.writeCell('B2', cell()); },
    'one merge': (s) => { s.writeCell('A1', cell()); s.writeCell('B2', cell('m', { merge: { rows: 2, cols: 3 } })); },
    'several merges': (s) => {
      s.writeCell('A1', cell('m', { merge: { rows: 2, cols: 2 } }));
      s.writeCell('C3', cell('m', { merge: { rows: 1, cols: 4 } }));
      s.writeCell('AA9', cell('m', { merge: { rows: 5, cols: 1 } }));
      s.writeCell('D4', cell('plain'));
      // A 1x1 "merge" is not one; the old walk rejected it and so must this.
      s.writeCell('E5', cell('m', { merge: { rows: 1, cols: 1 } }));
    },
  };

  for (const [what, build] of Object.entries(sheets)) {
    // --- Arrange ---
    const s = createSandbox();
    build(s);

    // --- Act ---
    const got = normalise(s.merges());
    const want = normalise(s.referenceMerges());

    // --- Assert ---
    assert.deepStrictEqual(got, want, `${what}: the model's merges match the old walk`);
  }
});

test('the merge list is the model, so asking for it costs no walk', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.writeCell('B2', cell('m', { merge: { rows: 2, cols: 2 } }));

  // --- Act ---
  const first = s.merges();

  // --- Assert: getActiveSheetMerges used to build a fresh array — and an
  //     Object.keys of every cell id — on each call ---
  assert.strictEqual(s.merges(), first, 'the same array comes back');
  assert.strictEqual(s.scan().merges, first, "and it is the model's own");
});
