/**
 * @file dimension-service.test.js
 * @description Unit tests for the transport-agnostic column-width / row-height
 * service: input validation, clamping, lazy per-sheet bucket creation, and the
 * { ok: false } no-op contract.
 */

import test from 'node:test';
import assert from 'node:assert';
import { resizeColumn, resizeRow, setColCount, setHiddenCols, MIN_SIZE, MAX_SIZE, MAX_ROWS, DEFAULT_COLS, MAX_COLS } from '../services/dimension-service.js';

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

test('setColCount stores a count above the default in a lazily created map', () => {
  const wb = makeWb('Sheet1');
  const res = setColCount(wb, { sheetName: 'Sheet1', count: 30 });
  assert.deepStrictEqual(res, { ok: true, sheetName: 'Sheet1', count: 30 });
  assert.strictEqual(wb.colCounts.Sheet1, 30);
});

test('setColCount drops the entry at or below the default (keeps the doc lean)', () => {
  const wb = makeWb('Sheet1');
  setColCount(wb, { sheetName: 'Sheet1', count: 30 });
  // Shrinking back to the default removes the stored growth.
  const res = setColCount(wb, { sheetName: 'Sheet1', count: DEFAULT_COLS });
  assert.deepStrictEqual(res, { ok: true, sheetName: 'Sheet1', count: DEFAULT_COLS });
  assert.strictEqual(wb.colCounts.Sheet1, undefined);
});

test('setColCount accepts the MAX_COLS ceiling and rejects out-of-range / non-integer', () => {
  const wb = makeWb('Sheet1');
  assert.strictEqual(setColCount(wb, { sheetName: 'Sheet1', count: MAX_COLS }).count, MAX_COLS);
  assert.deepStrictEqual(setColCount(wb, { sheetName: 'Sheet1', count: MAX_COLS + 1 }), { ok: false });
  assert.deepStrictEqual(setColCount(wb, { sheetName: 'Sheet1', count: DEFAULT_COLS - 1 }), { ok: false });
  assert.deepStrictEqual(setColCount(wb, { sheetName: 'Sheet1', count: 30.5 }), { ok: false });
});

test('setColCount rejects an unknown sheet', () => {
  const wb = makeWb('Sheet1');
  assert.deepStrictEqual(setColCount(wb, { sheetName: 'Nope', count: 30 }), { ok: false });
  assert.strictEqual(wb.colCounts, undefined);
});

test('setHiddenCols stores a de-duplicated list in a lazily created map', () => {
  const wb = makeWb('Sheet1');
  const res = setHiddenCols(wb, { sheetName: 'Sheet1', cols: ['C', 'C', 'AB'] });
  assert.deepStrictEqual(res, { ok: true, sheetName: 'Sheet1', cols: ['C', 'AB'] });
  assert.deepStrictEqual(wb.hiddenCols.Sheet1, ['C', 'AB']);
});

test('setHiddenCols drops invalid column keys (regex / __proto__)', () => {
  const wb = makeWb('Sheet1');
  const res = setHiddenCols(wb, { sheetName: 'Sheet1', cols: ['A', 'a1', '__proto__', 'ZZ', 5] });
  assert.deepStrictEqual(res.cols, ['A', 'ZZ']);
  assert.deepStrictEqual(wb.hiddenCols.Sheet1, ['A', 'ZZ']);
});

test('setHiddenCols with an empty list drops the entry (keeps the doc lean)', () => {
  const wb = makeWb('Sheet1');
  setHiddenCols(wb, { sheetName: 'Sheet1', cols: ['B'] });
  const res = setHiddenCols(wb, { sheetName: 'Sheet1', cols: [] });
  assert.deepStrictEqual(res, { ok: true, sheetName: 'Sheet1', cols: [] });
  assert.strictEqual(wb.hiddenCols.Sheet1, undefined);
});

test('setHiddenCols rejects an unknown sheet and a non-array payload', () => {
  const wb = makeWb('Sheet1');
  assert.deepStrictEqual(setHiddenCols(wb, { sheetName: 'Nope', cols: ['A'] }), { ok: false });
  assert.deepStrictEqual(setHiddenCols(wb, { sheetName: 'Sheet1', cols: 'A' }), { ok: false });
  assert.strictEqual(wb.hiddenCols, undefined);
});
