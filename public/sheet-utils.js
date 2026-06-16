// @ts-check
/**
 * @file sheet-utils.js
 * @description Shared, dependency-free cell/coordinate helpers and HTML escaping.
 * Published on window.CoSheet.utils; consumed by formula-engine.js and app.js.
 * Loaded as a classic <script> before formula-engine.js and app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

/**
 * Safely escapes special HTML characters to prevent reflective XSS.
 * @param {string} str - Unsafe user string.
 * @returns {string} Escaped safe string.
 */
const escapeHtml = (str) => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

/**
 * Helper to convert 0-indexed column integer to letter sequence (e.g. A, B, Z, AA, AB).
 * @param {number} index - Column index.
 * @returns {string} The column letter string.
 */
const getColLetter = (index) => {
  let temp = index;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
};

/**
 * Helper to convert column letters (e.g. "A", "AB") to 1-based index numbers.
 * @param {string} colLetter - The column letter sequence.
 * @returns {number} The 1-indexed column number.
 */
const getColNumber = (colLetter) => {
  let colIndex = 0;
  for (let i = 0; i < colLetter.length; i++) {
    colIndex = colIndex * 26 + (colLetter.charCodeAt(i) - 64);
  }
  return colIndex;
};

/**
 * Parses a cell ID into row and column indices.
 * @param {string} cellId - The cell ID coordinate.
 * @returns {Object|null} Coordinate details.
 */
const parseCellCoord = (cellId) => {
  if (!cellId) return null;
  const match = cellId.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  return {
    colLetter: match[1],
    row: parseInt(match[2], 10),
    colIndex: getColNumber(match[1]) - 1
  };
};

/**
 * Helper to parse coordinates from cell ID (e.g. B4 -> {col: 1, row: 4})

 * @param {string} coord - Cell ID coordinate string.
 * @returns {{col: number, row: number}} Coordinates.
 */
const parseCoordinates = (coord) => {
  const colLetter = coord.match(/[A-Z]+/)[0];
  const rowNum = parseInt(coord.match(/\d+/)[0]);
  let colIndex = 0;
  for (let i = 0; i < colLetter.length; i++) {
    colIndex = colIndex * 26 + (colLetter.charCodeAt(i) - 64);
  }
  return { col: colIndex - 1, row: rowNum - 1 };
};

  root.CoSheet.utils = { escapeHtml, getColLetter, getColNumber, parseCellCoord, parseCoordinates };
})();
