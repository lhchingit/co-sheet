/**
 * @file cell-editor-text-shape.test.js
 * @description The inline cell editor holds its text the way the formula bar does:
 * one text node with real newlines, which is the space ceCaretOffset and ceSetCaret
 * count in. It used to seed itself with innerText, whose setter turns every newline
 * into a <br> that those helpers cannot see — so a formula already broken across
 * lines came back short of its breaks and the next one spliced them away (#242).
 *
 * The element stub reproduces that innerText setter, because it is the behaviour
 * under test: a stub treating innerText and textContent alike would catch nothing.
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createCellEditorSandbox as createSandbox } from './helpers/cell-editor-sandbox.js';

/**
 * Gives a stub cell the browser's innerText setter: text in, <br> per newline out,
 * and a textContent that has lost them.
 */
function withBrowserInnerText(cell) {
  let nodes = [];   // { nodeName: 'BR' } and { nodeType: 3, data }, as a real one holds
  const relink = () => { nodes.forEach((n, i) => { n.nextSibling = nodes[i + 1] || null; }); };
  const text = (str) => ({ nodeType: 3, nodeName: '#text', data: str });
  const rebuild = (v, asMarkup) => {
    const parts = String(v == null ? '' : v).split('\n');
    // The browser's innerText setter breaks the text into <br>-separated nodes;
    // textContent leaves it as the one node it was given.
    nodes = asMarkup
      ? parts.flatMap((part, i) => (i ? [{ nodeName: 'BR' }] : []).concat(part ? [text(part)] : []))
      : [text(parts.join('\n'))];
    if (!nodes.length) nodes = [text('')];
    relink();
  };
  const read = (brAs) => nodes.map((n) => (n.nodeName === 'BR' ? brAs : n.data)).join('');
  Object.defineProperties(cell, {
    innerText: { get: () => read('\n'), set: (v) => { rebuild(v, true); }, configurable: true },
    textContent: { get: () => read(''), set: (v) => { rebuild(v, false); }, configurable: true },
    childNodes: { get: () => nodes, configurable: true },
    firstElementChild: { get: () => nodes.find((n) => n.nodeName === 'BR') || null, configurable: true },
    lastChild: { get: () => nodes[nodes.length - 1] || null, configurable: true },
  });
  cell.appendChild = (node) => { nodes.push(node); relink(); };
  cell.textContent = '';
  return cell;
}

test('a formula already broken across lines opens with its breaks intact', () => {
  // --- Arrange ---
  const s = createSandbox({ value: '3', formula: '=1\n+2', style: {} });
  withBrowserInnerText(s.cell);

  // --- Act ---
  s.startCellInlineEdit('A1', s.cell);

  // --- Assert: the breaks are in the text, not in <br> elements the caret
  //     arithmetic cannot see ---
  assert.strictEqual(s.cell.textContent, '=1\n+2', 'the editor is seeded as one text node');
  assert.strictEqual(s.cell.innerText, '=1\n+2', 'and reads back the same either way');
});

test('breaking it again keeps the break that was already there', () => {
  // This is the bug: the second break was spliced into a string the first was
  // missing from, and the rewrite made that string the content.
  const s = createSandbox({ value: '3', formula: '=1\n+2', style: {} });
  withBrowserInnerText(s.cell);
  s.startCellInlineEdit('A1', s.cell);

  // --- Act ---
  s.pressKey('Enter', { ctrlKey: true });

  // --- Assert ---
  assert.strictEqual(s.cell.textContent, '=1\n+2\n', 'both breaks survive');
});

test('initial text typed over a cell is seeded the same way', () => {
  // --- Arrange & Act ---
  const s = createSandbox({ value: '', formula: '', style: {} });
  withBrowserInnerText(s.cell);
  s.startCellInlineEdit('A1', s.cell, '=A1\n+A2');

  // --- Assert ---
  assert.strictEqual(s.cell.textContent, '=A1\n+A2', 'typed-over text keeps its breaks too');
});

test('the autocomplete adapter counts in the same space as the caret', () => {
  // getValue read innerText while getCaret measured textContent, so on a broken
  // formula every offset the autocomplete computed was one per break too far.
  const s = createSandbox({ value: '', formula: '', style: {} });
  withBrowserInnerText(s.cell);
  s.startCellInlineEdit('A1', s.cell, '=1\n+SU');
  const editor = s.makeCellEditor(s.cell);

  // --- Act: accept a suggestion over the "SU" on the second line ---
  editor.replaceToken(4, 6, 'SUM(');

  // --- Assert ---
  assert.strictEqual(s.cell.textContent, '=1\n+SUM(', 'the token on the second line is replaced');
});

test('markup a paste left behind is folded back into text', () => {
  // A paste goes through the browser, which can leave <div>s and <br>s; the bar has
  // always normalised those away on input and the cell now does too.
  const s = createSandbox({ value: '', formula: '', style: {} });
  withBrowserInnerText(s.cell);
  s.startCellInlineEdit('A1', s.cell);
  s.cell.innerText = 'alpha\nbeta';   // as the browser leaves it after a paste

  // --- Act ---
  s.cell.oninput();

  // --- Assert ---
  assert.strictEqual(s.cell.textContent, 'alpha\nbeta', 'the breaks are real newlines again');
});
