/**
 * @file clipboard-sync.test.js
 * @description Covers copiedCellsToText, which serializes the in-memory clipboard
 * to tab/newline-delimited text so an in-app copy can be mirrored onto the system
 * clipboard (fixing #144: a browser-native paste inserting stale OS-clipboard text
 * instead of the copied cell). Cells are laid out by their row/column offsets and
 * gaps render as empty strings.
 *
 * copiedCellsToText is a pure helper, so we run the real client bundle in a VM
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
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    WebSocket: class { constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    setTimeout: () => 0, clearTimeout: () => {}, queueMicrotask: (fn) => fn(), requestAnimationFrame: () => 0,
    console, Math, parseFloat, parseInt, isNaN, isFinite, String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Proxy, Reflect,
  };
  vm.createContext(sandbox);
  const exportSuffix = `globalThis.copiedCellsToText = copiedCellsToText;`;
  vm.runInContext(readAppBundle() + exportSuffix, sandbox);
  return sandbox;
}

test('serializes a single copied cell to its bare value', () => {
  const s = createSandbox();
  assert.strictEqual(s.copiedCellsToText([{ offsetRow: 0, offsetCol: 0, value: '000001' }]), '000001');
});

test('joins columns with tabs and rows with newlines', () => {
  const s = createSandbox();
  const cells = [
    { offsetRow: 0, offsetCol: 0, value: 'a' },
    { offsetRow: 0, offsetCol: 1, value: 'b' },
    { offsetRow: 1, offsetCol: 0, value: 'c' },
    { offsetRow: 1, offsetCol: 1, value: 'd' },
  ];
  assert.strictEqual(s.copiedCellsToText(cells), 'a\tb\nc\td');
});

test('fills gaps in a sparse selection with empty strings', () => {
  const s = createSandbox();
  const cells = [
    { offsetRow: 0, offsetCol: 0, value: 'x' },
    { offsetRow: 1, offsetCol: 2, value: 'y' },
  ];
  assert.strictEqual(s.copiedCellsToText(cells), 'x\t\t\n\t\ty');
});

test('renders missing/nullish values as empty strings', () => {
  const s = createSandbox();
  const cells = [
    { offsetRow: 0, offsetCol: 0, value: '' },
    { offsetRow: 0, offsetCol: 1 },
    { offsetRow: 0, offsetCol: 2, value: null },
  ];
  assert.strictEqual(s.copiedCellsToText(cells), '\t\t');
});

test('returns an empty string for an empty or missing selection', () => {
  const s = createSandbox();
  assert.strictEqual(s.copiedCellsToText([]), '');
  assert.strictEqual(s.copiedCellsToText(undefined), '');
});
