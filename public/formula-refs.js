// @ts-check
/**
 * @file formula-refs.js
 * @description Pure scanner that finds cell/range references in a formula
 * string and assigns each a display color. Published on
 * window.CoSheet.formulaRefs. Depends on window.CoSheet.utils.parseCoordinates;
 * load as a classic <script> after sheet-utils.js and before app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};
  const { parseCoordinates } = root.CoSheet.utils;

  // Distinct, legible colors cycled across the references in one formula.
  const PALETTE = ['#1a73e8', '#e8710a', '#188038', '#9334e6', '#d01884', '#00897b', '#c5221f', '#7cb342'];

  // A1 or A1:B2, optional $ anchors. Lookbehind rejects matches that are part of
  // a longer identifier/number (so "LOG10" / "ABC123" don't yield a stray ref);
  // lookahead rejects a trailing identifier char or "(" (function call).
  const REF_RE = /(?<![A-Za-z0-9$_.])(\$?[A-Za-z]{1,2}\$?\d+)(?::(\$?[A-Za-z]{1,2}\$?\d+))?(?![A-Za-z0-9_(])/g;

  const toCoord = (part) => parseCoordinates(part.replace(/\$/g, '').toUpperCase());

  /**
   * Finds references in a formula (text must start with '='); returns descriptors
   * with character offsets, kind, and normalized zero-based coordinates. Skips
   * references inside "double-quoted" string literals.
   * @param {string} text
   */
  const scanReferences = (text) => {
    if (typeof text !== 'string' || text[0] !== '=') return [];
    // Mark characters that fall inside a string literal so they are ignored.
    const inString = new Array(text.length).fill(false);
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') {
        let j = i + 1;
        while (j < text.length) {
          if (text[j] === '"') { if (text[j + 1] === '"') { j += 2; continue; } break; }
          j++;
        }
        for (let k = i; k <= Math.min(j, text.length - 1); k++) inString[k] = true;
        i = j;
      }
    }
    const out = [];
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(text)) !== null) {
      if (inString[m.index]) continue;
      const a = toCoord(m[1]);
      const b = m[2] ? toCoord(m[2]) : a;
      out.push({
        ref: m[0],
        start: m.index,
        end: m.index + m[0].length,
        kind: m[2] ? 'range' : 'cell',
        r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col),
        r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col)
      });
    }
    return out;
  };

  /**
   * Annotates each ref with a color; identical references (case/`$`-insensitive)
   * share one color, distinct references cycle PALETTE in first-seen order.
   * Mutates and returns the same array.
   */
  const assignColors = (refs) => {
    const byKey = new Map();
    let next = 0;
    for (const r of refs) {
      const key = r.ref.replace(/\$/g, '').toUpperCase();
      if (!byKey.has(key)) { byKey.set(key, PALETTE[next % PALETTE.length]); next++; }
      r.color = byKey.get(key);
    }
    return refs;
  };

  root.CoSheet.formulaRefs = { PALETTE, scanReferences, assignColors };
})();
