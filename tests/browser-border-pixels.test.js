process.env.NODE_ENV = 'test';

/**
 * @file browser-border-pixels.test.js
 * @description Where a cell border is actually PAINTED, read off the screen.
 *
 * A border is meant to replace the gray gridline on its boundary, so it must land
 * on the pixel the gridline occupied. Twice it did not, and the suite could not
 * tell: #262 (the anchor's box model was being changed, pushing its border a pixel
 * further out than every other cell's) and #264 (a line centred on the boundary
 * spans [b - w/2, b + w/2], which for an odd width is not pixel-aligned and
 * resolved outward, while the gridline — a real CSS border inside the border box —
 * resolves inward, so every border sat one pixel right/below its own gridline).
 *
 * Both were found by a person looking at the screen. Everything the rest of the
 * suite can assert — model values, inline-style strings, stylesheet text — was
 * satisfied throughout.
 *
 * The assertions here compare a border against the GRIDLINE measured in the same
 * run, never against a hard-coded pixel index, so they state the invariant ("a
 * border replaces its gridline") rather than today's rounding, and do not become a
 * chore when Chromium changes how it resolves a half pixel.
 *
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';
import { waitForServer } from './helpers/wait-for-server.js';
import { browserRuntime, isCI } from './helpers/browser.js';
import { decodePng, darkness } from './helpers/png.js';

const PORT = '31452';

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

/** Anything at least this dark is ink rather than the white background. */
const INK = 12;
/**
 * Anything at least this dark is a black border. Set above the anchor's blue
 * selection frame (#1a73e8 reads ~153) as well as the gray gridline (~35): the
 * frame sits on the same pixels a border does, and counting it as border ink is
 * exactly how a first draft of this test passed with #262 reintroduced.
 */
const BORDER_INK = 200;

/**
 * The pixels drawn near one boundary of a cell, as offsets from that boundary
 * (0 = the pixel starting at the boundary, -1 = the one before it).
 * @returns {Promise<Array<{ at: number, dark: number }>>}
 */
async function inkAt(page, cellId, side) {
  const box = await page.locator(`[data-cell-id="${cellId}"]`).boundingBox();
  assert.ok(box, `cell ${cellId} must be rendered`);
  const g = { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };

  const PAD = 8;
  const vertical = side === 'left' || side === 'right';
  const boundary = g[side];
  // A thin strip across the boundary, sampled through the middle of the cell so it
  // never clips a corner where two edges meet.
  const clip = vertical
    ? { x: boundary - PAD, y: (g.top + g.bottom) / 2 - 2, width: PAD * 2, height: 4 }
    : { x: (g.left + g.right) / 2 - 2, y: boundary - PAD, width: 4, height: PAD * 2 };
  const img = decodePng(await page.screenshot({ clip }));

  const n = vertical ? img.width : img.height;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = vertical
      ? darkness(img, i, Math.floor(img.height / 2))
      : darkness(img, Math.floor(img.width / 2), i);
    if (d >= INK) out.push({ at: i - PAD, dark: d });
  }
  return out;
}

const SIDES = ['left', 'top', 'right', 'bottom'];

test('a cell border is painted on the pixel its gridline occupied', async (t) => {
  // --- Arrange ---
  const runtime = await browserRuntime();
  if (runtime.reason) {
    assert.ok(!isCI, `CI must be able to run browser tests: ${runtime.reason}`);
    return t.skip(runtime.reason);
  }

  const db = await createTestDb('border-pixels');
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url }
  });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      // Device pixels must be CSS pixels, or "which pixel" has no single answer.
      deviceScaleFactor: 1
    });
    // One login, shared: context.request uses the browser context's cookie jar, so
    // the page is signed in as the same user that creates the file.
    const login = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Pixel' });
    const cookie = [].concat(login.headers['set-cookie'])[0];
    await context.addCookies([{
      name: cookie.split('=')[0],
      value: cookie.split('=')[1].split(';')[0],
      domain: 'localhost', path: '/'
    }]);
    // A file of this test's own: the suite shares one realtime bus, so edits to the
    // common 'default' workbook arrive here from other test files.
    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'Pixels' }, { Cookie: cookie });
    assert.strictEqual(created.statusCode, 200);

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${PORT}/sheet?file=${created.data.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-cell-id="A1"]', { timeout: 30000 });
    await page.waitForTimeout(500);

    const border = async (cellId, style) => {
      await page.evaluate((s) => window.CoSheet.app.setBorderStyle(s), style);
      await page.click(`[data-cell-id="${cellId}"]`);
      await page.waitForTimeout(120);
      await page.evaluate(() => window.CoSheet.app.applyBordersToSelection('outer'));
      await page.waitForTimeout(300);
    };
    const deselect = async () => { await page.click('[data-cell-id="A1"]'); await page.waitForTimeout(300); };

    // --- Act & Assert: the reference. Where does an untouched cell's gridline sit? ---
    const plain = await inkAt(page, 'F9', 'right');
    assert.strictEqual(plain.length, 1, 'an unbordered cell shows exactly one gridline pixel');
    const GRIDLINE = plain[0].at;
    assert.ok(plain[0].dark < BORDER_INK, `the gridline is light gray, not ink (got ${plain[0].dark})`);
    for (const side of SIDES) {
      const ink = await inkAt(page, 'F9', side);
      assert.deepStrictEqual(ink.map((p) => p.at), [GRIDLINE],
        `an unbordered cell's ${side} gridline sits where every other one does`);
    }

    // --- Act & Assert: a thin border replaces that gridline, on the same pixel ---
    await border('C5', 'thin');
    await deselect();
    for (const side of SIDES) {
      const ink = await inkAt(page, 'C5', side);
      assert.deepStrictEqual(ink.map((p) => p.at), [GRIDLINE],
        `a thin border's ${side} side lands on the gridline's own pixel, not beside it (#264)`);
      assert.ok(ink[0].dark >= BORDER_INK, `and is drawn as ink (got ${ink[0].dark})`);
    }

    // --- Act & Assert: selecting a cell does not move its border (#262) ---
    // The 2px blue frame covers the border on two of the four sides, so this cannot
    // demand black on every side. What it can demand is that wherever black IS
    // visible, it is still on the gridline's pixel — which is what stops being true
    // when the anchor's box model is changed and its border shifts a pixel out.
    await page.click('[data-cell-id="C5"]');
    await page.waitForTimeout(300);
    let sidesWithBlack = 0;
    for (const side of SIDES) {
      const ink = await inkAt(page, 'C5', side);
      const black = ink.filter((p) => p.dark >= BORDER_INK).map((p) => p.at);
      sidesWithBlack += black.length ? 1 : 0;
      assert.deepStrictEqual(black.filter((at) => at !== GRIDLINE), [],
        `selecting a cell must not move its ${side} border off the gridline pixel (#262); `
        + `ink at ${JSON.stringify(ink)}`);
    }
    assert.ok(sidesWithBlack > 0, 'the selected cell must still show its border somewhere');
    await deselect();

    // --- Act & Assert: a thick border grows around the gridline's pixel ---
    // An odd width cannot be symmetric about a boundary that falls between pixels,
    // so the rule is the same one as for thin: the gridline's pixel is covered, and
    // the extra width spreads either side of it.
    await border('C15', 'thick');
    await deselect();
    for (const side of SIDES) {
      const offsets = (await inkAt(page, 'C15', side)).map((p) => p.at);
      assert.deepStrictEqual(offsets, [GRIDLINE - 1, GRIDLINE, GRIDLINE + 1],
        `a thick border's ${side} side is a contiguous run centred on the gridline's pixel`);
    }

    // --- Act & Assert: two bordered neighbours draw ONE line on the boundary ---
    // Both cells paint their own copy of the shared edge; they must coincide, or a
    // 1px border reads as 2px (which is what an "inward" shift would have caused).
    await border('E5', 'thin');
    await border('F5', 'thin');
    await deselect();
    const shared = await inkAt(page, 'E5', 'right');
    assert.deepStrictEqual(shared.map((p) => p.at), [GRIDLINE],
      `the boundary between two bordered cells is one pixel, not two; ink at ${JSON.stringify(shared)}`);

    assert.deepStrictEqual(errors, [], 'no page errors while painting borders');
  } finally {
    await browser.close();
    child.kill();
    await db.cleanup();
  }
});
