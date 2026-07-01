// @ts-check
/**
 * @file xlsx-export.js
 * @description Self-contained, dependency-free .xlsx (Office Open XML) writer.
 * Builds a valid SpreadsheetML workbook in the browser — including cell styles
 * (fonts, fills, borders, alignment) — and packages it into a ZIP archive
 * (stored, no compression) so it can be downloaded without any third-party
 * library. Published on window.CoSheet.xlsxExport and loaded as a classic
 * <script> before app.js.
 *
 * Public API:
 *   buildXlsxBlob(sheets) -> Blob
 *     sheets: Array<{ name: string, cells: Array<Cell> }>
 *     Cell: { row, col, value, style? } where row/col are 0-based, value is the
 *     cell's displayed text/number, and style is a normalized descriptor:
 *       { bold, italic, underline, strike, fontName, fontSize, fontColor,
 *         bgColor, hAlign, vAlign, wrap,
 *         borders?: { top, right, bottom, left } each { color, style } }
 *   downloadXlsx(sheets, fileName)
 *     Builds the workbook and triggers a browser download of `${fileName}.xlsx`.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

  const enc = new TextEncoder();

  // --- XML helpers ----------------------------------------------------------

  // Escape the five XML predefined entities for use in element text / attributes.
  const xmlEscape = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  // Convert a 0-based column index to its spreadsheet letter (0 -> A, 26 -> AA).
  const colLetter = (index) => {
    let temp = index;
    let letter = '';
    while (temp >= 0) {
      letter = String.fromCharCode((temp % 26) + 65) + letter;
      temp = Math.floor(temp / 26) - 1;
    }
    return letter;
  };

  // True when a value should be written as an xlsx number cell (vs. inline text).
  const isNumeric = (v) => {
    if (typeof v === 'number') return isFinite(v);
    if (v === '' || v === null || v === undefined) return false;
    const str = String(v).trim();
    if (str === '') return false;
    const num = Number(str);
    return !isNaN(num) && isFinite(num);
  };

  // Excel worksheet names cannot exceed 31 chars or contain []:*?/\ characters.
  const sanitizeSheetName = (name, fallbackIndex) => {
    let n = String(name == null ? '' : name).replace(/[[\]:*?/\\]/g, ' ').trim();
    if (!n) n = `Sheet${fallbackIndex}`;
    return n.slice(0, 31);
  };

  // Convert a CSS color (hex / rgb()/rgba() / named) to xlsx 8-digit ARGB hex.
  // Named/other colors are resolved through the DOM when available. Returns null
  // when the color can't be parsed, so callers can skip the styling.
  const cssColorToArgb = (css) => {
    if (!css) return null;
    const s = String(css).trim();
    let m = s.match(/^#([0-9a-fA-F]{3})$/);
    if (m) return 'FF' + m[1].split('').map((c) => c + c).join('').toUpperCase();
    m = s.match(/^#([0-9a-fA-F]{6})$/);
    if (m) return 'FF' + m[1].toUpperCase();
    m = s.match(/^#([0-9a-fA-F]{8})$/);
    if (m) { const x = m[1].toUpperCase(); return x.slice(6, 8) + x.slice(0, 6); }
    m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map((x) => x.trim());
      const hx = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0').toUpperCase();
      const a = p[3] !== undefined ? Math.max(0, Math.min(255, Math.round(parseFloat(p[3]) * 255))) : 255;
      return hx(a) + hx(p[0]) + hx(p[1]) + hx(p[2]);
    }
    if (typeof document !== 'undefined' && document.body) {
      try {
        const el = document.createElement('div');
        el.style.color = s;
        document.body.appendChild(el);
        const resolved = getComputedStyle(el).color;
        document.body.removeChild(el);
        if (resolved && resolved !== s) return cssColorToArgb(resolved);
      } catch (e) { /* fall through */ }
    }
    return null;
  };

  // --- Style book: dedupes fonts/fills/borders and assigns cellXfs indices ----

  const createStyleBook = () => {
    // Index 0 in fonts/borders and indices 0,1 in fills are the reserved
    // defaults the OOXML spec expects; custom entries are appended after them.
    const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
    const fills = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
    ];
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const xfCache = new Map();
    const partCache = new Map(); // xml string -> index, per part array

    const intern = (arr, xml) => {
      const k = arr === fonts ? 'f' : arr === fills ? 'l' : 'b';
      const key = k + xml;
      if (partCache.has(key)) return partCache.get(key);
      const idx = arr.length;
      arr.push(xml);
      partCache.set(key, idx);
      return idx;
    };

    const BORDER_MAP = { thin: 'thin', medium: 'medium', thick: 'thick', dashed: 'dashed', dotted: 'dotted', double: 'double' };

    const fontXml = (st) => {
      let s = '';
      if (st.bold) s += '<b/>';
      if (st.italic) s += '<i/>';
      if (st.underline) s += '<u/>';
      if (st.strike) s += '<strike/>';
      s += `<sz val="${Number(st.fontSize) || 11}"/>`;
      if (st.fontColor) { const a = cssColorToArgb(st.fontColor); if (a) s += `<color rgb="${a}"/>`; }
      s += `<name val="${xmlEscape(st.fontName || 'Calibri')}"/>`;
      return `<font>${s}</font>`;
    };
    const needsFont = (st) => !!(st.bold || st.italic || st.underline || st.strike || st.fontSize || st.fontColor || st.fontName);

    const fillXml = (st) => {
      if (!st.bgColor) return null;
      const a = cssColorToArgb(st.bgColor);
      if (!a) return null;
      return `<fill><patternFill patternType="solid"><fgColor rgb="${a}"/><bgColor indexed="64"/></patternFill></fill>`;
    };

    const sideXml = (tag, side) => {
      if (!side) return `<${tag}/>`;
      const style = BORDER_MAP[side.style] || 'thin';
      const a = cssColorToArgb(side.color) || 'FF000000';
      return `<${tag} style="${style}"><color rgb="${a}"/></${tag}>`;
    };
    const borderXml = (b) => {
      if (!b || (!b.top && !b.right && !b.bottom && !b.left)) return null;
      return `<border>${sideXml('left', b.left)}${sideXml('right', b.right)}${sideXml('top', b.top)}${sideXml('bottom', b.bottom)}<diagonal/></border>`;
    };

    const alignXml = (st) => {
      const attrs = [];
      if (st.hAlign) attrs.push(`horizontal="${st.hAlign}"`);
      if (st.vAlign) attrs.push(`vertical="${st.vAlign}"`);
      if (st.wrap) attrs.push('wrapText="1"');
      return attrs.length ? `<alignment ${attrs.join(' ')}/>` : '';
    };

    // Resolve a normalized style descriptor to a cellXfs index (0 = default).
    const getXfIndex = (st) => {
      if (!st) return 0;
      const key = JSON.stringify(st);
      if (xfCache.has(key)) return xfCache.get(key);

      const fontId = needsFont(st) ? intern(fonts, fontXml(st)) : 0;
      const fXml = fillXml(st);
      const fillId = fXml ? intern(fills, fXml) : 0;
      const bXml = borderXml(st.borders);
      const borderId = bXml ? intern(borders, bXml) : 0;
      const align = alignXml(st);

      const attrs = ['numFmtId="0"', `fontId="${fontId}"`, `fillId="${fillId}"`, `borderId="${borderId}"`, 'xfId="0"'];
      if (fontId) attrs.push('applyFont="1"');
      if (fillId) attrs.push('applyFill="1"');
      if (borderId) attrs.push('applyBorder="1"');
      if (align) attrs.push('applyAlignment="1"');

      const xf = align ? `<xf ${attrs.join(' ')}>${align}</xf>` : `<xf ${attrs.join(' ')}/>`;
      const idx = xfs.length;
      xfs.push(xf);
      xfCache.set(key, idx);
      return idx;
    };

    const buildStylesXml = () =>
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
      `<fills count="${fills.length}">${fills.join('')}</fills>` +
      `<borders count="${borders.length}">${borders.join('')}</borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`;

    return { getXfIndex, buildStylesXml };
  };

  // --- Worksheet XML --------------------------------------------------------

  // Render one worksheet's <sheetData>. A cell is emitted when it has a value or
  // a non-default style (so e.g. an empty filled/bordered cell still shows).
  const buildSheetXml = (cells, styleBook) => {
    const rows = new Map();
    let maxRow = 0;
    let maxCol = 0;
    for (const cell of cells) {
      if (cell.row < 0 || cell.col < 0) continue;
      const hasVal = !(cell.value === '' || cell.value === null || cell.value === undefined);
      const s = styleBook.getXfIndex(cell.style);
      if (!hasVal && !s) continue;
      if (!rows.has(cell.row)) rows.set(cell.row, []);
      rows.get(cell.row).push({ row: cell.row, col: cell.col, value: cell.value, hasVal, s });
      if (cell.row > maxRow) maxRow = cell.row;
      if (cell.col > maxCol) maxCol = cell.col;
    }

    let body = '';
    const sortedRows = [...rows.keys()].sort((a, b) => a - b);
    for (const r of sortedRows) {
      const rowCells = rows.get(r).sort((a, b) => a.col - b.col);
      let rowXml = '';
      for (const cell of rowCells) {
        const ref = `${colLetter(cell.col)}${r + 1}`;
        const sAttr = cell.s ? ` s="${cell.s}"` : '';
        if (!cell.hasVal) {
          rowXml += `<c r="${ref}"${sAttr}/>`;
        } else if (isNumeric(cell.value)) {
          rowXml += `<c r="${ref}"${sAttr}><v>${Number(cell.value)}</v></c>`;
        } else {
          rowXml += `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.value)}</t></is></c>`;
        }
      }
      body += `<row r="${r + 1}">${rowXml}</row>`;
    }

    const dimension = `A1:${colLetter(maxCol)}${maxRow + 1}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<dimension ref="${dimension}"/>` +
      `<sheetData>${body}</sheetData>` +
      `</worksheet>`;
  };

  // --- Package (container) XML ----------------------------------------------

  const buildContentTypes = (count) => {
    let overrides = '';
    for (let i = 1; i <= count; i++) {
      overrides += `<Override PartName="/xl/worksheets/sheet${i}.xml" ` +
        `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      overrides +
      `</Types>`;
  };

  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const buildWorkbookXml = (names) => {
    let sheetTags = '';
    names.forEach((name, i) => {
      sheetTags += `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${sheetTags}</sheets>` +
      `</workbook>`;
  };

  // Worksheets take rId1..count; the shared styles part takes the next id.
  const buildWorkbookRels = (count) => {
    let rels = '';
    for (let i = 1; i <= count; i++) {
      rels += `<Relationship Id="rId${i}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
        `Target="worksheets/sheet${i}.xml"/>`;
    }
    rels += `<Relationship Id="rId${count + 1}" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ` +
      `Target="styles.xml"/>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      rels +
      `</Relationships>`;
  };

  // --- Minimal ZIP writer (store / no compression) --------------------------

  // Precomputed CRC-32 lookup table (IEEE 802.3 polynomial).
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  const crc32 = (bytes) => {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };

  // Concatenate an array of Uint8Arrays into one.
  const concat = (arrays) => {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const a of arrays) { out.set(a, pos); pos += a.length; }
    return out;
  };

  // Build a ZIP archive (Uint8Array) from { name, bytes } entries, stored
  // uncompressed. Sufficient and spec-valid for .xlsx packages.
  const buildZip = (files) => {
    const chunks = [];
    const central = [];
    let offset = 0;

    const u16 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
    const u32 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
    const push = (arr, ...parts) => parts.forEach((p) => arr.push(p));

    for (const file of files) {
      const nameBytes = enc.encode(file.name);
      const data = file.bytes;
      const crc = crc32(data);
      const size = data.length;

      // Local file header (general-purpose flag 0x0800 marks UTF-8 names).
      const local = [];
      push(local, u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes, data);
      const localBytes = concat(local);
      chunks.push(localBytes);

      // Matching central directory record.
      const cd = [];
      push(cd, u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0),
        u16(0), u32(0), u32(offset), nameBytes);
      central.push(concat(cd));

      offset += localBytes.length;
    }

    const centralBytes = concat(central);
    const end = [];
    push(end, u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralBytes.length), u32(offset), u16(0));

    return concat([...chunks, centralBytes, concat(end)]);
  };

  // --- Public API -----------------------------------------------------------

  /**
   * Assemble a complete .xlsx workbook Blob from the given sheets.
   * @param {Array<{name: string, cells: Array<{row:number,col:number,value:any,style?:any}>}>} sheets
   * @returns {Blob}
   */
  const buildXlsxBlob = (sheets) => {
    const list = (Array.isArray(sheets) && sheets.length) ? sheets : [{ name: 'Sheet1', cells: [] }];
    const names = list.map((s, i) => sanitizeSheetName(s.name, i + 1));

    // Build sheet XML first so the style book is fully populated before styles.xml.
    const styleBook = createStyleBook();
    const sheetXmls = list.map((s) => buildSheetXml(s.cells || [], styleBook));

    const files = [
      { name: '[Content_Types].xml', bytes: enc.encode(buildContentTypes(list.length)) },
      { name: '_rels/.rels', bytes: enc.encode(ROOT_RELS) },
      { name: 'xl/workbook.xml', bytes: enc.encode(buildWorkbookXml(names)) },
      { name: 'xl/_rels/workbook.xml.rels', bytes: enc.encode(buildWorkbookRels(list.length)) },
      { name: 'xl/styles.xml', bytes: enc.encode(styleBook.buildStylesXml()) },
    ];
    sheetXmls.forEach((xml, i) => {
      files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, bytes: enc.encode(xml) });
    });

    const zip = buildZip(files);
    return new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  };

  /**
   * Build the workbook and trigger a browser download.
   * @param {Array} sheets - See buildXlsxBlob.
   * @param {string} fileName - Base name (without extension) for the download.
   */
  const downloadXlsx = (sheets, fileName) => {
    const blob = buildXlsxBlob(sheets);
    // Strip characters that are invalid in file names across platforms.
    const safe = String(fileName || 'spreadsheet').replace(/[\\/:*?"<>|]/g, '_').trim() || 'spreadsheet';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safe}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revoke so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Resolve a cell's border for one side from the app's style model: a legacy
  // boolean `border` means a thin grey box on every side; otherwise the structured
  // per-side `borders` map wins. Mirrors app.js's cellBorderSide.
  const borderSide = (style, side) => {
    if (!style) return null;
    if (style.border && !style.borders) return { color: '#717686', style: 'thin' };
    return style.borders ? (style.borders[side] || null) : null;
  };

  /**
   * Convert a co-sheet cell style object into the flat descriptor buildXlsxBlob
   * understands (fonts, fill, font color, alignment, borders). `style.color` is the
   * cell's background fill and `style.textColor` is the font color in this model.
   * Returns null when there's nothing worth exporting. Shared by the editor's
   * Download and the drive page's per-file download so the two never drift.
   * @param {Object} [style]
   * @returns {Object|null}
   */
  const normalizeAppStyle = (style) => {
    if (!style) return null;
    const out = {};
    if (style.bold) out.bold = true;
    if (style.italic) out.italic = true;
    if (style.underline) out.underline = true;
    if (style.strikethrough) out.strike = true;
    if (style.fontFamily) out.fontName = style.fontFamily;
    if (style.fontSize) out.fontSize = style.fontSize;
    if (style.textColor) out.fontColor = style.textColor;
    if (style.color) out.bgColor = style.color;
    if (style.align) out.hAlign = style.align;
    if (style.verticalAlign) out.vAlign = style.verticalAlign;
    if (style.textWrap === 'wrap') out.wrap = true;
    const borders = {};
    let hasBorder = false;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const spec = borderSide(style, side);
      if (spec) { borders[side] = { color: spec.color, style: spec.style }; hasBorder = true; }
    }
    if (hasBorder) out.borders = borders;
    return Object.keys(out).length ? out : null;
  };

  root.CoSheet.xlsxExport = { buildXlsxBlob, downloadXlsx, normalizeAppStyle };
})();
