/**
 * @file font-size-menu-check.test.js
 * @description Covers updateFontSizeMenuChecks, which places a check mark beside
 * the active cell's font size in the Format ▸ Font size menu (falling back to the
 * default size of 10 when no explicit size is set, and checking nothing when a
 * custom size matches no preset). We run the real client bundle in a VM sandbox
 * with a minimal DOM mock exposing the preset buttons, each holding a
 * `.fmt-size-check` element whose `invisible` class we inspect.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];
const DEFAULT_SIZE = 10;

function makeCheck() {
  const classes = new Set(['invisible']);
  return {
    classList: {
      toggle(cls, force) {
        const on = force === undefined ? !classes.has(cls) : force;
        if (on) classes.add(cls); else classes.delete(cls);
        return classes.has(cls);
      },
      contains: (cls) => classes.has(cls),
    },
  };
}

function createSandbox() {
  const checks = {};
  const buttons = SIZES.map((sz) => {
    const check = makeCheck();
    checks[sz] = check;
    return {
      getAttribute: (name) => (name === 'data-size' ? String(sz) : null),
      querySelector: (sel) => (sel === '.fmt-size-check' ? check : null),
    };
  });
  const list = {
    querySelectorAll: (sel) => (sel === '[data-size]' ? buttons : []),
  };
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => (id === 'fmt-fontsize-list' ? list : null),
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { classList: { add() {}, remove() {} } },
    },
    WebSocket: class { constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    setTimeout: () => 0, clearTimeout: () => {}, queueMicrotask: (fn) => fn(), requestAnimationFrame: () => 0,
    console, Math, parseFloat, parseInt, isNaN, isFinite, String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Proxy, Reflect,
  };
  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `globalThis.updateFontSizeMenuChecks = updateFontSizeMenuChecks;`, sandbox);
  return { run: sandbox.updateFontSizeMenuChecks, checks };
}

// Returns the sizes whose check mark is visible (i.e. no 'invisible' class).
function checkedSizes(checks) {
  return SIZES.filter((sz) => !checks[sz].classList.contains('invisible'));
}

// Asserts exactly one option is checked and returns its size.
function visibleSize(checks) {
  const shown = checkedSizes(checks);
  assert.strictEqual(shown.length, 1, `expected exactly one check, saw ${shown.length}: ${shown}`);
  return shown[0];
}

test('no explicit font size checks the default of 10', () => {
  const { run, checks } = createSandbox();
  run(null);
  assert.strictEqual(visibleSize(checks), DEFAULT_SIZE);
  run({});
  assert.strictEqual(visibleSize(checks), DEFAULT_SIZE);
});

test('each preset size checks exactly its own option', () => {
  const { run, checks } = createSandbox();
  for (const sz of SIZES) {
    run({ fontSize: sz });
    assert.strictEqual(visibleSize(checks), sz, `size ${sz}`);
  }
});

test('a custom size matching no preset leaves every option unchecked', () => {
  const { run, checks } = createSandbox();
  run({ fontSize: 13 });
  assert.deepStrictEqual(checkedSizes(checks), []);
  run({ fontSize: 400 });
  assert.deepStrictEqual(checkedSizes(checks), []);
});

test('switching sizes moves the single check mark', () => {
  const { run, checks } = createSandbox();
  run({ fontSize: 24 });
  assert.strictEqual(visibleSize(checks), 24);
  run({ fontSize: 6 });
  assert.strictEqual(visibleSize(checks), 6);
  run(null); // back to the default size
  assert.strictEqual(visibleSize(checks), DEFAULT_SIZE);
});
