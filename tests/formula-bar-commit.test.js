/**
 * @file formula-bar-commit.test.js
 * @description Committing from the formula bar with Enter must leave the cell
 * committed and closed, not re-opened for editing (#177). The bar blurs itself
 * before the key finishes, so unless the bar's handler stops the event it reaches
 * the document-level handler, which reads Enter on a selected cell as "start
 * editing it" — leaving the just-committed cell contenteditable and focused, with
 * its formula source in it, so the user's next keystroke types into it.
 *
 * The sandbox models that bubbling (see helpers/cell-editor-sandbox.js); without
 * it these tests could not see the bug at all.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createCellEditorSandbox as createSandbox } from './helpers/cell-editor-sandbox.js';

test('Enter in the formula bar does not re-open the cell for editing', () => {
  // --- Arrange: A1 holds 100, and a formula has been typed into the bar ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.setBarText('=1+1');

  // --- Act ---
  s.pressBarKey('Enter');

  // --- Assert: committed, and the cell is not left in edit mode ---
  assert.strictEqual(s.localCells['A1'].formula, '=1+1');
  assert.strictEqual(s.localCells['A1'].value, '2');
  assert.strictEqual(s.cell.getAttribute('contenteditable'), null,
    'the committed cell must not be re-opened for editing');
});

test('the committed cell shows its result, not its formula source', () => {
  // --- Arrange ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.setBarText('=1+1');

  // --- Act ---
  s.pressBarKey('Enter');

  // --- Assert: the re-opened edit used to overwrite the rendered value with the
  // formula text, so the cell read "=1+1" until something re-rendered it ---
  assert.strictEqual(s.cell.innerText, '2');
});

test('a plain value committed from the bar behaves the same way', () => {
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.setBarText('250');

  s.pressBarKey('Enter');

  assert.strictEqual(s.localCells['A1'].value, '250');
  assert.strictEqual(s.cell.getAttribute('contenteditable'), null);
  assert.strictEqual(s.cell.innerText, '250');
});

test('the cell keeps the committed state when nothing follows the Enter', () => {
  // --- Arrange: the abandoned edit only became visible when the user typed
  // next, so check the cell is not the focus of a live edit either ---
  const s = createSandbox({ value: '', formula: '', style: {} });
  s.setBarText('hello');

  s.pressBarKey('Enter');

  assert.strictEqual(s.localCells['A1'].value, 'hello');
  assert.strictEqual(typeof s.cell.onkeydown, 'undefined',
    'no inline editor should have been installed on the cell');
});
