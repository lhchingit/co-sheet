process.env.NODE_ENV = 'test';

/**
 * @file row-band-recycling.test.js
 * @description A scroll changes which rows should exist and nothing else, and
 * almost all of them existed a moment ago — so the band is moved by removing the
 * rows that left and building the ones that entered, instead of rebuilding ~1,600
 * elements (#201).
 *
 * The load-bearing claim is that this leaves the SAME grid a full render would
 * have built, so that is what these assert, canonically (placement is explicit, so
 * an appended row sits on its own track wherever it falls among its siblings and
 * DOM order carries no meaning). They also assert the cheap path was actually
 * taken — otherwise a silent fallback would satisfy the equivalence for the wrong
 * reason. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

const ROW_H = 21;

/** DOM element stub that supports removal, which the band update needs. */
function el(counters, tag = 'div') {
  const classes = new Set();
  const node = {
    tag, children: [], attributes: {}, style: {}, textContent: '', innerText: '', value: '',
    parent: null,
    offsetHeight: ROW_H, offsetWidth: 100, scrollWidth: 10, clientWidth: 100,
    scrollTop: 0, scrollLeft: 0, clientHeight: 30 * ROW_H,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c), toggle: () => {}
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return this.attributes[n] != null ? this.attributes[n] : null; },
    removeAttribute(n) { delete this.attributes[n]; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    append(...c) { c.forEach((x) => this.appendChild(x)); },
    remove() {
      if (!this.parent) return;
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    },
    addEventListener() {}, focus() {}, blur() {},
    querySelectorAll: () => [], querySelector: () => null,
    get firstElementChild() { return this.children[0] || null; }
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) { this._html = v; this.children.forEach((c) => { c.parent = null; }); this.children.length = 0; },
    configurable: true
  });
  return node;
}

function createSandbox() {
  const counters = { created: 0 };
  const byId = {};
  const rafQueue = [];
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el(counters))),
      createElement: (t) => { counters.created++; return el(counters, t); },
      createDocumentFragment: () => el(counters, '#fragment'),
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: () => ({ color: '' }),
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i ? i.detail : null; } },
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    setTimeout: () => {}, clearTimeout: () => {}, queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells, set: (v) => { localCells = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'localSheets', {
      get: () => localSheets, set: (v) => { localSheets = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'renderedRowStart', { get: () => renderedRowStart, configurable: true });
    Object.defineProperty(globalThis, 'renderedRowEnd', { get: () => renderedRowEnd, configurable: true });
    globalThis.renderSpreadsheetGrid = renderSpreadsheetGrid;
    globalThis.onGridScrollWindow = onGridScrollWindow;
    globalThis.updateRowBand = updateRowBand;
  `, sandbox);

  const cells = Object.create(null);
  for (let i = 0; i < 3000; i++) {
    const r = (i % 1000) + 1;
    const c = String.fromCharCode(65 + ((i / 1000 | 0) % 26));
    cells[`${c}${r}`] = { formula: '', value: `value ${i}`, style: { bold: i % 5 === 0 } };
  }
  sandbox.localCells = cells;
  sandbox.localSheets.Sheet1 = cells;

  sandbox.counters = counters;
  sandbox.viewport = sandbox.document.getElementById('grid-viewport');
  /** Scroll to a row and run the frame the handler scheduled. */
  sandbox.scrollToRow = (row) => {
    sandbox.viewport.scrollTop = row * ROW_H;
    sandbox.onGridScrollWindow();
    rafQueue.splice(0, rafQueue.length).forEach((fn) => fn());
  };
  /** Every row/cell in the grid, keyed by id, in a canonical order. */
  sandbox.dump = () => {
    const out = [];
    const walk = (n) => {
      const rid = n.getAttribute && n.getAttribute('data-row-id');
      const cid = n.getAttribute && n.getAttribute('data-cell-id');
      if (rid || cid) {
        out.push(`${cid ? `cell ${cid}` : `row ${rid}`}|${n.className}` +
          `|${JSON.stringify(n.style)}|${JSON.stringify(n.innerText || '')}`);
      }
      (n.children || []).forEach(walk);
    };
    walk(sandbox.document.getElementById('grid-root'));
    return out.sort().join('\n');
  };
  return sandbox;
}

test('moving the band leaves the grid a full render would have built', () => {
  // --- Arrange: two identical sandboxes, one scrolled incrementally and one
  // rebuilt from scratch at the same position ---
  const incremental = createSandbox();
  const full = createSandbox();
  incremental.renderSpreadsheetGrid();
  full.renderSpreadsheetGrid();

  // --- Act: walk down the sheet in small steps ---
  let moves = 0;
  for (let row = 0; row <= 300; row += 7) {
    const before = `${incremental.renderedRowStart}:${incremental.renderedRowEnd}`;
    incremental.scrollToRow(row);
    // The margin from #215 means a small scroll legitimately leaves the band
    // alone; the full-render side has to take the same decision or the two end up
    // comparing different scroll positions.
    if (`${incremental.renderedRowStart}:${incremental.renderedRowEnd}` !== before) {
      moves++;
      full.viewport.scrollTop = row * ROW_H;
      full.renderSpreadsheetGrid();
    }
  }

  // --- Assert ---
  assert.ok(moves >= 5, `the band moved several times during the walk (${moves})`);
  assert.strictEqual(
    `${incremental.renderedRowStart}-${incremental.renderedRowEnd}`,
    `${full.renderedRowStart}-${full.renderedRowEnd}`,
    'both ended on the same band'
  );
  assert.strictEqual(incremental.dump(), full.dump(), 'and on the same grid, cell for cell');
});

test('a small scroll builds only the rows that entered', () => {
  // Without this the equivalence above would be satisfied by silently falling back
  // to a full rebuild every time — the same answer for the wrong reason.
  const s = createSandbox();
  s.renderSpreadsheetGrid();
  const bandRows = s.renderedRowEnd - s.renderedRowStart + 1;

  s.counters.created = 0;
  let moves = 0;
  for (let row = 0; row <= 300; row += 7) {
    const before = `${s.renderedRowStart}:${s.renderedRowEnd}`;
    s.scrollToRow(row);
    if (`${s.renderedRowStart}:${s.renderedRowEnd}` !== before) moves++;
  }

  assert.ok(moves >= 5, `the band moved several times (${moves})`);
  // A rebuild constructs the whole band; a move constructs the shift. Comparing
  // against the band's own size keeps this meaningful if the overscan changes.
  const perMove = s.counters.created / moves;
  assert.ok(
    perMove < bandRows * 27 * 0.75,
    `each move builds a fraction of a band, not all of it (${Math.round(perMove)} elements/move, band is ${bandRows} rows)`
  );
});

test('a jump rebuilds what it has to, and still agrees with a full render', () => {
  // Nothing survives a jump past the band, so this is the case where incremental
  // and full do the same amount of work — it must still be correct.
  const incremental = createSandbox();
  const full = createSandbox();
  incremental.renderSpreadsheetGrid();
  full.renderSpreadsheetGrid();

  incremental.scrollToRow(700);
  full.viewport.scrollTop = 700 * ROW_H;
  full.renderSpreadsheetGrid();

  assert.ok(incremental.renderedRowStart > 600, 'the band followed the jump');
  assert.strictEqual(incremental.dump(), full.dump(), 'and matches a full render there');
});

test('a change the band update cannot honour falls back to a full render', () => {
  // The fingerprint covers what a reused band assumes: the sheet, the column
  // count, the frozen rows, hidden columns, row heights, wrapped text. A column
  // appearing changes where every cell sits, so the band cannot simply be extended.
  const s = createSandbox();
  s.renderSpreadsheetGrid();
  s.scrollToRow(120);

  // Data appears far to the right, widening the grid.
  s.localCells.BA5 = { formula: '', value: 'way out', style: {} };

  assert.strictEqual(s.updateRowBand(), false, 'the band update declines');

  // And the full render that the caller falls back to picks the change up.
  s.renderSpreadsheetGrid();
  assert.strictEqual(s.updateRowBand(), true, 'once rendered, the band is reusable again');
});
