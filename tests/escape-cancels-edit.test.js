/**
 * @file escape-cancels-edit.test.js
 * @description Escape must abandon an inline cell edit (#174): the cell goes back
 * to what it held and the blur that follows commits nothing. Escape keeps its
 * existing higher-priority jobs — closing the function autocomplete, ending a
 * formula range pick — so only a press with nothing left to close cancels.
 *
 * The client bundle runs in a VM sandbox; the cell is a mock element whose
 * blur() fires the handler the editor installed, as a browser would.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** Generic element stub for the bits of the DOM the bundle touches on start-up. */
function createMockElement() {
  return {
    value: '', innerText: '', innerHTML: '', className: '', style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelectorAll: () => [], appendChild() {}, remove() {},
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {}, blur() {}
  };
}

/**
 * Boots the bundle with one editable cell wired up.
 * @param {Object} cellState - The stored state of A1 before the edit.
 * @returns {Object} sandbox plus the mock cell element.
 */
function createSandbox(cellState) {
  const documentListeners = {};
  const formulaBar = createMockElement();

  // The cell under edit. blur() runs the handler startCellInlineEdit installed,
  // which is what a real blur does and what commits (or, after Escape, does not).
  const cell = {
    attributes: {},
    setAttribute(name, val) { this.attributes[name] = val; },
    removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) { return this.attributes[name] != null ? this.attributes[name] : null; },
    innerText: '',
    innerHTML: '',
    className: '',
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelectorAll: () => [],
    appendChild() {}, focus() {},
    blur() { if (typeof this.onblur === 'function') this.onblur(); }
  };

  const sandbox = {
    document: {
      getElementById: (id) => (id === 'formula-bar-input' ? formulaBar : createMockElement()),
      querySelectorAll: () => [],
      querySelector: (selector) => (selector === '[data-cell-id="A1"]' ? cell : null),
      addEventListener(event, cb) { (documentListeners[event] = documentListeners[event] || []).push(cb); },
      createElement: () => createMockElement(),
      createRange: () => ({ selectNodeContents() {}, collapse() {} }),
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
    globalThis.fnAutocomplete = window.CoSheet.fnAutocomplete;
  `, sandbox);

  // Only now: the bundle declares its own localCells/activeCellId, which shadow
  // anything seeded on the sandbox before it runs.
  sandbox.localCells = { 'A1': cellState };
  sandbox.activeCellId = 'A1';
  sandbox.cell = cell;
  sandbox.formulaBar = formulaBar;
  /** Presses a key on the cell being edited. */
  sandbox.pressKey = (key) => cell.onkeydown({
    key, preventDefault() {}, stopPropagation() {}
  });
  return sandbox;
}

test('Escape abandons the edit and the blur that follows commits nothing', () => {
  // --- Arrange: A1 holds 100 and is being edited ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.startCellInlineEdit('A1', s.cell);
  s.cell.innerText = '999';

  // --- Act ---
  s.pressKey('Escape');

  // --- Assert: Escape blurred the cell itself, and nothing was written ---
  assert.strictEqual(s.localCells['A1'].value, '100', 'the stored value must be untouched');
  assert.strictEqual(s.cell.getAttribute('contenteditable'), null, 'editing should have ended');
});

test('a blur arriving after Escape still commits nothing', () => {
  // --- Arrange ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.startCellInlineEdit('A1', s.cell);
  s.cell.innerText = '999';

  // --- Act: Escape, then the blur a click elsewhere would produce ---
  s.pressKey('Escape');
  s.cell.blur();

  // --- Assert: this is the actual bug — the second blur used to save ---
  assert.strictEqual(s.localCells['A1'].value, '100');
});

test('an abandoned first entry leaves an empty cell empty', () => {
  const s = createSandbox({ value: '', formula: '', style: {} });
  s.startCellInlineEdit('A1', s.cell, 'draft');

  s.pressKey('Escape');
  s.cell.blur();

  assert.strictEqual(s.localCells['A1'].value, '');
  assert.strictEqual(s.localCells['A1'].formula, '');
});

test('an abandoned formula is not evaluated or stored', () => {
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.startCellInlineEdit('A1', s.cell);
  s.cell.innerText = '=SUM(';

  s.pressKey('Escape');
  s.cell.blur();

  // Without the cancel path this committed "=SUM()" — balanceFormulaParens closes
  // the paren on the way in — and the cell showed an error.
  assert.strictEqual(s.localCells['A1'].formula, '');
  assert.strictEqual(s.localCells['A1'].value, '100');
});

test('a normal blur still commits, so the happy path is intact', () => {
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.startCellInlineEdit('A1', s.cell);
  s.cell.innerText = '250';

  s.cell.blur();

  assert.strictEqual(s.localCells['A1'].value, '250');
});

test('Enter still commits the edit', () => {
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.startCellInlineEdit('A1', s.cell);
  s.cell.innerText = '250';

  s.pressKey('Enter');

  assert.strictEqual(s.localCells['A1'].value, '250');
});

test('Escape closes the function autocomplete before it cancels anything', () => {
  // --- Arrange: an edit with the suggestion popup open ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.startCellInlineEdit('A1', s.cell);
  s.cell.innerText = '=SU';
  s.fnAutocomplete.update({
    getValue: () => '=SU',
    getCaret: () => 3,
    setValue() {},
    setCaret() {},
    getRect: () => ({ left: 0, bottom: 20, width: 100 }),
    el: s.cell
  });
  assert.ok(s.fnAutocomplete.isOpen(), 'precondition: the popup is open');

  // --- Act: the first Escape belongs to the popup ---
  s.pressKey('Escape');

  // --- Assert: still editing, nothing cancelled or committed ---
  assert.ok(!s.fnAutocomplete.isOpen(), 'the popup should have closed');
  assert.strictEqual(s.cell.getAttribute('contenteditable'), 'true', 'the edit should still be open');
  assert.strictEqual(s.localCells['A1'].value, '100');

  // --- Act: a second Escape now has nothing left to close ---
  s.pressKey('Escape');

  // --- Assert ---
  assert.strictEqual(s.cell.getAttribute('contenteditable'), null, 'the edit should have been abandoned');
  assert.strictEqual(s.localCells['A1'].value, '100');
  assert.strictEqual(s.localCells['A1'].formula, '');
});
