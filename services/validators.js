// @ts-check

/**
 * @file services/validators.js
 * @description Small, pure domain validators shared across the service layer.
 */

// A sheet name is 2–30 letters/digits/spaces (Unicode-aware).
export const SHEET_NAME_REGEX = /^[\p{L}\p{N} ]{2,30}$/u;

// A 6-digit hex color, e.g. #1a2b3c.
export const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * Property names that must never be used as a dynamic object key derived from user
 * input: assigning to them can pollute Object.prototype or shadow object internals
 * (prototype-pollution / property-injection). `__proto__` is already excluded by the
 * sheet-name regex (underscores aren't allowed), but `constructor` / `prototype` are
 * all-letters and would otherwise pass — reject them explicitly so a sheet can never
 * be named one of these anywhere in the app.
 * @param {*} key
 * @returns {boolean}
 */
export const isReservedKey = (key) =>
  key === '__proto__' || key === 'constructor' || key === 'prototype';

/**
 * Whether a sheet name is structurally valid.
 * @param {*} name
 * @returns {boolean}
 */
export const isValidSheetName = (name) =>
  typeof name === 'string' && !isReservedKey(name) && SHEET_NAME_REGEX.test(name);

/**
 * Whether a value is a valid 6-digit hex color string.
 * @param {*} color
 * @returns {boolean}
 */
export const isValidHexColor = (color) => typeof color === 'string' && HEX_COLOR_REGEX.test(color);
