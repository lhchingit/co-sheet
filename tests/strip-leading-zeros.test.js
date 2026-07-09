/**
 * @file strip-leading-zeros.test.js
 * @description Covers stripLeadingZeros, which normalizes a committed numeric
 * entry so redundant leading zeros are dropped ("01"/"007" → "1"/"7") and the
 * value is treated as an ordinary number. Only plain decimal numbers are
 * rewritten; the sign, fraction, and exponent are preserved, and non-numeric
 * text passes through untouched. (The plain-text format's exemption is enforced
 * by the caller, so it isn't exercised here.)
 *
 * stripLeadingZeros is a pure helper, so we run the real client bundle in a VM
 * sandbox and export just that function.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

function createSandbox() {
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: () => null,
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
  const exportSuffix = `globalThis.stripLeadingZeros = stripLeadingZeros;`;
  vm.runInContext(readAppBundle() + exportSuffix, sandbox);
  return sandbox;
}

test('trims leading zeros from whole-number entries', () => {
  const s = createSandbox();
  assert.strictEqual(s.stripLeadingZeros('01'), '1');
  assert.strictEqual(s.stripLeadingZeros('001'), '1');
  assert.strictEqual(s.stripLeadingZeros('007'), '7');
  assert.strictEqual(s.stripLeadingZeros('010'), '10');
});

test('collapses all-zero entries to a single zero', () => {
  const s = createSandbox();
  assert.strictEqual(s.stripLeadingZeros('0'), '0');
  assert.strictEqual(s.stripLeadingZeros('00'), '0');
  assert.strictEqual(s.stripLeadingZeros('000'), '0');
});

test('preserves a single leading zero before a decimal point', () => {
  const s = createSandbox();
  assert.strictEqual(s.stripLeadingZeros('0.5'), '0.5');
  assert.strictEqual(s.stripLeadingZeros('00.5'), '0.5');
  assert.strictEqual(s.stripLeadingZeros('01.50'), '1.50');
});

test('keeps the sign and exponent while trimming the integer part', () => {
  const s = createSandbox();
  assert.strictEqual(s.stripLeadingZeros('-01'), '-1');
  assert.strictEqual(s.stripLeadingZeros('+007'), '+7');
  assert.strictEqual(s.stripLeadingZeros('01e5'), '1e5');
});

test('leaves already-normalized numbers unchanged', () => {
  const s = createSandbox();
  assert.strictEqual(s.stripLeadingZeros('1'), '1');
  assert.strictEqual(s.stripLeadingZeros('42'), '42');
  assert.strictEqual(s.stripLeadingZeros('3.14'), '3.14');
});

test('passes non-numeric and non-decimal text through untouched', () => {
  const s = createSandbox();
  assert.strictEqual(s.stripLeadingZeros('007 James'), '007 James');
  assert.strictEqual(s.stripLeadingZeros('hello'), 'hello');
  assert.strictEqual(s.stripLeadingZeros('0x1a'), '0x1a');
  assert.strictEqual(s.stripLeadingZeros(''), '');
});
