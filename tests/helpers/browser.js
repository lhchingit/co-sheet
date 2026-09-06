import fs from 'node:fs';

/**
 * @file browser.js
 * @description Finds a Chromium to drive, without downloading one.
 *
 * The suite depends on `playwright-core`, which is the driver ONLY — it ships no
 * browser binaries (that is the difference from `playwright`). Every machine this
 * runs on already has a Chromium-family browser: a developer's Chrome or Edge, and
 * on GitHub's ubuntu-latest image a preinstalled Google Chrome. Pointing at one
 * keeps `npm ci` small and CI free of a ~150 MB browser download per run.
 */

/** Where a Chromium-family browser lives, per platform, in preference order. */
const CANDIDATES = {
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
  win32: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
};

/**
 * The browser executable to drive, or null when this machine has none.
 *
 * CHROME_PATH wins when set: it is the escape hatch for an unusual install, and
 * GitHub's runner images set it to the preinstalled Chrome.
 * @returns {string|null}
 */
export function findBrowser() {
  const fromEnv = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const p of CANDIDATES[process.platform] || []) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Everything a pixel test needs, or a reason it cannot run. Returned rather than
 * thrown so a caller can decide between skipping and failing — a contributor on a
 * machine with no Chromium should not be blocked, but CI must not go quietly green
 * on a test that never ran (see the smoke test, which fails there instead).
 * @returns {Promise<{ chromium: any, executablePath: string } | { reason: string }>}
 */
export async function browserRuntime() {
  const executablePath = findBrowser();
  if (!executablePath) {
    return { reason: `no Chromium-family browser found for platform ${process.platform}` };
  }
  try {
    const { chromium } = await import('playwright-core');
    return { chromium, executablePath };
  } catch (err) {
    return { reason: `playwright-core is not installed (${err.message})` };
  }
}

/** True on a CI runner, where a skipped browser test must be treated as a failure. */
export const isCI = process.env.CI === 'true' || process.env.CI === '1';
