/**
 * @file apply-format-painter.test.js
 * @description The toolbar "Apply format" roller (format painter) must copy the
 * active cell's visual style onto the next cell/range the user selects:
 * arm on click (visible pressed state + paint-format-mode body class), stamp on
 * the mouseup that completes the next grid selection, then disarm. A second
 * click or Escape cancels. `link` and `merge` are content/geometry, not
 * formatting — never copied from the source, always kept on the target.
 *
 * Runs the real client bundle in a vm sandbox (same approach as
 * context-menu-create-filter.test.js). The toolbar button element is
 * pre-registered so the bundle's getElementById wiring finds it.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

function createSandbox() {
  let gridRoot = null;
  const cellById = new Map(); // data-cell-id -> element
  const elById = new Map();   // element id -> element

  const makeEl = () => {
    const classes = new Set();
    const el = {
      nodeType: 1, tagName: 'div', style: {}, _children: [], _attrs: {},
      scrollWidth: 0, clientWidth: 100, clientHeight: 21,
      offsetWidth: 100, offsetHeight: 21, offsetLeft: 0, offsetTop: 0, scrollHeight: 0,
      firstElementChild: null,
      _listeners: {},
      set id(v) { this._id = v; if (v) elById.set(v, this); },
      get id() { return this._id || ''; },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get className() { return [...classes].join(' '); },
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          const want = force === undefined ? !classes.has(c) : !!force;
          if (want) classes.add(c); else classes.delete(c);
          return want;
        },
      },
      set innerHTML(v) {
        this._children.length = 0; this._ih = v;
        if (this === gridRoot) cellById.clear();
        for (const m of String(v).matchAll(/id="([^"]+)"/g)) {
          const child = makeEl();
          child.id = m[1];
          child._parent = this;
          this._children.push(child);
        }
      },
      get innerHTML() { return this._ih || ''; },
      set innerText(v) { this._it = v; }, get innerText() { return this._it || ''; },
      set textContent(v) { this._tc = v; }, get textContent() { return this._tc || ''; },
      setAttribute(k, v) {
        this._attrs[k] = v;
        if (k === 'data-cell-id') cellById.set(v, this);
      },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      removeAttribute(k) { delete this._attrs[k]; },
      get dataset() { return { cellId: this._attrs['data-cell-id'] }; },
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      removeEventListener() {},
      appendChild(c) { this._children.push(c); c._parent = this; return c; },
      removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; },
      remove() { if (this._parent) this._parent.removeChild(this); if (this._id) elById.delete(this._id); },
      closest(sel) {
        for (let n = this; n; n = n._parent || null) {
          if (sel === '[data-cell-id]' && n._attrs && 'data-cell-id' in n._attrs) return n;
          if (sel === '.grid-cell' && n.classList && n.classList.contains('grid-cell')) return n;
          if (sel.startsWith('#') && n._id === sel.slice(1)) return n;
        }
        return null;
      },
      querySelector() { return null; }, querySelectorAll() { return []; },
      contains() { return false; },
      scrollIntoView() {}, focus() {}, blur() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
      get parentNode() { return this._parent || null; },
    };
    return el;
  };

  gridRoot = makeEl();
  const body = makeEl();
  body.tagName = 'body';
  // The toolbar roller lives in the page markup (private/index.html), not in
  // anything the bundle renders, so it must exist before the bundle wires it.
  const paintBtn = makeEl();
  paintBtn.tagName = 'button';
  paintBtn.id = 'toolbar-paint-format';

  const windowListeners = {};
  const documentListeners = {};
  const parseCellSel = (sel) => {
    const m = /\[data-cell-id="([^"]+)"\]/.exec(sel);
    return m ? m[1] : null;
  };

  const sandbox = {
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    },
    document: {
      getElementById: (id) => (id === 'grid-root' ? gridRoot : (elById.get(id) || null)),
      createElement: () => makeEl(),
      createDocumentFragment: () => makeEl(),
      querySelector: (sel) => { const c = parseCellSel(sel); return c ? (cellById.get(c) || null) : null; },
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (documentListeners[type] = documentListeners[type] || []).push(fn); },
      activeElement: null,
      body,
    },
    WebSocket: class { constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    setTimeout: () => 0, clearTimeout: () => {}, queueMicrotask: () => {}, requestAnimationFrame: () => 0,
    console, Math, parseFloat, parseInt, isNaN, isFinite, String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Proxy, Reflect,
  };
  vm.createContext(sandbox);

  const exportSuffix = `
    globalThis.renderSpreadsheetGrid = renderSpreadsheetGrid;
    Object.defineProperty(globalThis, 'localSheets', { get: () => localSheets, set: (v) => { localSheets = v; }, configurable: true });
    Object.defineProperty(globalThis, 'activeSheetName', { get: () => activeSheetName, set: (v) => { activeSheetName = v; }, configurable: true });
  `;
  vm.runInContext(readAppBundle() + exportSuffix, sandbox);

  const fire = (type, target, props = {}) => {
    const e = { button: 0, target, preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of gridRoot._listeners[type] || []) fn(e);
  };
  const fireWindow = (type, props = {}) => {
    const e = { preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of windowListeners[type] || []) fn(e);
  };
  const fireDocument = (type, props = {}) => {
    const e = { preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of documentListeners[type] || []) fn(e);
  };
  const clickPaintButton = () => {
    for (const fn of paintBtn._listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} });
  };
  /** Full click on a cell: grid mousedown then the window-level mouseup. */
  const clickCell = (cellId) => {
    fire('mousedown', cellById.get(cellId));
    fireWindow('mouseup');
  };
  const painterArmed = () =>
    body.classList.contains('paint-format-mode') && paintBtn.classList.contains('bg-surface-variant');
  /** Whether the given cell currently wears the dashed source outline. */
  const sourceOutlined = (cellId) => {
    const el = cellById.get(cellId);
    return !!el && el.classList.contains('paint-format-source');
  };

  return { sandbox, cellById, paintBtn, body, fire, fireWindow, fireDocument, clickPaintButton, clickCell, painterArmed, sourceOutlined };
}

/** Renders a sheet with the given cells and returns the sandbox helpers. */
function setUpGrid(cells = {}) {
  const ctx = createSandbox();
  ctx.sandbox.localSheets = { Sheet1: cells };
  ctx.sandbox.activeSheetName = 'Sheet1';
  ctx.sandbox.renderSpreadsheetGrid();
  return ctx;
}

const cellStyle = (ctx, id) => {
  const cell = ctx.sandbox.localSheets.Sheet1[id];
  return cell ? cell.style : undefined;
};

test('clicking Apply format arms the painter and the next cell click receives the style', () => {
  const ctx = setUpGrid({
    A1: { formula: '', value: 'src', style: { bold: true, textColor: '#ff0000', fontSize: 14 } },
    B1: { formula: '', value: 'dst', style: {} },
  });
  const { clickCell, clickPaintButton, fireWindow, painterArmed, sourceOutlined } = ctx;

  clickCell('A1'); // the source becomes the active cell
  assert.strictEqual(painterArmed(), false, 'the painter must start idle');
  assert.strictEqual(sourceOutlined('A1'), false, 'no dashed outline while idle');

  clickPaintButton();
  assert.strictEqual(painterArmed(), true, 'clicking the roller must arm the painter (pressed button + mode class)');
  assert.strictEqual(sourceOutlined('A1'), true, 'the source cell must wear the dashed outline while armed');

  // A mouseup that doesn't finish a grid selection (e.g. on the toolbar) must
  // NOT fire the painter.
  fireWindow('mouseup');
  assert.strictEqual(painterArmed(), true, 'a non-grid mouseup must leave the painter armed');

  clickCell('B1');
  assert.deepStrictEqual(cellStyle(ctx, 'B1'), { bold: true, textColor: '#ff0000', fontSize: 14 },
    'the target must receive a copy of the source style');
  assert.strictEqual(painterArmed(), false, 'the painter must disarm after painting once');
  assert.strictEqual(sourceOutlined('A1'), false, 'the dashed outline must leave the source once painted');

  // The copy must be deep: mutating the target may not bleed into the source.
  cellStyle(ctx, 'B1').bold = false;
  assert.strictEqual(cellStyle(ctx, 'A1').bold, true);

  // Painting is one-shot: another selection must not paint again.
  clickCell('C1');
  assert.ok(!cellStyle(ctx, 'C1') || Object.keys(cellStyle(ctx, 'C1')).length === 0,
    'a later selection must not be painted');
});

test('a drag selection paints every cell in the range', () => {
  const ctx = setUpGrid({
    A1: { formula: '', value: '', style: { italic: true, color: '#00ff00' } },
  });
  const { fire, fireWindow, clickCell, clickPaintButton, cellById } = ctx;

  clickCell('A1');
  clickPaintButton();

  fire('mousedown', cellById.get('B2'));
  fire('mouseover', cellById.get('C3')); // drag out to a 2×2 range
  fireWindow('mouseup');

  for (const id of ['B2', 'B3', 'C2', 'C3']) {
    assert.deepStrictEqual(cellStyle(ctx, id), { italic: true, color: '#00ff00' },
      `every cell of the dragged range must be painted (${id})`);
  }
});

test('painting from an unformatted source clears the target, but link and merge survive', () => {
  const ctx = setUpGrid({
    A1: { formula: '', value: 'plain', style: {} },
    B1: { formula: '', value: 'x', style: { bold: true, link: 'https://example.com', merge: { rows: 2, cols: 1 } } },
  });
  const { clickCell, clickPaintButton } = ctx;

  clickCell('A1');
  clickPaintButton();
  clickCell('B1');

  assert.deepStrictEqual(cellStyle(ctx, 'B1'), { link: 'https://example.com', merge: { rows: 2, cols: 1 } },
    'formatting is cleared; the hyperlink (content) and merge (geometry) are kept');
});

test("the source's link and merge are never copied onto the target", () => {
  const ctx = setUpGrid({
    A1: { formula: '', value: '', style: { bold: true, link: 'https://example.com', merge: { rows: 2, cols: 2 } } },
  });
  const { clickCell, clickPaintButton } = ctx;

  clickCell('A1');
  clickPaintButton();
  clickCell('D5');

  assert.deepStrictEqual(cellStyle(ctx, 'D5'), { bold: true },
    'only visual formatting travels — no hyperlink, no merge stamped onto the target');
});

test('a second click on the button and Escape both cancel without painting', () => {
  const ctx = setUpGrid({
    A1: { formula: '', value: '', style: { bold: true } },
  });
  const { clickCell, clickPaintButton, fireDocument, painterArmed, sourceOutlined } = ctx;

  clickCell('A1');
  clickPaintButton();
  clickPaintButton(); // toggle off
  assert.strictEqual(painterArmed(), false, 'a second click must disarm the painter');
  assert.strictEqual(sourceOutlined('A1'), false, 'cancelling must clear the dashed source outline');
  clickCell('B1');
  assert.ok(!cellStyle(ctx, 'B1') || Object.keys(cellStyle(ctx, 'B1')).length === 0,
    'no painting after cancel');

  clickCell('A1');
  clickPaintButton();
  assert.strictEqual(painterArmed(), true);
  fireDocument('keydown', { key: 'Escape' });
  assert.strictEqual(painterArmed(), false, 'Escape must disarm the painter');
  assert.strictEqual(sourceOutlined('A1'), false, 'Escape must clear the dashed source outline');
  clickCell('C1');
  assert.ok(!cellStyle(ctx, 'C1') || Object.keys(cellStyle(ctx, 'C1')).length === 0,
    'no painting after Escape');
});

test('the dashed source outline survives a full grid re-render', () => {
  const ctx = setUpGrid({
    A1: { formula: '', value: '', style: { bold: true } },
  });
  const { clickCell, clickPaintButton, sourceOutlined, sandbox } = ctx;

  clickCell('A1');
  clickPaintButton();
  assert.strictEqual(sourceOutlined('A1'), true);

  // A full rebuild (remote edit, resize, sheet ops…) replaces every cell
  // element; the outline must be re-applied onto the fresh source cell.
  sandbox.renderSpreadsheetGrid();
  assert.strictEqual(sourceOutlined('A1'), true,
    'the outline must be re-applied after renderSpreadsheetGrid rebuilds the DOM');
});

test('the toolbar button markup is enabled and localized in both bundled locales', async () => {
  const { readFileSync } = await import('fs');
  const html = readFileSync(new URL('../private/index.html', import.meta.url), 'utf8');
  const btn = /<button[^>]*id="toolbar-paint-format"[^>]*>/.exec(html);
  assert.ok(btn, 'private/index.html must contain the toolbar-paint-format button');
  assert.ok(!/\bdisabled\b/.test(btn[0]), 'the roller button must no longer be disabled');
  assert.ok(btn[0].includes('data-i18n-title="tip.paintFormat"'), 'the tooltip must go through i18n');

  // The armed painter shows a dashed outline on the source cell, and must NOT
  // change the pointer over target cells (it stays the normal arrow).
  const outlineRule = /\.grid-cell\.paint-format-source\s*\{[^}]*dashed[^}]*\}/.exec(html);
  assert.ok(outlineRule, 'the dashed source-cell outline rule must exist');
  assert.ok(!/paint-format-mode[^{]*\{[^}]*cursor/.test(html),
    'no paint-mode cursor override may remain — the pointer stays an arrow');

  const en = JSON.parse(readFileSync(new URL('../public/locales/en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(readFileSync(new URL('../public/locales/zh-TW.json', import.meta.url), 'utf8'));
  assert.strictEqual(typeof en['tip.paintFormat'], 'string');
  assert.strictEqual(typeof zh['tip.paintFormat'], 'string');
});
