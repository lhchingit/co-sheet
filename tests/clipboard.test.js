/**
 * @file clipboard.test.js
 * @description Integration tests for client-side Copy, Cut, and Paste clipboard logic
 * and global keyboard shortcuts. Follows the AAA pattern and contains descriptive comments.
 */

import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/**
 * Helper to create a mock DOM element with styling and event listener properties.
 * @param {Object} [initialStyle] - Initial style attributes.
 * @returns {Object} A mock element conforming to DOM APIs.
 */
function createMockElement(initialStyle = {}) {
  return {
    value: '',
    innerText: '',
    innerHTML: '',
    className: '',
    style: { ...initialStyle },
    classList: {
      classes: new Set(),
      add(cls) { this.classes.add(cls); },
      remove(cls) { this.classes.delete(cls); },
      contains(cls) { return this.classes.has(cls); }
    },
    querySelectorAll() { return []; },
    appendChild() {},
    setAttribute() {},
    removeAttribute() {},
    addEventListener(_event, _cb) {},
    blur() {}
  };
}

test('Clipboard - Copy, Cut, and Paste logic with keyboard shortcuts', () => {
  // --- Arrange ---
  const code = readAppBundle();
  const documentListeners = {};
  const mockCellsDOM = {
    'A1': createMockElement(),
    'B1': createMockElement(),
    'B2': createMockElement()
  };
  const mockFormulaBar = createMockElement();

  const sandbox = {
    document: {
      getElementById(id) {
        if (id === 'formula-bar-input') return mockFormulaBar;
        return createMockElement();
      },
      querySelectorAll() { return []; },
      querySelector(selector) {
        const match = selector.match(/\[data-cell-id="([^"]+)"\]/);
        if (match && mockCellsDOM[match[1]]) {
          return mockCellsDOM[match[1]];
        }
        return null;
      },
      addEventListener(event, cb) {
        // Mirror browser semantics: a single event type can have many listeners,
        // and all of them fire. Storing only the last one would let a later
        // registration (e.g. the share dialog's Escape handler) clobber the
        // clipboard shortcut handler.
        (documentListeners[event] = documentListeners[event] || []).push(cb);
      },
      createElement() {
        return createMockElement();
      },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener() {}
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send(msg) {
        this.lastSentMessage = msg;
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array,
    JSON: JSON
  };

  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells,
      set: (val) => { localCells = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'activeCellId', {
      get: () => activeCellId,
      set: (val) => { activeCellId = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'clipboardData', {
      get: () => clipboardData,
      set: (val) => { clipboardData = val; },
      configurable: true
    });
    globalThis.copySelectedCells = copySelectedCells;
    globalThis.cutSelectedCells = cutSelectedCells;
    globalThis.pasteSelectedCells = pasteSelectedCells;
    globalThis.socket = socket;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // Initialize cells state with valid values and styling
  sandbox.localCells = {
    'A1': { value: 'Hello Copy', formula: '', style: { bold: true } },
    'B2': { value: '', formula: '', style: {} }
  };
  sandbox.activeCellId = 'A1';

  // --- Act 1: Copy cell A1 ---
  sandbox.copySelectedCells();

  // --- Assert 1: Verify clipboard state has the copied data ---
  assert.ok(sandbox.clipboardData !== null, 'Clipboard data should be populated');
  assert.strictEqual(sandbox.clipboardData.copiedCells.length, 1, 'Exactly one cell should be copied');
  assert.strictEqual(sandbox.clipboardData.copiedCells[0].value, 'Hello Copy', 'Copied value should match A1');
  assert.strictEqual(sandbox.clipboardData.copiedCells[0].formula, '', 'Copied formula should match A1');
  assert.strictEqual(sandbox.clipboardData.copiedCells[0].style.bold, true, 'Copied style should match A1');

  // --- Act 2: Move active cursor to B2 and paste ---
  sandbox.activeCellId = 'B2';
  sandbox.pasteSelectedCells();

  // --- Assert 2: Verify cell B2 matches original copied properties ---
  assert.strictEqual(sandbox.localCells['B2'].value, 'Hello Copy', 'Pasted cell B2 value should match A1');
  assert.strictEqual(sandbox.localCells['B2'].formula, '', 'Pasted cell B2 formula should match A1');
  assert.strictEqual(sandbox.localCells['B2'].style.bold, true, 'Pasted cell B2 style should match A1');

  // --- Act 3: Verify copying and pasting a valid formula ---
  sandbox.localCells = {
    'A1': { value: '5', formula: '', style: {} },
    'B1': { value: '10', formula: '=A1+5', style: {} },
    'B2': { value: '', formula: '', style: {} }
  };
  sandbox.activeCellId = 'B1';
  sandbox.copySelectedCells();
  sandbox.activeCellId = 'B2';
  sandbox.pasteSelectedCells();
  assert.strictEqual(sandbox.localCells['B2'].formula, '=A1+5', 'B2 formula should be copied');
  assert.strictEqual(sandbox.localCells['B2'].value, '10', 'B2 value should evaluate to 10');

  // --- Act 4: Cut cell A1 ---
  sandbox.localCells = {
    'A1': { value: 'Hello Cut', formula: '', style: { bold: true } }
  };
  sandbox.activeCellId = 'A1';
  sandbox.cutSelectedCells();

  // --- Assert 4: Verify A1 is cleared, but data is copied to clipboard ---
  assert.strictEqual(sandbox.localCells['A1'].value, '', 'A1 value should be cleared after cut');
  assert.strictEqual(sandbox.localCells['A1'].formula, '', 'A1 formula should be cleared after cut');
  assert.deepEqual(sandbox.localCells['A1'].style, {}, 'A1 style should be empty after cut');
  assert.strictEqual(sandbox.clipboardData.copiedCells[0].value, 'Hello Cut', 'Clipboard should still retain the cut cell value');

  // --- Act 5: Trigger Ctrl+C keyboard shortcut on A1 ---
  // Reset cell A1 and clipboard state first
  sandbox.localCells['A1'] = { value: 'Keyboard Value', formula: '', style: { italic: true } };
  sandbox.activeCellId = 'A1';
  sandbox.clipboardData = null;
  // Dispatch to every registered keydown listener, as a browser would.
  const dispatchKeydown = (evt) => (documentListeners['keydown'] || []).forEach((cb) => cb(evt));
  let preventDefaultCalled = false;
  dispatchKeydown({
    key: 'c',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault() { preventDefaultCalled = true; }
  });

  // --- Assert 5: Verify copy was called via keyboard shortcut ---
  assert.ok(preventDefaultCalled, 'preventDefault should be called for Ctrl+C');
  assert.ok(sandbox.clipboardData !== null, 'Clipboard data should be set after Ctrl+C');
  assert.strictEqual(sandbox.clipboardData.copiedCells[0].value, 'Keyboard Value', 'Clipboard should hold the value from A1');

  // --- Act 6: Select B2 and trigger Ctrl+V keyboard shortcut ---
  sandbox.activeCellId = 'B2';
  preventDefaultCalled = false;
  dispatchKeydown({
    key: 'v',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault() { preventDefaultCalled = true; }
  });

  // --- Assert 6: Verify paste was called via keyboard shortcut ---
  assert.ok(preventDefaultCalled, 'preventDefault should be called for Ctrl+V');
  assert.strictEqual(sandbox.localCells['B2'].value, 'Keyboard Value', 'B2 should now contain pasted value');
  assert.strictEqual(sandbox.localCells['B2'].style.italic, true, 'B2 should retain style from A1');

  // --- Act 7: Select B2 and trigger Ctrl+X keyboard shortcut ---
  sandbox.activeCellId = 'B2';
  preventDefaultCalled = false;
  dispatchKeydown({
    key: 'x',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault() { preventDefaultCalled = true; }
  });

  // --- Assert 7: Verify cut cleared B2 and put it in clipboard ---
  assert.ok(preventDefaultCalled, 'preventDefault should be called for Ctrl+X');
  assert.strictEqual(sandbox.localCells['B2'].value, '', 'B2 should be cleared after cut');
  assert.strictEqual(sandbox.clipboardData.copiedCells[0].value, 'Keyboard Value', 'Clipboard should contain the value from B2');
});
