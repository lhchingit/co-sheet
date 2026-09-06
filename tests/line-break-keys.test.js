/**
 * @file line-break-keys.test.js
 * @description Ctrl+Enter, Cmd+Enter and Alt+Enter break a line rather than
 * committing — in the formula bar and in an inline cell edit alike. Google Sheets
 * serves both from one editor component, checked against a live sheet: Ctrl+Enter
 * there put "=1+\n2" into the formula bar and the in-cell editor at once, while the
 * bar's own height never moved off 29px.
 *
 * The sandbox models the bubbling a real key does, so a break that failed to stop
 * the event would show up here as a committed cell rather than a longer formula.
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createCellEditorSandbox as createSandbox } from './helpers/cell-editor-sandbox.js';

const BREAK_KEYS = {
  'Ctrl+Enter': { ctrlKey: true },
  'Cmd+Enter': { metaKey: true },
  'Alt+Enter': { altKey: true },
};

test('every break key splits the formula in the bar instead of committing it', () => {
  for (const [name, mods] of Object.entries(BREAK_KEYS)) {
    // --- Arrange ---
    const s = createSandbox({ value: '100', formula: '', style: {} });
    s.setBarText('=1+1');

    // --- Act ---
    s.pressBarKey('Enter', mods);

    // --- Assert: the text grew a line, and A1 was not written ---
    assert.strictEqual(s.barText(), '=1+1\n', `${name} breaks the line`);
    assert.strictEqual(s.localCells.A1.value, '100', `${name} does not commit`);
  }
});

test('a plain Enter in the bar still commits', () => {
  // --- Arrange ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.setBarText('=1+1');

  // --- Act ---
  s.pressBarKey('Enter');

  // --- Assert ---
  assert.strictEqual(s.localCells.A1.value, '2', 'Enter with no modifier commits as before');
});

test('every break key splits the line in an inline cell edit too', () => {
  for (const [name, mods] of Object.entries(BREAK_KEYS)) {
    // --- Arrange: the cell is opened for editing, as a double-click does ---
    const s = createSandbox({ value: '100', formula: '', style: {} });
    s.startCellInlineEdit('A1', s.cell);
    s.cell.textContent = '=1+1';

    // --- Act ---
    s.pressKey('Enter', mods);

    // --- Assert ---
    assert.strictEqual(s.cell.textContent, '=1+1\n', `${name} breaks the line in the cell`);
    assert.strictEqual(s.localCells.A1.value, '100', `${name} does not commit the cell`);
  }
});

test('a plain Enter in the cell still commits', () => {
  // --- Arrange ---
  const s = createSandbox({ value: '100', formula: '', style: {} });
  s.startCellInlineEdit('A1', s.cell);
  s.cell.textContent = '=1+1';

  // --- Act ---
  s.pressKey('Enter');

  // --- Assert ---
  assert.strictEqual(s.localCells.A1.value, '2', 'Enter with no modifier commits as before');
});

test('the cell can draw a break while it is being edited, and stops when it is not', () => {
  // A cell is nowrap, which cannot draw a line break at all — so a break inserted
  // while editing would be invisible without this.
  const s = createSandbox({ value: '100', formula: '', style: {} });

  // --- Act & Assert ---
  s.startCellInlineEdit('A1', s.cell);
  assert.strictEqual(s.cell.style.whiteSpace, 'pre-wrap', 'the editing cell shows its breaks');

  s.cell.blur();   // commits, the way clicking away does
  assert.strictEqual(s.cell.style.whiteSpace, '',
    'and hands the cell back to its own wrap style afterwards');
});
