/**
 * @file dimensionService.test.js
 * @description Unit tests for the transport-agnostic column-width / row-height
 * service: input validation, clamping, lazy per-sheet bucket creation, and the
 * { ok: false } no-op contract.
 */

import test from 'node:test';
import assert from 'node:assert';
import { resizeColumn, resizeRow, MIN_SIZE, MAX_SIZE, MAX_ROWS } from '../services/dimensionService.js';

/** Build a minimal workbook with the given sheet names. */
const makeWb = (...names) => {
  const sheets = Object.create(null);
  for (const n of names) sheets[n] = Object.create(null);
  return { sheets };
};

test('resizeColumn stores a clamped, rounded width in a lazily created bucket', () => {
  const wb = makeWb('Sheet1');
  const res = resizeColumn(wb, { sheetName: 'Sheet1', col: 'B', size: 137.6 });
  assert.deepStrictEqual(res, { ok: true, sheetName: 'Sheet1', col: 'B', size: 138 });
  assert.strictEqual(wb.colWidths.Sheet1.B, 138);
});

test('resizeColumn clamps below MIN_SIZE and above MAX_SIZE', () => {
  const wb = makeWb('Sheet1');
  assert.strictEqual(resizeColumn(wb, { sheetName: 'Sheet1', col: 'A', size: 1 }).size, MIN_SIZE);
  assert.strictEqual(resizeColumn(wb, { sheetName: 'Sheet1', col: 'A', size: 99999 }).size, MAX_SIZE);
});

test('resizeColumn rejects unknown sheet, bad column key, and non-numeric size', () => {
  const wb = makeWb('Sheet1');
  assert.deepStrictEqual(resizeColumn(wb, { sheetName: 'Nope', col: 'A', size: 100 }), { ok: false });
  assert.deepStrictEqual(resizeColumn(wb, { sheetName: 'Sheet1', col: 'a1', size: 100 }), { ok: false });
  assert.deepStrictEqual(resizeColumn(wb, { sheetName: 'Sheet1', col: 'A', size: '100' }), { ok: false });
  assert.deepStrictEqual(resizeColumn(wb, { sheetName: 'Sheet1', col: 'A', size: NaN }), { ok: false });
  assert.strictEqual(wb.colWidths, undefined);
});

test('resizeRow stores by numeric row key and accepts numeric strings', () => {
  const wb = makeWb('Sheet1');
  const res = resizeRow(wb, { sheetName: 'Sheet1', row: 5, size: 40 });
  assert.deepStrictEqual(res, { ok: true, sheetName: 'Sheet1', row: 5, size: 40 });
  assert.strictEqual(wb.rowHeights.Sheet1['5'], 40);
  // Numeric string coerces to the same key.
  resizeRow(wb, { sheetName: 'Sheet1', row: '5', size: 60 });
  assert.strictEqual(wb.rowHeights.Sheet1['5'], 60);
});

test('resizeRow rejects out-of-range and non-integer rows', () => {
  const wb = makeWb('Sheet1');
  assert.deepStrictEqual(resizeRow(wb, { sheetName: 'Sheet1', row: 0, size: 40 }), { ok: false });
  assert.deepStrictEqual(resizeRow(wb, { sheetName: 'Sheet1', row: MAX_ROWS + 1, size: 40 }), { ok: false });
  assert.deepStrictEqual(resizeRow(wb, { sheetName: 'Sheet1', row: 2.5, size: 40 }), { ok: false });
  assert.strictEqual(wb.rowHeights, undefined);
});

test('resize ignores prototype-polluting keys gracefully (col regex / row range)', () => {
  const wb = makeWb('Sheet1');
  assert.deepStrictEqual(resizeColumn(wb, { sheetName: 'Sheet1', col: '__proto__', size: 100 }), { ok: false });
  assert.deepStrictEqual(resizeRow(wb, { sheetName: 'Sheet1', row: '__proto__', size: 100 }), { ok: false });
});
