process.env.NODE_ENV = 'test';

/**
 * @file add-cols-band.test.js
 * @description Columns could not be APPENDED from the grid at all (#283).
 *
 * Rows have had a control in the band below the last row for a while. Columns grew
 * only when data reached them, through undo/redo, or through the right-click insert
 * — which is `performStructuralInsert`, an insert AT a position that shifts existing
 * cells right. None of those is "give me more room at the edge", and the difference
 * matters: the structural insert moves the user's data to make the space.
 *
 * Nobody noticed because every sheet renders at least 26 columns whatever its data
 * is, so there was always somewhere to type. That floor was acting as the affordance
 * (#282), which is why this had to be built before the floor could be narrowed.
 *
 * A column control now shares the row control's band. These pin that it appends
 * rather than inserts, that it drives the same persisted per-sheet count the insert
 * path uses, and that it declines the same way the row control does. Follows the AAA
 * pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';
import { DEFAULT_COLS as SERVER_DEFAULT_COLS, MAX_COLS as SERVER_MAX_COLS } from '../services/dimension-service.js';

/** A DOM element stub with a real classList and working event dispatch. */
function el(tag = 'DIV') {
  const classes = new Set();
  const handlers = Object.create(null);
  const node = {
    tagName: tag, children: [], attributes: {}, style: {}, textContent: '', innerText: '',
    value: '', disabled: false, type: '', inputMode: '', id: '',
    offsetHeight: 21, offsetWidth: 100,
    scrollWidth: 0, scrollHeight: 0, clientWidth: 1200, clientHeight: 600,
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
    fire(type, ev = {}) {
      for (const fn of handlers[type] || []) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
    },
    getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 21, width: 100, height: 21 }; }
  };
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
    globalThis.getColCount = getColCount;
    globalThis.setActiveColCount = setActiveColCount;
    globalThis.localCells = localCells;
    globalThis.DEFAULT_COLS = DEFAULT_COLS;
    globalThis.MAX_COLS = MAX_COLS;
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

/** One grow control from the last render, by id — the two share their classes. */
function control(s, which) {
  const nodes = [...walk(s.byId['grid-root'])];
  const byId = (id) => nodes.find((n) => n.id === id);
  return { button: byId(`add-${which}-button`), input: byId(`add-${which}-count`) };
}

/**
 * The rightmost column index the render built a header for. An index rather than a
 * count: the element stub does not clear children on innerHTML, so nodes accumulate
 * across renders — the same reason the row band test reads a max instead of a length.
 */
const widestCol = (s) => Math.max(...[...walk(s.byId['grid-root'])]
  .map((n) => n.getAttribute('data-col-id'))
  .filter((v) => v != null)
  .map((letter) => {
    let n = 0;
    for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }));

test('the band carries a column control beside the row one', () => {
  // --- Arrange & Act ---
  const s = createSandbox();
  s.renderSpreadsheetGrid();

  // --- Assert ---
  const cols = control(s, 'cols');
  assert.ok(cols.button && cols.input, 'the column control is rendered');
  assert.ok(control(s, 'rows').button, 'and the row control is still there');
  assert.strictEqual(cols.button.getAttribute('data-i18n'), 'grid.addCols.action',
    'the labels are translated, not hard-coded');
  assert.ok(cols.button.classList.contains('grid-grow-button'),
    'it is styled as a grow control, sharing the row control\'s look');
});

test('pressing it appends columns at the right edge', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.renderSpreadsheetGrid();
  const before = s.getColCount();
  assert.strictEqual(before, s.DEFAULT_COLS, 'an untouched sheet starts at the default width');

  // --- Act ---
  control(s, 'cols').button.fire('click');

  // --- Assert ---
  assert.strictEqual(s.getColCount(), before + 10, 'the sheet grew by the box\'s worth');
  s.renderSpreadsheetGrid();
  assert.strictEqual(widestCol(s), before + 10 - 1, 'and the render reaches the new last column');
});

test('appending moves nobody\'s data, unlike a structural insert', () => {
  // --- Arrange: content in the first and last default columns. ---
  const s = createSandbox();
  s.localCells.A1 = { formula: '', value: 'first', style: {} };
  s.localCells.Z1 = { formula: '', value: 'last', style: {} };
  s.renderSpreadsheetGrid();

  // --- Act ---
  control(s, 'cols').button.fire('click');

  // --- Assert: this is the whole point of the control. The right-click insert
  //     shifts cells right to make room at a position; appending must not. ---
  assert.strictEqual(s.localCells.A1.value, 'first', 'A1 is untouched');
  assert.strictEqual(s.localCells.Z1.value, 'last', 'and Z1 did not become AA1');
  assert.ok(!s.localCells.AA1, 'nothing was shifted into the new space');
});

test('a typed count is used, and survives the band being rebuilt', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.renderSpreadsheetGrid();

  // --- Act ---
  const input = control(s, 'cols').input;
  input.value = '3';
  input.fire('input');
  control(s, 'cols').button.fire('click');

  // --- Assert: the click re-renders, which rebuilds the band; it has to come back
  //     holding what was typed rather than resetting. ---
  assert.strictEqual(s.getColCount(), s.DEFAULT_COLS + 3, 'exactly three columns were added');
  assert.strictEqual(control(s, 'cols').input.value, '3', 'and the box still reads 3');
});

test('a count that is not a positive whole number disables it', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.renderSpreadsheetGrid();
  const input = control(s, 'cols').input;

  // --- Act & Assert ---
  for (const bad of ['0', '-4', 'abc', '']) {
    input.value = bad;
    input.fire('input');
    assert.strictEqual(control(s, 'cols').button.disabled, true, `${JSON.stringify(bad)} is not a count`);
  }
  input.value = '6';
  input.fire('input');
  assert.strictEqual(control(s, 'cols').button.disabled, false, 'a positive whole number is');
});

test('it gives up once the sheet is at the ceiling', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.setActiveColCount(s.MAX_COLS);

  // --- Act ---
  s.renderSpreadsheetGrid();
  const c = control(s, 'cols');
  c.button.fire('click');

  // --- Assert ---
  assert.strictEqual(c.button.disabled, true, 'there is no room left to add into');
  assert.strictEqual(s.getColCount(), s.MAX_COLS, 'and pressing it anyway changes nothing');
});

test('the growth is broadcast so peers and the server follow', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.renderSpreadsheetGrid();

  // --- Act ---
  control(s, 'cols').button.fire('click');

  // --- Assert: the same message the right-click insert path already sends, so the
  //     count is persisted per sheet rather than being a local view preference. ---
  const msg = s.sent.filter((m) => m.type === 'set-col-count').pop();
  assert.ok(msg, 'a set-col-count went out');
  assert.strictEqual(msg.payload.count, s.DEFAULT_COLS + 10);
});

test('both languages carry the control\'s labels', () => {
  // --- Arrange & Act ---
  const locales = ['en', 'zh-TW'].map((lang) => ({
    lang,
    strings: JSON.parse(fs.readFileSync(path.resolve('public/locales', `${lang}.json`), 'utf8'))
  }));

  // --- Assert ---
  for (const { lang, strings } of locales) {
    for (const key of ['grid.addCols.action', 'grid.addCols.suffix']) {
      assert.ok(strings[key], `${lang} is missing ${key}`);
    }
  }
});

test('the client and the server agree on the column ceiling', () => {
  // --- Arrange ---
  const s = createSandbox();

  // --- Assert: the control clamps client-side, and dimensionService validates the
  //     broadcast; a disagreement means a count the client accepts is refused. ---
  assert.strictEqual(s.DEFAULT_COLS, SERVER_DEFAULT_COLS, 'default width agrees');
  assert.strictEqual(s.MAX_COLS, SERVER_MAX_COLS, 'ceiling agrees');
});
