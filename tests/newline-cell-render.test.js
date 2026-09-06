process.env.NODE_ENV = 'test';

/**
 * @file newline-cell-render.test.js
 * @description A cell whose value carries a line break -- what an Excel or Sheets
 * paste puts in one cell, and what Alt+Enter types into one -- used to grow its row
 * behind the model's back: the innerText *setter* turns each "\n" into a <br>, which
 * breaks the line even under `white-space: nowrap`. Nothing modelled that growth
 * (getCellMinHeight modelled the font size, hasWrappedRows only catches
 * textWrap: 'wrap'), so every offset below the cell drifted by it (#240).
 *
 * The fix is to model the break rather than to hide it, because a break is meant to
 * be seen: the text is written with textContent and drawn with `pre`, and
 * modelledCellHeight sizes the row from the line count the same way it sizes one
 * from the font size. The sheet stays on the windowed path either way -- only a
 * wrapped cell, whose height depends on the column width, still has to be measured.
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/**
 * A DOM element stub whose innerText setter behaves like the browser's: it turns a
 * newline into a <br>. That is the behaviour under test, so the stub has to have it
 * — with a stub that treated innerText and textContent alike there would be nothing
 * to catch.
 */
function el() {
  const classes = new Set();
  const node = {
    nodeName: 'DIV', nodeType: 1,
    children: [], childNodes: [], attributes: {}, style: {},
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
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    append(...c) { c.forEach((x) => this.appendChild(x)); },
    remove() {}, addEventListener() {}, focus() {}, blur() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelectorAll(sel) { return sel === 'br' ? this.children.filter((c) => c.nodeName === 'BR') : []; },
    querySelector: () => null,
    get firstElementChild() { return this.children[0] || null; },
  };
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get() { return text; },
    // Plain text: no elements, so no forced break.
    set(v) { text = String(v); this.children.length = 0; this.childNodes.length = 0; },
    configurable: true,
  });
  Object.defineProperty(node, 'innerText', {
    get() { return text; },
    set(v) {
      text = String(v);
      this.children.length = 0;
      this.childNodes.length = 0;
      // The browser's setter splits on newlines and puts a <br> between the pieces.
      const parts = text.split('\n');
      for (let i = 1; i < parts.length; i++) this.appendChild({ nodeName: 'BR', nodeType: 1 });
    },
    configurable: true,
  });
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; }, set(_v) { this.children.length = 0; this.childNodes.length = 0; }, configurable: true,
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
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    globalThis.render = renderSpreadsheetGrid;
    globalThis.updateCell = updateGridDOMCell;
    globalThis.seedCells = (cells) => { for (const id in cells) localCells[id] = cells[id]; };
    globalThis.cellEl = (id) => getCellEl(id);
    globalThis.isWindowed = () => activeSheetWindowed;
    globalThis.rowHeight = (r) => getRowHeight(r);
    globalThis.storedValue = (id) => (localCells[id] || {}).value;
    globalThis.minHeight = (fontSize, lines) => getCellMinHeight(fontSize, lines);
  `, sandbox);

  sandbox.byId = byId;
  return sandbox;
}

/** Every element under `node` (the stub keeps fragments as children). */
function* walk(node) {
  for (const child of node.children || []) {
    yield child;
    yield* walk(child);
  }
}
const renderedCell = (s, id) => [...walk(s.byId['grid-root'])]
  .find((n) => n.getAttribute && n.getAttribute('data-cell-id') === id);

const withBreak = { formula: '', value: 'alpha\nbeta', style: {} };

test('a value with a line break is written as text, so nothing forces a break', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ C5: withBreak });

  // --- Act ---
  s.render();
  const cell = renderedCell(s, 'C5');

  // --- Assert: a <br> would break the line whatever white-space says, and grow the
  //     row by an amount the model does not know about ---
  assert.ok(cell, 'the cell was rendered');
  assert.strictEqual(cell.children.filter((c) => c.nodeName === 'BR').length, 0,
    'the render leaves no <br> in the cell');
  assert.strictEqual(cell.textContent, 'alpha\nbeta', 'and the text is all there');
});

test('the same holds when a cell is updated in place', () => {
  // --- Arrange: the path a paste and a peer's edit both take ---
  const s = createSandbox();
  s.seedCells({ C5: { formula: '', value: 'plain', style: {} } });
  s.render();

  // --- Act ---
  s.seedCells({ C5: withBreak });
  s.updateCell('C5', 'alpha\nbeta', {});
  const cell = s.cellEl('C5');

  // --- Assert ---
  assert.strictEqual(cell.children.filter((c) => c.nodeName === 'BR').length, 0,
    'updateGridDOMCell leaves no <br> either');
  assert.strictEqual(cell.textContent, 'alpha\nbeta');
});

test('the stored value keeps its newlines — only the rendering changed', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ C5: withBreak });

  // --- Act ---
  s.render();

  // --- Assert: read back out of the model, not off the fixture ---
  assert.strictEqual(s.cellEl('C5').textContent, 'alpha\nbeta', 'shown with the break in it');
  assert.strictEqual(s.storedValue('C5'), 'alpha\nbeta', 'and the stored value still has it');
});

test('the row grows to the lines it draws, and the sheet stays windowed', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ C5: withBreak });

  // --- Act ---
  s.render();

  // --- Assert: two lines is the height the model gives the row, and it is reached
  //     without leaving the windowed path -- a break costs no performance ---
  assert.strictEqual(s.rowHeight(5), s.minHeight(null, 2), 'row 5 is two lines tall');
  assert.ok(s.rowHeight(5) > 21, 'which is taller than the default row');
  assert.strictEqual(s.isWindowed(), true, 'and the sheet is still windowed');
});

test('a cell with no break leaves its row alone', () => {
  // The model must not claim a row that nothing grew, or every row below it would
  // be placed too low -- the same drift as #240, in the other direction.
  const s = createSandbox();
  s.seedCells({ C5: { formula: '', value: 'plain', style: {} } });

  // --- Act ---
  s.render();

  // --- Assert ---
  assert.strictEqual(s.rowHeight(5), 21, 'row 5 keeps the default height');
});

test('the height counts lines and font size together', () => {
  // --- Arrange & Act ---
  const s = createSandbox();

  // --- Assert: each extra line adds a line box, at whatever size the cell is ---
  const one = s.minHeight(24, 1);
  const two = s.minHeight(24, 2);
  const three = s.minHeight(24, 3);
  assert.ok(one > 21, 'a single 24pt line already needs more than the default row');
  assert.strictEqual(two - one, three - two, 'every extra line costs the same');
  assert.ok(two > one, 'and a second line is taller than one');
  assert.strictEqual(s.minHeight(null, 1), null,
    'while a default-size single line asks for nothing');
});

test('a broken cell is drawn with pre, from the render and from an update alike', () => {
  // `pre` shows the break without also wrapping at the column edge, which is what
  // textWrap: 'wrap' asks for and nothing else should get. The two sites must agree,
  // or a cell would show its break after a render and lose it after an edit.
  const s = createSandbox();
  s.seedCells({ C5: withBreak });

  // --- Act ---
  s.render();

  // --- Assert ---
  assert.strictEqual(renderedCell(s, 'C5').style.whiteSpace, 'pre', 'the render draws it');
  s.updateCell('C5', 'alpha\nbeta', {});
  assert.strictEqual(s.cellEl('C5').style.whiteSpace, 'pre', 'and so does an update');
});

test('a cell that loses its break loses the white-space that drew it', () => {
  // --- Arrange: updateGridDOMCell reuses the element, so this has to be cleared ---
  const s = createSandbox();
  s.seedCells({ C5: withBreak });
  s.render();

  // --- Act ---
  s.updateCell('C5', 'plain', {});

  // --- Assert ---
  assert.strictEqual(s.cellEl('C5').style.whiteSpace, '',
    "back to the stylesheet's own nowrap");
});

test('a wrapped cell shows its breaks, on the path that measures heights', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ C5: { formula: '', value: 'alpha\nbeta', style: { textWrap: 'wrap' } } });

  // --- Act ---
  s.render();
  const cell = renderedCell(s, 'C5');

  // --- Assert: pre-wrap, not normal -- `normal` would collapse the break to a
  //     space, so turning wrapping on would not show it ---
  assert.strictEqual(cell.style.whiteSpace, 'pre-wrap', 'the break is drawn');
  assert.strictEqual(s.isWindowed(), false,
    'and the sheet falls back to the full render, where row heights are measured');
});

test('a wrapped cell is left to that measurement, not modelled', () => {
  // Its height depends on where the text breaks against the column width, which no
  // model can know; claiming a height for it would fight the measured one.
  const s = createSandbox();
  s.seedCells({ C5: { formula: '', value: 'alpha\nbeta', style: { textWrap: 'wrap' } } });

  // --- Act ---
  s.render();

  // --- Assert ---
  assert.strictEqual(s.rowHeight(5), 21, 'the model claims nothing for a wrapped row');
});

test('updating a cell into the wrapped state uses pre-wrap too', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.seedCells({ C5: withBreak });
  s.render();

  // --- Act ---
  s.updateCell('C5', 'alpha\nbeta', { textWrap: 'wrap' });

  // --- Assert ---
  assert.strictEqual(s.cellEl('C5').style.whiteSpace, 'pre-wrap');
});
