process.env.NODE_ENV = 'test';

/**
 * @file grid-template-cache.test.js
 * @description applyGridTemplate builds one grid-template-rows track per row, and a
 * scroll frame calls it whether or not anything changed. writeGridTemplate deduped
 * the DOM write but not the build, so a 50,000-row sheet produced ~928KB and 4.2ms
 * of track string per frame only to find it identical and drop it (#232). The build
 * is now guarded by a key over the inputs it reads — all of them sparse, so the key
 * costs O(sized rows) rather than O(rows).
 *
 * The "did it build?" assertions are deterministic operation counts, not timings:
 * the row loop reads the sheet's row-height map once per row, so a counting Proxy
 * in that slot says exactly how many rows were walked. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** A DOM element stub with a real classList and a recording style object. */
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
    globalThis.applyTemplate = () => applyGridTemplate(document.getElementById('grid-root'));
    globalThis.rowKey = () => rowTemplateKey();
    globalThis.colKey = () => colTemplateKey(getColCount());
    globalThis.setRowHeights = (v) => { rowHeights = v; };
    globalThis.setColWidths = (v) => { colWidths = v; };
    globalThis.setHiddenColsMap = (v) => { hiddenCols = v; };
    globalThis.setAutoFontRowHeights = (v) => { autoFontRowHeights = v; };
    globalThis.setHistoryMode = (v) => { isHistoryMode = v; };
    globalThis.setSheet = (v) => { activeSheetName = v; };
    globalThis.addRows = (n) => setActiveRowCount(getRowCount() + n);
    globalThis.seedCells = (cells) => { for (const id in cells) localCells[id] = cells[id]; };
    globalThis.sheetName = () => activeSheetName;
  `, sandbox);

  sandbox.byId = byId;
  sandbox.gridRoot = byId['grid-root'] || (byId['grid-root'] = el());

  /**
   * Puts a counting Proxy in the active sheet's row-height slot. The row loop looks
   * up one row number per row, so counting only numeric keys gives exactly "rows
   * walked by the build" — and ignores the `toJSON` probe JSON.stringify makes when
   * the key hashes the same map.
   */
  sandbox.countRowReads = () => {
    const counter = { reads: 0 };
    const target = Object.create(null);
    const map = Object.create(null);
    map[sandbox.sheetName()] = new Proxy(target, {
      get(t, k) {
        if (typeof k === 'string' && /^[0-9]+$/.test(k)) counter.reads++;
        return t[k];
      }
    });
    sandbox.setRowHeights(map);
    return counter;
  };
  return sandbox;
}

test('the first call builds the row template, walking every row', () => {
  // --- Arrange ---
  const s = createSandbox();
  const counter = s.countRowReads();

  // --- Act ---
  s.applyTemplate();

  // --- Assert ---
  assert.ok(counter.reads > 0, 'the build walked the sheet');
  assert.match(s.gridRoot.style.gridTemplateRows, /^minmax\(21px, auto\)/, 'and the element carries the tracks');
});

test('a call with nothing changed walks no rows at all', () => {
  // --- Arrange: the state a scroll frame is in — the template already applied ---
  const s = createSandbox();
  s.applyTemplate();
  const counter = s.countRowReads();
  s.applyTemplate();          // the counting map is itself a change; settle on it
  counter.reads = 0;

  // --- Act: the case that is nearly every frame ---
  s.applyTemplate();
  s.applyTemplate();
  s.applyTemplate();

  // --- Assert: not one row walked, where the old code rebuilt the whole string
  //     three times over to discover the same thing ---
  assert.strictEqual(counter.reads, 0, 'the build is skipped entirely');
});

test('adding rows rebuilds the template, and the new rows get tracks', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.applyTemplate();
  const before = s.gridRoot.style.gridTemplateRows;
  const counter = s.countRowReads();
  s.applyTemplate();
  counter.reads = 0;

  // --- Act ---
  s.addRows(500);
  s.applyTemplate();

  // --- Assert ---
  assert.ok(counter.reads > 0, 'the build ran again');
  const tracks = (str) => str.split(' minmax').length;
  assert.strictEqual(tracks(s.gridRoot.style.gridTemplateRows), tracks(before) + 500,
    'and the template grew by exactly the rows added');
});

test('the skip is not over-eager: a resized row reaches the element', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.applyTemplate();
  assert.ok(!s.gridRoot.style.gridTemplateRows.includes('40px'), 'no row is 40px yet');

  // --- Act: resize row 3, as a header drag does ---
  const map = Object.create(null);
  map[s.sheetName()] = { 3: 40 };
  s.setRowHeights(map);
  s.applyTemplate();

  // --- Assert ---
  const tracks = s.gridRoot.style.gridTemplateRows.split(' ');
  assert.ok(s.gridRoot.style.gridTemplateRows.includes('40px'), 'the new height is in the template');
  assert.ok(tracks.length > 100, 'and the rest of the tracks are still there');
});

test('the row key tracks every input the row template is built from', () => {
  // A stale key means a stale template, so each input gets its own sandbox rather
  // than riding on the previous case's change.
  const changes = {
    'the row count': (s) => s.addRows(10),
    'an explicit row height': (s) => { const m = Object.create(null); m[s.sheetName()] = { 5: 40 }; s.setRowHeights(m); },
    'a font-grown row': (s) => s.setAutoFontRowHeights({ 7: 78 }),
    'history mode': (s) => s.setHistoryMode(true),
    'the active sheet': (s) => s.setSheet('Sheet2'),
  };

  for (const [what, apply] of Object.entries(changes)) {
    // --- Arrange ---
    const s = createSandbox();
    const before = s.rowKey();

    // --- Act ---
    apply(s);

    // --- Assert ---
    assert.notStrictEqual(s.rowKey(), before, `${what} changes the key`);
  }
});

test('the column key tracks every input the column template is built from', () => {
  // --- Arrange ---
  const s = createSandbox();
  const base = s.colKey();

  // --- Act & Assert: a width ---
  const widths = Object.create(null);
  widths[s.sheetName()] = { B: 250 };
  s.setColWidths(widths);
  const afterWidth = s.colKey();
  assert.notStrictEqual(afterWidth, base, 'a column width changes the key');

  // --- Act & Assert: a hidden column, which getColWidth resolves to zero ---
  const hidden = Object.create(null);
  hidden[s.sheetName()] = ['C'];
  s.setHiddenColsMap(hidden);
  const afterHidden = s.colKey();
  assert.notStrictEqual(afterHidden, afterWidth, 'hiding a column changes it');

  // --- Act & Assert: history mode, which getColWidth also resolves ---
  s.setHistoryMode(true);
  assert.notStrictEqual(s.colKey(), afterHidden, 'and so does history mode');
});

test('an edit that changes no track leaves the key alone', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.applyTemplate();
  const key = s.rowKey();
  const counter = s.countRowReads();
  s.applyTemplate();
  counter.reads = 0;

  // --- Act: a cell edit and a scroll — neither resizes anything ---
  s.seedCells({ A1: { formula: '', value: 'hello', style: {} } });
  s.byId['grid-viewport'].scrollTop = 4000;
  s.applyTemplate();

  // --- Assert ---
  assert.strictEqual(s.rowKey(), key, 'nothing the template depends on moved');
  assert.strictEqual(counter.reads, 0, 'so no row was walked');
});
