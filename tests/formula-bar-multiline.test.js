process.env.NODE_ENV = 'test';

/**
 * @file formula-bar-multiline.test.js
 * @description A formula could not be split across lines: the formula bar was an
 * <input>, which cannot hold a newline at all (#238). It is a contenteditable div
 * now, as Google Sheets' is, and Ctrl+Enter breaks the line at the caret.
 *
 * The bar is kept in one shape — a single text node holding the whole formula,
 * newlines and all, plus a trailing <br> only when the formula ends with one. That
 * <br> is a rendering sentinel: `pre-wrap` does not draw a trailing newline, so
 * without it the caret cannot sit on the new last line. Everything here turns on
 * that shape, so most of these tests are about it. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

/** A DOM element stub with the surface the formula bar and the render touch. */
function el(tag = 'DIV') {
  const classes = new Set();
  const node = {
    tagName: tag, nodeName: tag, nodeType: 1,
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
    querySelectorAll: () => [], querySelector: () => null,
    get firstElementChild() { return this.children[0] || null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
  };
  // textContent drives the children the way the real one does: setting it replaces
  // everything with a single text node, which is exactly the shape under test.
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get() { return text; },
    set(v) { text = String(v); this.children.length = 0; this.childNodes.length = 0; },
    configurable: true,
  });
  Object.defineProperty(node, 'innerText', {
    get() { return text; }, set(v) { this.textContent = v; }, configurable: true,
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
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {}, getSelection: () => null },
    document: {
      getElementById: (id) => (byId[id] || (byId[id] = el())),
      createElement: (tag) => el(String(tag).toUpperCase()),
      createDocumentFragment: () => el(),
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {},
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    // Enough of a box model for the height sync to do real arithmetic.
    getComputedStyle: (node) => (node && node.id === 'formula-bar-input'
      ? { lineHeight: '20px', paddingTop: '4px', paddingBottom: '4px', color: '' }
      : { color: '' }),
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i ? i.detail : null; } },
    requestAnimationFrame: () => {},
    setTimeout: () => {}, clearTimeout: () => {}, queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };
  // The bar's element needs its id for the stubbed getComputedStyle above.
  vm.createContext(sandbox);
  byId['formula-bar-input'] = el();
  byId['formula-bar-input'].id = 'formula-bar-input';
  byId['formula-bar'] = el();

  vm.runInContext(readAppBundle() + `
    globalThis.getText = () => formulaBarText(document.getElementById('formula-bar-input'));
    globalThis.setText = (t) => setFormulaBarText(document.getElementById('formula-bar-input'), t);
    globalThis.evaluate = (text) => window.CoSheet.formula.evaluateFormula
      ? window.CoSheet.formula.evaluateFormula(text)
      : evaluateFormula(text);
    globalThis.seedCells = (cells) => { for (const id in cells) localCells[id] = cells[id]; };
  `, sandbox);

  sandbox.byId = byId;
  sandbox.fb = byId['formula-bar-input'];
  sandbox.bar = byId['formula-bar'];
  sandbox.barHeight = () => parseFloat(byId['formula-bar'].style.height) || 0;
  return sandbox;
}

const markup = () => fs.readFileSync(path.resolve('private/index.html'), 'utf8');

test('the formula bar is a contenteditable, not an input', () => {
  // --- Arrange & Act ---
  const html = markup();
  const tag = /<[^>]*id="formula-bar-input"[^>]*>/.exec(html);

  // --- Assert: an input cannot hold a newline, which is the whole of #238 ---
  assert.ok(tag, 'the formula bar is in the markup');
  assert.ok(!/^<input/i.test(tag[0]), 'it is not an <input>');
  assert.match(tag[0], /contenteditable="true"/, 'it is editable rich text');
  assert.match(tag[0], /role="textbox"/, 'and still announces itself as a text box');
  assert.match(tag[0], /aria-multiline="true"/, 'that accepts more than one line');
});

test('its styling is what makes a line break visible', () => {
  // --- Arrange & Act ---
  const html = markup();
  const start = html.indexOf('.formula-bar-editor {');
  const rule = start === -1 ? '' : html.slice(start, html.indexOf('}', start));

  // --- Assert: pre-wrap draws the newlines and still wraps a long single line,
  //     which is what Google Sheets' own bar computes to ---
  assert.ok(start !== -1, '.formula-bar-editor is defined');
  assert.match(rule, /white-space:\s*pre-wrap/, 'newlines are drawn');
  assert.match(rule, /overflow-wrap:\s*break-word/, 'and a long line still wraps');

  // --- Assert: the box is one line tall and the extra lines scroll inside it,
  //     which is what lets the bar keep its height when a formula is split ---
  const line = Number(/line-height:\s*(\d+)px/.exec(rule)[1]);
  const pad = Number(/padding:\s*(\d+)px/.exec(rule)[1]);
  assert.strictEqual(line + pad * 2, 28, 'one line comes to the 28px the bar has always been');
  assert.match(rule, /overflow-y:\s*auto/, 'and anything past it scrolls rather than growing the bar');
});

test('the text round-trips through the bar with its newlines', () => {
  // --- Arrange ---
  const s = createSandbox();

  for (const formula of ['=A1+1', '=SUM(A1:A2)+\n10', '=IF(\nA1>0,\n"y",\n"n")']) {
    // --- Act ---
    s.setText(formula);

    // --- Assert ---
    assert.strictEqual(s.getText(), formula, `round-trips ${JSON.stringify(formula)}`);
  }
});

test('a formula ending in a newline gets a sentinel that is not part of it', () => {
  // --- Arrange ---
  const s = createSandbox();

  // --- Act ---
  s.setText('=A1+\n');

  // --- Assert: the <br> is there so the caret has a last line to sit on, but the
  //     value is read from the text node, so it does not see it ---
  assert.deepStrictEqual(Array.from(s.fb.children, (c) => c.nodeName), ['BR'],
    'the trailing sentinel is appended');
  assert.strictEqual(s.getText(), '=A1+\n', 'and the value is unchanged by it');

  // --- Act: a formula that does not end in one gets no sentinel ---
  s.setText('=A1+\n2');

  // --- Assert ---
  assert.deepStrictEqual(Array.from(s.fb.children, (c) => c.nodeName), [],
    'nothing is appended when the last line has content');
});

test('splitting a formula leaves the bar the height it was', () => {
  // Google Sheets keeps its own formula bar at one line and scrolls the rest; the
  // drag handle is how it is made taller. An earlier version of this grew the bar to
  // fit, which is not what it does.
  const s = createSandbox();
  s.setText('=A1+1');
  const before = s.bar.style.height;

  // --- Act ---
  s.setText('=A1+\n1+\n2+\n3');

  // --- Assert ---
  assert.strictEqual(s.bar.style.height, before, 'the bar is not resized by its content');
});

test('a height the user dragged to is left alone', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.bar.style.height = '200px';

  // --- Act ---
  s.setText('=A1+\n1');

  // --- Assert ---
  assert.strictEqual(s.bar.style.height, '200px', 'filling the bar does not undo the drag');
});

test('the engine reads a broken formula exactly as the flat one', () => {
  // A newline is whitespace to the tokenizer, so this is what makes the feature
  // safe: the break is for the reader, never for the result.
  const s = createSandbox();
  s.seedCells({
    A1: { formula: '', value: '2', style: {} },
    A2: { formula: '', value: '3', style: {} },
  });

  const pairs = [
    ['=SUM(A1:A2)+10', '=SUM(A1:A2)+\n10'],
    ['=IF(A1>1,"y","n")', '=IF(\n  A1>1,\n  "y",\n  "n"\n)'],
    ['=A1*A2', '=A1\n*\nA2'],
  ];
  for (const [flat, broken] of pairs) {
    // --- Act ---
    const a = s.evaluate(flat);
    const b = s.evaluate(broken);

    // --- Assert ---
    assert.strictEqual(String(b), String(a), `${JSON.stringify(broken)} matches ${JSON.stringify(flat)}`);
  }
});
