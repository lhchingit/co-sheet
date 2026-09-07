process.env.NODE_ENV = 'test';

/**
 * @file browser-wrapped-window.test.js
 * @description A wrapped cell must no longer cost the sheet its windowing (#278).
 *
 * One cell with textWrap 'wrap' used to turn windowing off for the entire sheet,
 * because a wrapped row's height could not be modelled and windowing needs a height
 * for rows it has not rendered. Measured on a 4,000-row import, that was 104,000
 * cells in the DOM instead of 1,482 — the cause of a 2.4 GB tab in production.
 *
 * The line count is now measured with canvas text metrics, so the height is modelled
 * like any other. Two things have to hold, and only a real browser can answer either:
 *
 *  1. the sheet stays windowed with a wrapped cell on it;
 *  2. the modelled height MATCHES what the browser lays out — a track sized from a
 *     wrong model would put every row below the wrapped one at the wrong offset,
 *     which is a worse bug than the memory it saves.
 *
 * (2) is the assertion that matters, and it is checked the only way that cannot
 * fool itself: against the next row's actual position on screen. Follows the AAA
 * pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';
import { waitForServer } from './helpers/wait-for-server.js';
import { browserRuntime, isCI } from './helpers/browser.js';

const PORT = '31540';
const ROWS = 600;
const COLS = 8;
const DEFAULT_ROW_HEIGHT = 21;
/** Long enough to wrap onto several lines in a default 100px column. */
const LONG = 'the quick brown fox jumps over the lazy dog and keeps running past the edge';

function makeRequest(url, method, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(data), headers: res.headers }); }
        catch (e) { resolve({ statusCode: res.statusCode, data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const letters = [];
for (let c = 0; c < COLS; c++) letters.push(String.fromCharCode(65 + c));

/** A plain-text sheet, optionally with one long wrapped cell at B2. */
function buildSheet(withWrap) {
  const cells = {};
  for (let r = 1; r <= ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      cells[`${letters[c]}${r}`] = { formula: '', value: `r${r}c${c}`, style: {} };
    }
  }
  if (withWrap) cells.B2 = { formula: '', value: LONG, style: { textWrap: 'wrap' } };
  return cells;
}

test('a wrapped cell keeps its row honest without costing the sheet its windowing', async (t) => {
  // --- Arrange ---
  const runtime = await browserRuntime();
  if (runtime.reason) {
    assert.ok(!isCI, `CI must be able to run browser tests: ${runtime.reason}`);
    return t.skip(runtime.reason);
  }

  const db = await createTestDb('wrapped-window');
  const child = spawn('node', ['server.js'], {
    // The probe user owns several files; the default quota is one.
    env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url, SUPER_ADMIN_EMAILS: 'Wrap' }
  });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    const login = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Wrap' });
    const cookie = [].concat(login.headers['set-cookie'])[0];
    await context.addCookies([{
      name: cookie.split('=')[0], value: cookie.split('=')[1].split(';')[0], domain: 'localhost', path: '/'
    }]);

    /**
     * Seeded straight into the database rather than through POST /api/files: that
     * route inserts an empty workbook and caches it in the server's memory, so a
     * later UPDATE of the row would be invisible until the cache evicted.
     */
    const open = async (id, withWrap) => {
      await db.seedFile(id, `wrap-${withWrap}`, 'Wrap');
      await db.seedWorkbookState(id, {
        sheets: { Sheet1: buildSheet(withWrap) },
        sheetOrder: ['Sheet1'], sheetColors: {}, hiddenSheets: [],
        rowCounts: { Sheet1: ROWS }, colCounts: { Sheet1: COLS }
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://localhost:${PORT}/sheet?file=${id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-cell-id="A1"]', { timeout: 60000 });
      await page.waitForTimeout(1500);
      return { page, errors };
    };

    const plain = await open('aaaa0123456789abcdef0123', false);
    const wrapped = await open('bbbb0123456789abcdef0123', true);

    // --- Act ---
    const measure = (p) => p.evaluate(() => {
      const rect = (id) => {
        const el = document.querySelector(`[data-cell-id="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height };
      };
      // Distinct ROWS rendered, not cells: the grid always renders at least the
      // default 26 columns, so a cell count says as much about the column floor as
      // about windowing. Rows are what windowing actually bounds.
      const rows = new Set();
      for (const el of document.querySelectorAll('[data-cell-id]')) {
        const m = /\d+$/.exec(el.getAttribute('data-cell-id'));
        if (m) rows.add(m[0]);
      }
      return {
        renderedCells: document.querySelectorAll('[data-cell-id]').length,
        renderedRows: rows.size,
        b2: rect('B2'),
        b3: rect('B3'),
        a2: rect('A2')
      };
    });
    const before = await measure(plain.page);
    const after = await measure(wrapped.page);

    // --- Assert 1: the wrapped sheet is still windowed. ---
    assert.ok(
      after.renderedRows < ROWS / 4,
      `a wrapped cell must not put every row in the DOM (rendered ${after.renderedRows} of ${ROWS})`
    );
    // And it costs no more than the same sheet without the wrap: both render one
    // window. A regression here reads as "windowing quietly turned off again".
    assert.ok(
      after.renderedRows <= before.renderedRows + 2,
      `wrapped ${after.renderedRows} vs plain ${before.renderedRows} rendered rows`
    );

    // --- Assert 2: the row actually grew, so this is a real wrap, not a no-op. ---
    assert.ok(after.b2, 'B2 is rendered');
    assert.ok(
      after.b2.height > DEFAULT_ROW_HEIGHT * 1.5,
      `the wrapped cell should be several lines tall, got ${after.b2.height}px`
    );
    assert.strictEqual(
      Math.round(before.b2.height), DEFAULT_ROW_HEIGHT,
      'the same cell without the wrap style is one default row'
    );

    // --- Assert 3: the model agrees with the layout. ---
    // The whole risk of modelling a height instead of rendering for it is drift: if
    // the track were sized from a wrong number, the next row would not start where
    // this one ends. Its own row-mate must agree too, or the row itself is ragged.
    assert.ok(after.b3, 'B3 is rendered');
    assert.ok(
      Math.abs(after.b3.top - after.b2.bottom) <= 1,
      `the row below a wrapped row must start where it ends (B2 bottom ${after.b2.bottom}, B3 top ${after.b3.top})`
    );
    assert.ok(
      Math.abs(after.a2.height - after.b2.height) <= 1,
      `every cell in the wrapped row shares its height (A2 ${after.a2.height}, B2 ${after.b2.height})`
    );

    assert.deepStrictEqual(wrapped.errors, [], 'no page errors');
    assert.deepStrictEqual(plain.errors, [], 'no page errors');
  } finally {
    await browser.close();
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    await db.cleanup();
  }
});
