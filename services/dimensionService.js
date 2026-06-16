// @ts-check
import { isValidSheetName } from './validators.js';

/**
 * @file services/dimensionService.js
 * @description Transport-agnostic column-width / row-height operations. Sizes are
 * stored per sheet on the workbook as `wb.colWidths` / `wb.rowHeights`, each a map
 * keyed by sheet name → { [colLetter|rowNumber]: pixels }. Each function validates
 * its inputs, clamps the size to a sane range, and mutates the workbook state in
 * place, returning a result object. Persistence and broadcasting are orchestrated
 * by the caller (the WebSocket handler), mirroring sheetService.
 *
 * A `{ ok: false }` result means the operation was a no-op (failed a guard) and the
 * caller should silently ignore it.
 *
 * @typedef {{ sheets: Object, colWidths?: Object, rowHeights?: Object }} Workbook
 */

// Smallest / largest size (px) a column or row may be dragged to. The floor keeps
// a resized track clickable; the ceiling guards against absurd values.
export const MIN_SIZE = 20;
export const MAX_SIZE = 2000;

// Highest addressable row, matching the client grid (TOTAL_ROWS).
export const MAX_ROWS = 1000;

// A column key is 1–2 uppercase letters (A … Z, AA … ZZ would be future-proof; the
// grid currently renders A–Z, but the regex stays lenient within that shape).
const COL_KEY_REGEX = /^[A-Z]{1,2}$/;

/** Clamp a numeric size into [MIN_SIZE, MAX_SIZE] and round to a whole pixel. */
const clampSize = (n) => Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(n)));

/** Lazily create the per-sheet map for a dimension and return the sheet's bucket. */
const bucketFor = (wb, mapName, sheetName) => {
  if (!wb[mapName] || typeof wb[mapName] !== 'object') {
    wb[mapName] = Object.create(null);
  }
  if (!wb[mapName][sheetName] || typeof wb[mapName][sheetName] !== 'object') {
    wb[mapName][sheetName] = Object.create(null);
  }
  return wb[mapName][sheetName];
};

/**
 * Set the pixel width of a single column on a sheet.
 * @param {Workbook} wb
 * @param {{ sheetName: any, col: any, size: any }} payload
 * @returns {{ ok: true, sheetName: string, col: string, size: number } | { ok: false }}
 */
export const resizeColumn = (wb, { sheetName, col, size }) => {
  if (!isValidSheetName(sheetName) || !wb.sheets || !wb.sheets[sheetName]) {
    return { ok: false };
  }
  if (typeof col !== 'string' || !COL_KEY_REGEX.test(col)) {
    return { ok: false };
  }
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return { ok: false };
  }
  const px = clampSize(size);
  bucketFor(wb, 'colWidths', sheetName)[col] = px;
  return { ok: true, sheetName, col, size: px };
};

/**
 * Set the pixel height of a single row on a sheet.
 * @param {Workbook} wb
 * @param {{ sheetName: any, row: any, size: any }} payload
 * @returns {{ ok: true, sheetName: string, row: number, size: number } | { ok: false }}
 */
export const resizeRow = (wb, { sheetName, row, size }) => {
  if (!isValidSheetName(sheetName) || !wb.sheets || !wb.sheets[sheetName]) {
    return { ok: false };
  }
  const r = Number(row);
  if (!Number.isInteger(r) || r < 1 || r > MAX_ROWS) {
    return { ok: false };
  }
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return { ok: false };
  }
  const px = clampSize(size);
  bucketFor(wb, 'rowHeights', sheetName)[String(r)] = px;
  return { ok: true, sheetName, row: r, size: px };
};
