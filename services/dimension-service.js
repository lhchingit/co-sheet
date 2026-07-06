// @ts-check
import { isValidSheetName } from './validators.js';

/**
 * @file services/dimension-service.js
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
 * @typedef {{ ok: true, sheetName: string, col?: string, row?: number, size: number } | { ok: false }} ResizeResult
 */

// Smallest / largest size (px) a column or row may be dragged to. The floor keeps
// a resized track clickable; the ceiling guards against absurd values.
export const MIN_SIZE = 20;
export const MAX_SIZE = 2000;

// Highest addressable row, matching the client grid (TOTAL_ROWS).
export const MAX_ROWS = 1000;

// Column-count bounds, matching the client grid: it starts at A–Z and grows on
// column insert up to ZZ. A 2-letter key covers the whole A … ZZ range.
export const DEFAULT_COLS = 26;        // A–Z
export const MAX_COLS = 26 + 26 * 26;  // up to ZZ (702)

// A column key is 1–2 uppercase letters (A … Z, AA … ZZ), matching MAX_COLS.
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
 * @returns {ResizeResult}
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
 * @returns {ResizeResult}
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

/**
 * Set a sheet's explicit column count (how many columns the grid renders, grown
 * by column inserts and shrunk by deletes). Stored on `wb.colCounts[sheetName]`
 * as an integer in [DEFAULT_COLS, MAX_COLS]; the default is dropped so legacy/
 * untouched sheets stay absent from the map.
 * @param {{ sheets: Object, colCounts?: Object }} wb
 * @param {{ sheetName: any, count: any }} payload
 * @returns {{ ok: true, sheetName: string, count: number } | { ok: false }}
 */
export const setColCount = (wb, { sheetName, count }) => {
  if (!isValidSheetName(sheetName) || !wb.sheets || !wb.sheets[sheetName]) {
    return { ok: false };
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < DEFAULT_COLS || n > MAX_COLS) {
    return { ok: false };
  }
  if (!wb.colCounts || typeof wb.colCounts !== 'object') {
    wb.colCounts = Object.create(null);
  }
  if (n > DEFAULT_COLS) {
    wb.colCounts[sheetName] = n;
  } else {
    // The default needs no entry; clear any prior growth so the doc stays lean.
    delete wb.colCounts[sheetName];
  }
  return { ok: true, sheetName, count: n };
};

/**
 * Set the full list of hidden columns on a sheet. Stored on
 * `wb.hiddenCols[sheetName]` as an array of column-letter keys (A … ZZ); an
 * empty list drops the entry so sheets with nothing hidden stay absent from the
 * map. The client sends the whole desired set each time (idempotent, mirroring
 * setColCount), so this simply validates and replaces it.
 * @param {{ sheets: Object, hiddenCols?: Object }} wb
 * @param {{ sheetName: any, cols: any }} payload
 * @returns {{ ok: true, sheetName: string, cols: string[] } | { ok: false }}
 */
export const setHiddenCols = (wb, { sheetName, cols }) => {
  if (!isValidSheetName(sheetName) || !wb.sheets || !wb.sheets[sheetName]) {
    return { ok: false };
  }
  if (!Array.isArray(cols)) {
    return { ok: false };
  }
  // Keep only valid, de-duplicated column keys, capped at the grid width.
  const seen = new Set();
  const clean = [];
  for (const c of cols) {
    if (typeof c === 'string' && COL_KEY_REGEX.test(c) && !seen.has(c)) {
      seen.add(c);
      clean.push(c);
    }
  }
  if (clean.length > MAX_COLS) clean.length = MAX_COLS;
  if (!wb.hiddenCols || typeof wb.hiddenCols !== 'object') {
    wb.hiddenCols = Object.create(null);
  }
  if (clean.length) {
    wb.hiddenCols[sheetName] = clean;
  } else {
    delete wb.hiddenCols[sheetName];
  }
  return { ok: true, sheetName, cols: clean };
};
