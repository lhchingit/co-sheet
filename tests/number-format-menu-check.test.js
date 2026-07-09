/**
 * @file number-format-menu-check.test.js
 * @description Covers updateNumberFormatMenuChecks, which places a check mark
 * beside the active cell's number format in the Format ▸ Number menu (falling
 * back to "Automatic" when no explicit format is set). We run the real client
 * bundle in a VM sandbox with a minimal DOM mock exposing the nine format
 * buttons, each holding a `.fmt-num-check` element whose `invisible` class we
 * inspect.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

const BUTTON_IDS = [
  'fmt-num-auto', 'fmt-num-plain-text', 'fmt-num-number', 'fmt-num-percent',
  'fmt-num-scientific', 'fmt-num-accounting', 'fmt-num-financial',
  'fmt-num-currency', 'fmt-num-currency-rounded',
];

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
  const buttons = {};
  const checks = {};
  for (const id of BUTTON_IDS) {
    const check = makeCheck();
    checks[id] = check;
    buttons[id] = { querySelector: (sel) => (sel === '.fmt-num-check' ? check : null) };
  }
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => buttons[id] || null,
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
  vm.runInContext(readAppBundle() + `globalThis.updateNumberFormatMenuChecks = updateNumberFormatMenuChecks;`, sandbox);
  return { run: sandbox.updateNumberFormatMenuChecks, checks };
}

// Returns the id of the single button whose check mark is visible (no 'invisible').
function visibleId(checks) {
  const shown = BUTTON_IDS.filter((id) => !checks[id].classList.contains('invisible'));
  assert.strictEqual(shown.length, 1, `expected exactly one check, saw ${shown.length}: ${shown}`);
  return shown[0];
}

test('no explicit format checks Automatic', () => {
  const { run, checks } = createSandbox();
  run(null);
  assert.strictEqual(visibleId(checks), 'fmt-num-auto');
  run({});
  assert.strictEqual(visibleId(checks), 'fmt-num-auto');
});

test('plain text format checks the Plain text option', () => {
  const { run, checks } = createSandbox();
  run({ numberFormat: 'text' });
  assert.strictEqual(visibleId(checks), 'fmt-num-plain-text');
});

test('currencyRounded maps to the Currency (rounded) button', () => {
  const { run, checks } = createSandbox();
  run({ numberFormat: 'currencyRounded' });
  assert.strictEqual(visibleId(checks), 'fmt-num-currency-rounded');
});

test('each named format checks exactly its own option', () => {
  const { run, checks } = createSandbox();
  const cases = {
    number: 'fmt-num-number', percent: 'fmt-num-percent', scientific: 'fmt-num-scientific',
    accounting: 'fmt-num-accounting', financial: 'fmt-num-financial', currency: 'fmt-num-currency',
  };
  for (const [fmt, id] of Object.entries(cases)) {
    run({ numberFormat: fmt });
    assert.strictEqual(visibleId(checks), id, `format ${fmt}`);
  }
});

test('switching formats moves the single check mark', () => {
  const { run, checks } = createSandbox();
  run({ numberFormat: 'percent' });
  assert.strictEqual(visibleId(checks), 'fmt-num-percent');
  run(null); // back to Automatic
  assert.strictEqual(visibleId(checks), 'fmt-num-auto');
});
