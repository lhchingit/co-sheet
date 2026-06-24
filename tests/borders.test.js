/**
 * @file borders.test.js
 * @description Unit tests for the neighbour-aware cell-border renderer
 * (applyCellBorders / addBorderLine in public/app.js). The key invariant under
 * test is that an interior shared boundary between two cells is drawn exactly
 * ONCE — by the left/top owner — so framing many cells doesn't multiply the
 * number of overlay DOM nodes (the cause of the "many framed cells" lag). The
 * grid's outer edges (column A / row 1), which have no preceding neighbour to
 * own the boundary, still draw their own left/top.
 */

import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';

const thin = () => ({ color: '#000000', style: 'thin' });

/** Minimal DOM element stand-in that records appended border-line overlays. */
function makeEl() {
  const el = {
    className: '',
    style: {},
    _children: [],
    appendChild(child) { child._parent = el; el._children.push(child); return child; },
    // app.js only ever queries ':scope > .grid-border-line' on a cell element.
    querySelectorAll() {
      return el._children.filter((c) => (c.className || '').includes('grid-border-line'));
    },
    remove() {
      if (!el._parent) return;
      const arr = el._parent._children;
      const i = arr.indexOf(el);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  return el;
}

/** The overlay border lines currently on a cell element. */
const lines = (el) => el._children.filter((c) => c.className === 'grid-border-line');

function createSandbox() {
  const code = readAppBundle();
  const sandbox = {
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
      createElement: () => makeEl(),
    },
    WebSocket: class { constructor() { this.readyState = 0; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    setTimeout: () => 0,
    queueMicrotask: () => {},
    console, Math, parseFloat, isNaN, String, Object, Array, JSON,
  };
  vm.createContext(sandbox);

  const exportSuffix = `
    Object.defineProperty(globalThis, 'localCells', { get: () => localCells, set: (v) => { localCells = v; }, configurable: true });
    Object.defineProperty(globalThis, 'isHistoryMode', { get: () => isHistoryMode, set: (v) => { isHistoryMode = v; }, configurable: true });
    globalThis.applyCellBorders = applyCellBorders;
  `;
  vm.runInContext(code + exportSuffix, sandbox);
  return sandbox;
}

test('interior vertical boundary between two framed cells is drawn once', () => {
  const sandbox = createSandbox();
  // A1's right and B1's left describe the SAME shared boundary; A1 (the left
  // owner) should draw it and B1 should not redraw its own left.
  sandbox.localCells = {
    A1: { style: { borders: { right: thin() } } },
    B1: { style: { borders: { left: thin() } } },
  };

  const elA = makeEl();
  const elB = makeEl();
  sandbox.applyCellBorders(elA, sandbox.localCells.A1.style, 'A1');
  sandbox.applyCellBorders(elB, sandbox.localCells.B1.style, 'B1');

  assert.strictEqual(lines(elA).length + lines(elB).length, 1, 'shared boundary should yield exactly one overlay line');
  assert.strictEqual(lines(elA).length, 1, 'the left owner (A1) draws the boundary');
  assert.strictEqual(lines(elB).length, 0, 'the right cell (B1) must not redraw its own left');
});

test('interior horizontal boundary between two framed cells is drawn once', () => {
  const sandbox = createSandbox();
  sandbox.localCells = {
    A1: { style: { borders: { bottom: thin() } } },
    A2: { style: { borders: { top: thin() } } },
  };

  const el1 = makeEl();
  const el2 = makeEl();
  sandbox.applyCellBorders(el1, sandbox.localCells.A1.style, 'A1');
  sandbox.applyCellBorders(el2, sandbox.localCells.A2.style, 'A2');

  assert.strictEqual(lines(el1).length + lines(el2).length, 1, 'shared boundary should yield exactly one overlay line');
  assert.strictEqual(lines(el1).length, 1, 'the top owner (A1) draws the boundary');
  assert.strictEqual(lines(el2).length, 0, 'the bottom cell (A2) must not redraw its own top');
});

test('a fully framed interior cell still shows all four edges via its neighbours', () => {
  const sandbox = createSandbox();
  // B2 framed on all sides, sitting amongst blank neighbours. B2 draws its own
  // right & bottom; its left is drawn by A2's right, its top by B1's bottom.
  sandbox.localCells = {
    B2: { style: { borders: { top: thin(), right: thin(), bottom: thin(), left: thin() } } },
  };
  const at = (id) => {
    const el = makeEl();
    const st = (sandbox.localCells[id] && sandbox.localCells[id].style) || {};
    sandbox.applyCellBorders(el, st, id);
    return el;
  };

  const edges = (el, axis) => lines(el).filter((l) => (l.style.cssText || '').includes(axis));
  const elB2 = at('B2');
  const elA2 = at('A2'); // left neighbour owns B2's left edge
  const elB1 = at('B1'); // top neighbour owns B2's top edge

  // B2 itself owns only its right & bottom (two lines, no self left/top).
  assert.strictEqual(lines(elB2).length, 2, 'B2 draws only its owned right & bottom');
  // The left edge is painted by A2 (as its right), the top by B1 (as its bottom).
  assert.strictEqual(edges(elA2, 'right:').length, 1, 'A2 paints B2 left edge as its own right');
  assert.strictEqual(edges(elB1, 'bottom:').length, 1, 'B1 paints B2 top edge as its own bottom');
});

test('grid outer edges (column A / row 1) draw their own left / top', () => {
  const sandbox = createSandbox();
  sandbox.localCells = {
    A1: { style: { borders: { left: thin(), top: thin() } } },
  };
  const elA1 = makeEl();
  sandbox.applyCellBorders(elA1, sandbox.localCells.A1.style, 'A1');

  // No preceding neighbour exists for column A / row 1, so A1 must draw both.
  const css = lines(elA1).map((l) => l.style.cssText || '');
  assert.strictEqual(lines(elA1).length, 2, 'A1 draws its own left and top at the grid frame');
  assert.ok(css.some((c) => c.includes('left:')), 'A1 draws its own left edge');
  assert.ok(css.some((c) => c.includes('top:')), 'A1 draws its own top edge');
});

const thick = () => ({ color: '#000000', style: 'thick' });

test('a thick interior border is drawn inset, never straddling into the neighbour', () => {
  // Regression: a straddling overlay bleeds half its width into the neighbour
  // cell; that half is painted over when the neighbour is independently
  // re-rendered (e.g. bordering an adjacent range later), and at fractional
  // device-pixel ratios (125%/150% display scaling) the line then reads as half
  // width. Keeping the line fully inside the owner (boundary-facing edge on the
  // boundary, offset = -GRIDLINE_W on the gridline sides) makes it immune.
  const sandbox = createSandbox();
  sandbox.localCells = { B2: { style: { borders: { right: thick(), bottom: thick() } } } };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.B2.style, 'B2');

  const css = lines(el).map((l) => l.style.cssText || '');
  const right = css.find((c) => /(^|;)\s*right:/.test(c));
  const bottom = css.find((c) => /(^|;)\s*bottom:/.test(c));
  assert.ok(right && bottom, 'B2 draws its owned right and bottom edges');
  // -1px keeps the 3px line inside the owner (right edge on the boundary). The
  // old straddling value (-2.5px) would push 1.5px across into the neighbour.
  assert.ok(/right:\s*-1px/.test(right), `right edge must be inset (-1px), got: ${right}`);
  assert.ok(/bottom:\s*-1px/.test(bottom), `bottom edge must be inset (-1px), got: ${bottom}`);
  assert.ok(!css.some((c) => /-2\.5px/.test(c)), 'no overlay straddles the boundary (no -2.5px offset)');
});
