// @ts-check
import zlib from 'zlib';
import { SHEET_NAME_REGEX } from './validators.js';

/**
 * @file services/xlsx-import.js
 * @description Dependency-free .xlsx (Office Open XML) reader. Parses an uploaded
 * workbook Buffer into co-sheet's workbook shape: ordered sheets of cells (value +
 * formula + style), per-sheet column widths / row heights, sheet tab colors, and
 * (best-effort) an auto-filter descriptor. An .xlsx file is a ZIP of XML parts; we
 * unzip it with Node's built-in zlib (raw DEFLATE) — no third-party library — and
 * read the parts with targeted regexes (the parts are machine-generated, so a full
 * XML parser is unnecessary).
 *
 * What is imported:
 *   - values (shared/inline strings, numbers, booleans)
 *   - formulas (`<f>` -> `=…`, with the cached `<v>` kept as the fallback value)
 *   - formatting: bold/italic/underline/strike, font family & size, font & fill
 *     colors (rgb / indexed / theme+tint), borders, horizontal & vertical
 *     alignment, wrap, and a best-effort number-format class (percent / currency /
 *     accounting / scientific; date & time serials are converted to text)
 *   - merged cells (stored on the anchor cell's style.merge)
 *   - explicit column widths / row heights, and sheet tab colors
 *   - a best-effort auto-filter (single column — see services note in the route)
 *
 * Failures throw an Error carrying a `code` so the route can map it to a localized
 * warning: 'legacy_xls' (old binary .xls), 'unsupported' (not an OOXML zip),
 * 'corrupt' (zip/XML it couldn't read), or 'empty' (no importable sheets).
 */

// The editor renders up to 702 columns (A–ZZ) and 1000 rows, so cells/tracks
// beyond that range can't be shown and are dropped on import.
const MAX_COL = 701;  // 0-based, 'ZZ'
const MAX_ROW = 1000; // 1-based
// Stored cell text / formula is truncated to the length the cell editor accepts, so
// an imported cell stays editable afterwards.
const MAX_VALUE_LEN = 200;
const MAX_FORMULA_LEN = 200;
// Defensive overall ceiling so a hostile/huge sheet can't exhaust memory.
const MAX_TOTAL_CELLS = 200000;
// Column-width / row-height clamp (px), mirroring services/dimension-service.js.
const MIN_TRACK = 20;
const MAX_TRACK = 2000;

const tagged = (message, code) => Object.assign(new Error(message), { code });

// --- ZIP reading (central-directory based) ----------------------------------

// Locate the End Of Central Directory record and return the catalogue of entries
// as a Map of name -> { method, compSize, localOffset }.
const readZipDirectory = (buf) => {
  const EOCD_SIG = 0x06054b50;
  const minPos = Math.max(0, buf.length - (22 + 0xffff)); // 22 = EOCD size, +max comment
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw tagged('No ZIP end-of-central-directory record', 'corrupt');

  const total = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16); // offset of first central-directory record
  const entries = new Map();
  const CDH_SIG = 0x02014b50;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CDH_SIG) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
};

// Decompress one entry to a string (raw DEFLATE or stored), reading the local
// header to skip its (possibly differently-sized) name/extra fields.
const readEntry = (buf, entry) => {
  const LFH_SIG = 0x04034b50;
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LFH_SIG) {
    throw tagged('Bad ZIP local file header', 'corrupt');
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  let out;
  if (entry.method === 0) out = data;                           // stored
  else if (entry.method === 8) out = zlib.inflateRawSync(data); // deflate
  else throw tagged(`Unsupported ZIP compression method ${entry.method}`, 'corrupt');
  return out.toString('utf8');
};

// --- XML helpers ------------------------------------------------------------

const decodeEntities = (s) => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&'); // ampersand last so it can't double-decode

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1] : null;
};

// Whether a boolean child flag (<b/>, <i/>, <b val="1"/>, …) is on. Absent → off;
// present with val="0"/"false" → off; otherwise on.
const boolFlag = (frag, tag) => {
  const m = frag.match(new RegExp(`<${tag}(\\s[^>]*)?/?>`));
  if (!m) return false;
  const v = m[1] && /\bval="([^"]*)"/.exec(m[1]);
  if (v) return v[1] !== '0' && v[1] !== 'false' && v[1] !== 'none';
  return true;
};

// Concatenate every <t> text node inside a fragment (covers rich-text runs).
const collectText = (fragment) => {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(fragment))) out += m[1];
  return decodeEntities(out);
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const colRowFromRef = (ref) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) }; // col 0-based, row 1-based
};

// 0-based column index -> spreadsheet letters (0 -> A, 26 -> AA).
const colLetters = (index) => {
  let temp = index;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
};

const clampTrack = (n) => Math.max(MIN_TRACK, Math.min(MAX_TRACK, Math.round(n)));

// --- Colors -----------------------------------------------------------------

// The legacy 56-entry indexed color palette (indices 64/65 are the system fore/
// background "automatic" colors, resolved to null so we don't force a color).
const INDEXED_PALETTE = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'
];

// Default Office theme colors in clrScheme document order: dk1, lt1, dk2, lt2,
// accent1..6, hlink, folHlink. Used as a fallback when theme1.xml is absent.
const DEFAULT_THEME = ['000000', 'FFFFFF', '44546A', 'E7E6E6', '4472C4', 'ED7D31',
  'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

// The style "theme" index maps into clrScheme order with dk1<->lt1 and dk2<->lt2
// swapped (a well-known OOXML quirk).
const THEME_INDEX_TO_SCHEME = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11];

const argbToHex = (argb) => {
  const s = String(argb).trim();
  if (/^[0-9a-fA-F]{8}$/.test(s)) return `#${s.slice(2).toUpperCase()}`;
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toUpperCase()}`;
  return null;
};

const hexToRgb = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16)
});
const rgbToHex = ({ r, g, b }) => `#${[r, g, b].map((v) =>
  Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

// Apply an OOXML tint to a hex color via HSL luminance (negative darkens, positive
// lightens). Uses the common lum' = lum*(1-tint)+tint approximation for tint>0.
const applyTint = (hex, tint) => {
  if (!tint) return hex;
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  let h = 0, s = 0; const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }
  const l2 = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r2, g2, b2;
  if (s === 0) { r2 = g2 = b2 = l2; }
  else {
    const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
    const p = 2 * l2 - q;
    r2 = hue2rgb(p, q, h + 1 / 3); g2 = hue2rgb(p, q, h); b2 = hue2rgb(p, q, h - 1 / 3);
  }
  return rgbToHex({ r: r2 * 255, g: g2 * 255, b: b2 * 255 });
};

// Build a color resolver bound to the workbook's theme palette.
const makeColorResolver = (themeColors) => (colorTag) => {
  if (!colorTag) return null;
  const rgb = attr(colorTag, 'rgb');
  if (rgb) return argbToHex(rgb);
  const indexed = attr(colorTag, 'indexed');
  if (indexed != null) {
    const idx = parseInt(indexed, 10);
    const hex = INDEXED_PALETTE[idx];
    return hex ? `#${hex}` : null; // 64/65 (auto) fall off the end -> null
  }
  const theme = attr(colorTag, 'theme');
  if (theme != null) {
    const ti = parseInt(theme, 10);
    const scheme = THEME_INDEX_TO_SCHEME[ti];
    const base = scheme != null ? themeColors[scheme] : null;
    if (!base) return null;
    const tint = parseFloat(attr(colorTag, 'tint') || '0') || 0;
    return applyTint(`#${base}`, tint);
  }
  return null;
};

// --- Number formats ---------------------------------------------------------

// Built-in numFmtId -> format class. Anything absent here is treated as plain.
const BUILTIN_NUMFMT = {
  1: 'number', 2: 'number', 3: 'number', 4: 'number',
  5: 'currency', 6: 'currency', 7: 'currency', 8: 'currency',
  9: 'percent', 10: 'percent', 11: 'scientific',
  37: 'number', 38: 'number', 39: 'number', 40: 'number', 41: 'number', 43: 'number',
  42: 'currency', 44: 'accounting', 48: 'scientific',
  14: 'date', 15: 'date', 16: 'date', 17: 'date', 22: 'datetime',
  18: 'time', 19: 'time', 20: 'time', 21: 'time', 45: 'time', 46: 'time', 47: 'time'
};

// Classify a custom format code into the same classes.
const classifyFormatCode = (code) => {
  if (!code) return null;
  // Drop color/condition/locale tags like [Red] or [$-409], but UNWRAP currency
  // tags ([$£-809] -> £-809) so the symbol survives; then drop \-escapes. Quoted
  // literals are kept here so a quoted currency symbol ("$") is still detectable.
  const c = code
    .replace(/\[(?!\$)[^\]]*\]/g, '')
    .replace(/\[\$([^\]]*)\]/g, '$1')
    .replace(/\\./g, '');
  if (/%/.test(c)) return 'percent';
  if (/[eE]\+/.test(c)) return 'scientific';
  // Date/time tokens, tested with quoted literals removed so letters inside text
  // (e.g. "May") don't read as month/day tokens.
  const tok = c.replace(/"[^"]*"/g, '');
  if (/[yY]/.test(tok) || /[dD]/.test(tok)) return /[hHsS]/.test(tok) ? 'datetime' : 'date';
  if (/[hHsS]/.test(tok)) return 'time';
  if (/[$£€¥₩₹]|¤/.test(c)) return /[(_]/.test(code) ? 'accounting' : 'currency';
  return 'number';
};

// Excel's date epoch is 1899-12-30 (day 0); fractional days are the time of day.
const serialToDateText = (num, kind) => {
  if (!isFinite(num) || num < 0 || num > 2958465) return null; // 2958465 = 9999-12-31
  const ms = Math.round(num * 86400000) + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const secs = d.getUTCSeconds();
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${secs ? `:${p(secs)}` : ''}`;
  if (kind === 'time') return time;
  if (kind === 'datetime') return `${date} ${time}`;
  return date;
};

// --- styles.xml -> resolved cell formats ------------------------------------

const SIDE_STYLE_MAP = {
  thin: 'thin', medium: 'medium', thick: 'thick', double: 'double',
  dotted: 'dotted', hair: 'dotted', dashed: 'dashed', mediumdashed: 'dashed',
  dashdot: 'dashed', mediumdashdot: 'dashed', dashdotdot: 'dashed',
  mediumdashdotdot: 'dashed', slantdashdot: 'dashed'
};
const H_ALIGN = { left: 'left', center: 'center', right: 'right', centercontinuous: 'center' };
const V_ALIGN = { top: 'top', center: 'center', bottom: 'bottom', middle: 'center' };

// Parse styles.xml into an array of resolved cell formats, indexed by the cell's
// `s` attribute. Each entry is { style, numKind } where style is a co-sheet style
// object and numKind ('date'|'time'|'datetime'|null) drives value conversion.
const parseStyles = (xml, resolveColor) => {
  if (!xml) return [];

  // Custom number formats (id -> code).
  const numFmts = new Map();
  {
    const re = /<numFmt\b[^>]*\/?>/g; let m;
    while ((m = re.exec(xml))) {
      const id = parseInt(attr(m[0], 'numFmtId') || '', 10);
      const code = attr(m[0], 'formatCode');
      if (!isNaN(id) && code != null) numFmts.set(id, decodeEntities(code));
    }
  }
  const classOf = (numFmtId) => {
    if (numFmts.has(numFmtId)) return classifyFormatCode(numFmts.get(numFmtId));
    return BUILTIN_NUMFMT[numFmtId] || null;
  };

  const section = (tag) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
    return m ? m[1] : '';
  };

  // Fonts.
  const fonts = [];
  {
    const re = /<font\b[^>]*>([\s\S]*?)<\/font>|<font\b[^>]*\/>/g;
    const block = section('fonts');
    re.lastIndex = 0;
    let mm;
    const fre = /<font>([\s\S]*?)<\/font>|<font\/>/g;
    while ((mm = fre.exec(block))) {
      const inner = mm[1] || '';
      const f = {};
      if (boolFlag(inner, 'b')) f.bold = true;
      if (boolFlag(inner, 'i')) f.italic = true;
      if (boolFlag(inner, 'u')) f.underline = true;
      if (boolFlag(inner, 'strike')) f.strikethrough = true;
      const sz = /<sz\b[^>]*\bval="([^"]*)"/.exec(inner);
      if (sz) { const n = Math.round(parseFloat(sz[1])); if (n && n !== 11) f.fontSize = Math.max(1, Math.min(400, n)); }
      const nm = /<name\b[^>]*\bval="([^"]*)"/.exec(inner) || /<rFont\b[^>]*\bval="([^"]*)"/.exec(inner);
      if (nm) { const name = decodeEntities(nm[1]); if (name && name !== 'Calibri') f.fontFamily = name.slice(0, 100); }
      const colorTag = /<color\b[^>]*\/?>/.exec(inner);
      if (colorTag) { const c = resolveColor(colorTag[0]); if (c && c !== '#000000') f.textColor = c; }
      fonts.push(f);
    }
  }

  // Fills (solid pattern -> fgColor).
  const fills = [];
  {
    const block = section('fills');
    const fre = /<fill>([\s\S]*?)<\/fill>|<fill\/>/g; let mm;
    while ((mm = fre.exec(block))) {
      const inner = mm[1] || '';
      const pat = /<patternFill\b[^>]*\bpatternType="([^"]*)"/.exec(inner);
      let color = null;
      if (pat && pat[1] === 'solid') {
        const fg = /<fgColor\b[^>]*\/?>/.exec(inner);
        if (fg) color = resolveColor(fg[0]);
      }
      fills.push(color);
    }
  }

  // Borders.
  const borders = [];
  {
    const block = section('borders');
    const bre = /<border\b[^>]*>([\s\S]*?)<\/border>|<border\b[^>]*\/>/g; let mm;
    while ((mm = bre.exec(block))) {
      const inner = mm[1] || '';
      const b = {};
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const sm = new RegExp(`<${side}\\b([^>]*)>([\\s\\S]*?)</${side}>|<${side}\\b([^>]*)/>`).exec(inner);
        if (!sm) continue;
        const sideAttrs = sm[1] || sm[3] || '';
        const styleName = (attr(sideAttrs, 'style') || '').toLowerCase();
        if (!styleName || styleName === 'none') continue;
        const mapped = SIDE_STYLE_MAP[styleName] || 'thin';
        const colorTag = sm[2] ? /<color\b[^>]*\/?>/.exec(sm[2]) : null;
        const color = (colorTag && resolveColor(colorTag[0])) || '#000000';
        b[side] = { color, style: mapped };
      }
      borders.push(Object.keys(b).length ? b : null);
    }
  }

  // cellXfs.
  const xfs = [];
  {
    const block = section('cellXfs');
    const xre = /<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g; let mm;
    while ((mm = xre.exec(block))) {
      const a = mm[1] || '';
      const inner = mm[2] || '';
      const style = {};
      const fontId = parseInt(attr(a, 'fontId') || '0', 10);
      const fillId = parseInt(attr(a, 'fillId') || '0', 10);
      const borderId = parseInt(attr(a, 'borderId') || '0', 10);
      const numFmtId = parseInt(attr(a, 'numFmtId') || '0', 10);
      Object.assign(style, fonts[fontId] || {});
      const fillColor = fills[fillId];
      if (fillColor) style.color = fillColor;
      const border = borders[borderId];
      if (border) style.borders = border;
      const align = /<alignment\b[^>]*\/?>/.exec(inner);
      if (align) {
        const h = (attr(align[0], 'horizontal') || '').toLowerCase();
        const v = (attr(align[0], 'vertical') || '').toLowerCase();
        if (H_ALIGN[h]) style.align = H_ALIGN[h];
        if (V_ALIGN[v]) style.verticalAlign = V_ALIGN[v];
        if (boolFlag(align[0], 'wrapText') || attr(align[0], 'wrapText') === '1') style.textWrap = 'wrap';
      }
      const cls = classOf(numFmtId);
      let numKind = null;
      if (cls === 'percent' || cls === 'scientific' || cls === 'currency' || cls === 'accounting') {
        style.numberFormat = cls;
      } else if (cls === 'date' || cls === 'time' || cls === 'datetime') {
        numKind = cls;
      }
      xfs.push({ style, numKind });
    }
  }
  return xfs;
};

// --- Worksheet --------------------------------------------------------------

// Parse one worksheet into cells (value/formula/style), explicit track sizes, a
// tab color, and a best-effort filter. `xfs` is the resolved styles table.
const parseSheet = (xml, ctx) => {
  const { sharedStrings, xfs, resolveColor, budget } = ctx;
  const cells = Object.create(null);

  // Pre-scan row heights from <row> attributes (customHeight only).
  const rowHeights = Object.create(null);

  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowAttrs = rm[1] || '';
    const r = parseInt(attr(rowAttrs, 'r') || '0', 10);
    if (r >= 1 && r <= MAX_ROW && attr(rowAttrs, 'customHeight') === '1') {
      const ht = parseFloat(attr(rowAttrs, 'ht') || '');
      if (isFinite(ht)) rowHeights[String(r)] = clampTrack(ht * 4 / 3); // points -> px
    }
    const rowBody = rm[2] || '';
    let m;
    cellRe.lastIndex = 0;
    while ((m = cellRe.exec(rowBody))) {
      if (budget.left <= 0) break;
      const attrs = m[1];
      const inner = m[2] || '';
      const ref = attr(attrs, 'r');
      if (!ref) continue;
      const cr = colRowFromRef(ref);
      if (!cr || cr.col < 0 || cr.col > MAX_COL || cr.row < 1 || cr.row > MAX_ROW) continue;

      const xf = xfs[parseInt(attr(attrs, 's') || '0', 10)] || { style: {}, numKind: null };
      const style = Object.assign(Object.create(null), xf.style);

      // Formula (skip empty/shared-without-text and over-long ones; the cached <v>
      // is still imported as the value so the cell shows Excel's last result).
      let formula = '';
      const fm = /<f\b([^>]*)>([\s\S]*?)<\/f>/.exec(inner);
      if (fm && fm[2].trim()) {
        const ftext = decodeEntities(fm[2]).trim();
        if (ftext && ftext.length <= MAX_FORMULA_LEN - 1) formula = `=${ftext}`;
      }

      // Value.
      const type = attr(attrs, 't'); // s | str | inlineStr | b | (number/date)
      let text = '';
      if (type === 'inlineStr') {
        text = collectText(inner);
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vm ? vm[1] : '';
        if (type === 's') {
          const idx = parseInt(raw, 10);
          text = Number.isInteger(idx) ? (sharedStrings[idx] || '') : '';
        } else if (type === 'b') {
          text = raw === '1' ? 'TRUE' : 'FALSE';
        } else if (xf.numKind && raw !== '') {
          const dt = serialToDateText(Number(raw), xf.numKind);
          text = dt != null ? dt : decodeEntities(raw);
        } else {
          text = decodeEntities(raw);
        }
      }
      if (text.length > MAX_VALUE_LEN) text = text.slice(0, MAX_VALUE_LEN);

      const hasStyle = Object.keys(style).length > 0;
      if (text === '' && !formula && !hasStyle) continue; // truly empty
      cells[`${colLetters(cr.col)}${cr.row}`] = { formula, value: text, style };
      budget.left--;
    }
  }

  // Merged cells -> style.merge on the anchor (top-left) cell.
  let hasMerges = false;
  {
    const mc = /<mergeCell\b[^>]*\bref="([^"]*)"/g; let m;
    while ((m = mc.exec(xml))) {
      const [a, b] = m[1].split(':');
      const s = a && colRowFromRef(a);
      const e = b && colRowFromRef(b);
      if (!s || !e) continue;
      const rows = Math.abs(e.row - s.row) + 1;
      const cols = Math.abs(e.col - s.col) + 1;
      const ar = Math.min(s.row, e.row), ac = Math.min(s.col, e.col);
      if (ac > MAX_COL || ar > MAX_ROW || rows * cols <= 1) continue;
      const anchor = `${colLetters(ac)}${ar}`;
      if (!cells[anchor]) cells[anchor] = { formula: '', value: '', style: Object.create(null) };
      cells[anchor].style.merge = { rows: Math.min(rows, MAX_ROW), cols: Math.min(cols, MAX_COL + 1) };
      hasMerges = true;
    }
  }

  // Explicit column widths (<col customWidth="1">), expanded across [min,max].
  const colWidths = Object.create(null);
  {
    const colsBlock = /<cols>([\s\S]*?)<\/cols>/.exec(xml);
    if (colsBlock) {
      const cre = /<col\b[^>]*\/?>/g; let m;
      while ((m = cre.exec(colsBlock[1]))) {
        if (attr(m[0], 'customWidth') !== '1') continue;
        const width = parseFloat(attr(m[0], 'width') || '');
        if (!isFinite(width)) continue;
        const min = parseInt(attr(m[0], 'min') || '0', 10);
        const max = parseInt(attr(m[0], 'max') || '0', 10);
        const px = clampTrack(width * 7 + 5); // char units -> px (default font)
        for (let c = min; c <= max && c <= MAX_COL + 1; c++) {
          if (c >= 1) colWidths[colLetters(c - 1)] = px;
        }
      }
    }
  }

  // Sheet tab color.
  let tabColor = null;
  {
    const sp = /<sheetPr\b[^>]*>([\s\S]*?)<\/sheetPr>/.exec(xml);
    const tc = sp ? /<tabColor\b[^>]*\/?>/.exec(sp[1]) : null;
    if (tc) tabColor = resolveColor(tc[0]);
  }

  // Best-effort auto-filter (a single value-filtered column). The app forbids a
  // filter on a sheet that has merges, so we drop it in that case.
  let filter = null;
  if (!hasMerges) {
    const af = /<autoFilter\b([^>]*?)(?:\/>|>([\s\S]*?)<\/autoFilter>)/.exec(xml);
    if (af) {
      const ref = attr(af[1], 'ref');
      const start = ref ? colRowFromRef(ref.split(':')[0]) : null;
      if (start) {
        const body = af[2] || '';
        const fc = /<filterColumn\b[^>]*\bcolId="([^"]*)"[\s\S]*?<\/filterColumn>|<filterColumn\b[^>]*\bcolId="([^"]*)"[^>]*\/>/.exec(body);
        const relCol = fc ? parseInt(fc[1] != null ? fc[1] : fc[2], 10) : 0;
        const colIndex = start.col + (isNaN(relCol) ? 0 : relCol);
        if (colIndex >= 0 && colIndex <= MAX_COL) {
          // Shown values from <filter val="…">; hidden = the column's other values.
          const shown = new Set();
          if (fc) {
            const fr = /<filter\b[^>]*\bval="([^"]*)"/g; let mm;
            while ((mm = fr.exec(fc[0]))) shown.add(decodeEntities(mm[1]));
          }
          let hidden = [];
          if (shown.size > 0) {
            const headerRow = start.row; // filter header is the range's first row
            const colKey = colLetters(colIndex);
            const seen = new Set();
            for (const k of Object.keys(cells)) {
              if (!k.startsWith(colKey)) continue;
              const cr2 = colRowFromRef(k);
              if (!cr2 || cr2.col !== colIndex || cr2.row <= headerRow) continue;
              const val = cells[k].value;
              const key = (val === '' || val == null) ? '__BLANK__' : String(val);
              if (seen.has(key)) continue;
              seen.add(key);
              if (!shown.has(String(val))) hidden.push(key);
            }
          }
          filter = { colIndex, hidden };
        }
      }
    }
  }

  return { cells, colWidths, rowHeights, tabColor, filter };
};

// --- Sheet-name sanitisation ------------------------------------------------

// Coerce an Excel sheet name into co-sheet's stricter shape (2–30 letters/digits/
// spaces) and guarantee uniqueness within the workbook.
const sanitizeSheetNames = (rawNames) => {
  const used = new Set();
  return rawNames.map((raw, i) => {
    let n = String(raw || '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (n.length < 2) n = `Sheet${i + 1}`;
    if (n.length > 30) n = n.slice(0, 30).trim();
    if (!SHEET_NAME_REGEX.test(n)) n = `Sheet${i + 1}`;
    let candidate = n;
    let k = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = ` ${k++}`;
      candidate = (n.slice(0, 30 - suffix.length) + suffix).trim();
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
};

// Rewrite sheet-qualified references (Old!A1 / 'Old'!A1) in a formula to the
// renamed sheet, for the sheets whose names sanitisation actually changed.
const rewriteSheetRefs = (formula, renameMap) => {
  let out = formula;
  for (const [oldName, newName] of renameMap) {
    out = out
      .replace(new RegExp(`'${escapeRegExp(oldName)}'!`, 'g'), `'${newName}'!`)
      .replace(new RegExp(`(^|[^A-Za-z0-9_'])${escapeRegExp(oldName)}!`, 'g'), `$1${newName}!`);
  }
  return out;
};

// --- Public API -------------------------------------------------------------

/**
 * Parse an .xlsx Buffer into ordered sheets with values, formulas, formatting,
 * merges, track sizes, tab colors, and best-effort filters.
 * @param {Buffer} buf The raw uploaded file bytes.
 * @returns {{ sheets: Array<{ name: string, cells: Record<string, {formula:string,value:string,style:object}>, colWidths: Record<string,number>, rowHeights: Record<string,number>, tabColor: string|null, filter: {colIndex:number,hidden:string[]}|null }> }}
 */
export function parseXlsx(buf) {
  // Validate the input's type before any byte-level access. Callers pass
  // request-derived data, which could be tampered into a different type (a string
  // or array with a numeric `length`, or any other non-Buffer object). Reject the
  // string/array shapes explicitly, then require an actual Buffer, so the later
  // .length / .readUInt32LE / .subarray calls cannot be confused by a spoofed type.
  if (typeof buf === 'string' || Array.isArray(buf)) throw tagged('Empty upload', 'empty');
  if (!Buffer.isBuffer(buf)) throw tagged('Empty upload', 'empty');
  if (buf.length < 4) throw tagged('Empty upload', 'empty');

  // Legacy binary .xls is an OLE2 compound file (magic D0 CF 11 E0).
  if (buf.readUInt32LE(0) === 0xe011cfd0) throw tagged('Legacy .xls is not supported', 'legacy_xls');
  // Every .xlsx is a ZIP, which begins with "PK".
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw tagged('Not an OOXML spreadsheet', 'unsupported');

  let entries;
  try {
    entries = readZipDirectory(buf);
  } catch (e) {
    throw (e && e.code) ? e : tagged('Could not read the workbook archive', 'corrupt');
  }

  const get = (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    try { return readEntry(buf, entry); }
    catch (e) { throw (e && e.code) ? e : tagged('Could not read a workbook part', 'corrupt'); }
  };

  const workbookXml = get('xl/workbook.xml');
  if (!workbookXml) throw tagged('Missing xl/workbook.xml', 'corrupt');

  // Theme palette (for theme/tint colors), then a color resolver bound to it.
  const themeColors = DEFAULT_THEME.slice();
  const themeXml = get('xl/theme/theme1.xml');
  if (themeXml) {
    const scheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(themeXml);
    if (scheme) {
      const order = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
      order.forEach((slot, i) => {
        const sm = new RegExp(`<a:${slot}>([\\s\\S]*?)</a:${slot}>`).exec(scheme[1]);
        if (!sm) return;
        const srgb = /<a:srgbClr\b[^>]*\bval="([0-9a-fA-F]{6})"/.exec(sm[1]);
        const sys = /<a:sysClr\b[^>]*\blastClr="([0-9a-fA-F]{6})"/.exec(sm[1]);
        if (srgb) themeColors[i] = srgb[1].toUpperCase();
        else if (sys) themeColors[i] = sys[1].toUpperCase();
      });
    }
  }
  const resolveColor = makeColorResolver(themeColors);

  // Shared strings.
  const sharedStrings = [];
  const ssXml = get('xl/sharedStrings.xml');
  if (ssXml) {
    const re = /<si>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(ssXml))) sharedStrings.push(collectText(m[1]));
  }

  // Resolved styles table.
  const xfs = parseStyles(get('xl/styles.xml'), resolveColor);

  // Relationship id -> worksheet part path.
  const relsXml = get('xl/_rels/workbook.xml.rels') || '';
  const ridToTarget = new Map();
  {
    const re = /<Relationship\b[^>]*\/?>/g; let m;
    while ((m = re.exec(relsXml))) {
      const id = attr(m[0], 'Id');
      let target = attr(m[0], 'Target');
      if (!id || !target) continue;
      target = target.replace(/^\/?xl\//, '').replace(/^\.\//, '');
      ridToTarget.set(id, target);
    }
  }

  // Ordered <sheet> list (name + r:id).
  const sheetDefs = [];
  {
    const re = /<sheet\b[^>]*\/?>/g; let m;
    while ((m = re.exec(workbookXml))) {
      sheetDefs.push({ name: decodeEntities(attr(m[0], 'name') || ''), rid: attr(m[0], 'r:id') });
    }
  }
  if (sheetDefs.length === 0) throw tagged('Workbook declares no sheets', 'empty');

  const names = sanitizeSheetNames(sheetDefs.map((s) => s.name));
  const renameMap = new Map();
  sheetDefs.forEach((def, i) => { if (def.name && def.name !== names[i]) renameMap.set(def.name, names[i]); });

  const budget = { left: MAX_TOTAL_CELLS };
  const sheets = sheetDefs.map((def, i) => {
    const target = def.rid ? ridToTarget.get(def.rid) : null;
    const xml = target ? get(`xl/${target}`) : null;
    const parsed = xml
      ? parseSheet(xml, { sharedStrings, xfs, resolveColor, budget })
      : { cells: Object.create(null), colWidths: Object.create(null), rowHeights: Object.create(null), tabColor: null, filter: null };

    // Fix up cross-sheet references for any sheets that were renamed.
    if (renameMap.size) {
      for (const k of Object.keys(parsed.cells)) {
        const cell = parsed.cells[k];
        if (cell.formula) cell.formula = rewriteSheetRefs(cell.formula, renameMap);
      }
    }
    return { name: names[i], ...parsed };
  });

  return { sheets };
}
