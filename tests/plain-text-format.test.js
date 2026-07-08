/**
 * @file plain-text-format.test.js
 * @description Covers the "Plain text" number format (Format ▸ Number ▸ Plain
 * text). It is display-only: a cell's stored value is untouched, but numeric
 * content renders verbatim and left-aligns (rather than picking up the numeric
 * right-alignment spreadsheets apply by default).
 *
 * resolveCellAlign and formatCellDisplay are pure helpers, so we run the real
 * client bundle in a VM sandbox and export just those two functions.
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
  const exportSuffix = `
    globalThis.resolveCellAlign = resolveCellAlign;
    globalThis.formatCellDisplay = formatCellDisplay;
  `;
  vm.runInContext(readAppBundle() + exportSuffix, sandbox);
  return sandbox;
}

test('plain-text format left-aligns numeric content (no numeric right-align)', () => {
  const s = createSandbox();
  assert.strictEqual(s.resolveCellAlign('42', { numberFormat: 'text' }), '');
});

test('a numeric cell with no text format still right-aligns (control)', () => {
  const s = createSandbox();
  assert.strictEqual(s.resolveCellAlign('42', {}), 'right');
});

test('an explicit alignment still wins over plain-text default', () => {
  const s = createSandbox();
  assert.strictEqual(s.resolveCellAlign('42', { numberFormat: 'text', align: 'center' }), 'center');
});

test('plain-text format renders numeric values verbatim', () => {
  const s = createSandbox();
  assert.strictEqual(s.formatCellDisplay('007', { numberFormat: 'text' }), '007');
  assert.strictEqual(s.formatCellDisplay('1.50', { numberFormat: 'text' }), '1.50');
});

test('a numeric format still reformats the value (control)', () => {
  const s = createSandbox();
  assert.strictEqual(s.formatCellDisplay('1', { numberFormat: 'percent' }), '100.00%');
});
