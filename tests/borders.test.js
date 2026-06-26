/**
 * @file borders.test.js
 * @description Unit tests for the neighbour-aware cell-border renderer
 * (applyCellBorders / addBorderLine in public/app.js). Borders are CENTRED on
 * the cell boundary (half their width each side, like Excel/Sheets), so a
 * centred line bleeds across the boundary. The key invariant under test is that
 * EACH cell draws its own copy of every edge it touches — a shared interior
 * boundary is drawn by BOTH neighbours as two identical, coincident lines (e.g.
 * the left cell's right and the right cell's left) — so the half a higher
 * stacking neighbour (the active cell) would paint over is always redrawn by
 * that neighbour's own copy and the boundary survives any repaint. The two
 * copies agree because pick() resolves a shared edge to the heavier of the two
 * coincident specs in both cells.
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
    globalThis.applyBordersToSelection = applyBordersToSelection;
    Object.defineProperty(globalThis, 'selectionStartCellId', { get: () => selectionStartCellId, set: (v) => { selectionStartCellId = v; }, configurable: true });
    Object.defineProperty(globalThis, 'selectionEndCellId', { get: () => selectionEndCellId, set: (v) => { selectionEndCellId = v; }, configurable: true });
    Object.defineProperty(globalThis, 'activeCellId', { get: () => activeCellId, set: (v) => { activeCellId = v; }, configurable: true });
    Object.defineProperty(globalThis, 'currentBorderColor', { get: () => currentBorderColor, set: (v) => { currentBorderColor = v; }, configurable: true });
    Object.defineProperty(globalThis, 'currentBorderStyle', { get: () => currentBorderStyle, set: (v) => { currentBorderStyle = v; }, configurable: true });
    Object.defineProperty(globalThis, 'socket', { get: () => socket, set: (v) => { socket = v; }, configurable: true });
  `;
  vm.runInContext(code + exportSuffix, sandbox);
  return sandbox;
}

test('interior vertical boundary is drawn by both neighbours (coincident copies)', () => {
  const sandbox = createSandbox();
  // A1's right and B1's left describe the SAME shared boundary. A centred line
  // bleeds across it, so each cell draws its own copy: A1 its right, B1 its left.
  sandbox.localCells = {
    A1: { style: { borders: { right: thin() } } },
    B1: { style: { borders: { left: thin() } } },
  };

  const elA = makeEl();
  const elB = makeEl();
  sandbox.applyCellBorders(elA, sandbox.localCells.A1.style, 'A1');
  sandbox.applyCellBorders(elB, sandbox.localCells.B1.style, 'B1');

  assert.strictEqual(lines(elA).length, 1, 'A1 draws its right copy of the boundary');
  assert.strictEqual(lines(elB).length, 1, 'B1 draws its own left copy (covers the half A1 bleeds in)');
  assert.ok(/(^|;)\s*right:/.test(elA._children[0].style.cssText || ''), 'A1 copy is a right edge');
  assert.ok(/(^|;)\s*left:/.test(elB._children[0].style.cssText || ''), 'B1 copy is a left edge');
});

test('interior horizontal boundary is drawn by both neighbours (coincident copies)', () => {
  const sandbox = createSandbox();
  sandbox.localCells = {
    A1: { style: { borders: { bottom: thin() } } },
    A2: { style: { borders: { top: thin() } } },
  };

  const el1 = makeEl();
  const el2 = makeEl();
  sandbox.applyCellBorders(el1, sandbox.localCells.A1.style, 'A1');
  sandbox.applyCellBorders(el2, sandbox.localCells.A2.style, 'A2');

  assert.strictEqual(lines(el1).length, 1, 'A1 draws its bottom copy of the boundary');
  assert.strictEqual(lines(el2).length, 1, 'A2 draws its own top copy (covers the half A1 bleeds in)');
  assert.ok(/(^|;)\s*bottom:/.test(el1._children[0].style.cssText || ''), 'A1 copy is a bottom edge');
  assert.ok(/(^|;)\s*top:/.test(el2._children[0].style.cssText || ''), 'A2 copy is a top edge');
});

test('a fully framed interior cell draws all four of its own edges', () => {
  const sandbox = createSandbox();
  // B2 framed on all sides, sitting amongst blank neighbours. B2 draws its own
  // four edges; each shared boundary is ALSO drawn by the facing neighbour.
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
  const elA2 = at('A2'); // left neighbour: draws B2's left boundary as its own right
  const elB1 = at('B1'); // top neighbour: draws B2's top boundary as its own bottom

  // B2 draws all four of its own edges.
  assert.strictEqual(lines(elB2).length, 4, 'B2 draws its own four edges');
  // Each shared boundary is redrawn by the facing neighbour's coincident copy.
  assert.strictEqual(edges(elA2, 'right:').length, 1, 'A2 redraws B2 left boundary as its own right');
  assert.strictEqual(edges(elB1, 'bottom:').length, 1, 'B1 redraws B2 top boundary as its own bottom');
});

test('grid outer edges (column A / row 1) draw their own left / top', () => {
  const sandbox = createSandbox();
  sandbox.localCells = {
    A1: { style: { borders: { left: thin(), top: thin() } } },
  };
  const elA1 = makeEl();
  sandbox.applyCellBorders(elA1, sandbox.localCells.A1.style, 'A1');

  // No preceding neighbour exists for column A / row 1, so A1 must draw both —
  // and each frame edge is drawn twice (a self-coincident copy, see below), so
  // two left + two top = four lines.
  const css = lines(elA1).map((l) => l.style.cssText || '');
  assert.strictEqual(lines(elA1).length, 4, 'A1 draws its own left and top (doubled) at the grid frame');
  assert.ok(css.some((c) => /width:0;\s*left:/.test(c)), 'A1 draws its own left edge');
  assert.ok(css.some((c) => /height:0;\s*top:/.test(c)), 'A1 draws its own top edge');
});

test('the grid frame (column A left / row 1 top) is drawn twice so it is not thinner than the other sides', () => {
  // An interior shared edge is drawn by both neighbours; the two coincident copies
  // reinforce each other so the line keeps full weight even when its boundary
  // lands on a fractional device pixel (e.g. at 150% zoom). The grid frame has no
  // neighbour to draw that second copy, so a lone centred line there anti-aliases
  // to half intensity and looks thinner. The frame cell draws the edge twice to
  // match. Both copies stay CENTRED (offset -1.5 for thick), never inset.
  const sandbox = createSandbox();
  sandbox.localCells = { A1: { style: { borders: { left: thick(), top: thick() } } } };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.A1.style, 'A1');
  const css = lines(el).map((l) => l.style.cssText || '');
  const lefts = css.filter((c) => /width:0;\s*left:/.test(c));
  const tops = css.filter((c) => /height:0;\s*top:/.test(c));
  assert.strictEqual(lefts.length, 2, 'column A left frame is drawn twice (coincident copies)');
  assert.strictEqual(tops.length, 2, 'row 1 top frame is drawn twice (coincident copies)');
  assert.ok(lefts.every((c) => /width:0;\s*left:\s*-1\.5px/.test(c)), 'both left copies stay centred (-1.5px)');
  assert.ok(tops.every((c) => /height:0;\s*top:\s*-1\.5px/.test(c)), 'both top copies stay centred (-1.5px)');
});

test('an interior left/top edge (not on the grid frame) stays centred', () => {
  // Only the grid's physical frame is inset; an interior cell's left/top still
  // straddle the boundary, backed by the neighbour's coincident copy.
  const sandbox = createSandbox();
  sandbox.localCells = { C3: { style: { borders: { left: thick(), top: thick() } } } };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.C3.style, 'C3');
  const css = lines(el).map((l) => l.style.cssText || '');
  const left = css.find((c) => /width:0;\s*left:/.test(c));
  const top = css.find((c) => /height:0;\s*top:/.test(c));
  assert.ok(/width:0;\s*left:\s*-1\.5px/.test(left), `interior left must be centred (-1.5px), got: ${left}`);
  assert.ok(/height:0;\s*top:\s*-1\.5px/.test(top), `interior top must be centred (-1.5px), got: ${top}`);
});

const thick = () => ({ color: '#000000', style: 'thick' });

test('a thick border is centred on the boundary, half its width each side', () => {
  // Borders straddle the boundary (Excel/Sheets behaviour). A 3px thick line
  // sits 1.5px each side. The gridline-bearing sides (right/bottom) reference a
  // padding box GRIDLINE_W (1px) inside the boundary, so their offset is
  // -(GRIDLINE_W + w/2) = -2.5px; the borderless sides (left/top) reference a
  // padding box on the boundary, so their offset is -w/2 = -1.5px. The line is
  // safe to bleed because the facing neighbour draws its own coincident copy.
  const sandbox = createSandbox();
  sandbox.localCells = { B2: { style: { borders: { top: thick(), right: thick(), bottom: thick(), left: thick() } } } };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.B2.style, 'B2');

  const css = lines(el).map((l) => l.style.cssText || '');
  // The edge-defining offset always immediately follows width:0 (verticals) or
  // height:0 (horizontals); the values before it (thick: -1.5px) are the
  // cross-axis corner overruns, not the edge offset.
  const right = css.find((c) => /width:0;\s*right:/.test(c));
  const left = css.find((c) => /width:0;\s*left:/.test(c));
  const bottom = css.find((c) => /height:0;\s*bottom:/.test(c));
  const top = css.find((c) => /height:0;\s*top:/.test(c));
  assert.ok(right && bottom && left && top, 'B2 draws all four of its own edges');
  // Gridline sides: -(1 + 1.5) = -2.5px. Borderless sides: -1.5px.
  assert.ok(/width:0;\s*right:\s*-2\.5px/.test(right), `right edge must be centred (-2.5px), got: ${right}`);
  assert.ok(/height:0;\s*bottom:\s*-2\.5px/.test(bottom), `bottom edge must be centred (-2.5px), got: ${bottom}`);
  assert.ok(/width:0;\s*left:\s*-1\.5px/.test(left), `left edge must be centred (-1.5px), got: ${left}`);
  assert.ok(/height:0;\s*top:\s*-1\.5px/.test(top), `top edge must be centred (-1.5px), got: ${top}`);
  // The old inset edge offsets (-1px on right/bottom, 0 on left/top) must be gone.
  assert.ok(!/width:0;\s*right:\s*-1px/.test(right) && !/height:0;\s*bottom:\s*-1px/.test(bottom),
    'right/bottom edges must no longer be inset to -1px');
  assert.ok(!/width:0;\s*left:\s*0px/.test(left) && !/height:0;\s*top:\s*0px/.test(top),
    'left/top edges must no longer be inset to 0px');
});

test('overlay lines overrun past BOTH ends to close every corner (#82, #86)', () => {
  // A line's far-end overrun (bottom on verticals, right on horizontals) lets a
  // cell's own right+bottom fill its bottom-right corner. The symmetric near-end
  // overrun (top / left) closes the top-left corner, whose left edge is drawn by
  // the left neighbour and top edge by the upper neighbour — without it those two
  // lines met only at a point, leaving the corner open. The overrun reaches the
  // outline's outer corner, which sits half the perpendicular line's width beyond
  // the boundary, so for a thick (3px) frame it must be max(GRIDLINE_W, w/2) =
  // 1.5px — a fixed 1px fell short and chipped a notch out of every corner (#86).
  const sandbox = createSandbox();
  // C3 (an interior cell) draws all four of its own edges, one each — no frame
  // doubling, which only applies at column A / row 1.
  sandbox.localCells = { C3: { style: { borders: { top: thick(), right: thick(), bottom: thick(), left: thick() } } } };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.C3.style, 'C3');
  const css = lines(el).map((l) => l.style.cssText || '');

  const verticals = css.filter((c) => /width:0/.test(c));
  const horizontals = css.filter((c) => /height:0/.test(c));
  assert.strictEqual(verticals.length, 2, 'C3 has its left + right vertical lines');
  assert.strictEqual(horizontals.length, 2, 'C3 has its top + bottom horizontal lines');
  // Thick: overrun = max(1, 1.5) = 1.5px. Every vertical overruns top AND bottom;
  // every horizontal overruns left AND right.
  verticals.forEach((c) => {
    assert.ok(/top:\s*-1\.5px/.test(c), `vertical must overrun its top end (-1.5px), got: ${c}`);
    assert.ok(/bottom:\s*-1\.5px/.test(c), `vertical must overrun its bottom end (-1.5px), got: ${c}`);
  });
  horizontals.forEach((c) => {
    assert.ok(/left:\s*-1\.5px/.test(c), `horizontal must overrun its left end (-1.5px), got: ${c}`);
    assert.ok(/right:\s*-1\.5px/.test(c), `horizontal must overrun its right end (-1.5px), got: ${c}`);
  });
});

test('thin / medium borders keep the 1px overrun; thick overruns its half-width (#86)', () => {
  // The corner overrun is max(GRIDLINE_W, w/2): it must reach the outline's outer
  // corner (half the perpendicular line beyond the boundary) without shrinking the
  // existing 1px gridline-gap overhang for lighter borders.
  const sandbox = createSandbox();
  const overrun = (style) => {
    sandbox.localCells = { C3: { style: { borders: { top: { color: '#000', style }, left: { color: '#000', style } } } } };
    const el = makeEl();
    sandbox.applyCellBorders(el, sandbox.localCells.C3.style, 'C3');
    const css = lines(el).map((l) => l.style.cssText || '');
    const vert = css.find((c) => /width:0/.test(c));
    return /top:\s*(-?[\d.]+)px/.exec(vert)[1]; // cross-axis overrun of the left vertical
  };
  assert.strictEqual(overrun('thin'), '-1', 'thin (0.5px half) keeps the 1px overrun');
  assert.strictEqual(overrun('medium'), '-1', 'medium (1px half) keeps the 1px overrun');
  assert.strictEqual(overrun('thick'), '-1.5', 'thick (1.5px half) overruns to its outer corner');
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
  // C3 (interior) owns all four edges without the frame doubling at column A / row 1.
  sandbox.localCells = {
    C3: { style: { borders: { top: thick(), right: thick(), bottom: thick(), left: thick() } } },
  };
  const elA1 = makeEl();
  sandbox.applyCellBorders(elA1, sandbox.localCells.C3.style, 'C3');

  const order = lines(elA1).map((l) => edgeOf(l.style.cssText || ''));
  assert.strictEqual(order.length, 4, 'C3 draws all four edges');
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
    // C3 (interior): thick top/bottom horizontals, thin left/right verticals.
    C3: { style: { borders: { top: thick(), bottom: thick(), left: thin(), right: thin() } } },
  };
  const elA1 = makeEl();
  sandbox.applyCellBorders(elA1, sandbox.localCells.C3.style, 'C3');
  const order = lines(elA1).map((l) => edgeOf(l.style.cssText || ''));
  assert.strictEqual(order.length, 4, 'C3 draws all four edges');
  // The two thick horizontals must paint last (on top) despite being horizontal.
  const lastTwo = order.slice(2);
  assert.ok(lastTwo.every((e) => e === 'top' || e === 'bottom'),
    `the heavier (thick) horizontals must paint on top, got order: ${order.join(',')}`);
});

// --- applyBordersToSelection face mirroring (#82) ---------------------------
// A shared boundary is drawn once by its owner (the left/top cell) and pick()
// ties to the owner's own side. Applying a border to a cell whose left/top
// neighbour already has a coincident border used to leave the neighbour's stale
// spec winning, so the freshly-applied colour showed only on the cell's own
// right/bottom. applyBordersToSelection now mirrors each set side onto the
// neighbour's opposite face so the owner paints the applied spec.
const blueThin = () => ({ color: '#1a56ff', style: 'thin' });
const redThin = () => ({ color: '#ff0000', style: 'thin' });
const colorOf = (cells, id, side) =>
  (cells[id] && cells[id].style && cells[id].style.borders && cells[id].style.borders[side]
    ? cells[id].style.borders[side].color : null);

/** Seed B7:C9 all blue, select one cell, apply red in `mode`, return localCells. */
function applyRedTo(cellId, mode) {
  const sandbox = createSandbox();
  sandbox.socket = { readyState: 0 }; // never OPEN → skip network send
  const cells = {};
  ['B7', 'C7', 'B8', 'C8', 'B9', 'C9'].forEach((id) => {
    cells[id] = { formula: '', value: '', style: { borders: { top: blueThin(), right: blueThin(), bottom: blueThin(), left: blueThin() } } };
  });
  sandbox.localCells = cells;
  sandbox.activeCellId = cellId;
  sandbox.selectionStartCellId = cellId;
  sandbox.selectionEndCellId = cellId;
  sandbox.currentBorderColor = '#ff0000';
  sandbox.currentBorderStyle = 'thin';
  sandbox.applyBordersToSelection(mode);
  return sandbox.localCells;
}

test('applying a border mirrors the applied spec onto neighbour faces (#82)', () => {
  // Apply red "all" to C8 inside an all-blue B7:C9. C8's left is owned by B8 (its
  // right) and its top by C7 (its bottom); without mirroring those stayed blue.
  const cells = applyRedTo('C8', 'all');
  assert.strictEqual(colorOf(cells, 'C8', 'right'), '#ff0000', 'C8 own right is red');
  assert.strictEqual(colorOf(cells, 'C8', 'bottom'), '#ff0000', 'C8 own bottom is red');
  // The fix: the left/top owners now store red on the shared faces.
  assert.strictEqual(colorOf(cells, 'B8', 'right'), '#ff0000', "C8's left edge (B8.right) is now red");
  assert.strictEqual(colorOf(cells, 'C7', 'bottom'), '#ff0000', "C8's top edge (C7.bottom) is now red");
  // Only the shared faces flip; the neighbours' unrelated sides stay blue.
  assert.strictEqual(colorOf(cells, 'B8', 'bottom'), '#1a56ff', 'B8 unrelated side untouched');
  assert.strictEqual(colorOf(cells, 'C7', 'right'), '#1a56ff', 'C7 unrelated side untouched');
});

test('mirroring never creates records on empty neighbours (#82)', () => {
  // Apply red "all" to a lone E5 with no surrounding borders. A null neighbour
  // face already loses to the applied spec in pick(), so empty neighbours must be
  // left untouched — no border records, no history/sync bloat.
  const sandbox = createSandbox();
  sandbox.socket = { readyState: 0 };
  sandbox.localCells = {};
  sandbox.activeCellId = 'E5';
  sandbox.selectionStartCellId = 'E5';
  sandbox.selectionEndCellId = 'E5';
  sandbox.currentBorderColor = '#ff0000';
  sandbox.currentBorderStyle = 'thin';
  sandbox.applyBordersToSelection('all');
  const cells = sandbox.localCells;
  assert.strictEqual(colorOf(cells, 'E5', 'left'), '#ff0000', 'E5 itself gets all four red');
  ['D5', 'F5', 'E4', 'E6'].forEach((id) => {
    assert.ok(!cells[id], `empty neighbour ${id} must not be created`);
  });
});

test('clear does not mirror onto neighbour faces (#82)', () => {
  // Clearing must keep its existing behaviour: it nulls the target's own sides
  // and leaves the neighbours' borders intact (a cleared side mirrors nothing).
  const cells = applyRedTo('C8', 'clear');
  assert.ok(!cells.C8.style.borders, 'C8 borders cleared');
  assert.strictEqual(colorOf(cells, 'B8', 'right'), '#1a56ff', 'B8 untouched by clear');
  assert.strictEqual(colorOf(cells, 'C7', 'bottom'), '#1a56ff', 'C7 untouched by clear');
});
