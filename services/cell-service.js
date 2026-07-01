// @ts-check
import { isValidSheetName } from './validators.js';

/**
 * @file services/cell-service.js
 * @description Transport-agnostic cell-edit logic shared by the REST endpoint
 * (POST /api/cells) and the WebSocket `cell-edit` handler. Owns payload validation
 * and the in-memory cell write (sheet resolution + the canonical cell shape).
 * Persistence, broadcasting, and access control are orchestrated by the callers,
 * which differ by transport.
 */

/**
 * Validate a cell edit payload: verifies types, formats, string lengths, and style
 * structures, and guards against prototype-pollution cell ids.
 * @param {*} cellId - The identifier of the cell (e.g. 'A1').
 * @param {*} formula - The cell's formula string.
 * @param {*} value - The cell's evaluated string value.
 * @param {*} style - The cell's formatting style options.
 * @returns {{ valid: boolean, message?: string }}
 */
export const validateCellPayload = (cellId, formula, value, style) => {
  // Validate that cellId is a non-empty string.
  if (typeof cellId !== 'string' || !cellId) {
    return { valid: false, message: 'cellId must be a valid non-empty string' };
  }

  // Explicitly prevent prototype pollution attacks by rejecting reserved property names.
  if (cellId === '__proto__' || cellId === 'constructor') {
    return { valid: false, message: 'Invalid cellId: Reserved property name' };
  }

  // Enforce cell ID schema format (columns A-ZZ, rows 1-999).
  const cellIdRegex = /^[A-Z]{1,2}[1-9][0-9]{0,2}$/;
  if (!cellIdRegex.test(cellId)) {
    return { valid: false, message: 'Invalid cellId format' };
  }

  // Validate formula if provided
  if (formula !== undefined) {
    if (typeof formula !== 'string' || formula.length > 200) {
      return { valid: false, message: 'formula must be a string up to 200 characters' };
    }
  }

  // Validate value if provided
  if (value !== undefined) {
    if (typeof value !== 'string' || value.length > 200) {
      return { valid: false, message: 'value must be a string up to 200 characters' };
    }
  }

  // Validate style if provided
  if (style !== undefined) {
    if (typeof style !== 'object' || style === null || Array.isArray(style)) {
      return { valid: false, message: 'style must be an object' };
    }
    const allowedKeys = ['bold', 'italic', 'underline', 'color', 'strikethrough', 'textColor', 'border', 'borders', 'align', 'link', 'verticalAlign', 'fontFamily', 'fontSize', 'numberFormat', 'textWrap'];
    const borderSides = ['top', 'right', 'bottom', 'left'];
    const borderStyles = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'];
    const numberFormats = ['number', 'percent', 'scientific', 'accounting', 'financial', 'currency', 'currencyRounded'];
    const textWrapModes = ['overflow', 'wrap', 'clip'];
    for (const key of Object.keys(style)) {
      if (!allowedKeys.includes(key)) {
        return { valid: false, message: `Invalid style property: ${key}` };
      }
      // Validate boolean properties
      if (key === 'bold' || key === 'italic' || key === 'underline' || key === 'strikethrough' || key === 'border') {
        if (typeof style[key] !== 'boolean') {
          return { valid: false, message: `${key} must be a boolean` };
        }
      }
      // Validate number format key (null/absent means "automatic").
      if (key === 'numberFormat') {
        if (style[key] !== null && (typeof style[key] !== 'string' || !numberFormats.includes(style[key]))) {
          return { valid: false, message: 'numberFormat is invalid' };
        }
      }
      // Validate text-wrapping mode.
      if (key === 'textWrap') {
        if (typeof style[key] !== 'string' || !textWrapModes.includes(style[key])) {
          return { valid: false, message: "textWrap must be 'overflow', 'wrap', or 'clip'" };
        }
      }
      // Validate color HEX properties
      if (key === 'color' || key === 'textColor') {
        if (typeof style[key] !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(style[key])) {
          return { valid: false, message: `${key} must be a valid 6-character hex string starting with #` };
        }
      }
      // Validate structured per-side borders object. Each side is either null
      // (no border) or { color: '#rrggbb', style: <one of borderStyles> }.
      if (key === 'borders') {
        const borders = style[key];
        if (typeof borders !== 'object' || borders === null || Array.isArray(borders)) {
          return { valid: false, message: 'borders must be an object' };
        }
        for (const side of Object.keys(borders)) {
          if (!borderSides.includes(side)) {
            return { valid: false, message: `Invalid border side: ${side}` };
          }
          const spec = borders[side];
          if (spec === null) continue;
          if (typeof spec !== 'object' || Array.isArray(spec)) {
            return { valid: false, message: `border ${side} must be null or an object` };
          }
          for (const specKey of Object.keys(spec)) {
            if (specKey !== 'color' && specKey !== 'style') {
              return { valid: false, message: `Invalid border property: ${specKey}` };
            }
          }
          if (typeof spec.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(spec.color)) {
            return { valid: false, message: `border ${side} color must be a valid 6-character hex string` };
          }
          if (typeof spec.style !== 'string' || !borderStyles.includes(spec.style)) {
            return { valid: false, message: `border ${side} style is invalid` };
          }
        }
      }
      // Validate alignment property (left, center, or right)
      if (key === 'align') {
        if (typeof style[key] !== 'string' || !['left', 'center', 'right'].includes(style[key])) {
          return { valid: false, message: `align must be 'left', 'center', or 'right'` };
        }
      }
      // Validate hyperlink URL string (limit up to 200 chars)
      if (key === 'link') {
        if (typeof style[key] !== 'string' || style[key].length > 200) {
          return { valid: false, message: 'link must be a string up to 200 characters' };
        }
      }
      // Validate vertical alignment property (top, center, or bottom)
      if (key === 'verticalAlign') {
        if (typeof style[key] !== 'string' || !['top', 'center', 'bottom'].includes(style[key])) {
          return { valid: false, message: "verticalAlign must be 'top', 'center', or 'bottom'" };
        }
      }
      // Validate font family name (non-empty string up to 100 chars)
      if (key === 'fontFamily') {
        if (typeof style[key] !== 'string' || style[key].length === 0 || style[key].length > 100) {
          return { valid: false, message: 'fontFamily must be a string up to 100 characters' };
        }
      }
      // Validate font size (integer point value between 1 and 400)
      if (key === 'fontSize') {
        if (typeof style[key] !== 'number' || !Number.isInteger(style[key]) || style[key] < 1 || style[key] > 400) {
          return { valid: false, message: 'fontSize must be an integer between 1 and 400' };
        }
      }
    }
  }

  return { valid: true };
};

/**
 * Apply a (validated) cell edit to an in-memory workbook. Does not persist or
 * broadcast — the caller orchestrates that per transport.
 *
 * Two write modes:
 *  - When `sheetName` is omitted (REST), writes through the workbook's `cells`
 *    accessor (the first visible sheet).
 *  - When `sheetName` is provided (WebSocket), the sheet name must be structurally
 *    valid and already exist on the workbook; otherwise the write is rejected.
 *
 * @param {any} workbook The live workbook state ({ sheets, cells, ... }).
 * @param {{ cellId: string, formula?: any, value?: any, style?: any, sheetName?: string }} payload
 * @returns {{ ok: true, sheet: string|null } | { ok: false, message: string }}
 */
export const writeCellValue = (workbook, { cellId, formula, value, style, sheetName }) => {
  const validation = validateCellPayload(cellId, formula, value, style);
  if (!validation.valid) {
    return { ok: false, message: validation.message || 'Invalid cell payload' };
  }

  if (sheetName !== undefined) {
    const sheet = sheetName || 'Sheet1';
    if (!isValidSheetName(sheet) || !(workbook.sheets && workbook.sheets[sheet])) {
      return { ok: false, message: 'Invalid or unknown sheet' };
    }
    workbook.sheets[sheet][cellId] = { formula, value, style };
    return { ok: true, sheet };
  }

  if (!workbook.cells) {
    workbook.cells = Object.create(null);
  }
  workbook.cells[cellId] = { formula, value, style };
  return { ok: true, sheet: null };
};
