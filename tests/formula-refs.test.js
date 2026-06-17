/**
 * @file formula-refs.test.js
 * @description Unit tests for the pure reference scanner/colorizer
 * (public/formula-refs.js). Loads sheet-utils.js + formula-refs.js in a vm.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

function loadRefs() {
  const read = (f) => fs.readFileSync(path.resolve('public', f), 'utf8');
  const sandbox = { window: {}, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('sheet-utils.js') + '\n;\n' + read('formula-refs.js'), sandbox);
  return sandbox.window.CoSheet.formulaRefs;
}

test('formula-refs - scans single-cell references with offsets', () => {
  const { scanReferences } = loadRefs();
  const refs = scanReferences('=A1+B2');
  assert.strictEqual(refs.length, 2);
  // Spread the sandbox array into the test realm before deepStrictEqual: arrays
  // created inside the vm have a different Array.prototype, which the strict
  // comparison rejects across realms.
  assert.deepStrictEqual(
    [...refs].map(r => [r.ref, r.start, r.end, r.kind]),
    [['A1', 1, 3, 'cell'], ['B2', 4, 6, 'cell']]
  );
});

test('formula-refs - scans a range reference and normalizes coordinates', () => {
  const { scanReferences } = loadRefs();
  const refs = scanReferences('=SUM(B3:B8)');
  assert.strictEqual(refs.length, 1);
  const r = refs[0];
  assert.strictEqual(r.ref, 'B3:B8');
  assert.strictEqual(r.kind, 'range');
  assert.strictEqual(r.start, 5);
  assert.deepStrictEqual([r.r1, r.c1, r.r2, r.c2], [2, 1, 7, 1]);
});

test('formula-refs - ignores references inside string literals', () => {
  const { scanReferences } = loadRefs();
  const refs = scanReferences('="A1"&B2');
  assert.deepStrictEqual([...refs].map(r => r.ref), ['B2']);
});

test('formula-refs - ignores function names including digit-bearing ones', () => {
  const { scanReferences } = loadRefs();
  const refs = scanReferences('=LOG10(A1)');
  assert.deepStrictEqual([...refs].map(r => r.ref), ['A1']);
});

test('formula-refs - honors $ anchors', () => {
  const { scanReferences } = loadRefs();
  const refs = scanReferences('=$A$1');
  assert.strictEqual(refs[0].ref, '$A$1');
  assert.deepStrictEqual([refs[0].r1, refs[0].c1], [0, 0]);
});

test('formula-refs - returns [] for non-formula text', () => {
  const { scanReferences } = loadRefs();
  assert.deepStrictEqual([...scanReferences('A1+B2')], []);
});

test('formula-refs - assignColors: identical refs share a color, distinct cycle', () => {
  const { scanReferences, assignColors, PALETTE } = loadRefs();
  const refs = assignColors(scanReferences('=A1+A1+B2'));
  assert.strictEqual(refs[0].color, PALETTE[0]); // first A1
  assert.strictEqual(refs[1].color, PALETTE[0]); // second A1 -> same
  assert.strictEqual(refs[2].color, PALETTE[1]); // B2 -> next
});
