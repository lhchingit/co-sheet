/**
 * @file clipboard-paste.test.js
 * @description Covers pasting content that originated outside co-sheet (#168):
 * the TSV dialect Excel/Google Sheets put on the system clipboard, and the
 * document-level `paste` handler that routes a payload to the grid, to the cell
 * being edited, or back through the in-app clipboard buffer. Also covers the
 * menu-driven paste (#170), which has no native paste event to work from and so
 * reads the clipboard through navigator.clipboard.readText().
 *
 * The client bundle is run in a VM sandbox, exporting the paste helpers and the
 * registered `paste` listener.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** Minimal DOM element stub good enough for the grid/formula-bar lookups. */
function createMockElement() {
  return {
    value: '',
    innerText: '',
    innerHTML: '',
    className: '',
    style: {},
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
    addEventListener() {},
    blur() {}
  };
}

/**
 * Boots the client bundle in a sandbox and exposes the pieces under test.
 * @returns {Object} The sandbox, plus `dispatchPaste` / `dispatchKeydown` helpers.
 */
function createSandbox() {
  const documentListeners = {};
  const cellsDOM = {};
  const formulaBar = createMockElement();
  const sentMessages = [];
  // Deferred timers, so the Ctrl+V fallback can be ordered against the paste
  // event the way a browser orders them.
  const pendingTimers = [];
  let systemClipboard = { readable: true, text: '' };

  const sandbox = {
    document: {
      getElementById(id) {
        if (id === 'formula-bar-input') return formulaBar;
        return createMockElement();
      },
      querySelectorAll() { return []; },
      querySelector(selector) {
        const match = selector.match(/\[data-cell-id="([^"]+)"\]/);
        if (!match) return null;
        if (!cellsDOM[match[1]]) cellsDOM[match[1]] = createMockElement();
        return cellsDOM[match[1]];
      },
      addEventListener(event, cb) {
        (documentListeners[event] = documentListeners[event] || []).push(cb);
      },
      createElement() { return createMockElement(); },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener() {}
    },
    // A stand-in for the OS clipboard: an in-app copy really does mirror onto it
    // via writeSystemClipboard, and the menu paste path really does read it back.
    navigator: {
      clipboard: {
        writeText: (t) => { systemClipboard = { readable: true, text: t }; return Promise.resolve(); },
        readText: () => (systemClipboard.readable
          ? Promise.resolve(systemClipboard.text)
          : Promise.reject(new Error('clipboard read denied')))
      }
    },
    WebSocket: class {
      static OPEN = 1;
      constructor() { this.readyState = 1; }
      send(msg) { sentMessages.push(JSON.parse(msg)); }
    },
    setTimeout: (fn) => pendingTimers.push(fn),
    clearTimeout: () => {},
    queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells, set: (v) => { localCells = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'activeCellId', {
      get: () => activeCellId, set: (v) => { activeCellId = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'clipboardData', {
      get: () => clipboardData, set: (v) => { clipboardData = v; }, configurable: true
    });
    globalThis.parseClipboardTable = parseClipboardTable;
    globalThis.copySelectedCells = copySelectedCells;
    globalThis.pasteFromSystemClipboard = pasteFromSystemClipboard;
  `;
  vm.runInContext(readAppBundle() + exportSuffix, sandbox);

  // Drop any timer the bundle's own start-up queued; only the ones a test
  // triggers are of interest.
  pendingTimers.length = 0;
  sandbox.sentMessages = sentMessages;
  /** Runs every queued timer callback, in order. */
  sandbox.flushTimers = () => {
    const due = pendingTimers.splice(0, pendingTimers.length);
    due.forEach((fn) => fn());
  };
  /**
   * Dispatches a paste event carrying `text` as the text/plain flavour.
   * @param {string} text - Clipboard payload.
   * @returns {{prevented: boolean}} Whether the handler cancelled the event.
   */
  sandbox.dispatchPaste = (text) => {
    let prevented = false;
    const event = {
      clipboardData: { getData: (type) => (type === 'text/plain' ? text : '') },
      preventDefault() { prevented = true; }
    };
    (documentListeners['paste'] || []).forEach((cb) => cb(event));
    return { prevented };
  };
  sandbox.dispatchKeydown = (evt) => (documentListeners['keydown'] || []).forEach((cb) => cb(evt));
  /** Puts text on the stand-in OS clipboard, readable by the menu paste path. */
  sandbox.setSystemClipboard = (text) => { systemClipboard = { readable: true, text }; };
  /** Makes readText() reject, as a denied or dismissed permission prompt does. */
  sandbox.denySystemClipboard = () => { systemClipboard = { readable: false, text: '' }; };
  /** Removes the Clipboard API entirely (an insecure context, an old browser). */
  sandbox.removeClipboardApi = () => { sandbox.navigator.clipboard = undefined; };
  /** Lets the readText() promise and its handlers settle. */
  sandbox.settle = () => new Promise((resolve) => setImmediate(resolve));
  return sandbox;
}

test('parses a tab/newline separated block into a grid of values', () => {
  const s = createSandbox();
  assert.deepEqual(
    s.parseClipboardTable('a\tb\nc\td'),
    [['a', 'b'], ['c', 'd']]
  );
});

test('treats CRLF line breaks and a trailing newline as Excel emits them', () => {
  const s = createSandbox();
  assert.deepEqual(
    s.parseClipboardTable('a\tb\r\nc\td\r\n'),
    [['a', 'b'], ['c', 'd']]
  );
});

test('unwraps quoted fields containing tabs, newlines and doubled quotes', () => {
  const s = createSandbox();
  assert.deepEqual(
    s.parseClipboardTable('"has\ttab"\t"two\nlines"\t"say ""hi"""'),
    [['has\ttab', 'two\nlines', 'say "hi"']]
  );
});

test('keeps a quote that is not at the start of a field as literal data', () => {
  const s = createSandbox();
  assert.deepEqual(s.parseClipboardTable('12" pipe\tok'), [['12" pipe', 'ok']]);
});

test('parses a single value and preserves empty cells in the block', () => {
  const s = createSandbox();
  assert.deepEqual(s.parseClipboardTable('solo'), [['solo']]);
  assert.deepEqual(s.parseClipboardTable('a\t\tc'), [['a', '', 'c']]);
});

test('pastes an external block onto the grid starting at the active cell', () => {
  // --- Arrange: an empty sheet with B2 selected and nothing copied in-app ---
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'B2';
  s.clipboardData = null;

  // --- Act: paste a 2x2 block as Excel would put it on the clipboard ---
  const { prevented } = s.dispatchPaste('Name\tQty\r\nWidget\t7\r\n');

  // --- Assert: the block lands with B2 as its top-left corner ---
  assert.ok(prevented, 'the grid paste should cancel the browser default');
  assert.strictEqual(s.localCells['B2'].value, 'Name');
  assert.strictEqual(s.localCells['C2'].value, 'Qty');
  assert.strictEqual(s.localCells['B3'].value, 'Widget');
  assert.strictEqual(s.localCells['C3'].value, '7');
  // Peers are told about every written cell.
  const edited = s.sentMessages.filter((m) => m.type === 'cell-edit').map((m) => m.payload.cellId);
  assert.deepEqual(edited.sort(), ['B2', 'B3', 'C2', 'C3']);
});

test('commits pasted text like a typed entry: formulas evaluate, styles survive', () => {
  // --- Arrange: A1 holds 5; B1 is pre-formatted bold ---
  const s = createSandbox();
  s.localCells = {
    'A1': { value: '5', formula: '', style: {} },
    'B1': { value: '', formula: '', style: { bold: true } }
  };
  s.activeCellId = 'B1';
  s.clipboardData = null;

  // --- Act: paste a formula ---
  s.dispatchPaste('=A1+5');

  // --- Assert: stored as a formula and evaluated; plain text carries no
  // formatting, so B1 keeps the style it already had ---
  assert.strictEqual(s.localCells['B1'].formula, '=A1+5');
  assert.strictEqual(s.localCells['B1'].value, '10');
  assert.strictEqual(s.localCells['B1'].style.bold, true, 'destination formatting should be preserved');
});

test('routes a paste of the app\'s own copy through the in-app buffer', () => {
  // --- Arrange: copy a styled cell, which also mirrors its TSV to the OS clipboard ---
  const s = createSandbox();
  s.localCells = { 'A1': { value: 'Styled', formula: '', style: { bold: true } } };
  s.activeCellId = 'A1';
  s.copySelectedCells();

  // --- Act: paste into B2 with the very text the copy put on the clipboard ---
  s.activeCellId = 'B2';
  s.dispatchPaste('Styled');

  // --- Assert: the rich in-app buffer wins, so styling comes along ---
  assert.strictEqual(s.localCells['B2'].value, 'Styled');
  assert.strictEqual(s.localCells['B2'].style.bold, true, 'in-app paste should keep the source style');
});

test('external content wins over a stale in-app copy', () => {
  // --- Arrange: an in-app copy exists, but the clipboard now holds Excel content ---
  const s = createSandbox();
  s.localCells = { 'A1': { value: 'Stale', formula: '', style: {} } };
  s.activeCellId = 'A1';
  s.copySelectedCells();

  // --- Act ---
  s.activeCellId = 'B2';
  s.dispatchPaste('From Excel');

  // --- Assert: the clipboard text is pasted, not the earlier in-app copy ---
  assert.strictEqual(s.localCells['B2'].value, 'From Excel');
});

test('a delivered paste event stands the Ctrl+V fallback down', () => {
  // --- Arrange: an in-app copy the fallback would paste if it ever ran ---
  const s = createSandbox();
  s.localCells = { 'A1': { value: 'Stale', formula: '', style: {} } };
  s.activeCellId = 'A1';
  s.copySelectedCells();
  s.activeCellId = 'B2';

  // --- Act: browser ordering — Ctrl+V arms the fallback, the paste event
  // follows, then the timer fires ---
  s.dispatchKeydown({ key: 'v', ctrlKey: true, metaKey: false, altKey: false, preventDefault() {} });
  s.dispatchPaste('From Excel');
  s.flushTimers();

  // --- Assert: the external content stands; the fallback did not overwrite it ---
  assert.strictEqual(s.localCells['B2'].value, 'From Excel');
});

test('Ctrl+V still pastes the in-app buffer when no paste event arrives', () => {
  // --- Arrange: covers browsers that only fire paste on editable targets ---
  const s = createSandbox();
  s.localCells = { 'A1': { value: 'In-app', formula: '', style: { bold: true } } };
  s.activeCellId = 'A1';
  s.copySelectedCells();
  s.activeCellId = 'B2';

  // --- Act: the key is pressed but the browser never delivers a paste event ---
  s.dispatchKeydown({ key: 'v', ctrlKey: true, metaKey: false, altKey: false, preventDefault() {} });
  s.flushTimers();

  // --- Assert: the internal buffer is pasted, styling included ---
  assert.strictEqual(s.localCells['B2'].value, 'In-app');
  assert.strictEqual(s.localCells['B2'].style.bold, true);
});

test('leaves an edited cell to the caret-insert path instead of the grid', () => {
  // --- Arrange: a cell in edit mode (contenteditable) has focus ---
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'B2';
  s.clipboardData = null;
  const editing = createMockElement();
  editing.getAttribute = (name) => (name === 'contenteditable' ? 'true' : null);
  s.document.activeElement = editing;

  // --- Act ---
  const { prevented } = s.dispatchPaste('a\tb\nc\td');

  // --- Assert: nothing is spread across the grid; the text goes into the cell
  // being edited (the sandbox has no Selection API, so only the routing is
  // asserted here) ---
  assert.ok(prevented, 'the browser default is replaced by a plain-text insert');
  assert.strictEqual(s.localCells['B2'], undefined, 'edit mode must not write a block of cells');
  assert.strictEqual(s.localCells['C2'], undefined);
});

test('leaves inputs and textareas to the browser\'s native paste', () => {
  // --- Arrange: the formula bar has focus ---
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'B2';
  s.clipboardData = null;
  s.document.activeElement = { tagName: 'INPUT', getAttribute: () => null };

  // --- Act ---
  const { prevented } = s.dispatchPaste('a\tb');

  // --- Assert ---
  assert.ok(!prevented, 'native text/plain paste is already correct in a text field');
  assert.strictEqual(s.localCells['B2'], undefined);
});

test('an empty clipboard on the grid writes nothing', () => {
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'B2';
  s.clipboardData = null;

  s.dispatchPaste('');

  assert.strictEqual(s.localCells['B2'], undefined);
});

test('a clipboard with no text flavour still pastes the in-app buffer', () => {
  // --- Arrange: an in-app copy whose mirror to the OS clipboard did not stick
  // (insecure context, denied permission) or that was displaced by an image ---
  const s = createSandbox();
  s.localCells = { 'A1': { value: 'In-app', formula: '', style: { bold: true } } };
  s.activeCellId = 'A1';
  s.copySelectedCells();
  s.activeCellId = 'B2';

  // --- Act ---
  s.dispatchPaste('');

  // --- Assert: the pre-#168 behaviour is preserved rather than pasting nothing ---
  assert.strictEqual(s.localCells['B2'].value, 'In-app');
  assert.strictEqual(s.localCells['B2'].style.bold, true);
});

test('an empty clipboard leaves an edited cell untouched', () => {
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'B2';
  s.clipboardData = null;
  const editing = createMockElement();
  editing.getAttribute = (name) => (name === 'contenteditable' ? 'true' : null);
  s.document.activeElement = editing;

  const { prevented } = s.dispatchPaste('');

  assert.ok(!prevented);
  assert.strictEqual(s.localCells['B2'], undefined);
});

// --- Menu-driven paste (#170) ------------------------------------------------
// The context menus and the Edit menu produce no native paste event, so they ask
// for the system clipboard explicitly via navigator.clipboard.readText().

test('the menu paste reads the system clipboard and spreads it across cells', async () => {
  // --- Arrange: Excel content on the OS clipboard, nothing copied in-app ---
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'B2';
  s.clipboardData = null;
  s.setSystemClipboard('Name\tQty\r\nWidget\t7\r\n');

  // --- Act ---
  s.pasteFromSystemClipboard();
  await s.settle();

  // --- Assert: same block placement a Ctrl+V would produce ---
  assert.strictEqual(s.localCells['B2'].value, 'Name');
  assert.strictEqual(s.localCells['C2'].value, 'Qty');
  assert.strictEqual(s.localCells['B3'].value, 'Widget');
  assert.strictEqual(s.localCells['C3'].value, '7');
});

test('the menu paste keeps formulas and styling for the app\'s own copy', async () => {
  // --- Arrange: an in-app copy, which mirrors its text onto the OS clipboard ---
  const s = createSandbox();
  s.localCells = { 'A1': { value: 'Styled', formula: '', style: { bold: true } } };
  s.activeCellId = 'A1';
  s.copySelectedCells();

  // --- Act ---
  s.activeCellId = 'B2';
  s.pasteFromSystemClipboard();
  await s.settle();

  // --- Assert: routed through the in-app buffer, not flattened to text ---
  assert.strictEqual(s.localCells['B2'].value, 'Styled');
  assert.strictEqual(s.localCells['B2'].style.bold, true);
});

test('a denied clipboard permission falls back to the in-app buffer', async () => {
  // --- Arrange: an in-app copy, and a read the user denies or dismisses ---
  const s = createSandbox();
  s.localCells = { 'A1': { value: 'In-app', formula: '', style: { italic: true } } };
  s.activeCellId = 'A1';
  s.copySelectedCells();
  s.denySystemClipboard();

  // --- Act ---
  s.activeCellId = 'B2';
  s.pasteFromSystemClipboard();
  await s.settle();

  // --- Assert: the menus never do less than they did before #170 ---
  assert.strictEqual(s.localCells['B2'].value, 'In-app');
  assert.strictEqual(s.localCells['B2'].style.italic, true);
});

test('no Clipboard API at all still pastes the in-app buffer', async () => {
  // --- Arrange: an insecure context or a browser without readText ---
  const s = createSandbox();
  s.localCells = { 'A1': { value: 'In-app', formula: '', style: {} } };
  s.activeCellId = 'A1';
  s.copySelectedCells();
  s.removeClipboardApi();

  // --- Act ---
  s.activeCellId = 'B2';
  s.pasteFromSystemClipboard();
  await s.settle();

  // --- Assert ---
  assert.strictEqual(s.localCells['B2'].value, 'In-app');
});

test('the menu paste does nothing without an active cell', async () => {
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = null;
  s.setSystemClipboard('Name\tQty');

  s.pasteFromSystemClipboard();
  await s.settle();

  assert.deepEqual(Object.keys(s.localCells), []);
});
