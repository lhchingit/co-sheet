process.env.NODE_ENV = 'test';

/**
 * @file wrapped-line-count.test.js
 * @description Unit tests for the text measurement behind wrapped row heights (#278).
 *
 * A wrapped cell's height is `getCellMinHeight(fontSize, lines)` like every other
 * cell's; the only thing that ever needed a render was the LINE COUNT. These pin how
 * that count is derived, against a stub canvas whose glyphs are exactly 10px wide —
 * so every expectation below is arithmetic a reader can check, rather than a number
 * that happened to come out of a font.
 *
 * The rules being mirrored are `.grid-cell`'s: `white-space: pre-wrap` (explicit
 * breaks kept, wrapping at spaces) and `word-break: break-word` (a word too long for
 * the line breaks inside itself). Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';
import { createMockElement } from './helpers/cell-editor-sandbox.js';

/** Every character 10px wide, so a width of N*10 fits exactly N characters. */
const CHAR_PX = 10;

/**
 * Boot the bundle with a canvas whose measureText is uniform and exact, and hand
 * back the wrap helpers.
 * @param {{ canvas?: boolean }} [opts] canvas:false simulates an environment with none.
 */
function boot(opts = {}) {
  const withCanvas = opts.canvas !== false;
  const sandbox = {
    document: {
      getElementById: () => createMockElement(),
      querySelectorAll: () => [],
      // No '.grid-cell' in this sandbox, so the base font falls back to the
      // constant — which is fine here: the stub ignores the font entirely.
      querySelector: () => null,
      addEventListener() {},
      createElement: (tag) => {
        if (tag === 'canvas') {
          if (!withCanvas) return {};
          return {
            getContext: () => ({
              font: '',
              measureText: (str) => ({ width: String(str).length * CHAR_PX })
            })
          };
        }
        return createMockElement();
      },
      createDocumentFragment: () => createMockElement(),
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: () => ({ color: '' }),
    window: {
      location: { protocol: 'http:', host: 'localhost:3000', search: '', origin: 'http://localhost:3000' },
      addEventListener() {}
    },
    navigator: { clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') } },
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 1; } send() {} close() {} },
    URLSearchParams,
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    setTimeout: () => {}, clearTimeout: () => {}, queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite, encodeURIComponent,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Promise, Error
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readAppBundle()
    + '\nglobalThis.__wrappedLineCount = wrappedLineCount;'
    + '\nglobalThis.__cellFontCss = cellFontCss;'
    + '\nglobalThis.__getCellMinHeight = getCellMinHeight;',
    sandbox
  );
  return sandbox;
}

test('a line that fits is one line, and explicit breaks always start a new one', () => {
  // --- Arrange ---
  const { __wrappedLineCount: lineCount } = boot();

  // --- Act / Assert ---
  assert.strictEqual(lineCount('abc', 'x', 100), 1, '3 chars in a 10-char width');
  assert.strictEqual(lineCount('abcdefghij', 'x', 100), 1, 'exactly filling the width does not spill');
  // pre-wrap keeps the break, so these are two lines regardless of how short they are.
  assert.strictEqual(lineCount('a\nb', 'x', 100), 2);
  assert.strictEqual(lineCount('a\nb\nc', 'x', 100), 3);
  // An empty segment between two breaks is still a line that occupies height.
  assert.strictEqual(lineCount('a\n\nb', 'x', 100), 3);
});

test('wrapping happens at spaces, greedily', () => {
  // --- Arrange ---
  const { __wrappedLineCount: lineCount } = boot();

  // --- Act / Assert: width 100 = 10 characters. ---
  // 'aaa bbb' is 7 chars — fits.
  assert.strictEqual(lineCount('aaa bbb', 'x', 100), 1);
  // 'aaa bbb ccc' is 11 — 'aaa bbb' (7) fills the first line, 'ccc' the second.
  assert.strictEqual(lineCount('aaa bbb ccc', 'x', 100), 2);
  // Four 3-letter words = 15 chars: 'aaa bbb' then 'ccc ddd'.
  assert.strictEqual(lineCount('aaa bbb ccc ddd', 'x', 100), 2);
  // Six of them = 23 chars over three lines.
  assert.strictEqual(lineCount('aaa bbb ccc ddd eee fff', 'x', 100), 3);
});

test('a word wider than the line breaks inside itself', () => {
  // --- Arrange: word-break: break-word, so a long token does not just overflow. ---
  const { __wrappedLineCount: lineCount } = boot();

  // --- Act / Assert ---
  assert.strictEqual(lineCount('abcdefghijklmno', 'x', 100), 2, '15 chars at 10 per line');
  assert.strictEqual(lineCount('a'.repeat(30), 'x', 100), 3, 'exactly three full lines');
  assert.strictEqual(lineCount('a'.repeat(31), 'x', 100), 4, 'one character over starts a fourth');
  // A long word after a short one: the short word's line is finished first.
  assert.strictEqual(lineCount('ab ' + 'c'.repeat(20), 'x', 100), 3);
});

test('a column too narrow to show anything counts as one line', () => {
  // --- Arrange: a hidden column resolves to a zero (or negative) content width. ---
  const { __wrappedLineCount: lineCount } = boot();

  // --- Act / Assert: no height is claimed for text that cannot be seen. ---
  assert.strictEqual(lineCount('anything at all', 'x', 0), 1);
  assert.strictEqual(lineCount('anything at all', 'x', -7), 1);
});

test('without a canvas the line count is unknown rather than guessed', () => {
  // --- Arrange ---
  const { __wrappedLineCount: lineCount } = boot({ canvas: false });

  // --- Act / Assert ---
  // null is what makes the caller fall back to rendering every row. Returning a
  // plausible-looking number instead would put every row below a wrapped one at the
  // wrong offset, which is worse than the memory it would save.
  assert.strictEqual(lineCount('some text that would wrap', 'x', 100), null);
});

test('the measured line count feeds the same height model every cell uses', () => {
  // --- Arrange ---
  const { __wrappedLineCount: lineCount, __getCellMinHeight: minHeight } = boot();

  // --- Act ---
  const lines = lineCount('a'.repeat(30), 'x', 100);

  // --- Assert: ceil(12 * (1.2 * 3 + 0.4) + 1) = ceil(49) = 49. ---
  assert.strictEqual(lines, 3);
  assert.strictEqual(minHeight(null, lines), 49, 'height comes from getCellMinHeight, not a wrap-specific formula');
  // One line at the default font still fits the default row, so it claims nothing.
  assert.strictEqual(minHeight(null, 1), null);
});

test('a cell\'s own font overrides are carried into the measurement', () => {
  // --- Arrange ---
  const { __cellFontCss: fontCss } = boot();

  // --- Act / Assert ---
  const plain = fontCss(null);
  assert.ok(/12px/.test(plain), `base font should carry the default size, got ${plain}`);
  // 12pt -> 16px, so a larger cell measures against wider glyphs.
  assert.ok(/16px/.test(fontCss({ fontSize: 12 })), fontCss({ fontSize: 12 }));
  assert.ok(/^italic /.test(fontCss({ italic: true })), fontCss({ italic: true }));
  assert.ok(/\b700\b/.test(fontCss({ bold: true })), fontCss({ bold: true }));
});
