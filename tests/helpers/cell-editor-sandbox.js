/**
 * @file cell-editor-sandbox.js
 * @description Boots the client bundle in a VM sandbox with one editable cell and
 * a working formula bar, for tests about committing and abandoning edits.
 *
 * The two editors are driven the way a browser drives them: the cell's blur()
 * fires the handler startCellInlineEdit installed, and a key pressed on the
 * formula bar bubbles on to the document-level handler unless the bar's own
 * handler stopped it — which is the difference several of these behaviours turn
 * on (#177).
 */
import vm from 'vm';
import { readAppBundle } from './app-bundle.js';

// Colour keywords the stub browser can compute, for the paste path's probe.
const CSS_COLOR_KEYWORDS = { red: 'rgb(255, 0, 0)', white: 'rgb(255, 255, 255)' };

/**
 * Backs innerText and textContent with one string, as a real element does. They were
 * separate fields here, so a test that wrote one and read the other passed or failed
 * for the wrong reason — and the cell editor does both: a line break is spliced in
 * through textContent, which is what the caret arithmetic counts, and committed back
 * out through innerText (#238).
 * @param {Object} node
 * @returns {Object} The same node.
 */
export function withSharedText(node) {
  let text = '';
  for (const prop of ['innerText', 'textContent']) {
    Object.defineProperty(node, prop, {
      get: () => text,
      set: (v) => { text = (v == null) ? '' : String(v); },
      configurable: true,
    });
  }
  return node;
}

/** Generic element stub for the bits of the DOM the bundle touches on start-up. */
export function createMockElement() {
  return withSharedText({
    value: '', innerHTML: '', className: '', style: {}, childNodes: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelectorAll: () => [], appendChild() {}, remove() {},
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {}, blur() {}
  });
}

/**
 * @param {Object} cellState - The stored state of A1 before the edit.
 * @returns {Object} The sandbox, plus `cell`, `formulaBar`, `pressKey`,
 *   `pressBarKey` and `fnAutocomplete`.
 */
export function createCellEditorSandbox(cellState) {
  const documentListeners = {};
  // The formula bar captures its own listeners so a key can be pressed on it.
  const barListeners = {};
  const formulaBar = createMockElement();
  formulaBar.addEventListener = (type, cb) => { (barListeners[type] = barListeners[type] || []).push(cb); };

  // The cell under edit. blur() runs the handler startCellInlineEdit installed,
  // which is what a real blur does and what commits (or, after Escape, does not).
  const cell = withSharedText({
    attributes: {},
    setAttribute(name, val) { this.attributes[name] = val; },
    removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) { return this.attributes[name] != null ? this.attributes[name] : null; },
    innerHTML: '',
    // Empty, so ceSetCaret finds no text node to land in and falls back to the end
    // of the content — which is where the caret is here anyway, the selection stub
    // below reporting none.
    childNodes: [],
    className: '',
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelectorAll: () => [],
    appendChild() {}, focus() {},
    blur() { if (typeof this.onblur === 'function') this.onblur(); }
  });

  const sandbox = {
    document: {
      getElementById: (id) => (id === 'formula-bar-input' ? formulaBar : createMockElement()),
      querySelectorAll: () => [],
      querySelector: (selector) => (selector === '[data-cell-id="A1"]' ? cell : null),
      addEventListener(event, cb) { (documentListeners[event] = documentListeners[event] || []).push(cb); },
      createElement() {
        const el = createMockElement();
        let color = '';
        Object.defineProperty(el.style, 'color', {
          get: () => color,
          set: (v) => { if (v === '' || CSS_COLOR_KEYWORDS[v]) color = v; },
          configurable: true
        });
        return el;
      },
      // setStart/setEnd are reached once a stub carries real child nodes for
      // ceSetCaret to walk into.
      createRange: () => ({ selectNodeContents() {}, collapse() {}, setStart() {}, setEnd() {} }),
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
      // The autocomplete positions its dropdown against the viewport.
      innerWidth: 1280,
      innerHeight: 720
    },
    getComputedStyle: (el) => ({ color: CSS_COLOR_KEYWORDS[el.style.color] || '' }),
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 1; } send() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    setTimeout: (fn) => fn(), clearTimeout: () => {}, queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells, set: (v) => { localCells = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'activeCellId', {
      get: () => activeCellId, set: (v) => { activeCellId = v; }, configurable: true
    });
    globalThis.startCellInlineEdit = startCellInlineEdit;
    globalThis.setFormulaBarText = setFormulaBarText;
    globalThis.formulaBarText = formulaBarText;
    globalThis.fnAutocomplete = window.CoSheet.fnAutocomplete;
    globalThis.makeCellEditor = makeCellEditor;
  `, sandbox);

  // Only now: the bundle declares its own localCells/activeCellId, which shadow
  // anything seeded on the sandbox before it runs.
  sandbox.localCells = { 'A1': cellState };
  sandbox.activeCellId = 'A1';
  sandbox.cell = cell;
  sandbox.formulaBar = formulaBar;
  // Put text in the bar, and read it back, the way the app does. The bar is a
  // contenteditable div (#238), so a test that assigned `.value` would be setting a
  // property nothing reads.
  sandbox.setBarText = (text) => sandbox.setFormulaBarText(formulaBar, text);
  sandbox.barText = () => sandbox.formulaBarText(formulaBar);

  /**
   * Presses a key on the cell being edited. `mods` carries the modifier flags a
   * real event would — Ctrl/Alt+Enter breaks a line here rather than committing
   * (#238), so a test has to be able to say which.
   */
  sandbox.pressKey = (key, mods = {}) => cell.onkeydown(Object.assign({
    key, preventDefault() {}, stopPropagation() {}
  }, mods));

  /**
   * Presses a key on the formula bar. A browser bubbles it on to the
   * document-level handler unless the bar's handler stops it, and the guard that
   * would otherwise skip that handler has already been defeated by the blur, so
   * model the bubbling rather than assuming it away.
   */
  sandbox.pressBarKey = (key, mods = {}) => {
    let propagates = true;
    const event = Object.assign(
      { key, preventDefault() {}, stopPropagation() { propagates = false; } }, mods);
    (barListeners['keydown'] || []).forEach((cb) => cb(event));
    if (propagates) (documentListeners['keydown'] || []).forEach((cb) => cb(event));
  };

  return sandbox;
}
