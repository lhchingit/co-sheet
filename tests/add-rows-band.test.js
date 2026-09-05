process.env.NODE_ENV = 'test';

/**
 * @file add-rows-band.test.js
 * @description The band under the last row used to be an empty 42px spacer that let
 * the last row clear the horizontal scrollbar. The bar now has a lane of its own, so
 * the band carries Google Sheets' "add N rows at the bottom" control instead (#228),
 * and the row count it drives is per-sheet state mirroring colCounts rather than the
 * TOTAL_ROWS constant it replaced. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';
import { writeCellValue } from '../services/cell-service.js';
import { DEFAULT_ROWS as SERVER_DEFAULT_ROWS, MAX_ROWS as SERVER_MAX_ROWS } from '../services/dimension-service.js';

/** A DOM element stub with a real classList and working event dispatch. */
function el(tag = 'DIV') {
  const classes = new Set();
  const handlers = Object.create(null);
  const node = {
    tagName: tag, children: [], attributes: {}, style: {}, textContent: '', innerText: '',
    value: '', disabled: false, type: '', inputMode: '', id: '',
    offsetHeight: 21, offsetWidth: 100,
    scrollWidth: 0, scrollHeight: 0, clientWidth: 0, clientHeight: 600,
    scrollTop: 0, scrollLeft: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : force; if (on) classes.add(c); else classes.delete(c); return on; }
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return this.attributes[n] != null ? this.attributes[n] : null; },
    removeAttribute(n) { delete this.attributes[n]; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    remove() {}, focus() {}, blur() {},
    addEventListener(type, fn) { (handlers[type] || (handlers[type] = [])).push(fn); },
    /** Fires the listeners bound for `type`, as a click or an input would. */
    fire(type, e = {}) { (handlers[type] || []).forEach((fn) => fn(e)); },
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
  const sent = [];
  for (const id of ['grid-vscroll', 'grid-hscroll']) {
    byId[id] = el();
    byId[id].appendChild(el());
  }
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el())),
      createElement: (tag) => el(String(tag).toUpperCase()),
      createDocumentFragment: () => el(),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: () => ({ color: '' }),
    WebSocket: class {
      static OPEN = 1;
      constructor() { this.readyState = 1; }
      send(msg) { sent.push(JSON.parse(msg)); }
    },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i ? i.detail : null; } },
    requestAnimationFrame: () => {},
    setTimeout: () => {}, clearTimeout: () => {}, queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    globalThis.renderSpreadsheetGrid = renderSpreadsheetGrid;
    globalThis.getRowCount = getRowCount;
    globalThis.setActiveRowCount = setActiveRowCount;
    globalThis.DEFAULT_ROWS = DEFAULT_ROWS;
    globalThis.MAX_ROWS = MAX_ROWS;
  `, sandbox);

  sandbox.byId = byId;
  sandbox.sent = sent;
  return sandbox;
}

/** Every element in the tree below `node` (the stub keeps fragments as children). */
function* walk(node) {
  for (const child of node.children || []) {
    yield child;
    yield* walk(child);
  }
}

/** The three parts of the add-rows control, from the last render. */
function control(s) {
  const nodes = [...walk(s.byId['grid-root'])];
  return {
    band: nodes.find((n) => n.classList.contains('grid-bottom-buffer')),
    button: nodes.find((n) => n.classList.contains('add-rows-button')),
    input: nodes.find((n) => n.classList.contains('add-rows-count')),
    suffix: nodes.find((n) => n.classList.contains('add-rows-suffix')),
  };
}

/** The 1-based row numbers the render built headers for. */
const renderedRows = (s) => [...walk(s.byId['grid-root'])]
  .filter((n) => n.getAttribute('data-row-id') != null)
  .map((n) => Number(n.getAttribute('data-row-id')));

/**
 * Renders with the row window parked at the end of the sheet. Rendering is
 * windowed, so the last row — the one that carries the pulled-in resize handle,
 * and the one the add-rows control extends — only exists in the DOM when it is
 * scrolled to.
 */
const renderAtBottom = (s) => {
  const viewport = s.byId['grid-viewport'];
  viewport.clientHeight = 600;
  viewport.scrollTop = s.getRowCount() * 21;
  s.renderSpreadsheetGrid();
};

test('an untouched sheet renders the default number of rows', () => {
  // --- Arrange & Act ---
  const s = createSandbox();

  // --- Assert ---
  assert.strictEqual(s.getRowCount(), s.DEFAULT_ROWS);
});

test('the row count is clamped to the grid\'s range and broadcast', () => {
  // --- Arrange ---
  const s = createSandbox();

  // --- Act ---
  const grown = s.setActiveRowCount(2000);
  const overCeiling = s.setActiveRowCount(s.MAX_ROWS + 10_000);
  const underDefault = s.setActiveRowCount(10);

  // --- Assert ---
  assert.strictEqual(grown, 2000, 'a count in range is taken as given');
  assert.strictEqual(overCeiling, s.MAX_ROWS, 'past the ceiling fills it exactly');
  assert.strictEqual(underDefault, s.DEFAULT_ROWS, 'below the default falls back to it');
  assert.strictEqual(s.getRowCount(), s.DEFAULT_ROWS, 'and the getter agrees with the last write');

  const counts = s.sent.filter((m) => m.type === 'set-row-count').map((m) => m.payload.count);
  assert.deepStrictEqual(counts, [2000, s.MAX_ROWS, s.DEFAULT_ROWS],
    'every change is sent so the server persists it and peers follow');
});

test('the band under the last row holds the add-rows control', () => {
  // --- Arrange ---
  const s = createSandbox();

  // --- Act ---
  s.renderSpreadsheetGrid();
  const c = control(s);

  // --- Assert ---
  assert.ok(c.band, 'the band is rendered');
  assert.ok(c.button && c.input && c.suffix, 'with a button, a count box and its trailing label');
  assert.strictEqual(c.input.value, String(s.DEFAULT_ROWS), 'the box defaults to a full grid\'s worth of rows');
  assert.strictEqual(c.button.getAttribute('data-i18n'), 'grid.addRows.action',
    'the labels are translated, not hard-coded');
  assert.strictEqual(c.suffix.getAttribute('data-i18n'), 'grid.addRows.suffix');
});

test('pressing the button adds the box\'s worth of rows', () => {
  // --- Arrange ---
  const s = createSandbox();
  renderAtBottom(s);
  assert.strictEqual(Math.max(...renderedRows(s)), s.DEFAULT_ROWS, 'the grid ends at the default');

  // --- Act ---
  control(s).button.fire('click');

  // --- Assert ---
  assert.strictEqual(s.getRowCount(), 2 * s.DEFAULT_ROWS, 'the sheet grew by the default count');
  renderAtBottom(s);
  assert.strictEqual(Math.max(...renderedRows(s)), 2 * s.DEFAULT_ROWS, 'and the new last row is reachable');
});

test('a typed count is used, and survives the band being rebuilt', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.renderSpreadsheetGrid();

  // --- Act: type into the box, then add ---
  const input = control(s).input;
  input.value = '7';
  input.fire('input');
  control(s).button.fire('click');

  // --- Assert: the render that follows rebuilds the band, which must come back
  //     holding what was typed rather than resetting to the default ---
  assert.strictEqual(s.getRowCount(), s.DEFAULT_ROWS + 7, 'exactly seven rows were added');
  assert.strictEqual(control(s).input.value, '7', 'and the box still reads 7');
});

test('a count that is not a positive whole number disables the button', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.renderSpreadsheetGrid();
  const input = control(s).input;

  for (const bad of ['', 'abc', '0', '-5']) {
    // --- Act ---
    input.value = bad;
    input.fire('input');

    // --- Assert ---
    assert.strictEqual(control(s).button.disabled, true, `"${bad}" is not a count to add`);
  }

  // --- Act & Assert: a good value re-enables it ---
  input.value = '3';
  input.fire('input');
  assert.strictEqual(control(s).button.disabled, false, 'a positive whole number is');
});

test('the button gives up once the sheet is at the ceiling', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.setActiveRowCount(s.MAX_ROWS);

  // --- Act ---
  s.renderSpreadsheetGrid();
  const c = control(s);
  c.button.fire('click');

  // --- Assert ---
  assert.strictEqual(c.button.disabled, true, 'there is no room left to add into');
  assert.strictEqual(s.getRowCount(), s.MAX_ROWS, 'and pressing it anyway changes nothing');
});

test('only the last row\'s resize handle is pulled inside the grid', () => {
  // --- Arrange: the last row only exists in the DOM once it is scrolled to ---
  const s = createSandbox();

  // --- Act ---
  renderAtBottom(s);
  const handles = [...walk(s.byId['grid-root'])].filter((n) => n.classList.contains('row-resize-handle'));
  const pulled = handles.filter((h) => h.classList.contains('row-resize-handle-last'));

  // --- Assert: its 3px overhang would otherwise extend the scrollable height past
  //     the last row and keep it off the horizontal bar ---
  assert.ok(handles.length > 1, 'every rendered row header carries a handle');
  assert.strictEqual(pulled.length, 1, 'exactly one is pulled inside');
  assert.strictEqual(handles[handles.length - 1], pulled[0], 'and it is the last one');
});

test('the pulled-in row handle has a rule that cancels the overhang', () => {
  // --- Arrange & Act ---
  const html = fs.readFileSync(path.resolve('private/index.html'), 'utf8');
  const start = html.indexOf('.row-resize-handle-last {');
  const rule = start === -1 ? '' : html.slice(start, html.indexOf('}', start));

  // --- Assert ---
  assert.ok(start !== -1, '.row-resize-handle-last is defined');
  assert.match(rule, /bottom\s*:\s*0\s*;/, 'it sits flush inside its own track');
});

test('both languages carry the control\'s labels', () => {
  // --- Arrange & Act ---
  const zh = JSON.parse(fs.readFileSync(path.resolve('public/locales/zh-TW.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.resolve('public/locales/en.json'), 'utf8'));

  // --- Assert ---
  for (const key of ['grid.addRows.action', 'grid.addRows.suffix']) {
    assert.ok(zh[key], `zh-TW defines ${key}`);
    assert.ok(en[key], `en defines ${key}`);
  }
});

test('the server accepts a write anywhere the grid can reach', () => {
  // --- Arrange ---
  const wb = { sheets: { Sheet1: Object.create(null) } };
  const write = (cellId) => writeCellValue(wb, { cellId, formula: '', value: 'x', style: {}, sheetName: 'Sheet1' });

  // --- Act & Assert: rows the add-rows control can reach are addressable ---
  assert.strictEqual(write('A1').ok, true, 'the first row');
  assert.strictEqual(write(`B${SERVER_DEFAULT_ROWS}`).ok, true,
    'the default grid\'s last row — which the old three-digit id cap silently refused');
  assert.strictEqual(write(`C${SERVER_DEFAULT_ROWS + 1005}`).ok, true, 'a row only reachable after adding some');
  assert.strictEqual(write(`D${SERVER_MAX_ROWS}`).ok, true, 'and the ceiling itself');

  // --- Assert: nothing past the ceiling, and the id is still a safe key ---
  assert.strictEqual(write(`E${SERVER_MAX_ROWS + 1}`).ok, false, 'one row past the ceiling is refused');
  assert.strictEqual(write('F99999').ok, false, 'and so is a row far beyond it');
  assert.strictEqual(write('A0').ok, false, 'row 0 is not a row');
  assert.strictEqual(write('__proto__').ok, false, 'and a reserved key is never written');
});

test('the client and the server agree on the row ceiling', () => {
  // --- Arrange ---
  const s = createSandbox();

  // --- Assert: the client clamps to a range the server would reject writes past ---
  assert.strictEqual(s.DEFAULT_ROWS, SERVER_DEFAULT_ROWS, 'the default matches');
  assert.strictEqual(s.MAX_ROWS, SERVER_MAX_ROWS, 'and so does the ceiling');
});
