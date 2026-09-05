/**
 * @file xlsx-import-rows.test.js
 * @description The importer used to carry its own `MAX_ROW = 1000`, written when
 * the grid was exactly that tall, so every row past it was dropped (#230). The grid
 * has held up to MAX_ROWS since #228, and rows — unlike columns, which getColCount
 * raises itself to — have no data-derived floor, so an import that reaches past the
 * default must also record how far it got or those rows never render.
 *
 * The fixtures are real .xlsx files built here: an .xlsx is a ZIP of XML parts, and
 * the reader accepts stored (uncompressed) entries, so a few dozen lines of ZIP
 * writing exercise the actual parser rather than a stand-in. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { parseXlsx } from '../services/xlsx-import.js';
import { DEFAULT_ROWS, MAX_ROWS, MAX_COLS } from '../services/dimension-service.js';
import { createTestDb } from './helpers/db.js';
import { waitForServer } from './helpers/wait-for-server.js';

/**
 * Packs named parts into a ZIP using stored (method 0) entries.
 * @param {Array<{name: string, data: string}>} parts
 * @returns {Buffer}
 */
function zip(parts) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of parts) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.from(data, 'utf8');

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // local file header signature
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0, 8);            // method: stored
    lfh.writeUInt32LE(0, 14);           // crc-32 (unchecked by the reader)
    lfh.writeUInt32LE(body.length, 18); // compressed size
    lfh.writeUInt32LE(body.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);   // central directory header signature
    cdh.writeUInt16LE(20, 6);           // version needed
    cdh.writeUInt16LE(0, 10);           // method: stored
    cdh.writeUInt32LE(body.length, 20); // compressed size
    cdh.writeUInt32LE(body.length, 24); // uncompressed size
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);      // offset of the local header
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);        // end of central directory signature
  eocd.writeUInt16LE(parts.length, 8);      // entries on this disk
  eocd.writeUInt16LE(parts.length, 10);     // entries total
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);           // offset of the central directory
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/**
 * A one-sheet workbook holding `cells` ({ 'A1': '5', … }), plus optional raw row
 * XML for the cases that need attributes (a custom height) or a merge.
 * @param {Record<string, string>} cells
 * @param {{ merges?: string[], rowAttrs?: Record<number, string> }} [extra]
 * @returns {Buffer}
 */
function workbookWith(cells, extra = {}) {
  const byRow = new Map();
  for (const [ref, value] of Object.entries(cells)) {
    const row = Number(/\d+/.exec(ref)[0]);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(`<c r="${ref}"><v>${value}</v></c>`);
  }
  for (const row of Object.keys(extra.rowAttrs || {}).map(Number)) {
    if (!byRow.has(row)) byRow.set(row, []);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b)
    .map((r) => `<row r="${r}" ${(extra.rowAttrs || {})[r] || ''}>${byRow.get(r).join('')}</row>`)
    .join('');
  const merges = (extra.merges || []).length
    ? `<mergeCells count="${extra.merges.length}">${extra.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    : '';

  return zip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${rows}</sheetData>${merges}</worksheet>` },
  ]);
}

/** The highest row number any of a parsed sheet's cells sits on. */
const maxRowOf = (sheet) => Object.keys(sheet.cells)
  .reduce((hi, ref) => Math.max(hi, Number(/\d+/.exec(ref)[0])), 0);

test('a row past the old 1000-row cap is imported, not dropped', () => {
  // --- Arrange ---
  const buf = workbookWith({ A1: '1', [`A${DEFAULT_ROWS}`]: '2', [`A${DEFAULT_ROWS + 1}`]: '3', A5000: '4' });

  // --- Act ---
  const { sheets } = parseXlsx(buf);

  // --- Assert ---
  assert.strictEqual(sheets.length, 1);
  const cells = sheets[0].cells;
  assert.strictEqual(cells[`A${DEFAULT_ROWS}`].value, '2', 'the default grid\'s last row still imports');
  assert.strictEqual(cells[`A${DEFAULT_ROWS + 1}`].value, '3', 'and so does the row after it');
  assert.strictEqual(cells.A5000.value, '4', 'and one far below, which used to be dropped');
});

test('a row past the grid\'s ceiling is still dropped', () => {
  // --- Arrange ---
  const buf = workbookWith({ [`A${MAX_ROWS}`]: 'in', [`A${MAX_ROWS + 1}`]: 'out' });

  // --- Act ---
  const { cells } = parseXlsx(buf).sheets[0];

  // --- Assert: the ceiling moved, it did not go away ---
  assert.ok(cells[`A${MAX_ROWS}`], 'the ceiling row itself is addressable');
  assert.strictEqual(cells[`A${MAX_ROWS + 1}`], undefined, 'one row past it is not');
});

test('a custom row height past the old cap comes through, and one past the ceiling does not', () => {
  // --- Arrange ---
  const buf = workbookWith({ A1: '1' }, {
    rowAttrs: {
      [DEFAULT_ROWS + 500]: 'customHeight="1" ht="30"',
      [MAX_ROWS + 1]: 'customHeight="1" ht="30"',
    },
  });

  // --- Act ---
  const { rowHeights } = parseXlsx(buf).sheets[0];

  // --- Assert ---
  assert.ok(rowHeights[String(DEFAULT_ROWS + 500)] > 0, 'a height below the ceiling is kept');
  assert.strictEqual(rowHeights[String(MAX_ROWS + 1)], undefined, 'one past it is not');
});

test('a merge anchored past the old cap survives the import', () => {
  // --- Arrange ---
  const anchor = `B${DEFAULT_ROWS + 200}`;
  const buf = workbookWith({ A1: '1' }, { merges: [`${anchor}:C${DEFAULT_ROWS + 201}`] });

  // --- Act ---
  const { cells } = parseXlsx(buf).sheets[0];

  // --- Assert ---
  assert.deepStrictEqual(cells[anchor] && cells[anchor].style.merge, { rows: 2, cols: 2 },
    'the anchor keeps its span');
});

test('the importer holds no bounds of its own', () => {
  // --- Arrange: the ceilings live in dimension-service; the importer used to keep
  //     a second copy, which is how it fell a grid-size behind ---
  const overCol = `${'A'.repeat(3)}1`;   // 'AAA1' — past the A–ZZ range

  // --- Act ---
  const wide = parseXlsx(workbookWith({ A1: '1', [overCol]: '2' })).sheets[0];
  const tall = parseXlsx(workbookWith({ A1: '1', [`A${MAX_ROWS}`]: '2' })).sheets[0];

  // --- Assert ---
  assert.strictEqual(wide.cells[overCol], undefined, `a column past ${MAX_COLS} is dropped`);
  assert.strictEqual(maxRowOf(tall), MAX_ROWS, 'and the row ceiling is the grid\'s, not a local copy');
});

/**
 * POSTs `body` and resolves with the status, headers and parsed JSON. Kept local
 * rather than shared so this file can send raw bytes, which the import route takes
 * as the request body.
 */
function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch { /* leave as text */ }
          resolve({ statusCode: res.statusCode, headers: res.headers, data: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('an imported sheet records how far down it reaches, so those rows render', async () => {
  // --- Arrange ---
  const db = await createTestDb('importrows');
  const port = '31288';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: port, NODE_ENV: 'test', DATABASE_URL: db.url }
  });
  await waitForServer(port);

  try {
    const login = await post(`http://localhost:${port}/auth/test-login`, JSON.stringify({ username: 'Importer' }),
      { 'Content-Type': 'application/json' });
    const cookie = [].concat(login.headers['set-cookie'])[0];

    // --- Act: a sheet reaching well past the default row count ---
    const deepRow = DEFAULT_ROWS + 1500;
    const res = await post(
      `http://localhost:${port}/api/files/import?name=deep`,
      workbookWith({ A1: '1', [`B${deepRow}`]: '2' }),
      { 'Content-Type': 'application/octet-stream', Cookie: cookie }
    );

    // --- Assert ---
    assert.strictEqual(res.statusCode, 200, `import failed: ${JSON.stringify(res.data)}`);
    const state = await db.getWorkbookState(res.data.id);
    assert.strictEqual(state.sheets.Data[`B${deepRow}`].value, '2', 'the deep cell is stored');
    assert.strictEqual(state.rowCounts.Data, deepRow,
      'and the sheet carries a row count that reaches it — without this the cell exists but never renders');
  } finally {
    child.kill();
    await db.cleanup();
  }
});

test('an import that stays within the default carries no row count', async () => {
  // --- Arrange ---
  const db = await createTestDb('importrows2');
  const port = '31289';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: port, NODE_ENV: 'test', DATABASE_URL: db.url }
  });
  await waitForServer(port);

  try {
    const login = await post(`http://localhost:${port}/auth/test-login`, JSON.stringify({ username: 'Importer' }),
      { 'Content-Type': 'application/json' });
    const cookie = [].concat(login.headers['set-cookie'])[0];

    // --- Act ---
    const res = await post(
      `http://localhost:${port}/api/files/import?name=shallow`,
      workbookWith({ A1: '1', [`A${DEFAULT_ROWS}`]: '2' }),
      { 'Content-Type': 'application/octet-stream', Cookie: cookie }
    );

    // --- Assert: the default needs no entry, matching setRowCount's own bookkeeping ---
    assert.strictEqual(res.statusCode, 200, `import failed: ${JSON.stringify(res.data)}`);
    const state = await db.getWorkbookState(res.data.id);
    assert.strictEqual(state.sheets.Data[`A${DEFAULT_ROWS}`].value, '2', 'the last default row is stored');
    assert.deepStrictEqual(state.rowCounts, {}, 'and nothing is written for a sheet that fits');
  } finally {
    child.kill();
    await db.cleanup();
  }
});
