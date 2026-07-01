// @ts-check
import { isValidSheetName, isValidHexColor } from './validators.js';

/**
 * @file services/sheet-service.js
 * @description Transport-agnostic sheet operations (add / delete / copy / rename /
 * color / hide / unhide / reorder). Each function validates its inputs and mutates
 * the in-memory workbook state in place, returning a result object describing the
 * outcome. Persistence, presence (active-user) reassignment, and broadcasting are
 * orchestrated by the caller — currently the WebSocket handler.
 *
 * A `{ ok: false }` result means the operation was a no-op (failed a guard) and the
 * caller should silently ignore it, matching the prior WebSocket behavior.
 *
 * @typedef {{ sheets: Object, sheetOrder: string[], sheetColors: Object, hiddenSheets: string[] }} Workbook
 */

/**
 * Create a new, empty sheet and append it to the order.
 * @param {Workbook} wb
 * @param {{ sheetName: any }} payload
 * @returns {{ ok: true, sheetName: string, sheetOrder: string[] } | { ok: false }}
 */
export const addSheet = (wb, { sheetName }) => {
  if (!isValidSheetName(sheetName) || wb.sheets[sheetName]) {
    return { ok: false };
  }
  // Prototype-free to prevent prototype pollution.
  wb.sheets[sheetName] = Object.create(null);
  if (!wb.sheetOrder.includes(sheetName)) {
    wb.sheetOrder.push(sheetName);
  }
  return { ok: true, sheetName, sheetOrder: wb.sheetOrder };
};

/**
 * Delete a sheet, provided at least one other sheet remains.
 * @param {Workbook} wb
 * @param {{ sheetName: any }} payload
 * @returns {{ ok: true, sheetName: string } | { ok: false }}
 */
export const deleteSheet = (wb, { sheetName }) => {
  if (!wb.sheets[sheetName] || wb.sheetOrder.length <= 1) {
    return { ok: false };
  }
  delete wb.sheets[sheetName];
  wb.sheetOrder = wb.sheetOrder.filter((s) => s !== sheetName);
  if (wb.sheetColors[sheetName]) {
    delete wb.sheetColors[sheetName];
  }
  wb.hiddenSheets = wb.hiddenSheets.filter((s) => s !== sheetName);
  return { ok: true, sheetName };
};

/**
 * Duplicate a sheet, inserting the copy directly after the source in the order.
 * @param {Workbook} wb
 * @param {{ sheetName: any }} payload
 * @returns {{ ok: true, sheetName: string, sheetOrder: string[], cells: Object } | { ok: false }}
 */
export const copySheet = (wb, { sheetName }) => {
  if (!wb.sheets[sheetName]) {
    return { ok: false };
  }
  // Generate a unique copy name (e.g. "Sheet1 (Copy)" or "Sheet1 (Copy) 2").
  let copyName = `${sheetName} (Copy)`;
  let suffix = 2;
  while (wb.sheets[copyName]) {
    copyName = `${sheetName} (Copy) ${suffix}`;
    suffix++;
  }
  // Clone cells map securely.
  wb.sheets[copyName] = JSON.parse(JSON.stringify(wb.sheets[sheetName]));
  const originalIndex = wb.sheetOrder.indexOf(sheetName);
  wb.sheetOrder.splice(originalIndex + 1, 0, copyName);
  return { ok: true, sheetName: copyName, sheetOrder: wb.sheetOrder, cells: wb.sheets[copyName] };
};

/**
 * Rename a sheet, carrying over its color and hidden/order placement.
 * @param {Workbook} wb
 * @param {{ oldName: any, newName: any }} payload
 * @returns {{ ok: true, oldName: string, newName: string } | { ok: false }}
 */
export const renameSheet = (wb, { oldName, newName }) => {
  if (!wb.sheets[oldName] || !isValidSheetName(newName) || wb.sheets[newName]) {
    return { ok: false };
  }
  wb.sheets[newName] = wb.sheets[oldName];
  delete wb.sheets[oldName];
  wb.sheetOrder = wb.sheetOrder.map((s) => (s === oldName ? newName : s));
  if (wb.sheetColors[oldName]) {
    wb.sheetColors[newName] = wb.sheetColors[oldName];
    delete wb.sheetColors[oldName];
  }
  wb.hiddenSheets = wb.hiddenSheets.map((s) => (s === oldName ? newName : s));
  return { ok: true, oldName, newName };
};

/**
 * Set (or clear, when color is null) a sheet's tab color.
 * @param {Workbook} wb
 * @param {{ sheetName: any, color: any }} payload
 * @returns {{ ok: true, sheetName: string, color: string|null } | { ok: false }}
 */
export const colorSheet = (wb, { sheetName, color }) => {
  if (!wb.sheets[sheetName]) {
    return { ok: false };
  }
  if (color !== null && !isValidHexColor(color)) {
    return { ok: false };
  }
  if (color === null) {
    delete wb.sheetColors[sheetName];
  } else {
    wb.sheetColors[sheetName] = color;
  }
  return { ok: true, sheetName, color };
};

/**
 * Hide a sheet, provided it exists, is not already hidden, and is not the last
 * visible sheet.
 * @param {Workbook} wb
 * @param {{ sheetName: any }} payload
 * @returns {{ ok: true, sheetName: string } | { ok: false }}
 */
export const hideSheet = (wb, { sheetName }) => {
  if (!wb.sheets[sheetName] || wb.hiddenSheets.includes(sheetName)) {
    return { ok: false };
  }
  const visibleCount = wb.sheetOrder.filter((s) => !wb.hiddenSheets.includes(s)).length;
  if (visibleCount <= 1) {
    return { ok: false };
  }
  wb.hiddenSheets.push(sheetName);
  return { ok: true, sheetName };
};

/**
 * Unhide a currently-hidden sheet.
 * @param {Workbook} wb
 * @param {{ sheetName: any }} payload
 * @returns {{ ok: true, sheetName: string } | { ok: false }}
 */
export const unhideSheet = (wb, { sheetName }) => {
  if (!wb.hiddenSheets.includes(sheetName)) {
    return { ok: false };
  }
  wb.hiddenSheets = wb.hiddenSheets.filter((s) => s !== sheetName);
  return { ok: true, sheetName };
};

/**
 * Replace the sheet order. The new order must be a permutation of the current one
 * (same length, same members).
 * @param {Workbook} wb
 * @param {{ sheetOrder: any }} payload
 * @returns {{ ok: true, sheetOrder: string[] } | { ok: false }}
 */
export const reorderSheets = (wb, { sheetOrder }) => {
  if (!Array.isArray(sheetOrder) ||
      sheetOrder.length !== wb.sheetOrder.length ||
      !sheetOrder.every((s) => wb.sheetOrder.includes(s))) {
    return { ok: false };
  }
  wb.sheetOrder = sheetOrder;
  return { ok: true, sheetOrder };
};
