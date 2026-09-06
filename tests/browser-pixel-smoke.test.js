process.env.NODE_ENV = 'test';

/**
 * @file browser-pixel-smoke.test.js
 * @description Proves the machinery a pixel-level rendering test needs actually
 * works here: find a browser, drive it headless, screenshot a region, decode the
 * PNG, and read a known pixel back.
 *
 * The suite otherwise has no browser. Everything it asserts stops at the model
 * (values and inline-style strings, through a vm) or at stylesheet text — neither
 * of which can answer "which pixel is this line drawn on". Two border bugs shipped
 * through 468 tests because of that (#262, #264), and the regression guard written
 * for the first of them could only assert that a CSS declaration was absent.
 *
 * This file establishes the capability. It deliberately renders its own HTML rather
 * than the app, so a failure here means the tooling is broken, not the spreadsheet.
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { browserRuntime, isCI } from './helpers/browser.js';
import { decodePng, darkness } from './helpers/png.js';

// A 1px black line at a known offset inside a white box: the same shape a cell
// border is, and the same question ("which pixel?") asked of a page we control.
const PAGE = `
  <style>
    html, body { margin: 0; padding: 0; background: #fff; }
    #box { position: absolute; left: 20px; top: 20px; width: 60px; height: 40px; background: #fff; }
    #line { position: absolute; left: 50px; top: 20px; width: 0; height: 40px; border-left: 1px solid #000; }
    #grey { position: absolute; left: 70px; top: 20px; width: 0; height: 40px; border-left: 1px solid #dadce0; }
  </style>
  <div id="box"></div><div id="line"></div><div id="grey"></div>
`;

test('a pixel-level rendering check can run on this machine', async (t) => {
  // --- Arrange ---
  const runtime = await browserRuntime();
  if (runtime.reason) {
    // On a contributor's machine without Chromium this is a skip; on CI it is a
    // failure, because a browser test that silently never runs is worse than none.
    assert.ok(!isCI, `CI must be able to run browser tests: ${runtime.reason}`);
    return t.skip(runtime.reason);
  }
  console.log(`[pixel] platform=${process.platform} executable=${runtime.executablePath}`);

  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  try {
    console.log(`[pixel] browser=${browser.version()}`);
    const context = await browser.newContext({ viewport: { width: 200, height: 120 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent(PAGE);

    // --- Act ---
    const shot = await page.screenshot({ clip: { x: 0, y: 30, width: 100, height: 4 } });
    const img = decodePng(shot);

    // --- Assert ---
    assert.strictEqual(img.width, 100, 'the screenshot is the size that was asked for');
    assert.ok(img.channels === 3 || img.channels === 4, `decoded ${img.channels} channels per pixel`);

    const row = 2;
    const at = (x) => darkness(img, x, row);
    assert.ok(at(35) < 12, 'the middle of the white box reads as white');
    assert.strictEqual(at(50), 255, 'the black line is found on exactly the pixel it was placed on');
    assert.ok(at(49) < 12 && at(51) < 12, 'and does not bleed into its neighbours');

    // A #dadce0 gridline must be distinguishable from a black border, which is the
    // comparison every real border assertion rests on.
    const grey = at(70);
    assert.ok(grey > 12 && grey < 80, `the grey gridline reads as grey, not black or white (got ${grey})`);
  } finally {
    await browser.close();
  }
});
