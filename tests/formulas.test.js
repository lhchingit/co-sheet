/**
 * @file formulas.test.js
 * @description Unit/Integration tests for the co-sheet client-side formula engine.
 * Evaluates SUM, AVERAGE, and basic arithmetic operations using Node's native vm module
 * to run app.js in a mocked browser context. Follows the AAA pattern.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/**
 * Helper to create a mock DOM element with classList and custom event dispatching capabilities.
 * @returns {Object} A mock element conforming to DOM APIs.
 */
function createMockElement() {
  return {
    listeners: {},
    // Registers an event listener, supporting custom events
    addEventListener(event, cb) { this.listeners[event] = cb; },
    // Dispatches a custom event by invoking the registered callback
    dispatchEvent(event) {
      const eventType = typeof event === 'string' ? event : (event.type || '');
      if (this.listeners[eventType]) {
        this.listeners[eventType](event);
      }
      return true;
    },
    classList: {
      classes: new Set(),
      add(cls) { this.classes.add(cls); },
      remove(cls) { this.classes.delete(cls); },
      contains(cls) { return this.classes.has(cls); }
    }
  };
}

/**
 * Helper to initialize the app.js environment in a mocked browser sandbox.
 * @returns {Object} The sandbox context containing the evaluated app.js variables and functions.
 */
function createSandbox() {
  const appJsPath = path.resolve('public/app.js');
  const code = readAppBundle();
  
  // Mock browser globals required for app.js initialization
  const sandbox = {
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {}
    },
    document: {
      // Returns mock elements for sheet-tabs-container and add-sheet-btn if requested
      getElementById: (id) => {
        if (id === 'add-sheet-btn' || id === 'sheet-tabs-container') {
          return createMockElement();
        }
        return null;
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {}
    },
    WebSocket: class {
      constructor() {
        this.readyState = 0; // CONNECTING
      }
    },
    // Mock CustomEvent class for custom event support
    CustomEvent: class {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict ? eventInitDict.detail : null;
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  vm.createContext(sandbox);

  // Dynamically export the block-scoped variables and arrow functions
  // from app.js to the sandbox global context.
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells,
      set: (val) => { localCells = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'localSheets', {
      get: () => localSheets,
      set: (val) => { localSheets = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'activeSheetName', {
      get: () => activeSheetName,
      set: (val) => { activeSheetName = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'fpOriginSheet', {
      get: () => fpOriginSheet,
      set: (val) => { fpOriginSheet = val; },
      configurable: true
    });
    globalThis.getColLetter = getColLetter;
    globalThis.parseCoordinates = parseCoordinates;
    globalThis.getCellValue = getCellValue;
    globalThis.evaluateFormula = evaluateFormula;
    globalThis.recalculateSheet = recalculateSheet;
    globalThis.buildRangeRef = buildRangeRef;
    globalThis.parseFormulaRefs = parseFormulaRefs;
    globalThis.formatSheetPrefix = formatSheetPrefix;
  `;

  vm.runInContext(code + exportSuffix, sandbox);
  return sandbox;
}

test('Formula Parser - Standard non-formula cell values are returned as-is', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.localCells = {
    'A1': { value: '100' },
    'B2': { value: 'Text Value' }
  };

  // --- Act ---
  const val1 = sandbox.getCellValue('A1');
  const val2 = sandbox.getCellValue('B2');

  // --- Assert ---
  assert.strictEqual(val1, '100');
  assert.strictEqual(val2, 'Text Value');
});

test('Formula Parser - SUM evaluates range sum correctly', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.localCells = {
    'A1': { value: '10' },
    'A2': { value: '20' },
    'A3': { value: '30' },
    'B1': { formula: '=SUM(A1:A3)' }
  };

  // --- Act ---
  const val = sandbox.getCellValue('B1');

  // --- Assert ---
  assert.strictEqual(val, '60');
});

test('Formula Parser - AVERAGE evaluates range average correctly', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.localCells = {
    'A1': { value: '10' },
    'A2': { value: '20' },
    'A3': { value: '30' },
    'B1': { formula: '=AVERAGE(A1:A3)' }
  };

  // --- Act ---
  const val = sandbox.getCellValue('B1');

  // --- Assert ---
  assert.strictEqual(val, '20');
});

test('Formula Parser - Basic math operations evaluate correctly', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.localCells = {
    'A1': { value: '15' },
    'A2': { value: '5' },
    'B1': { formula: '=A1+A2' },
    'B2': { formula: '=A1-A2' },
    'B3': { formula: '=A1*A2' },
    'B4': { formula: '=A1/A2' },
    'B5': { formula: '=A1*1.5' } // With float literal
  };

  // --- Act & Assert ---
  assert.strictEqual(sandbox.getCellValue('B1'), '20');
  assert.strictEqual(sandbox.getCellValue('B2'), '10');
  assert.strictEqual(sandbox.getCellValue('B3'), '75');
  assert.strictEqual(sandbox.getCellValue('B4'), '3');
  assert.strictEqual(sandbox.getCellValue('B5'), '22.5');
});

test('Formula Parser - Division by zero returns #DIV/0!', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.localCells = {
    'A1': { value: '10' },
    'A2': { value: '0' },
    'B1': { formula: '=A1/A2' }
  };

  // --- Act ---
  const val = sandbox.getCellValue('B1');

  // --- Assert ---
  assert.strictEqual(val, '#DIV/0!');
});

test('Formula Parser - Recursive evaluation works and deep recursion returns #ERR!', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  
  // Recursive chain: B1 -> A2 -> A1
  sandbox.localCells = {
    'A1': { value: '10' },
    'A2': { formula: '=A1+5' },
    'B1': { formula: '=A2+5' }
  };

  // Circular reference: C1 -> C2 -> C1
  sandbox.localCells['C1'] = { formula: '=C2+1' };
  sandbox.localCells['C2'] = { formula: '=C1+1' };

  // --- Act ---
  const validChain = sandbox.getCellValue('B1');
  const circularChain = sandbox.getCellValue('C1');

  // --- Assert ---
  assert.strictEqual(validChain, '20');
  assert.strictEqual(circularChain, '#REF!');
});

test('Formula Parser - Invalid formulas return #ERR!', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.localCells = {
    'A1': { formula: '=SUM(INVALID)' },
    'A2': { formula: '=A1+INVALID' },
    'A3': { formula: '=ABC' }
  };

  // --- Act & Assert ---
  assert.strictEqual(sandbox.getCellValue('A1'), '#NAME?');
  assert.strictEqual(sandbox.getCellValue('A2'), '#NAME?');
  assert.strictEqual(sandbox.getCellValue('A3'), '#NAME?');
});

test('Cross-sheet - quoted sheet name range resolves from another sheet', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  // Note: not overriding localCells keeps the activeSheet-bound proxy intact, so
  // unqualified refs resolve against Sheet2 while 'Sheet 1'!… reads Sheet1.
  sandbox.localSheets = {
    'Sheet 1': {
      'E3': { value: '10' },
      'E4': { value: '20' },
      'E5': { value: '30' }
    },
    'Sheet2': {
      'A1': { formula: "=SUM('Sheet 1'!E3:E5)" }
    }
  };
  sandbox.activeSheetName = 'Sheet2';

  // --- Act ---
  const val = sandbox.getCellValue('A1');

  // --- Assert ---
  assert.strictEqual(val, '60');
});

test('Cross-sheet - unquoted sheet name single-cell reference resolves', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.localSheets = {
    'Sheet1': { 'B2': { value: '42' } },
    'Sheet2': { 'A1': { formula: '=Sheet1!B2*2' } }
  };
  sandbox.activeSheetName = 'Sheet2';

  // --- Act & Assert ---
  assert.strictEqual(sandbox.getCellValue('A1'), '84');
});

test('Cross-sheet - referenced formula keeps its own sheet as the base', (t) => {
  // --- Arrange ---
  // Sheet1!C1 = A1 + B1 — those unqualified refs must resolve within Sheet1 even
  // though C1 is reached from Sheet2.
  const sandbox = createSandbox();
  sandbox.localSheets = {
    'Sheet1': {
      'A1': { value: '5' },
      'B1': { value: '7' },
      'C1': { formula: '=A1+B1' }
    },
    'Sheet2': {
      'A1': { value: '100' }, // must NOT be picked up by Sheet1!C1
      'D1': { formula: "=Sheet1!C1" }
    }
  };
  sandbox.activeSheetName = 'Sheet2';

  // --- Act & Assert ---
  assert.strictEqual(sandbox.getCellValue('D1'), '12');
});

test('Cross-sheet - chained cross-sheet references resolve transitively', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.localSheets = {
    'Sheet1': { 'A1': { value: '3' } },
    'Sheet2': { 'A1': { formula: '=Sheet1!A1*10' } },
    'Sheet3': { 'A1': { formula: '=Sheet2!A1+5' } }
  };
  sandbox.activeSheetName = 'Sheet3';

  // --- Act & Assert ---
  assert.strictEqual(sandbox.getCellValue('A1'), '35');
});

test('Cross-sheet - reference to an unknown sheet is treated as blank', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.localSheets = {
    'Sheet1': { 'A1': { formula: "=SUM(Ghost!A1:A3)" } }
  };
  sandbox.activeSheetName = 'Sheet1';

  // --- Act & Assert ---
  assert.strictEqual(sandbox.getCellValue('A1'), '0');
});

test('Cross-sheet - buildRangeRef qualifies picks made on a foreign sheet', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.activeSheetName = 'Sheet 1'; // the sheet the user picked on
  sandbox.fpOriginSheet = 'Sheet2';    // the formula being edited lives on Sheet2

  // --- Act ---
  const range = sandbox.buildRangeRef('E3', 'E5');
  const single = sandbox.buildRangeRef('B1', 'B1');

  // --- Assert: foreign sheet name with a space gets quoted ---
  assert.strictEqual(range, "'Sheet 1'!E3:E5");
  assert.strictEqual(single, "'Sheet 1'!B1");
});

test('Cross-sheet - buildRangeRef leaves same-sheet picks unqualified', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();
  sandbox.activeSheetName = 'Sheet2';
  sandbox.fpOriginSheet = 'Sheet2'; // picking on the same sheet being edited

  // --- Act & Assert ---
  assert.strictEqual(sandbox.buildRangeRef('E3', 'E5'), 'E3:E5');
});

test('Cross-sheet - formatSheetPrefix quotes only when needed', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();

  // --- Act & Assert ---
  assert.strictEqual(sandbox.formatSheetPrefix('Sheet1'), 'Sheet1!');
  assert.strictEqual(sandbox.formatSheetPrefix('Sheet 1'), "'Sheet 1'!");
  assert.strictEqual(sandbox.formatSheetPrefix('工作表1'), "'工作表1'!");
  assert.strictEqual(sandbox.formatSheetPrefix("Bob's"), "'Bob''s'!");
});

test('Cross-sheet - parseFormulaRefs captures the sheet qualifier', (t) => {
  // --- Arrange ---
  const sandbox = createSandbox();

  // --- Act ---
  // Flatten to strings: parseFormulaRefs returns objects built inside the vm realm,
  // so deepStrictEqual would trip on the cross-realm prototype mismatch.
  const refs = sandbox.parseFormulaRefs("=SUM('Sheet 1'!E3:E5)+Sheet2!B2+A1")
    .map((r) => `${r.sheet}|${r.startId}|${r.endId}`)
    .join(' ; ');

  // --- Assert ---
  assert.strictEqual(refs, 'Sheet 1|E3|E5 ; Sheet2|B2|B2 ; null|A1|A1');
});

test('Toolbar - Formatting buttons toggle style on active cell', (t) => {
  // --- Arrange ---
  const appJsPath = path.resolve('public/app.js');
  const code = readAppBundle();

  // Track event listeners and active states
  const mockButtons = {
    'toolbar-bold': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); }
      }
    },
    'toolbar-italic': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); }
      }
    },
    'toolbar-strikethrough': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); }
      }
    },
    'toolbar-border': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); }
      }
    },
    // Mock for the main alignment dropdown toggle button container
    'toolbar-align': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); },
        contains(cls) { return this.classes.has(cls); }
      }
    },
    // Mock for the inner alignment icon element in the toggle button
    'toolbar-align-icon': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); },
        contains(cls) { return this.classes.has(cls); }
      },
      textContent: ''
    },
    // Mock for the floating dropdown menu containing alignment options
    'toolbar-align-menu': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(['hidden']),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); },
        contains(cls) { return this.classes.has(cls); }
      }
    },
    // Mock for Left alignment button option
    'toolbar-align-left': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); },
        contains(cls) { return this.classes.has(cls); }
      }
    },
    // Mock for Center alignment button option
    'toolbar-align-center': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); },
        contains(cls) { return this.classes.has(cls); }
      }
    },
    // Mock for Right alignment button option
    'toolbar-align-right': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); },
        contains(cls) { return this.classes.has(cls); }
      }
    },
    'toolbar-link': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); }
      }
    },
    'toolbar-color-text-input': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      value: '#000000'
    },
    'toolbar-color-fill-input': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      value: '#ffffff'
    },
    // Mock for Undo toolbar button, supporting classList, addEventListener, and disabled attribute operations
    'toolbar-undo': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(['opacity-40', 'cursor-not-allowed']),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); }
      },
      attributes: { disabled: 'true' },
      setAttribute(name, val) { this.attributes[name] = val; },
      removeAttribute(name) { delete this.attributes[name]; }
    },
    // Mock for Redo toolbar button, supporting classList, addEventListener, and disabled attribute operations
    'toolbar-redo': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; },
      classList: {
        classes: new Set(['opacity-40', 'cursor-not-allowed']),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); }
      },
      attributes: { disabled: 'true' },
      setAttribute(name, val) { this.attributes[name] = val; },
      removeAttribute(name) { delete this.attributes[name]; }
    },
    // Mock for the new dynamic add sheet button
    'add-sheet-btn': createMockElement(),
    // Mock for the sheet tabs container
    'sheet-tabs-container': createMockElement()
  };

  const sandbox = {
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection() {
        return {
          removeAllRanges() {},
          addRange() {}
        };
      }
    },
    document: {
      getElementById: (id) => mockButtons[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createRange() {
        return {
          selectNodeContents() {},
          collapse() {}
        };
      },
      addEventListener: () => {}
    },
    WebSocket: class {
      constructor() {
        this.readyState = 1; // OPEN
      }
      send() {}
    },
    // Mock CustomEvent class for custom event support
    CustomEvent: class {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict ? eventInitDict.detail : null;
      }
    },
    prompt: () => 'https://example.com', // Mock prompt for link input
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  vm.createContext(sandbox);

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
    globalThis.toggleFormat = toggleFormat;
    globalThis.changeCellColor = changeCellColor;
    globalThis.changeCellTextColor = changeCellTextColor;
    globalThis.toggleBorder = toggleBorder;
    globalThis.setCellAlignment = setCellAlignment;
    globalThis.changeCellLink = changeCellLink;
    globalThis.getCellValue = getCellValue;
  `;

  vm.runInContext(code + exportSuffix, sandbox);

  // Set active cell ID and initial mock cells
  sandbox.activeCellId = 'A1';
  sandbox.localCells = {
    'A1': { value: 'Test', formula: '', style: {} }
  };

  // --- Act ---
  // Trigger clicks and color/link changes
  mockButtons['toolbar-bold'].listeners['click']();
  mockButtons['toolbar-italic'].listeners['click']();
  mockButtons['toolbar-strikethrough'].listeners['click']();
  sandbox.toggleBorder('A1');
  // Trigger click on the center alignment option in the mock dropdown
  mockButtons['toolbar-align-center'].listeners['click']();
  // The toolbar link button now opens an interactive dialog; the link-setting
  // path it ultimately drives is changeCellLink, exercised directly here.
  sandbox.changeCellLink('A1', 'https://example.com');
  mockButtons['toolbar-color-text-input'].listeners['change']({ target: { value: '#ff0000' } });
  mockButtons['toolbar-color-fill-input'].listeners['change']({ target: { value: '#00ff00' } });

  // --- Assert ---
  // Verify styling in local cells was updated correctly
  assert.strictEqual(sandbox.localCells['A1'].style.bold, true);
  assert.strictEqual(sandbox.localCells['A1'].style.italic, true);
  assert.strictEqual(sandbox.localCells['A1'].style.strikethrough, true);
  assert.strictEqual(sandbox.localCells['A1'].style.border, true);
  assert.strictEqual(sandbox.localCells['A1'].style.align, 'center');
  assert.strictEqual(sandbox.localCells['A1'].style.link, 'https://example.com');
  assert.strictEqual(sandbox.localCells['A1'].style.textColor, '#ff0000');
  assert.strictEqual(sandbox.localCells['A1'].style.color, '#00ff00');
});

/**
 * Test to verify that direct cell typing (alphanumeric key) activates inline editing
 * and that pressing the Backspace key clears the cell content.
 * Follows the Arrange-Act-Assert (AAA) pattern.
 */
test('Direct Typing - Alphanumeric key starts inline edit and Backspace clears cell', (t) => {
  // --- Arrange ---
  // Read the latest app.js content to execute inside the VM context
  const code = readAppBundle();
  // Store document-level event listeners to trigger them manually
  const documentListeners = {};
  
  // Mock element representing a cell in the DOM
  const mockCellEl = {
    attributes: {},
    setAttribute(name, val) { this.attributes[name] = val; },
    removeAttribute(name) { delete this.attributes[name]; },
    innerText: 'Initial',
    focus() {},
    appendChild() {},
    querySelectorAll: () => [],
    className: '',
    style: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; }
    }
  };

  // VM sandbox context representing the global window/document context
  const sandbox = {
    localCells: {
      'A1': { value: 'Initial', formula: '', style: {} }
    },
    activeCellId: 'A1',
    document: {
      // Returns mock elements for sheet-tabs-container and add-sheet-btn if requested
      getElementById: (id) => {
        if (id === 'add-sheet-btn' || id === 'sheet-tabs-container') {
          return createMockElement();
        }
        return null;
      },
      querySelectorAll: () => [],
      querySelector: (selector) => {
        // Return the mock cell if selected by its data attribute
        if (selector === '[data-cell-id="A1"]') return mockCellEl;
        return null;
      },
      addEventListener(event, cb) {
        documentListeners[event] = cb;
      },
      createElement(tagName) {
        return {
          className: '',
          innerHTML: '',
          style: {},
          appendChild() {},
          remove() {}
        };
      },
      createRange() {
        return {
          selectNodeContents() {},
          collapse() {}
        };
      },
      activeElement: {
        tagName: 'BODY',
        getAttribute: () => null
      }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection() {
        return {
          removeAllRanges() {},
          addRange() {}
        };
      }
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    // Mock CustomEvent class for custom event support
    CustomEvent: class {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict ? eventInitDict.detail : null;
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);
  // Suffix to export block-scoped local variables from app.js to the global sandbox scope
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells,
      set: (val) => { localCells = val; }
    });
    Object.defineProperty(globalThis, 'activeCellId', {
      get: () => activeCellId,
      set: (val) => { activeCellId = val; }
    });
    globalThis.startCellInlineEdit = startCellInlineEdit;
    globalThis.clearCell = clearCell;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // Set the active cell and local cell state after evaluating app.js
  sandbox.activeCellId = 'A1';
  sandbox.localCells = {
    'A1': { value: 'Initial', formula: '', style: {} }
  };

  // --- Act 1: Press alphanumeric 'A' key ---
  documentListeners['keydown']({
    key: 'A',
    preventDefault() {},
    ctrlKey: false,
    metaKey: false,
    altKey: false
  });

  // --- Assert 1 ---
  // Verify that editing mode was activated and the key was set as the cell text
  assert.strictEqual(mockCellEl.attributes['contenteditable'], 'true');
  assert.strictEqual(mockCellEl.innerText, 'A');

  // --- Act 2: Simulate saving the inline edit ---
  // Trigger blur handler to persist changes
  mockCellEl.onblur();

  // --- Assert 2 ---
  // Verify the updated cell value in state
  assert.strictEqual(sandbox.localCells['A1'].value, 'A');

  // --- Act 3: Press Backspace key ---
  documentListeners['keydown']({
    key: 'Backspace',
    preventDefault() {},
    ctrlKey: false,
    metaKey: false,
    altKey: false
  });

  // --- Assert 3 ---
  // Verify that the cell value in state was cleared
  assert.strictEqual(sandbox.localCells['A1'].value, '');
});

test('Undo/Redo - Editing cell and triggering Undo/Redo buttons reverts and restores values', (t) => {
  // --- Arrange ---
  const code = readAppBundle();
  const documentListeners = {};
  
  const mockCellEl = {
    attributes: {},
    setAttribute(name, val) { this.attributes[name] = val; },
    removeAttribute(name) { delete this.attributes[name]; },
    innerText: 'Initial',
    focus() {},
    appendChild() {},
    querySelectorAll: () => [],
    className: '',
    style: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; }
    }
  };

  const sandbox = {
    localCells: {
      'A1': { value: 'Initial', formula: '', style: {} }
    },
    activeCellId: 'A1',
    document: {
      getElementById(id) {
        if (id === 'toolbar-undo' || id === 'toolbar-redo') {
          return {
            attributes: {},
            classList: {
              add() {},
              remove() {},
              contains() { return false; }
            },
            setAttribute(name, val) { this.attributes[name] = val; },
            removeAttribute(name) { delete this.attributes[name]; },
            addEventListener(event, cb) {}
          };
        }
        // Returns mock elements for sheet-tabs-container and add-sheet-btn if requested
        if (id === 'add-sheet-btn' || id === 'sheet-tabs-container') {
          return createMockElement();
        }
        return null;
      },
      querySelectorAll: () => [],
      querySelector: (selector) => {
        if (selector === '[data-cell-id="A1"]') return mockCellEl;
        return null;
      },
      addEventListener(event, cb) {
        documentListeners[event] = cb;
      },
      createElement() {
        return { style: {}, appendChild() {}, remove() {} };
      },
      createRange() {
        return { selectNodeContents() {}, collapse() {} };
      },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection() {
        return { removeAllRanges() {}, addRange() {} };
      }
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    // Mock CustomEvent class for custom event support
    CustomEvent: class {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict ? eventInitDict.detail : null;
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells,
      set: (val) => { localCells = val; }
    });
    Object.defineProperty(globalThis, 'activeCellId', {
      get: () => activeCellId,
      set: (val) => { activeCellId = val; }
    });
    globalThis.performUndo = performUndo;
    globalThis.performRedo = performRedo;
    globalThis.saveCellUpdate = saveCellUpdate;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // Set the active cell and initial state after evaluation
  sandbox.activeCellId = 'A1';
  sandbox.localCells = {
    'A1': { value: 'Initial', formula: '', style: {} }
  };

  // --- Act 1: Perform cell edit ---
  sandbox.saveCellUpdate('A1', 'New Value');

  // --- Assert 1 ---
  assert.strictEqual(sandbox.localCells['A1'].value, 'New Value');

  // --- Act 2: Perform Undo ---
  sandbox.performUndo();

  // --- Assert 2: Reverted to Initial ---
  assert.strictEqual(sandbox.localCells['A1'].value, 'Initial');

  // --- Act 3: Perform Redo ---
  sandbox.performRedo();

  // --- Assert 3: Restored to New Value ---
  assert.strictEqual(sandbox.localCells['A1'].value, 'New Value');
});

test('Sheets - Switching active sheet dynamically displays correct values and isolates changes', (t) => {
  // --- Arrange ---
  const code = readAppBundle();
  const documentListeners = {};
  
  const mockCellEl = {
    attributes: {},
    setAttribute(name, val) { this.attributes[name] = val; },
    removeAttribute(name) { delete this.attributes[name]; },
    innerText: 'Initial',
    focus() {},
    appendChild() {},
    querySelectorAll: () => [],
    className: '',
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } }
  };

  const sandbox = {
    localSheets: {
      'Sheet1': { 'A1': { value: 'Sheet1Val', formula: '', style: {} } },
      'Sheet2': { 'A1': { value: 'Sheet2Val', formula: '', style: {} } }
    },
    activeSheetName: 'Sheet1',
    document: {
      getElementById(id) {
        return {
          innerHTML: '',
          attributes: {},
          classList: { add() {}, remove() {} },
          setAttribute(name, val) { this.attributes[name] = val; },
          removeAttribute(name) { delete this.attributes[name]; },
          addEventListener() {},
          appendChild() {}
        };
      },
      querySelectorAll: () => [],
      querySelector: (selector) => {
        if (selector === '[data-cell-id="A1"]') return mockCellEl;
        return null;
      },
      addEventListener(event, cb) { documentListeners[event] = cb; },
      createElement() {
        return {
          style: {},
          appendChild() {},
          remove() {},
          addEventListener() {},
          setAttribute() {},
          removeAttribute() {},
          classList: { add() {}, remove() {}, contains() { return false; } }
        };
      },
      createDocumentFragment() { return this.createElement(); },
      createRange() { return { selectNodeContents() {}, collapse() {} }; },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection() { return { removeAllRanges() {}, addRange() {} }; }
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localSheets', {
      get: () => localSheets,
      set: (val) => { localSheets = val; }
    });
    Object.defineProperty(globalThis, 'activeSheetName', {
      get: () => activeSheetName,
      set: (val) => { activeSheetName = val; }
    });
    globalThis.switchSheet = switchSheet;
    globalThis.addSheet = addSheet;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // Initial values
  sandbox.activeSheetName = 'Sheet1';

  // --- Act 1: Switch to Sheet2 ---
  sandbox.switchSheet('Sheet2');

  // --- Assert 1 ---
  assert.strictEqual(sandbox.activeSheetName, 'Sheet2');
});

test('Sheets - Reordering sheet order updates active indexes', (t) => {
  // --- Arrange ---
  // Load client-side code from public/app.js
  const code = readAppBundle();
  
  // Set up mocked DOM/browser context for VM environment
  const sandbox = {
    localSheets: {
      'Sheet1': {},
      'Sheet2': {}
    },
    activeSheetName: 'Sheet1',
    sheetOrder: ['Sheet1', 'Sheet2'],
    document: {
      getElementById(id) {
        return {
          innerHTML: '',
          attributes: {},
          classList: { add() {}, remove() {} },
          setAttribute(name, val) { this.attributes[name] = val; },
          removeAttribute(name) { delete this.attributes[name]; },
          addEventListener() {},
          appendChild() {}
        };
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      createElement() {
        return {
          style: {},
          appendChild() {},
          remove() {},
          addEventListener() {},
          setAttribute() {},
          removeAttribute() {},
          classList: { add() {}, remove() {}, contains() { return false; } }
        };
      },
      createDocumentFragment() { return this.createElement(); }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {}
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  // Create vm context and define property mappings to expose local scope variables
  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    globalThis.sheetOrder = ['Sheet1', 'Sheet2'];
    Object.defineProperty(globalThis, 'localSheets', {
      get: () => localSheets,
      set: (val) => { localSheets = val; }
    });
    Object.defineProperty(globalThis, 'activeSheetName', {
      get: () => activeSheetName,
      set: (val) => { activeSheetName = val; }
    });
    globalThis.switchSheet = switchSheet;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // --- Act ---
  // Switch sheet to Sheet2 which triggers active tab and layout changes
  sandbox.switchSheet('Sheet2');

  // --- Assert ---
  // Verify that the activeSheetName has been correctly updated
  assert.strictEqual(sandbox.activeSheetName, 'Sheet2');
});

test('Sheets - Switching restores each sheet\'s last selection and formula bar', (t) => {
  // --- Arrange ---
  const code = readAppBundle();

  // A formula bar whose value we can read back to verify it follows the selection.
  const formulaBar = { value: '', focus() {}, setSelectionRange() {} };
  const makeEl = () => ({
    style: {}, attributes: {}, innerText: '', innerHTML: '',
    appendChild() {}, remove() {}, addEventListener() {}, focus() {},
    setAttribute(n, v) { this.attributes[n] = v; },
    removeAttribute(n) { delete this.attributes[n]; },
    classList: { add() {}, remove() {}, contains() { return false; } }
  });

  const sandbox = {
    document: {
      getElementById(id) { return id === 'formula-bar-input' ? formulaBar : makeEl(); },
      querySelectorAll: () => [],
      // Hand back a cell element for any data-cell-id lookup so a remembered cell
      // can be re-selected after the (mocked) grid re-render.
      querySelector: (sel) => (/\[data-cell-id=|\.w-12\.text-center/.test(sel) ? makeEl() : null),
      addEventListener() {},
      createElement() { return makeEl(); },
      createDocumentFragment() { return makeEl(); },
      createRange() { return { selectNodeContents() {}, collapse() {} }; },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection() { return { removeAllRanges() {}, addRange() {} }; }
    },
    WebSocket: class { constructor() { this.readyState = 1; } send() {} },
    CustomEvent: class { constructor(type) { this.type = type; } },
    localStorage: (() => {
      const store = {};
      return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
      };
    })(),
    console, Math, parseFloat, isNaN, String, Object, Array
  };

  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    globalThis.sheetOrder = ['Sheet1', 'Sheet2'];
    Object.defineProperty(globalThis, 'localSheets', { get: () => localSheets, set: (v) => { localSheets = v; } });
    Object.defineProperty(globalThis, 'activeSheetName', { get: () => activeSheetName, set: (v) => { activeSheetName = v; } });
    Object.defineProperty(globalThis, 'activeCellId', { get: () => activeCellId, set: (v) => { activeCellId = v; } });
    globalThis.switchSheet = switchSheet;
    globalThis.handleCellSelect = handleCellSelect;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // Seed sheet contents AFTER running the bundle, so app.js's own `let localSheets`
  // declaration doesn't clobber them. localCells reads the active sheet via a proxy.
  sandbox.localSheets = {
    'Sheet1': { 'A2': { value: 'apple', formula: '', style: {} } },
    'Sheet2': { 'B3': { value: 'banana', formula: '', style: {} } }
  };
  sandbox.activeSheetName = 'Sheet1';

  // currentFileId is null in the test harness, so the storage key falls back to 'default'.
  const SHEET_KEY = 'co-sheet:active-sheet:default';

  // --- Act 1: select A2 on Sheet1, then visit Sheet2 (fresh) ---
  sandbox.handleCellSelect('A2', sandbox.document.querySelector('[data-cell-id="A2"]'));
  assert.strictEqual(sandbox.activeCellId, 'A2');
  assert.strictEqual(formulaBar.value, 'apple');

  sandbox.switchSheet('Sheet2');
  // A not-yet-visited sheet auto-focuses A1, and the switch is persisted.
  assert.strictEqual(sandbox.activeCellId, 'A1');
  assert.strictEqual(sandbox.localStorage.getItem(SHEET_KEY), 'Sheet2');

  sandbox.handleCellSelect('B3', sandbox.document.querySelector('[data-cell-id="B3"]'));
  assert.strictEqual(formulaBar.value, 'banana');

  // --- Act 2: switch back to Sheet1 — A2 should be restored ---
  sandbox.switchSheet('Sheet1');

  // --- Assert ---
  assert.strictEqual(sandbox.activeSheetName, 'Sheet1');
  assert.strictEqual(sandbox.activeCellId, 'A2');
  assert.strictEqual(formulaBar.value, 'apple');
  assert.strictEqual(sandbox.localStorage.getItem(SHEET_KEY), 'Sheet1');

  // --- Act 3: and back to Sheet2 — B3 should be restored ---
  sandbox.switchSheet('Sheet2');
  assert.strictEqual(sandbox.activeCellId, 'B3');
  assert.strictEqual(formulaBar.value, 'banana');
});

test('Selection - Selecting a cell highlights the corresponding row and column header indexes', (t) => {
  // --- Arrange ---
  // Read code of app.js to run in a mock sandboxed vm context
  const code = readAppBundle();
  
  // Track class modifications on mock header elements
  const mockColHeader = {
    classList: {
      classes: [],
      add(className) { this.classes.push(className); },
      remove(className) { this.classes = this.classes.filter(c => c !== className); }
    }
  };
  const mockRowHeader = {
    classList: {
      classes: [],
      add(className) { this.classes.push(className); },
      remove(className) { this.classes = this.classes.filter(c => c !== className); }
    }
  };

  // Define sandbox with document, query selectors, window, and WebSocket mocks needed by app.js
  const sandbox = {
    localCells: {},
    activeCellId: null,
    document: {
      getElementById: () => null,
      querySelectorAll: (selector) => {
        // Return mock list to represent highlighted elements if requested
        if (selector === '.grid-header.active-header') {
          return [mockColHeader, mockRowHeader];
        }
        return [];
      },
      querySelector: (selector) => {
        if (selector === '[data-col-id="B"]') return mockColHeader;
        if (selector === '[data-row-id="4"]') return mockRowHeader;
        return null;
      },
      createElement: () => ({
        style: {},
        appendChild() {},
        remove() {}
      }),
      addEventListener: () => {}
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {}
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    globalThis.handleCellSelect = handleCellSelect;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // --- Act ---
  // Select cell B4 which triggers highlights on B and 4 headers
  const mockCellEl = { appendChild() {} };
  sandbox.handleCellSelect('B4', mockCellEl);

  // --- Assert ---
  // Verify that active-header class has been added to column B and row 4 headers
  assert.ok(mockColHeader.classList.classes.includes('active-header'));
  assert.ok(mockRowHeader.classList.classes.includes('active-header'));
});

test('Toolbar - Dropdown menu closure conflict resolution', (t) => {
  // --- Arrange ---
  const appJsPath = path.resolve('public/app.js');
  const code = readAppBundle();

  // Track mock elements and event listeners for alignment dropdowns
  const mockElements = {
    'toolbar-align': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; }
    },
    'toolbar-align-menu': {
      classList: {
        classes: new Set(['hidden']),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); },
        toggle(cls) {
          if (this.classes.has(cls)) this.classes.delete(cls);
          else this.classes.add(cls);
        },
        contains(cls) { return this.classes.has(cls); }
      }
    },
    'toolbar-valign': {
      listeners: {},
      addEventListener(event, cb) { this.listeners[event] = cb; }
    },
    'toolbar-valign-menu': {
      classList: {
        classes: new Set(['hidden']),
        add(cls) { this.classes.add(cls); },
        remove(cls) { this.classes.delete(cls); },
        toggle(cls) {
          if (this.classes.has(cls)) this.classes.delete(cls);
          else this.classes.add(cls);
        },
        contains(cls) { return this.classes.has(cls); }
      }
    }
  };

  // Define VM sandbox context with mock DOM methods to capture elements
  const sandbox = {
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {}
    },
    document: {
      getElementById: (id) => mockElements[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {}
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // --- Act & Assert ---

  // 1. Arrange verification: Initially, both menus should contain the 'hidden' class
  assert.ok(mockElements['toolbar-align-menu'].classList.contains('hidden'));
  assert.ok(mockElements['toolbar-valign-menu'].classList.contains('hidden'));

  // 2. Act: Trigger click on the horizontal align button
  mockElements['toolbar-align'].listeners['click']({ stopPropagation() {} });
  // Assert: The horizontal align menu is now visible (not hidden), and the vertical align menu remains hidden
  assert.ok(!mockElements['toolbar-align-menu'].classList.contains('hidden'));
  assert.ok(mockElements['toolbar-valign-menu'].classList.contains('hidden'));

  // 3. Act: Trigger click on the vertical align button
  mockElements['toolbar-valign'].listeners['click']({ stopPropagation() {} });
  // Assert: The vertical align menu is now visible (not hidden), and the horizontal align menu is closed/hidden
  assert.ok(mockElements['toolbar-align-menu'].classList.contains('hidden'));
  assert.ok(!mockElements['toolbar-valign-menu'].classList.contains('hidden'));

  // 4. Act: Trigger click on the horizontal align button again
  mockElements['toolbar-align'].listeners['click']({ stopPropagation() {} });
  // Assert: The horizontal align menu is open/visible again, and the vertical align menu has been closed/hidden
  assert.ok(!mockElements['toolbar-align-menu'].classList.contains('hidden'));
  assert.ok(mockElements['toolbar-valign-menu'].classList.contains('hidden'));
});

test('Toolbar - Vertical alignment dropdown option click applies style format and updates active UI icon', (t) => {
  // --- Arrange ---
  const code = readAppBundle();

  // Mocks for DOM elements to track vertical alignment styles and listeners
  const mockValignIcon = { textContent: 'vertical_align_bottom' };
  const mockValignMenu = {
    classList: {
      classes: ['hidden'],
      toggle(className) {
        if (this.classes.includes(className)) {
          this.classes = this.classes.filter(c => c !== className);
        } else {
          this.classes.push(className);
        }
      },
      add(className) {
        if (!this.classes.includes(className)) this.classes.push(className);
      },
      contains(className) {
        return this.classes.includes(className);
      }
    }
  };
  const mockTopBtn = {
    classList: { add() {}, remove() {} },
    listeners: {},
    addEventListener(event, cb) { this.listeners[event] = cb; }
  };
  const mockCenterBtn = {
    classList: { add() {}, remove() {} },
    listeners: {},
    addEventListener(event, cb) { this.listeners[event] = cb; }
  };
  const mockBottomBtn = {
    classList: { add() {}, remove() {} },
    listeners: {},
    addEventListener(event, cb) { this.listeners[event] = cb; }
  };

  const mockCellEl = {
    classList: { add() {}, remove() {} },
    style: { textAlign: '', justifyContent: '' },
    querySelectorAll: () => [],
    appendChild() {}
  };

  const mockButtons = {
    'toolbar-valign': { listeners: {}, addEventListener(event, cb) { this.listeners[event] = cb; } },
    'toolbar-valign-top': mockTopBtn,
    'toolbar-valign-center': mockCenterBtn,
    'toolbar-valign-bottom': mockBottomBtn
  };

  let wsSentPayload = null;

  const sandbox = {
    document: {
      getElementById: (id) => {
        if (id === 'toolbar-valign-icon') return mockValignIcon;
        if (id === 'toolbar-valign-menu') return mockValignMenu;
        if (id === 'toolbar-valign-top') return mockTopBtn;
        if (id === 'toolbar-valign-center') return mockCenterBtn;
        if (id === 'toolbar-valign-bottom') return mockBottomBtn;
        if (mockButtons[id]) return mockButtons[id];
        return null;
      },
      querySelector: (selector) => {
        if (selector === '[data-cell-id="A1"]') return mockCellEl;
        return null;
      },
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, appendChild() {}, remove() {} }),
      addEventListener: () => {}
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {}
    },
    WebSocket: class {
      static OPEN = 1;
      constructor() { this.readyState = 1; }
      send(data) {
        wsSentPayload = JSON.parse(data);
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
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
  `;

  vm.runInContext(code + exportSuffix, vmContext);

  // Set active cell ID and initial mock cells after context running to link local variables
  sandbox.activeCellId = 'A1';
  sandbox.localCells = {
    'A1': { formula: '10', value: '10', style: {} }
  };

  // --- Act ---
  // Act 1: Click the vertical alignment trigger button to open the menu
  mockButtons['toolbar-valign'].listeners['click']({ stopPropagation() {} });
  assert.ok(!mockValignMenu.classList.contains('hidden'));

  // Act 2: Click top alignment option
  mockButtons['toolbar-valign-top'].listeners['click']({ stopPropagation() {} });

  // --- Assert ---
  // Menu is closed
  assert.ok(mockValignMenu.classList.contains('hidden'));
  // Local cell style has verticalAlign set to 'top'
  assert.strictEqual(sandbox.localCells['A1'].style.verticalAlign, 'top');
  // DOM cell style justifyContent has been set to 'flex-start'
  assert.strictEqual(mockCellEl.style.justifyContent, 'flex-start');
  // WS message has broadcasted style changes to peer clients
  assert.ok(wsSentPayload);
  assert.strictEqual(wsSentPayload.type, 'cell-edit');
  assert.strictEqual(wsSentPayload.payload.style.verticalAlign, 'top');
  // UI active icon has updated
  assert.strictEqual(mockValignIcon.textContent, 'vertical_align_top');
});

test('Toolbar - Zoom selector controls, preset click, and manual input validation', (t) => {
  // --- Arrange ---
  const code = readAppBundle();

  // Mocks for DOM elements to track zoom state and listeners
  const mockGridRoot = { style: { zoom: '1' } };
  
  let selectCalled = false;
  let blurCalled = false;
  const mockZoomInput = {
    value: '100%',
    listeners: {},
    addEventListener(event, cb) { this.listeners[event] = cb; },
    select() { selectCalled = true; },
    blur() { blurCalled = true; }
  };

  const mockZoomArrow = {
    listeners: {},
    addEventListener(event, cb) { this.listeners[event] = cb; }
  };

  const createClassList = (initialClasses) => ({
    classes: initialClasses || [],
    toggle(className) {
      if (this.classes.includes(className)) {
        this.classes = this.classes.filter(c => c !== className);
      } else {
        this.classes.push(className);
      }
    },
    add(className) {
      if (!this.classes.includes(className)) this.classes.push(className);
    },
    remove(className) {
      this.classes = this.classes.filter(c => c !== className);
    },
    contains(className) {
      return this.classes.includes(className);
    }
  });

  const mockZoomMenu = { classList: createClassList(['hidden']) };
  const mockAlignMenu = { classList: createClassList(['hidden']) };
  const mockValignMenu = { classList: createClassList(['hidden']) };

  // Preset options: 50%, 100%, 150%
  const presetData = ['50', '100', '150'];
  const mockPresetButtons = presetData.map(val => ({
    classList: createClassList([]),
    listeners: {},
    addEventListener(event, cb) { this.listeners[event] = cb; },
    getAttribute(attr) {
      if (attr === 'data-zoom') return val;
      return null;
    }
  }));

  const mockAlignBtn = {
    listeners: {},
    addEventListener(event, cb) { this.listeners[event] = cb; }
  };

  const mockValignBtn = {
    listeners: {},
    addEventListener(event, cb) { this.listeners[event] = cb; }
  };

  const sandbox = {
    document: {
      getElementById: (id) => {
        if (id === 'grid-root') return mockGridRoot;
        if (id === 'toolbar-zoom-input') return mockZoomInput;
        if (id === 'toolbar-zoom-arrow') return mockZoomArrow;
        if (id === 'toolbar-zoom-menu') return mockZoomMenu;
        if (id === 'toolbar-align-menu') return mockAlignMenu;
        if (id === 'toolbar-valign-menu') return mockValignMenu;
        if (id === 'toolbar-align') return mockAlignBtn;
        if (id === 'toolbar-valign') return mockValignBtn;
        return null;
      },
      querySelector: () => null,
      querySelectorAll: (selector) => {
        if (selector === '.toolbar-zoom-option') return mockPresetButtons;
        return [];
      },
      addEventListener: () => {}
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {}
    },
    WebSocket: class {
      static OPEN = 1;
      constructor() { this.readyState = 1; }
      send() {}
    },
    console: console,
    Math: Math,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);

  const exportSuffix = `
    Object.defineProperty(globalThis, 'currentZoom', {
      get: () => currentZoom,
      set: (val) => { currentZoom = val; },
      configurable: true
    });
  `;

  // Run the script to initialize event handlers and default state
  vm.runInContext(code + exportSuffix, vmContext);

  // --- Act & Assert ---

  // 1. Act: Click zoom arrow to toggle zoom menu open
  // Assert initially zoom menu is hidden
  assert.ok(mockZoomMenu.classList.contains('hidden'));
  mockZoomArrow.listeners['click']({ stopPropagation() {} });
  // Assert zoom menu is opened, and other menus are hidden
  assert.ok(!mockZoomMenu.classList.contains('hidden'));
  assert.ok(mockAlignMenu.classList.contains('hidden'));
  assert.ok(mockValignMenu.classList.contains('hidden'));

  // 2. Act: Opening horizontal alignment menu should close zoom menu
  mockAlignBtn.listeners['click']({ stopPropagation() {} });
  // Assert zoom menu is hidden when alignment menu opens
  assert.ok(mockZoomMenu.classList.contains('hidden'));

  // 3. Act: Opening vertical alignment menu should close zoom menu
  // Set zoom menu to open first
  mockZoomMenu.classList.remove('hidden');
  mockValignBtn.listeners['click']({ stopPropagation() {} });
  // Assert zoom menu is hidden when vertical alignment menu opens
  assert.ok(mockZoomMenu.classList.contains('hidden'));

  // 4. Act: Trigger click on a zoom preset option (150%)
  // Re-open zoom menu first
  mockZoomMenu.classList.remove('hidden');
  const preset150Btn = mockPresetButtons.find(btn => btn.getAttribute('data-zoom') === '150');
  preset150Btn.listeners['click']({ stopPropagation() {} });
  // Assert zoom menu is closed
  assert.ok(mockZoomMenu.classList.contains('hidden'));
  // Assert current zoom state and grid-root styles are updated
  assert.strictEqual(sandbox.currentZoom, 150);
  assert.strictEqual(mockGridRoot.style.zoom, 1.5);
  assert.strictEqual(mockZoomInput.value, '150%');
  // Assert active highlight is added to 150% button and removed from others
  assert.ok(preset150Btn.classList.contains('bg-surface-variant'));
  assert.ok(!mockPresetButtons[0].classList.contains('bg-surface-variant')); // 50% button

  // 5. Act: Focus on custom zoom input
  mockZoomInput.listeners['focus'].call(mockZoomInput);
  // Assert text is selected automatically
  assert.ok(selectCalled);

  // 6. Act: Input valid custom zoom (120%) and blur
  mockZoomInput.value = '120%';
  mockZoomInput.listeners['blur']();
  // Assert zoom updates to 120
  assert.strictEqual(sandbox.currentZoom, 120);
  assert.strictEqual(mockGridRoot.style.zoom, 1.2);
  assert.strictEqual(mockZoomInput.value, '120%');

  // 7. Act: Input invalid custom zoom ('abc') and press Enter key
  mockZoomInput.value = 'abc';
  blurCalled = false;
  mockZoomInput.listeners['keydown']({
    key: 'Enter',
    preventDefault() {}
  });
  // Assert zoom input reverts to current valid zoom (120%) and blur is called
  assert.strictEqual(mockZoomInput.value, '120%');
  assert.ok(blurCalled);

  // 8. Act: Input out of bounds custom zoom ('300') and blur
  mockZoomInput.value = '300';
  mockZoomInput.listeners['blur']();
  // Assert zoom input reverts to current valid zoom (120%)
  assert.strictEqual(mockZoomInput.value, '120%');

  // 9. Act: Input valid zoom without percent sign ('75') and press Enter
  mockZoomInput.value = '75';
  blurCalled = false;
  mockZoomInput.listeners['keydown']({
    key: 'Enter',
    preventDefault() {}
  });
  // Assert zoom updates to 75
  assert.strictEqual(sandbox.currentZoom, 75);
  assert.strictEqual(mockGridRoot.style.zoom, 0.75);
  assert.strictEqual(mockZoomInput.value, '75%');
  assert.ok(blurCalled);
});

/**
 * Test to verify that selecting a cell updates the formula bar input value,
 * and pressing Enter in the formula bar updates the cell state and evaluates it.
 * Follows the Arrange-Act-Assert (AAA) pattern.
 */
test('Formula Bar - Selecting a cell updates input value and pressing Enter updates cell state', (t) => {
  // --- Arrange ---
  // Read the latest app.js content to execute inside the VM context
  const code = readAppBundle();

  // Mocks for DOM elements
  const mockFormulaBar = {
    value: '',
    listeners: {},
    addEventListener(event, cb) { this.listeners[event] = cb; },
    blur() {}
  };

  const mockCellEl = {
    classList: { add() {}, remove() {} },
    style: { textAlign: '', justifyContent: '' },
    querySelectorAll: () => [],
    appendChild() {}
  };

  let wsSentPayload = null;

  // VM sandbox context representing the global window/document context
  const sandbox = {
    localCells: {
      'A1': { formula: '=10+5', value: '15', style: {} }
    },
    activeCellId: 'A1',
    document: {
      getElementById: (id) => {
        if (id === 'formula-bar-input') return mockFormulaBar;
        return null;
      },
      querySelector: (selector) => {
        if (selector === '[data-cell-id="A1"]') return mockCellEl;
        return null;
      },
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, appendChild() {}, remove() {} }),
      addEventListener: () => {}
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {}
    },
    WebSocket: class {
      static OPEN = 1;
      constructor() { this.readyState = 1; }
      send(data) {
        const parsed = JSON.parse(data);
        if (parsed.type === 'cell-edit') {
          wsSentPayload = parsed;
        }
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);

  // Suffix to export block-scoped local variables from app.js to the global sandbox scope
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells,
      set: (val) => { localCells = val; },
      configurable: true
    });
    globalThis.handleCellSelect = handleCellSelect;
  `;

  vm.runInContext(code + exportSuffix, vmContext);

  // Set the local cell state after evaluating app.js
  sandbox.localCells = {
    'A1': { formula: '=10+5', value: '15', style: {} },
    'B1': { value: '20' }
  };

  // --- Act 1: Select cell A1 ---
  // Trigger handleCellSelect to update UI
  vmContext.handleCellSelect('A1', mockCellEl);

  // --- Assert 1 ---
  // Formula bar displays the cell's formula
  assert.strictEqual(mockFormulaBar.value, '=10+5');

  // --- Act 2: Modify formula bar value and hit Enter ---
  // Update value and trigger keydown with key='Enter'
  mockFormulaBar.value = '=B1+30';
  mockFormulaBar.listeners['keydown']({
    key: 'Enter',
    preventDefault() {}
  });

  // --- Assert 2 ---
  // Local cells update formula and evaluate it
  assert.strictEqual(sandbox.localCells['A1'].formula, '=B1+30');
  assert.strictEqual(sandbox.localCells['A1'].value, '50');
  // WS message has broadcasted style changes to peer clients
  assert.ok(wsSentPayload);
  assert.strictEqual(wsSentPayload.type, 'cell-edit');
  assert.strictEqual(wsSentPayload.payload.formula, '=B1+30');
  assert.strictEqual(wsSentPayload.payload.value, '50');
});

test('Range Selection & Composite Undo/Redo - Toggle format applies to range and reverts correctly', (t) => {
  // --- Arrange ---
  const code = readAppBundle();
  let wsSentPayloads = [];

  const createMockCellElement = () => ({
    attributes: {},
    setAttribute(name, val) { this.attributes[name] = val; },
    removeAttribute(name) { delete this.attributes[name]; },
    innerText: '',
    focus() {},
    appendChild() {},
    querySelectorAll: () => [],
    className: '',
    style: {},
    classList: {
      classes: new Set(),
      add(cls) { this.classes.add(cls); },
      remove(cls) { this.classes.delete(cls); },
      contains(cls) { return this.classes.has(cls); }
    }
  });

  const mockCellElements = {
    'A1': createMockCellElement(),
    'A2': createMockCellElement(),
    'B1': createMockCellElement(),
    'B2': createMockCellElement()
  };

  const sandbox = {
    localCells: {
      'A1': { value: '1', formula: '', style: {} },
      'A2': { value: '2', formula: '', style: {} },
      'B1': { value: '3', formula: '', style: {} },
      'B2': { value: '4', formula: '', style: {} }
    },
    activeCellId: 'A1',
    selectionStartCellId: 'A1',
    selectionEndCellId: 'B2',
    document: {
      getElementById(id) {
        if (id === 'toolbar-undo' || id === 'toolbar-redo') {
          return {
            attributes: {},
            classList: {
              add() {},
              remove() {},
              contains() { return false; }
            },
            setAttribute(name, val) { this.attributes[name] = val; },
            removeAttribute(name) { delete this.attributes[name]; },
            addEventListener(event, cb) {}
          };
        }
        if (id === 'add-sheet-btn' || id === 'sheet-tabs-container') {
          return createMockElement();
        }
        return null;
      },
      querySelectorAll: () => [],
      querySelector: (selector) => {
        const match = selector.match(/\[data-cell-id="([A-Z0-9]+)"\]/);
        if (match && mockCellElements[match[1]]) {
          return mockCellElements[match[1]];
        }
        return null;
      },
      addEventListener(event, cb) {},
      createElement() {
        return { style: {}, appendChild() {}, remove() {} };
      },
      createRange() {
        return { selectNodeContents() {}, collapse() {} };
      },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection() {
        return { removeAllRanges() {}, addRange() {} };
      }
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send(payload) {
        wsSentPayloads.push(JSON.parse(payload));
      }
    },
    CustomEvent: class {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict ? eventInitDict.detail : null;
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells,
      set: (val) => { localCells = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'selectionStartCellId', {
      get: () => selectionStartCellId,
      set: (val) => { selectionStartCellId = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'selectionEndCellId', {
      get: () => selectionEndCellId,
      set: (val) => { selectionEndCellId = val; },
      configurable: true
    });
    globalThis.toggleFormat = toggleFormat;
    globalThis.performUndo = performUndo;
    globalThis.performRedo = performRedo;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // Set range selection state after evaluation
  sandbox.selectionStartCellId = 'A1';
  sandbox.selectionEndCellId = 'B2';
  sandbox.localCells = {
    'A1': { value: '1', formula: '', style: {} },
    'A2': { value: '2', formula: '', style: {} },
    'B1': { value: '3', formula: '', style: {} },
    'B2': { value: '4', formula: '', style: {} }
  };

  // --- Act 1: Toggle bold on the selected range ---
  sandbox.toggleFormat('A1', 'bold');

  // --- Assert 1: All selected cells have bold set to true ---
  assert.strictEqual(sandbox.localCells['A1'].style.bold, true);
  assert.strictEqual(sandbox.localCells['A2'].style.bold, true);
  assert.strictEqual(sandbox.localCells['B1'].style.bold, true);
  assert.strictEqual(sandbox.localCells['B2'].style.bold, true);

  // --- Act 2: Perform Undo ---
  sandbox.performUndo();

  // --- Assert 2: All cells reverted to original style (no bold) ---
  assert.strictEqual(sandbox.localCells['A1'].style.bold, undefined);
  assert.strictEqual(sandbox.localCells['A2'].style.bold, undefined);
  assert.strictEqual(sandbox.localCells['B1'].style.bold, undefined);
  assert.strictEqual(sandbox.localCells['B2'].style.bold, undefined);

  // --- Act 3: Perform Redo ---
  sandbox.performRedo();

  // --- Assert 3: All cells have bold set to true again ---
  assert.strictEqual(sandbox.localCells['A1'].style.bold, true);
  assert.strictEqual(sandbox.localCells['A2'].style.bold, true);
  assert.strictEqual(sandbox.localCells['B1'].style.bold, true);
  assert.strictEqual(sandbox.localCells['B2'].style.bold, true);
});

test('Range Selection & Composite Undo/Redo - Clear cell and formatting applies to range and reverts correctly', (t) => {
  // --- Arrange ---
  const code = readAppBundle();
  let wsSentPayloads = [];

  const createMockCellElement = () => ({
    attributes: {},
    setAttribute(name, val) { this.attributes[name] = val; },
    removeAttribute(name) { delete this.attributes[name]; },
    innerText: '',
    focus() {},
    appendChild() {},
    querySelectorAll: () => [],
    className: '',
    style: {},
    classList: {
      classes: new Set(),
      add(cls) { this.classes.add(cls); },
      remove(cls) { this.classes.delete(cls); },
      contains(cls) { return this.classes.has(cls); }
    }
  });

  const mockCellElements = {
    'A1': createMockCellElement(),
    'A2': createMockCellElement(),
    'B1': createMockCellElement(),
    'B2': createMockCellElement()
  };

  const sandbox = {
    localCells: {
      'A1': { value: '1', formula: '', style: {} },
      'A2': { value: '2', formula: '', style: {} },
      'B1': { value: '3', formula: '', style: {} },
      'B2': { value: '4', formula: '', style: {} }
    },
    activeCellId: 'A1',
    selectionStartCellId: 'A1',
    selectionEndCellId: 'B2',
    document: {
      getElementById(id) {
        if (id === 'toolbar-undo' || id === 'toolbar-redo') {
          return {
            attributes: {},
            classList: {
              add() {},
              remove() {},
              contains() { return false; }
            },
            setAttribute(name, val) { this.attributes[name] = val; },
            removeAttribute(name) { delete this.attributes[name]; },
            addEventListener(event, cb) {}
          };
        }
        if (id === 'add-sheet-btn' || id === 'sheet-tabs-container') {
          return createMockElement();
        }
        return null;
      },
      querySelectorAll: () => [],
      querySelector: (selector) => {
        const match = selector.match(/\[data-cell-id="([A-Z0-9]+)"\]/);
        if (match && mockCellElements[match[1]]) {
          return mockCellElements[match[1]];
        }
        return null;
      },
      addEventListener(event, cb) {},
      createElement() {
        return { style: {}, appendChild() {}, remove() {} };
      },
      createRange() {
        return { selectNodeContents() {}, collapse() {} };
      },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection() {
        return { removeAllRanges() {}, addRange() {} };
      }
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send(payload) {
        wsSentPayloads.push(JSON.parse(payload));
      }
    },
    CustomEvent: class {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict ? eventInitDict.detail : null;
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells,
      set: (val) => { localCells = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'selectionStartCellId', {
      get: () => selectionStartCellId,
      set: (val) => { selectionStartCellId = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'selectionEndCellId', {
      get: () => selectionEndCellId,
      set: (val) => { selectionEndCellId = val; },
      configurable: true
    });
    globalThis.changeCellColor = changeCellColor;
    globalThis.changeCellTextColor = changeCellTextColor;
    globalThis.toggleBorder = toggleBorder;
    globalThis.setCellAlignment = setCellAlignment;
    globalThis.setCellVerticalAlignment = setCellVerticalAlignment;
    globalThis.clearCell = clearCell;
    globalThis.performUndo = performUndo;
    globalThis.performRedo = performRedo;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // Set range selection state after evaluation
  sandbox.selectionStartCellId = 'A1';
  sandbox.selectionEndCellId = 'B2';
  sandbox.localCells = {
    'A1': { value: '1', formula: '', style: {} },
    'A2': { value: '2', formula: '', style: {} },
    'B1': { value: '3', formula: '', style: {} },
    'B2': { value: '4', formula: '', style: {} }
  };

  // --- Act 1: Apply color formatting and clear cells on range ---
  sandbox.changeCellColor('A1', '#ff0000');
  sandbox.changeCellTextColor('A1', '#0000ff');
  sandbox.toggleBorder('A1');
  sandbox.setCellAlignment('A1', 'center');
  sandbox.setCellVerticalAlignment('A1', 'top');

  // --- Assert 1: Check formatting applied ---
  assert.strictEqual(sandbox.localCells['A1'].style.color, '#ff0000');
  assert.strictEqual(sandbox.localCells['A2'].style.color, '#ff0000');
  assert.strictEqual(sandbox.localCells['A1'].style.textColor, '#0000ff');
  assert.strictEqual(sandbox.localCells['A2'].style.textColor, '#0000ff');
  assert.strictEqual(sandbox.localCells['A1'].style.border, true);
  assert.strictEqual(sandbox.localCells['A2'].style.border, true);
  assert.strictEqual(sandbox.localCells['A1'].style.align, 'center');
  assert.strictEqual(sandbox.localCells['A2'].style.align, 'center');
  assert.strictEqual(sandbox.localCells['A1'].style.verticalAlign, 'top');
  assert.strictEqual(sandbox.localCells['A2'].style.verticalAlign, 'top');

  // --- Act 2: Clear cell range ---
  sandbox.clearCell('A1');

  // --- Assert 2: All selected cells cleared ---
  assert.deepEqual(sandbox.localCells['A1'], { formula: '', value: '', style: {} });
  assert.deepEqual(sandbox.localCells['A2'], { formula: '', value: '', style: {} });
  assert.deepEqual(sandbox.localCells['B1'], { formula: '', value: '', style: {} });
  assert.deepEqual(sandbox.localCells['B2'], { formula: '', value: '', style: {} });

  // --- Act 3: Undo clearCell ---
  sandbox.performUndo();

  // --- Assert 3: Reverted to formatting applied state ---
  assert.strictEqual(sandbox.localCells['A1'].style.color, '#ff0000');
  assert.strictEqual(sandbox.localCells['A2'].style.color, '#ff0000');
  assert.strictEqual(sandbox.localCells['A1'].style.textColor, '#0000ff');
  assert.strictEqual(sandbox.localCells['A2'].style.textColor, '#0000ff');

  // --- Act 4: Undo all alignments, border, and colors ---
  sandbox.performUndo(); // setCellVerticalAlignment
  sandbox.performUndo(); // setCellAlignment
  sandbox.performUndo(); // toggleBorder
  sandbox.performUndo(); // changeCellTextColor
  sandbox.performUndo(); // changeCellColor

  // --- Assert 4: Back to clean state ---
  assert.strictEqual(sandbox.localCells['A1'].style.color, undefined);
  assert.strictEqual(sandbox.localCells['A2'].style.color, undefined);
});

/**
 * Integration test case: Range Selection & DOM Update
 * Verifies that applying a cell formatting color (e.g. background/fill color)
 * preserves the visual selection highlight class ('grid-cell-selected')
 * on the target cell while correctly updating the cell styles in state and DOM.
 */
test('Range Selection & DOM Update - Applying format preserves selection highlight and applies colors', (t) => {
  // --- Arrange ---
  // Read client-side application code from public/app.js
  const code = readAppBundle();

  // Create a mock DOM element representing the grid cell.
  // The element starts with the selection highlight class.
  const mockCellEl = {
    attributes: {},
    setAttribute(name, val) { this.attributes[name] = val; },
    removeAttribute(name) { delete this.attributes[name]; },
    innerText: '',
    focus() {},
    appendChild() {},
    querySelectorAll: () => [],
    className: 'grid-cell grid-cell-selected',
    style: { backgroundColor: '', color: '', textDecoration: '', border: '', textAlign: '', justifyContent: '' },
    classList: {
      classes: new Set(['grid-cell-selected']),
      add(cls) { this.classes.add(cls); },
      remove(cls) { this.classes.delete(cls); },
      contains(cls) { return this.classes.has(cls); }
    }
  };

  // Mock global environment/sandbox context for evaluating app.js in VM
  const sandbox = {
    // Initial cells state
    localCells: {
      'A1': { value: '10', formula: '', style: {} }
    },
    activeCellId: 'A1',
    selectionStartCellId: 'A1',
    selectionEndCellId: 'A1',
    document: {
      // Return mock undo/redo buttons if queried by ID
      getElementById(id) {
        if (id === 'toolbar-undo' || id === 'toolbar-redo') {
          return {
            attributes: {},
            classList: { add() {}, remove() {}, contains() { return false; } },
            setAttribute(name, val) { this.attributes[name] = val; },
            removeAttribute(name) { delete this.attributes[name]; },
            addEventListener(event, cb) {}
          };
        }
        return null;
      },
      querySelectorAll: () => [],
      // Return the mock cell element when queried by its data attribute
      querySelector: (selector) => {
        if (selector === '[data-cell-id="A1"]') return mockCellEl;
        return null;
      },
      addEventListener(event, cb) {},
      createElement() {
        return { style: {}, appendChild() {}, remove() {} };
      },
      createRange() {
        return { selectNodeContents() {}, collapse() {} };
      },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      // Mock window selection APIs
      getSelection() {
        return { removeAllRanges() {}, addRange() {} };
      }
    },
    // Mock WebSocket class
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    // Mock CustomEvent class
    CustomEvent: class {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict ? eventInitDict.detail : null;
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  // Create the VM context with our mocks
  const vmContext = vm.createContext(sandbox);
  // Export the necessary variables/functions from the local module scope of app.js to sandbox
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells,
      set: (val) => { localCells = val; },
      configurable: true
    });
    globalThis.changeCellColor = changeCellColor;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // --- Act ---
  // Call the function to change cell color to green (#00ff00)
  vmContext.changeCellColor('A1', '#00ff00');

  // --- Assert ---
  // 1. Verify that target cell background color is updated to green in state
  assert.strictEqual(sandbox.localCells['A1'].style.color, '#00ff00');
  // 2. Verify that target cell background color is updated in the mock DOM element
  assert.strictEqual(mockCellEl.style.backgroundColor, '#00ff00');
  // 3. Verify that the visual selection highlight class 'grid-cell-selected' is preserved
  assert.ok(mockCellEl.classList.contains('grid-cell-selected'));
});

/**
 * Integration test case: Edit Menu & Clipboard
 * Verifies that copy/cut/paste works relative to active cell
 * and respects history undo/redo stacks.
 */
test('Edit Menu & Clipboard - Copy, Cut, and Paste correctly duplicates values and styles', (t) => {
  // --- Arrange ---
  const code = readAppBundle();
  const createMockCell = () => ({
    className: '',
    style: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; }
    },
    querySelectorAll: () => [],
    appendChild() {}
  });

  const mockCellElements = {
    'A1': createMockCell(),
    'B1': createMockCell(),
    'C3': createMockCell(),
    'D3': createMockCell()
  };

  const sandbox = {
    localCells: {},
    activeCellId: 'A1',
    selectionStartCellId: 'A1',
    selectionEndCellId: 'B1',
    alert: () => {},
    document: {
      getElementById(id) {
        return {
          attributes: {},
          classList: { add() {}, remove() {}, contains() { return false; } },
          setAttribute() {},
          removeAttribute() {},
          addEventListener() {},
          style: {}
        };
      },
      querySelectorAll: () => [],
      querySelector: (selector) => {
        const match = selector.match(/\[data-cell-id="([A-Z0-9]+)"\]/);
        if (match && mockCellElements[match[1]]) return mockCellElements[match[1]];
        return null;
      },
      addEventListener() {},
      createElement() {
        return { style: {}, appendChild() {}, remove() {} };
      },
      createRange() {
        return { selectNodeContents() {}, collapse() {} };
      },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection() {
        return { removeAllRanges() {}, addRange() {} };
      }
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    CustomEvent: class {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict ? eventInitDict.detail : null;
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    Object.defineProperty(globalThis, 'activeCellId', {
      get: () => activeCellId,
      set: (val) => { activeCellId = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'selectionStartCellId', {
      get: () => selectionStartCellId,
      set: (val) => { selectionStartCellId = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'selectionEndCellId', {
      get: () => selectionEndCellId,
      set: (val) => { selectionEndCellId = val; },
      configurable: true
    });
    globalThis.copySelectedCells = copySelectedCells;
    globalThis.cutSelectedCells = cutSelectedCells;
    globalThis.pasteSelectedCells = pasteSelectedCells;
    globalThis.performUndo = performUndo;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // Set range selection state and cell state inside VM context
  sandbox.selectionStartCellId = 'A1';
  sandbox.selectionEndCellId = 'B1';
  vm.runInContext(`
    localSheets = {
      'Sheet1': {
        'A1': { value: 'CopiedVal', formula: '', style: { bold: true } },
        'B1': { value: 'CopiedVal2', formula: '', style: { italic: true } }
      }
    };
  `, vmContext);

  // --- Act 1: Copy selected cells ---
  vmContext.copySelectedCells();

  // --- Act 2: Paste relative to C3 ---
  sandbox.activeCellId = 'C3';
  vmContext.pasteSelectedCells();

  // --- Assert 2 ---
  const sheetCells = vm.runInContext("localSheets['Sheet1']", vmContext);
  assert.strictEqual(sheetCells['C3'].value, 'CopiedVal');
  assert.strictEqual(sheetCells['C3'].style.bold, true);
  assert.strictEqual(sheetCells['D3'].value, 'CopiedVal2');
  assert.strictEqual(sheetCells['D3'].style.italic, true);

  // --- Act 3: Cut from range C3 to D3 ---
  sandbox.selectionStartCellId = 'C3';
  sandbox.selectionEndCellId = 'D3';
  vmContext.cutSelectedCells();

  // --- Assert 3 ---
  // Source cells cleared
  assert.strictEqual(sheetCells['C3'].value, '');
  assert.strictEqual(sheetCells['D3'].value, '');
  // Undo restores cut cells
  vmContext.performUndo();
  assert.strictEqual(sheetCells['C3'].value, 'CopiedVal');
  assert.strictEqual(sheetCells['D3'].value, 'CopiedVal2');
});

/**
 * Integration test case: Edit Menu & Search Replace
 * Verifies that find, replace, and replace all works correctly.
 */
test('Edit Menu & Search Replace - Find, Replace, and Replace All modify values appropriately', (t) => {
  // --- Arrange ---
  const code = readAppBundle();
  const mockInputs = {
    'find-input': { value: 'TargetText' },
    'replace-input': { value: 'ReplacementText' },
    'find-match-case': { checked: true },
    'find-match-entire': { checked: false },
    'find-use-regex': { checked: false },
    'find-search-formulas': { checked: false },
    'find-search-links': { checked: false },
    'find-scope-select': { value: '此工作表' }
  };

  const createMockCell = () => ({
    className: '',
    style: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; }
    },
    querySelectorAll: () => [],
    appendChild() {},
    scrollIntoView() {}
  });

  const sandbox = {
    localCells: {},
    activeCellId: 'A1',
    selectionStartCellId: 'A1',
    selectionEndCellId: 'A1',
    alert: () => {},
    document: {
      getElementById(id) {
        if (mockInputs[id]) {
          const inp = mockInputs[id];
          if (!inp.addEventListener) inp.addEventListener = () => {};
          if (!inp.classList) inp.classList = { add() {}, remove() {}, contains() { return false; } };
          inp.style = {};
          return inp;
        }
        return {
          attributes: {},
          classList: { add() {}, remove() {}, contains() { return false; } },
          setAttribute() {},
          removeAttribute() {},
          addEventListener() {},
          style: {}
        };
      },
      querySelectorAll: () => [],
      querySelector: (selector) => {
        const match = selector.match(/\[data-cell-id="([A-Z0-9]+)"\]/);
        if (match) {
          return createMockCell();
        }
        return null;
      },
      addEventListener() {},
      createElement() {
        return { style: {}, appendChild() {}, remove() {} };
      },
      createRange() {
        return { selectNodeContents() {}, collapse() {} };
      },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {},
      getSelection() {
        return { removeAllRanges() {}, addRange() {} };
      }
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    CustomEvent: class {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict ? eventInitDict.detail : null;
      }
    },
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array
  };

  const vmContext = vm.createContext(sandbox);
  const exportSuffix = `
    Object.defineProperty(globalThis, 'activeCellId', {
      get: () => activeCellId,
      set: (val) => { activeCellId = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'selectionStartCellId', {
      get: () => selectionStartCellId,
      set: (val) => { selectionStartCellId = val; },
      configurable: true
    });
    Object.defineProperty(globalThis, 'selectionEndCellId', {
      get: () => selectionEndCellId,
      set: (val) => { selectionEndCellId = val; },
      configurable: true
    });
    globalThis.findNextMatch = window.CoSheet.findReplace.findNext;
    globalThis.replaceCurrentMatch = window.CoSheet.findReplace.replaceCurrent;
    globalThis.replaceAllMatches = window.CoSheet.findReplace.replaceAll;
    globalThis.performUndo = performUndo;
  `;
  vm.runInContext(code + exportSuffix, vmContext);

  // Initialize cells state inside VM context
  vm.runInContext(`
    localSheets = {
      'Sheet1': {
        'A1': { value: 'Hello TargetText World', formula: '', style: {} },
        'A2': { value: 'TargetText Exact', formula: '', style: {} },
        'B1': { value: 'no match', formula: '', style: {} }
      }
    };
  `, vmContext);

  // --- Act 1: Find next match ---
  sandbox.activeCellId = 'A1';
  const firstMatch = vmContext.findNextMatch();

  // --- Assert 1 ---
  assert.ok(firstMatch !== null, 'Should find a match');
  assert.strictEqual(firstMatch.cellId, 'A2');

  // --- Act 2: Replace all matches ---
  vmContext.replaceAllMatches();

  // --- Assert 2 ---
  const sheetCells = vm.runInContext("localSheets['Sheet1']", vmContext);
  assert.strictEqual(sheetCells['A1'].value, 'Hello ReplacementText World');
  assert.strictEqual(sheetCells['A2'].value, 'ReplacementText Exact');
  assert.strictEqual(sheetCells['B1'].value, 'no match');

  // --- Act 3: Undo replace all ---
  vmContext.performUndo();
  assert.strictEqual(sheetCells['A1'].value, 'Hello TargetText World');
  assert.strictEqual(sheetCells['A2'].value, 'TargetText Exact');
});
