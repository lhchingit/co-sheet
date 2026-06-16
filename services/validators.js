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
 * Whether a sheet name is structurally valid.
 * @param {*} name
 * @returns {boolean}
 */
export const isValidSheetName = (name) => typeof name === 'string' && SHEET_NAME_REGEX.test(name);

/**
 * Whether a value is a valid 6-digit hex color string.
 * @param {*} color
 * @returns {boolean}
 */
export const isValidHexColor = (color) => typeof color === 'string' && HEX_COLOR_REGEX.test(color);
