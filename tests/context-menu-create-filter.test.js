/**
 * @file context-menu-create-filter.test.js
 * @description The cell right-click menu's "Create a filter" row must be a
 * live action that does exactly what the toolbar funnel button does: create
 * the per-sheet value filter on the clicked cell's column, or — while a
 * filter is already active — remove it (with the label flipping to "Remove
 * filter", mirroring the toolbar tooltip).
 *
 * Runs the real client bundle in a vm sandbox (same approach as
 * full-selection-header-style.test.js). The DOM stub additionally materializes
 * a child element for every id="…" in an innerHTML assignment so the menu's
 * post-render getElementById wiring works, and supports closest('.grid-cell')
 * plus dataset.cellId for the window-level contextmenu handler.
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
        toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      },
      set innerHTML(v) {
        this._children.length = 0; this._ih = v;
        if (this === gridRoot) cellById.clear();
        // Materialize a stub child per id="…" in the markup so the code under
        // test can wire the rows up via document.getElementById afterwards.
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

  // Neutralize the real filter plumbing (it needs a fuller DOM) and record
  // calls instead — the menu must delegate to these exact entry points.
  const calls = { create: [], remove: 0 };
  let filterActive = false;
  const sf = sandbox.window.CoSheet.sortFilter;
  sf.applyFilter = () => {};
  sf.updateToolbarButton = () => {};
  sf.hasActiveFilter = () => filterActive;
  sf.createFilter = (colIndex) => { calls.create.push(colIndex); };
  sf.removeFilter = () => { calls.remove += 1; };

  const fire = (type, target, props = {}) => {
    const e = { button: 0, target, preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of gridRoot._listeners[type] || []) fn(e);
  };
  const fireWindow = (type, props = {}) => {
    const e = { preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of windowListeners[type] || []) fn(e);
  };
  /** Right-clicks the given cell through the real window contextmenu handler. */
  const rightClick = (cellId) => {
    fireWindow('contextmenu', { target: cellById.get(cellId), clientX: 50, clientY: 50 });
    return sandbox.document.getElementById('grid-context-menu');
  };

  return {
    sandbox, cellById, calls, fire, fireWindow, rightClick,
    setFilterActive: (v) => { filterActive = v; },
    getById: (id) => sandbox.document.getElementById(id),
  };
}

/** Renders an empty sheet and clicks B2 so there is an active cell. */
function setUpGrid() {
  const ctx = createSandbox();
  const { sandbox, cellById, fire, fireWindow } = ctx;
  sandbox.localSheets = { Sheet1: {} };
  sandbox.activeSheetName = 'Sheet1';
  sandbox.renderSpreadsheetGrid();
  fire('mousedown', cellById.get('B2'));
  fireWindow('mouseup');
  return ctx;
}

test('the right-click menu offers a live "Create a filter" action, like the toolbar', () => {
  const { calls, rightClick, getById } = setUpGrid();

  const menu = rightClick('B2');
  assert.ok(menu, 'right-clicking a cell must open the context menu');

  // The row is a real enabled <button>, not the old greyed-out <div>.
  const rowTag = /<(button|div)[^>]*id="menu-create-filter"/.exec(menu.innerHTML);
  assert.ok(rowTag, 'the menu must contain a create-filter row');
  assert.strictEqual(rowTag[1], 'button', 'the create-filter row must be an enabled button');
  const rowMarkup = menu.innerHTML.slice(rowTag.index - 200, rowTag.index + 200);
  assert.ok(!rowMarkup.includes('cursor-not-allowed'), 'the create-filter row must not be disabled');

  // No filter active -> the label is the "Create a filter" key (the sandbox
  // has no locale fetch, so t() returns the key itself).
  assert.ok(menu.innerHTML.includes('ctx.createFilter'));
  assert.ok(!menu.innerHTML.includes('data.removeFilter'));

  getById('menu-create-filter').onclick();
  assert.deepStrictEqual(calls.create, [1], 'clicking must create the filter on column B (index 1)');
  assert.strictEqual(calls.remove, 0);
  assert.strictEqual(getById('grid-context-menu'), null, 'the menu must close after the action');
});

test('the filter is created on the right-clicked cell\'s column', () => {
  const { calls, rightClick, getById } = setUpGrid();

  // Right-click a cell outside the current selection: the handler moves the
  // selection there first, and the filter must key on that column.
  rightClick('D7');
  getById('menu-create-filter').onclick();

  assert.deepStrictEqual(calls.create, [3], 'right-clicking D7 must filter column D (index 3)');
});

test('while a filter is active the row reads "Remove filter" and removes it', () => {
  const { calls, rightClick, getById, setFilterActive } = setUpGrid();
  setFilterActive(true);

  const menu = rightClick('B2');
  assert.ok(menu.innerHTML.includes('data.removeFilter'),
    'the label must flip to "Remove filter" while a filter is active, like the toolbar tooltip');
  assert.ok(!menu.innerHTML.includes('ctx.createFilter'));

  getById('menu-create-filter').onclick();
  assert.strictEqual(calls.remove, 1, 'clicking must remove the active filter');
  assert.deepStrictEqual(calls.create, [], 'no new filter may be created while one is active');
});

test('reopening the menu after removing the filter offers "Create a filter" again', () => {
  const { calls, rightClick, getById, setFilterActive } = setUpGrid();

  setFilterActive(true);
  rightClick('C3');
  getById('menu-create-filter').onclick();
  assert.strictEqual(calls.remove, 1);

  setFilterActive(false); // the real removeFilter clears the active state
  const menu = rightClick('C3');
  assert.ok(menu.innerHTML.includes('ctx.createFilter'), 'the label must revert once no filter is active');
  getById('menu-create-filter').onclick();
  assert.deepStrictEqual(calls.create, [2], 'the toggle must create again on column C (index 2)');
});
