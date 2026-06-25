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

// Classify an overlay by the edge it actually paints. A vertical line (width:0) is
// left/right per the offset following width:0; a horizontal line (height:0) is
// top/bottom per the offset following height:0. (The cross-axis span — e.g. the
// "right:-1px" reach on a horizontal line — is NOT its edge.)
const edgeOf = (cssText) => {
  let m = /width:0;\s*(left|right):/.exec(cssText);
  if (m) return m[1];
  m = /height:0;\s*(top|bottom):/.exec(cssText);
  if (m) return m[1];
  return '?';
};
const edgeSet = (el) => new Set(lines(el).map((l) => edgeOf(l.style.cssText || '')));

test('a horizontally merged anchor draws the block\'s far-right edge', () => {
  // Regression (#78): a merged anchor is rendered as one element spanning the
  // whole block, so the block's right boundary is the FAR edge of the merge —
  // owned by the right-column member, where applyBordersToSelection stores the
  // outer border. That member is a covered cell (display:none), so reading only
  // the anchor's own right left the far edge unpainted on horizontal merges.
  const sandbox = createSandbox();
  // Outer border on merge B1:C1: B1 (anchor) gets left/top/bottom, C1 (far
  // member) gets right. B1 carries the merge marker.
  sandbox.localCells = {
    B1: { style: { merge: { rows: 1, cols: 2 }, borders: { top: thick(), bottom: thick(), left: thick(), right: null } } },
    C1: { style: { borders: { top: thick(), bottom: thick(), right: thick(), left: null } } },
  };
  const elB1 = makeEl();
  sandbox.applyCellBorders(elB1, sandbox.localCells.B1.style, 'B1');
  const e = edgeSet(elB1);
  assert.ok(e.has('right'), 'the merged anchor must paint the block\'s far-right edge');
  assert.ok(e.has('bottom'), 'and its bottom edge');
});

test('a vertically merged anchor draws the block\'s far-bottom edge', () => {
  // Regression (#78): symmetric to the horizontal case — a vertical merge's
  // bottom edge is owned by the (hidden) bottom-row member.
  const sandbox = createSandbox();
  // Outer border on merge A1:A2: A1 (anchor) gets left/top/right, A2 (far member)
  // gets bottom.
  sandbox.localCells = {
    A1: { style: { merge: { rows: 2, cols: 1 }, borders: { top: thick(), left: thick(), right: thick(), bottom: null } } },
    A2: { style: { borders: { left: thick(), right: thick(), bottom: thick(), top: null } } },
  };
  const elA1 = makeEl();
  sandbox.applyCellBorders(elA1, sandbox.localCells.A1.style, 'A1');
  const e = edgeSet(elA1);
  assert.ok(e.has('bottom'), 'the merged anchor must paint the block\'s far-bottom edge');
  assert.ok(e.has('right'), 'and its right edge');
});

test('a vertical edge paints above a horizontal one at equal weight (#80)', () => {
  // Regression (#80): overlay lines share one z-index, so paint order is append
  // order. A horizontal line spans the full track and covers the corner the
  // perpendicular vertical passes through, so if the horizontal is appended last
  // it chips a gap out of a differently-coloured vertical at every crossing —
  // the reported broken right edge / intact left edge asymmetry. A cell's own
  // edges must be appended horizontal-before-vertical so both verticals sit on
  // top. A1 (grid corner) owns all four edges, exercising every side at once.
  const sandbox = createSandbox();
  sandbox.localCells = {
    A1: { style: { borders: { top: thick(), right: thick(), bottom: thick(), left: thick() } } },
  };
  const elA1 = makeEl();
  sandbox.applyCellBorders(elA1, sandbox.localCells.A1.style, 'A1');

  const order = lines(elA1).map((l) => edgeOf(l.style.cssText || ''));
  assert.strictEqual(order.length, 4, 'A1 at the grid corner draws all four edges');
  // Verticals (left/right) must come after horizontals (top/bottom) so they paint
  // on top — both of them, symmetrically, not just the one appended last.
  const lastTwo = order.slice(2);
  assert.ok(lastTwo.every((e) => e === 'left' || e === 'right'),
    `both verticals must paint last (on top), got order: ${order.join(',')}`);
});

test('a heavier border paints above a lighter one regardless of axis (#80)', () => {
  // The primary key is weight: a thick horizontal must sit above a thin vertical
  // (and vice versa), so a bold separator is never chipped by a hairline crossing.
  const sandbox = createSandbox();
  sandbox.localCells = {
    // A1 grid corner: thick top/bottom horizontals, thin left/right verticals.
    A1: { style: { borders: { top: thick(), bottom: thick(), left: thin(), right: thin() } } },
  };
  const elA1 = makeEl();
  sandbox.applyCellBorders(elA1, sandbox.localCells.A1.style, 'A1');
  const order = lines(elA1).map((l) => edgeOf(l.style.cssText || ''));
  assert.strictEqual(order.length, 4, 'A1 draws all four edges');
  // The two thick horizontals must paint last (on top) despite being horizontal.
  const lastTwo = order.slice(2);
  assert.ok(lastTwo.every((e) => e === 'top' || e === 'bottom'),
    `the heavier (thick) horizontals must paint on top, got order: ${order.join(',')}`);
});
