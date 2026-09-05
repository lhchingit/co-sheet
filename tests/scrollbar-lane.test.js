process.env.NODE_ENV = 'test';

/**
 * @file scrollbar-lane.test.js
 * @description The synthetic vertical scrollbar used to be painted over the
 * scrolling viewport, so the last column scrolled underneath it and lost its right
 * gridline (#68). That was patched with a 42px `padding-right` on the grid, which
 * sits inside #grid-root's CSS `zoom` while the bar does not — leaving `42 * zoom
 * - 14` px of blank strip between the last column and the bar (#226). The bar now
 * gets a reserved lane instead: layout() insets the viewport's edge by the bar's
 * width, so content can never reach under it and the last column ends flush. #228
 * did the same for the horizontal bar, which couples the two: reserving one lane
 * shrinks the other axis and can call for its own bar.
 *
 * The viewport stub below models that coupling — its client box is the parent's
 * minus whatever lanes are reserved, and its scroll extent is the content's or the
 * client box, whichever is larger — so these tests exercise the real feedback
 * rather than a fixed set of numbers. Follows the AAA pattern.
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
  sandbox.hbar = byId['grid-hscroll'];

  // The viewport is `absolute inset-0` in its parent, so the parent holds the size
  // it would have with no lane reserved; its own client box is that minus whatever
  // it has given up. scrollWidth/scrollHeight report the content extent or the
  // client box, whichever is larger — as a real scroller does.
  const viewport = sandbox.viewport;
  const parent = { clientWidth: 1200, clientHeight: 800 };
  viewport.parentElement = parent;
  const content = { width: 0, height: 0 };
  const lane = (side) => (viewport.style[side] === `${BAR}px` ? BAR : 0);
  Object.defineProperties(viewport, {
    clientWidth: { get: () => parent.clientWidth - lane('right'), configurable: true },
    clientHeight: { get: () => parent.clientHeight - lane('bottom'), configurable: true },
    scrollWidth: { get: () => Math.max(content.width, viewport.clientWidth), configurable: true },
    scrollHeight: { get: () => Math.max(content.height, viewport.clientHeight), configurable: true },
  });

  /** Sets the container size and the content extent, then re-runs the bar layout. */
  sandbox.layoutWith = ({ width = 1200, height = 800, contentWidth = 0, contentHeight = 0 }) => {
    parent.clientWidth = width;
    parent.clientHeight = height;
    content.width = contentWidth;
    content.height = contentHeight;
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

test('each bar is given its own lane rather than covering the content', () => {
  // --- Arrange: content larger than the viewport on both axes ---
  const s = createSandbox();

  // --- Act ---
  s.layoutWith({ contentWidth: 2646, contentHeight: 21000 });

  // --- Assert ---
  assert.strictEqual(s.viewport.style.right, `${BAR}px`,
    'the viewport stops where the vertical bar begins, so no column scrolls under it');
  assert.strictEqual(s.viewport.style.bottom, `${BAR}px`,
    'and where the horizontal bar begins, so no row does either');
  assert.strictEqual(s.vbar.classList.contains('hidden'), false, 'both bars are drawn');
  assert.strictEqual(s.hbar.classList.contains('hidden'), false);
});

test('with nothing to scroll the lanes go back to the content', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.layoutWith({ contentWidth: 2646, contentHeight: 21000 });
  assert.strictEqual(s.viewport.style.right, `${BAR}px`, 'the lanes start reserved');

  // --- Act: content that fits on both axes ---
  s.layoutWith({ contentWidth: 400, contentHeight: 300 });

  // --- Assert: nothing is held back for bars that aren't there ---
  assert.strictEqual(s.viewport.style.right, '', 'the vertical reservation is released');
  assert.strictEqual(s.viewport.style.bottom, '', 'and the horizontal one');
  assert.strictEqual(s.vbar.classList.contains('hidden'), true, 'along with the bars');
  assert.strictEqual(s.hbar.classList.contains('hidden'), true);
});

test('a reserved lane does not latch its own bar on', () => {
  // --- Arrange: both bars up, so both lanes are held ---
  const s = createSandbox();
  s.layoutWith({ contentWidth: 2646, contentHeight: 21000 });

  // --- Act: content shrinks to just under the UNRESERVED box — it overflows only
  //     if the held lanes are counted against it, which is the state we start from ---
  s.layoutWith({ contentWidth: 1195, contentHeight: 795 });

  // --- Assert: measured against the box with no lanes held, so both go away
  //     rather than each keeping the other alive ---
  assert.strictEqual(s.viewport.style.right, '', 'the vertical lane is released');
  assert.strictEqual(s.viewport.style.bottom, '', 'and the horizontal lane with it');
});

test('reserving one lane can call for the other bar', () => {
  // --- Arrange: content wider than the viewport but exactly as tall, so on its own
  //     it needs only the horizontal bar ---
  const s = createSandbox();

  // --- Act ---
  s.layoutWith({ width: 1200, height: 800, contentWidth: 2646, contentHeight: 800 });

  // --- Assert: that bar's lane costs 14px of height, which the content no longer
  //     fits — so the vertical bar is needed after all, and the pass that decides
  //     it has to run after the first reservation ---
  assert.strictEqual(s.viewport.style.bottom, `${BAR}px`, 'the horizontal bar gets its lane');
  assert.strictEqual(s.viewport.style.right, `${BAR}px`, 'and the vertical bar, which only that made necessary');
  assert.strictEqual(s.vbar.classList.contains('hidden'), false, 'so both bars are drawn');
  assert.strictEqual(s.hbar.classList.contains('hidden'), false);
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
