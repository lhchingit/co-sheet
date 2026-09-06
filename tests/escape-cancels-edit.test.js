/**
 * @file escape-cancels-edit.test.js
 * @description Escape must abandon an in-progress edit — in a cell (#174) and in
 * the formula bar (#176). For the cell editor that means the cell goes back
 * to what it held and the blur that follows commits nothing; for the formula bar,
 * that the bar is restored and a following Enter commits nothing. Escape keeps its
 * existing higher-priority jobs — closing the function autocomplete, ending a
 * formula range pick — so only a press with nothing left to close cancels.
 *
 * The sandbox lives in helpers/cell-editor-sandbox.js.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createCellEditorSandbox as createSandbox } from './helpers/cell-editor-sandbox.js';

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

// --- The formula bar (#176) --------------------------------------------------
// Same contract, a different editor: the bar commits on Enter rather than blur,
// so an Escape that does nothing leaves text a later Enter will save.

test('Escape restores the formula bar to what the cell holds', () => {
  // --- Arrange: A1 holds 100 and the bar has been edited to 999 ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.setBarText('999');

  // --- Act ---
  s.pressBarKey('Escape');

  // --- Assert ---
  assert.strictEqual(s.barText(), '100', 'the bar should show the stored value again');
  assert.strictEqual(s.localCells['A1'].value, '100');
});

test('Enter after Escape commits nothing from the formula bar', () => {
  // --- Arrange ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.setBarText('999');

  // --- Act: this is the data-loss case — Escape then Enter used to save 999 ---
  s.pressBarKey('Escape');
  s.pressBarKey('Enter');

  // --- Assert ---
  assert.strictEqual(s.localCells['A1'].value, '100');
});

test('an abandoned formula bar entry leaves an empty cell empty', () => {
  const s = createSandbox({ value: '', formula: '', style: {} });
  s.setBarText('draft');

  s.pressBarKey('Escape');
  s.pressBarKey('Enter');

  assert.strictEqual(s.localCells['A1'].value, '');
  assert.strictEqual(s.localCells['A1'].formula, '');
});

test('an abandoned formula is not committed from the bar either', () => {
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.setBarText('=A1+');

  s.pressBarKey('Escape');
  s.pressBarKey('Enter');

  assert.strictEqual(s.localCells['A1'].formula, '');
  assert.strictEqual(s.localCells['A1'].value, '100');
});

test('the formula bar still commits on Enter, so the happy path is intact', () => {
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.setBarText('250');

  s.pressBarKey('Enter');

  assert.strictEqual(s.localCells['A1'].value, '250');
});

test('Escape closes the formula bar autocomplete before it cancels anything', () => {
  // --- Arrange: an edit in the bar with the suggestion popup open ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.setBarText('=SU');
  s.fnAutocomplete.update({
    getValue: () => '=SU',
    getCaret: () => 3,
    setValue() {},
    setCaret() {},
    getRect: () => ({ left: 0, bottom: 20, width: 100 }),
    el: s.formulaBar
  });
  assert.ok(s.fnAutocomplete.isOpen(), 'precondition: the popup is open');

  // --- Act: the first Escape belongs to the popup ---
  s.pressBarKey('Escape');

  // --- Assert: the edit is untouched ---
  assert.ok(!s.fnAutocomplete.isOpen());
  assert.strictEqual(s.barText(), '=SU', 'the edit should still be in the bar');

  // --- Act: a second Escape has nothing left to close ---
  s.pressBarKey('Escape');

  // --- Assert ---
  assert.strictEqual(s.barText(), '100');
  assert.strictEqual(s.localCells['A1'].value, '100');
});
