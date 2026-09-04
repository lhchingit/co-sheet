/**
 * @file clipboard-paste.test.js
 * @description Covers pasting content that originated outside co-sheet (#168):
 * the TSV dialect Excel/Google Sheets put on the system clipboard, and the
 * document-level `paste` handler that routes a payload to the grid, to the cell
 * being edited, or back through the in-app clipboard buffer. Also covers the
 * menu-driven paste (#170), which has no native paste event to work from and so
 * reads the clipboard through the navigator.clipboard API, and the mapping of a
 * source's `text/html` formatting onto the cell style schema (#171).
 *
 * The client bundle is run in a VM sandbox, exporting the paste helpers and the
 * registered `paste` listener. The sandbox has no DOMParser, so walking a pasted
 * HTML table is covered end-to-end in a browser instead; what is unit-tested here
 * is the pure mapping and how a styled block lands on the grid.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

// The colour keywords the stub browser below knows how to compute, and what it
// computes them to. Spreadsheets emit keywords freely and the CSSOM hands them
// back as written, so resolving them is part of the paste path.
const CSS_COLOR_KEYWORDS = {
  red: 'rgb(255, 0, 0)',
  green: 'rgb(0, 128, 0)',
  yellow: 'rgb(255, 255, 0)',
  white: 'rgb(255, 255, 255)',
  windowtext: 'rgb(0, 0, 0)'
};

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
      // Elements model the one CSSOM behaviour the colour probe relies on: a
      // value CSS does not accept never sticks, so the property stays empty.
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
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: (el) => ({ color: CSS_COLOR_KEYWORDS[el.style.color] || '' }),
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
    globalThis.cssColorToHex = cssColorToHex;
    globalThis.cellStyleFromCss = cellStyleFromCss;
    globalThis.parseClipboardHtmlTable = parseClipboardHtmlTable;
    globalThis.pasteCellGrid = pasteCellGrid;
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

// --- Pasting formatting from a source's text/html flavour (#171) -------------
// Walking the markup needs a real DOMParser, so the table parser itself is
// covered end-to-end in a browser; these cover the pure mapping onto co-sheet's
// style schema and how a styled block lands on the grid.

test('converts the colour forms the CSSOM and Excel actually emit', () => {
  const s = createSandbox();
  assert.strictEqual(s.cssColorToHex('rgb(255, 255, 0)'), '#ffff00');
  assert.strictEqual(s.cssColorToHex('rgba(0, 0, 255, 0.5)'), '#0000ff');
  assert.strictEqual(s.cssColorToHex('#AABBCC'), '#aabbcc');
  assert.strictEqual(s.cssColorToHex('#f00'), '#ff0000');
});

test('resolves the colour keywords the CSSOM hands back as written', () => {
  // The CSSOM does NOT normalize `color:red` to rgb() — it returns "red" — so a
  // keyword has to be computed before it can become the #rrggbb the schema needs.
  const s = createSandbox();
  assert.strictEqual(s.cssColorToHex('red'), '#ff0000');
  assert.strictEqual(s.cssColorToHex('green'), '#008000');
  // Excel's own system-colour keyword resolves like any other.
  assert.strictEqual(s.cssColorToHex('windowtext'), '#000000');
});

test('drops colours it cannot turn into the #rrggbb the server requires', () => {
  const s = createSandbox();
  // A fully transparent colour is "no colour", not black.
  assert.strictEqual(s.cssColorToHex('rgba(0, 0, 0, 0)'), null);
  // Not a colour at all: CSS rejects it, so nothing is computed.
  assert.strictEqual(s.cssColorToHex('linear-gradient(red, blue)'), null);
  assert.strictEqual(s.cssColorToHex('notacolour'), null);
  assert.strictEqual(s.cssColorToHex(''), null);
  assert.strictEqual(s.cssColorToHex(undefined), null);
});

test('a keyword fill goes through the same white-fill exclusion as a hex one', () => {
  const s = createSandbox();
  assert.strictEqual(s.cellStyleFromCss({ backgroundColor: 'yellow' }).color, '#ffff00');
  assert.strictEqual(s.cellStyleFromCss({ backgroundColor: 'white' }).color, undefined);
});

test('maps a source cell\'s CSS onto the cell style schema', () => {
  const s = createSandbox();
  assert.deepEqual(s.cellStyleFromCss({
    fontWeight: '700',
    fontStyle: 'italic',
    textDecoration: 'underline line-through',
    color: 'rgb(255, 0, 0)',
    backgroundColor: 'rgb(255, 255, 0)',
    textAlign: 'center',
    fontFamily: '"Calibri", sans-serif',
    fontSize: '14.0pt'
  }), {
    bold: true,
    italic: true,
    underline: true,
    strikethrough: true,
    textColor: '#ff0000',
    color: '#ffff00',
    align: 'center',
    fontFamily: 'Calibri',
    fontSize: 14
  });
});

test('a source that specifies no formatting maps to no style', () => {
  const s = createSandbox();
  assert.deepEqual(s.cellStyleFromCss({}), {});
  assert.deepEqual(s.cellStyleFromCss(null), {});
  // font-weight:normal and text-align:general are not formatting to carry over.
  assert.deepEqual(s.cellStyleFromCss({ fontWeight: 'normal', textAlign: 'general' }), {});
});

test('converts px font sizes to the integer points the schema requires', () => {
  const s = createSandbox();
  assert.strictEqual(s.cellStyleFromCss({ fontSize: '16px' }).fontSize, 12);
  assert.strictEqual(s.cellStyleFromCss({ fontSize: '11.0pt' }).fontSize, 11);
  // Out of the 1-400 range the server accepts, and a unit that says nothing.
  assert.strictEqual(s.cellStyleFromCss({ fontSize: '900pt' }).fontSize, undefined);
  assert.strictEqual(s.cellStyleFromCss({ fontSize: 'larger' }).fontSize, undefined);
});

test('drops a white fill so a pasted block does not paint every cell', () => {
  const s = createSandbox();
  assert.strictEqual(s.cellStyleFromCss({ backgroundColor: 'rgb(255, 255, 255)' }).color, undefined);
  assert.strictEqual(s.cellStyleFromCss({ backgroundColor: 'rgb(255, 255, 254)' }).color, '#fffffe');
});

test('a styled paste replaces the destination formatting it can express', () => {
  // --- Arrange: B2 is bold, right-aligned, and has a border ---
  const s = createSandbox();
  s.localCells = {
    'B2': { value: '', formula: '', style: { bold: true, align: 'right', borders: { top: { color: '#000000', style: 'thin' } } } }
  };
  s.activeCellId = 'B2';

  // --- Act: paste a cell whose source is italic and specifies nothing else ---
  s.pasteCellGrid([[{ text: 'x', style: { italic: true } }]]);

  // --- Assert: the source's formatting wins outright for the properties HTML
  // models, and the border — which it does not model — is left alone ---
  assert.strictEqual(s.localCells['B2'].style.italic, true);
  assert.strictEqual(s.localCells['B2'].style.bold, undefined, 'a plain source should clear a bold destination');
  assert.strictEqual(s.localCells['B2'].style.align, undefined);
  assert.deepEqual(s.localCells['B2'].style.borders, { top: { color: '#000000', style: 'thin' } });
});

test('a plain-text paste leaves the destination formatting untouched', () => {
  // --- Arrange: same bold, right-aligned cell ---
  const s = createSandbox();
  s.localCells = { 'B2': { value: '', formula: '', style: { bold: true, align: 'right' } } };
  s.activeCellId = 'B2';

  // --- Act: a null style is "the source specified nothing" ---
  s.pasteCellGrid([[{ text: 'x', style: null }]]);

  // --- Assert ---
  assert.strictEqual(s.localCells['B2'].style.bold, true);
  assert.strictEqual(s.localCells['B2'].style.align, 'right');
});

test('a styled paste still commits its text as a typed entry would', () => {
  const s = createSandbox();
  s.localCells = { 'A1': { value: '5', formula: '', style: {} } };
  s.activeCellId = 'B1';

  s.pasteCellGrid([[{ text: '=A1+5', style: { bold: true } }]]);

  assert.strictEqual(s.localCells['B1'].formula, '=A1+5');
  assert.strictEqual(s.localCells['B1'].value, '10');
  assert.strictEqual(s.localCells['B1'].style.bold, true);
});

test('unparseable HTML falls back to the plain-text table', () => {
  // --- Arrange: no DOMParser in this sandbox, so every HTML payload is unusable ---
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'B2';
  s.clipboardData = null;

  // --- Act: a paste carrying both flavours ---
  const { prevented } = s.dispatchPaste('Name\tQty');

  // --- Assert: the values still land, from the text flavour ---
  assert.ok(prevented);
  assert.strictEqual(s.localCells['B2'].value, 'Name');
  assert.strictEqual(s.localCells['C2'].value, 'Qty');
});

test('parseClipboardHtmlTable declines a payload it cannot use', () => {
  const s = createSandbox();
  assert.strictEqual(s.parseClipboardHtmlTable(''), null);
  assert.strictEqual(s.parseClipboardHtmlTable(undefined), null);
  // No DOMParser here, which is itself a decline rather than a throw.
  assert.strictEqual(s.parseClipboardHtmlTable('<table><tr><td>a</td></tr></table>'), null);
});
