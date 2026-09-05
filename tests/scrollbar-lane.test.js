process.env.NODE_ENV = 'test';

/**
 * @file scrollbar-lane.test.js
 * @description The synthetic vertical scrollbar used to be painted over the
 * scrolling viewport, so the last column scrolled underneath it and lost its right
 * gridline (#68). That was patched with a 42px `padding-right` on the grid, which
 * sits inside #grid-root's CSS `zoom` while the bar does not — leaving `42 * zoom
 * - 14` px of blank strip between the last column and the bar (#226). The bar now
 * gets a reserved lane instead: layout() insets the viewport's right edge by the
 * bar's width, so content can never reach under it and the last column ends flush.
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

const BAR = 14; // .grid-custom-scroll-v width, mirrored by initGridScrollbars

/** A DOM element stub with a real classList and settable scroll metrics. */
function el() {
  const classes = new Set();
  const node = {
    children: [], attributes: {}, style: {}, textContent: '', innerText: '',
    value: '', offsetHeight: 21, offsetWidth: 100,
    scrollWidth: 0, scrollHeight: 0, clientWidth: 0, clientHeight: 0,
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
  // initGridScrollbars() bails unless each bar already holds its thumb, so give
  // the two bars one before the bundle runs its start-up init.
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
      querySelectorAll: () => [],
      querySelector: () => null,   // no rendered corner: headerSize falls back to its defaults
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
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    globalThis.layoutScrollbars = () => gridScrollbarLayout && gridScrollbarLayout();
    globalThis.seedCells = (cells) => { for (const id in cells) localCells[id] = cells[id]; };
    globalThis.renderSpreadsheetGrid = renderSpreadsheetGrid;
  `, sandbox);

  sandbox.byId = byId;
  sandbox.viewport = byId['grid-viewport'];
  sandbox.vbar = byId['grid-vscroll'];
  /** Sets the viewport's scroll metrics, then re-runs the bar layout. */
  sandbox.layoutWith = (m) => {
    Object.assign(sandbox.viewport, m);
    sandbox.layoutScrollbars();
  };
  return sandbox;
}

/** Every element in the tree below `node` (the stub keeps fragments as children). */
function* walk(node) {
  for (const child of node.children || []) {
    yield child;
    yield* walk(child);
  }
}

const gridCss = () => {
  const html = fs.readFileSync(path.resolve('private/index.html'), 'utf8');
  const start = html.indexOf('.grid-container {');
  return html.slice(start, html.indexOf('}', start));
};

test('the grid carries no trailing buffer past its last column', () => {
  // --- Arrange & Act ---
  const rule = gridCss();

  // --- Assert: the strip #226 was about was this padding ---
  assert.ok(!/padding-right\s*:/.test(rule),
    '.grid-container declares no padding-right; the bar has a reserved lane instead');
});

test('the vertical bar is given its own lane rather than covering the content', () => {
  // --- Arrange: taller content than viewport, so the bar is needed ---
  const s = createSandbox();

  // --- Act ---
  s.layoutWith({ clientWidth: 1200, clientHeight: 800, scrollWidth: 2646, scrollHeight: 21000 });

  // --- Assert ---
  assert.strictEqual(s.viewport.style.right, `${BAR}px`,
    'the viewport stops where the bar begins, so nothing can scroll under it');
  assert.strictEqual(s.vbar.classList.contains('hidden'), false, 'and the bar is drawn');
});

test('with nothing to scroll vertically the lane goes back to the content', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.layoutWith({ clientWidth: 1200, clientHeight: 800, scrollWidth: 2646, scrollHeight: 21000 });
  assert.strictEqual(s.viewport.style.right, `${BAR}px`, 'the lane starts reserved');

  // --- Act: content that fits, so no vertical bar ---
  s.layoutWith({ clientWidth: 1200, clientHeight: 800, scrollWidth: 2646, scrollHeight: 800 });

  // --- Assert: no width is held back for a bar that isn't there ---
  assert.strictEqual(s.viewport.style.right, '', 'the reservation is released');
  assert.strictEqual(s.vbar.classList.contains('hidden'), true, 'along with the bar');
});

test('the reservation is decided before the width metrics are read', () => {
  // --- Arrange: a viewport whose clientWidth reflects the lane it gives up, the
  //     way a real one does — so a layout that measured width first would size the
  //     horizontal bar against a width that is about to change ---
  const s = createSandbox();
  let reads = [];
  const viewport = s.viewport;
  Object.defineProperty(viewport, 'clientWidth', {
    get() { reads.push(viewport.style.right); return 1200; }, configurable: true
  });

  // --- Act ---
  Object.assign(viewport, { clientHeight: 800, scrollWidth: 2646, scrollHeight: 21000 });
  s.layoutScrollbars();

  // --- Assert ---
  assert.ok(reads.length > 0, 'the layout reads the viewport width');
  assert.ok(reads.every((right) => right === `${BAR}px`),
    `every width read happens after the lane is reserved (saw ${JSON.stringify(reads)})`);
});

test('the last column\'s resize handle is pulled inside the grid', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ A1: { formula: '', value: '1', style: {} } });

  // --- Act ---
  s.renderSpreadsheetGrid();
  const handles = [...walk(s.byId['grid-root'])]
    .filter((n) => n.classList.contains('col-resize-handle'));
  const last = handles[handles.length - 1];

  // --- Assert: only the final one, whose 3px overhang would otherwise extend the
  //     scrollable width past the last column and stop it reaching the bar ---
  assert.ok(handles.length > 1, 'every visible column header carries a handle');
  assert.ok(last.classList.contains('col-resize-handle-last'), 'the last one is pulled inside');
  assert.strictEqual(
    handles.filter((h) => h.classList.contains('col-resize-handle-last')).length, 1,
    'and it is the only one');
});

test('the pulled-in handle has a rule that cancels the overhang', () => {
  // --- Arrange & Act ---
  const html = fs.readFileSync(path.resolve('private/index.html'), 'utf8');
  const start = html.indexOf('.col-resize-handle-last {');
  const rule = start === -1 ? '' : html.slice(start, html.indexOf('}', start));

  // --- Assert ---
  assert.ok(start !== -1, '.col-resize-handle-last is defined');
  assert.match(rule, /right\s*:\s*0\s*;/, 'it sits flush inside its own track');
});
