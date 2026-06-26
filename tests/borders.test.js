/**
 * @file borders.test.js
 * @description Unit tests for the neighbour-aware cell-border renderer
 * (applyCellBorders / addBorderBox in public/app.js). Borders are CENTRED on the
 * cell boundary (half their width each side, like Excel/Sheets), so a centred
 * border bleeds across the boundary. The key invariant under test is that EACH
 * cell draws its own copy of every edge it touches — a shared interior boundary
 * is drawn by BOTH neighbours (e.g. the left cell's right and the right cell's
 * left) — so the half a higher stacking neighbour (the active cell) would paint
 * over is always redrawn by that neighbour's own copy and the boundary survives
 * any repaint. The two agree because pick() resolves a shared edge to the heavier
 * of the two coincident specs in both cells.
 *
 * A cell's four effective edges are emitted as ONE box overlay carrying
 * border-top/right/bottom/left (one node per cell, not one per edge — #88); CSS
 * mitres its corners so a thick frame closes flush (#86) and a cell's own edges
 * can't chip each other (#80). The grid's physical frame (column A left, row 1
 * top) has no neighbour to draw a coincident copy, so the box edge there is
 * reinforced by a single-edge overlay (addBorderLine) to stay full-weight at
 * fractional zoom.
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

/** The overlay border elements currently on a cell element (box + reinforcers). */
const lines = (el) => el._children.filter((c) => c.className === 'grid-border-line');

/** The single box overlay carrying a cell's border sides (box-sizing:border-box). */
const boxOf = (el) => lines(el).find((l) => /box-sizing:\s*border-box/.test(l.style.cssText || ''));
/** Single-edge reinforcing overlays (the non-box lines, used at the grid frame). */
const reinforcers = (el) => lines(el).filter((l) => !/box-sizing:\s*border-box/.test(l.style.cssText || ''));
/** Map of side → CSS border shorthand for the sides the box actually paints. */
const boxSides = (el) => {
  const css = (boxOf(el) && boxOf(el).style.cssText) || '';
  const out = {};
  for (const s of ['top', 'right', 'bottom', 'left']) {
    const m = new RegExp(`border-${s}:\\s*([^;]+)`).exec(css);
    if (m) out[s] = m[1].trim();
  }
  return out;
};
/** The set of sides the box paints. */
const boxEdgeSet = (el) => new Set(Object.keys(boxSides(el)));
/** The box's positioning inset (px, signed number) for one side — the centring offset. */
const boxInset = (el, side) => {
  const css = (boxOf(el) && boxOf(el).style.cssText) || '';
  const m = new RegExp(`(?:^|;)\\s*${side}:\\s*(-?[\\d.]+)px`).exec(css);
  return m ? parseFloat(m[1]) : null;
};

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

test('interior vertical boundary is drawn by both neighbours (coincident boxes)', () => {
  const sandbox = createSandbox();
  // A1's right and B1's left describe the SAME shared boundary. A centred border
  // bleeds across it, so each cell's box draws its own copy: A1 its right, B1 its
  // left.
  sandbox.localCells = {
    A1: { style: { borders: { right: thin() } } },
    B1: { style: { borders: { left: thin() } } },
  };

  const elA = makeEl();
  const elB = makeEl();
  sandbox.applyCellBorders(elA, sandbox.localCells.A1.style, 'A1');
  sandbox.applyCellBorders(elB, sandbox.localCells.B1.style, 'B1');

  assert.deepStrictEqual([...boxEdgeSet(elA)], ['right'], 'A1 box paints the boundary as its right');
  assert.deepStrictEqual([...boxEdgeSet(elB)], ['left'], 'B1 box paints its own left copy (covers the half A1 bleeds in)');
});

test('interior horizontal boundary is drawn by both neighbours (coincident boxes)', () => {
  const sandbox = createSandbox();
  sandbox.localCells = {
    A1: { style: { borders: { bottom: thin() } } },
    A2: { style: { borders: { top: thin() } } },
  };

  const el1 = makeEl();
  const el2 = makeEl();
  sandbox.applyCellBorders(el1, sandbox.localCells.A1.style, 'A1');
  sandbox.applyCellBorders(el2, sandbox.localCells.A2.style, 'A2');

  assert.deepStrictEqual([...boxEdgeSet(el1)], ['bottom'], 'A1 box paints its bottom copy of the boundary');
  assert.deepStrictEqual([...boxEdgeSet(el2)], ['top'], 'A2 box paints its own top copy (covers the half A1 bleeds in)');
});

test('a fully framed interior cell draws all four of its own edges in one box', () => {
  const sandbox = createSandbox();
  // B2 framed on all sides, sitting amongst blank neighbours. B2's box paints its
  // own four edges; each shared boundary is ALSO drawn by the facing neighbour.
  sandbox.localCells = {
    B2: { style: { borders: { top: thin(), right: thin(), bottom: thin(), left: thin() } } },
  };
  const at = (id) => {
    const el = makeEl();
    const st = (sandbox.localCells[id] && sandbox.localCells[id].style) || {};
    sandbox.applyCellBorders(el, st, id);
    return el;
  };

  const elB2 = at('B2');
  const elA2 = at('A2'); // left neighbour: draws B2's left boundary as its own right
  const elB1 = at('B1'); // top neighbour: draws B2's top boundary as its own bottom

  // B2 emits ONE box carrying all four of its edges.
  assert.strictEqual(lines(elB2).length, 1, 'B2 draws a single box overlay');
  assert.strictEqual(boxEdgeSet(elB2).size, 4, 'B2 box paints its own four edges');
  // Each shared boundary is redrawn by the facing neighbour's coincident box.
  assert.ok(boxSides(elA2).right, 'A2 redraws B2 left boundary as its own right');
  assert.ok(boxSides(elB1).bottom, 'B1 redraws B2 top boundary as its own bottom');
});

test('grid outer edges (column A / row 1) draw their own left / top, reinforced', () => {
  const sandbox = createSandbox();
  sandbox.localCells = {
    A1: { style: { borders: { left: thin(), top: thin() } } },
  };
  const elA1 = makeEl();
  sandbox.applyCellBorders(elA1, sandbox.localCells.A1.style, 'A1');

  // No preceding neighbour exists for column A / row 1, so A1's box draws both —
  // and because there's no neighbour to draw the second coincident copy, each
  // frame edge gets a reinforcing single-edge overlay (see next test).
  assert.deepStrictEqual([...boxEdgeSet(elA1)].sort(), ['left', 'top'], 'A1 box paints its own left and top');
  assert.strictEqual(reinforcers(elA1).length, 2, 'the two frame edges are each reinforced once');
});

test('the grid frame (column A left / row 1 top) is reinforced so it is not thinner than the other sides', () => {
  // An interior shared edge is drawn by both neighbours; the two coincident boxes
  // reinforce each other so the edge keeps full weight even when its boundary
  // lands on a fractional device pixel (e.g. at 150% zoom). The grid frame has no
  // neighbour to draw that second copy, so a lone box edge there anti-aliases to
  // half intensity and looks thinner. The frame cell adds a single-edge copy that
  // coincides with the box edge. Both the box edge and the reinforcer stay CENTRED
  // (offset -1.5 for thick), never inset.
  const sandbox = createSandbox();
  sandbox.localCells = { A1: { style: { borders: { left: thick(), top: thick() } } } };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.A1.style, 'A1');

  assert.strictEqual(boxInset(el, 'left'), -1.5, 'box left edge stays centred (-1.5px)');
  assert.strictEqual(boxInset(el, 'top'), -1.5, 'box top edge stays centred (-1.5px)');
  const css = reinforcers(el).map((l) => l.style.cssText || '');
  const reLeft = css.filter((c) => /width:0;\s*left:\s*-1\.5px/.test(c));
  const reTop = css.filter((c) => /height:0;\s*top:\s*-1\.5px/.test(c));
  assert.strictEqual(reLeft.length, 1, 'left frame edge reinforced by one coincident centred copy');
  assert.strictEqual(reTop.length, 1, 'top frame edge reinforced by one coincident centred copy');
});

test('an interior left/top edge (not on the grid frame) stays centred and unreinforced', () => {
  // An interior cell's left/top straddle the boundary, backed by the neighbour's
  // own coincident box — so they need no single-edge reinforcer.
  const sandbox = createSandbox();
  sandbox.localCells = { C3: { style: { borders: { left: thick(), top: thick() } } } };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.C3.style, 'C3');

  assert.strictEqual(boxInset(el, 'left'), -1.5, 'interior left must be centred (-1.5px)');
  assert.strictEqual(boxInset(el, 'top'), -1.5, 'interior top must be centred (-1.5px)');
  assert.strictEqual(reinforcers(el).length, 0, 'an interior edge is not reinforced (the neighbour draws the second copy)');
});

const thick = () => ({ color: '#000000', style: 'thick' });

test('a thick border is centred on the boundary, half its width each side', () => {
  // Borders straddle the boundary (Excel/Sheets behaviour). A 3px thick border
  // sits 1.5px each side. The gridline-bearing sides (right/bottom) reference a
  // padding box GRIDLINE_W (1px) inside the boundary, so their inset is
  // -(GRIDLINE_W + w/2) = -2.5px; the borderless sides (left/top) reference a
  // padding box on the boundary, so their inset is -w/2 = -1.5px. The box is safe
  // to bleed because the facing neighbour draws its own coincident box.
  const sandbox = createSandbox();
  sandbox.localCells = { B2: { style: { borders: { top: thick(), right: thick(), bottom: thick(), left: thick() } } } };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.B2.style, 'B2');

  assert.strictEqual(boxEdgeSet(el).size, 4, 'B2 box draws all four of its own edges');
  // Gridline sides: -(1 + 1.5) = -2.5px. Borderless sides: -1.5px.
  assert.strictEqual(boxInset(el, 'right'), -2.5, 'right edge must be centred (-2.5px)');
  assert.strictEqual(boxInset(el, 'bottom'), -2.5, 'bottom edge must be centred (-2.5px)');
  assert.strictEqual(boxInset(el, 'left'), -1.5, 'left edge must be centred (-1.5px)');
  assert.strictEqual(boxInset(el, 'top'), -1.5, 'top edge must be centred (-1.5px)');
  // Each side is drawn at its full integer width so weights stay distinct.
  const sides = boxSides(el);
  ['top', 'right', 'bottom', 'left'].forEach((s) =>
    assert.ok(/^3px /.test(sides[s]), `${s} drawn at full thick width (3px), got: ${sides[s]}`));
});

test('a cell draws ONE box that mitres its corners closed (#82, #86, #80)', () => {
  // The four edges are a single box element, so CSS mitres the corners flush — a
  // thick frame closes with no notch (#86, was a fixed-overrun shortfall), and a
  // cell's own edges share one element so neither can chip the other at a crossing
  // (#80, was an overlay-line paint-order artefact). C3 (interior) draws all four
  // edges with no frame reinforcement (that applies only at column A / row 1).
  const sandbox = createSandbox();
  sandbox.localCells = { C3: { style: { borders: { top: thick(), right: thick(), bottom: thick(), left: thick() } } } };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.C3.style, 'C3');

  assert.strictEqual(lines(el).length, 1, 'an interior framed cell draws exactly one box');
  assert.ok(boxOf(el), 'the overlay is a border-box');
  assert.strictEqual(boxEdgeSet(el).size, 4, 'the box paints all four sides');
});

test('the box centres each border on its boundary, inset by half the weight (#85, #86)', () => {
  // In the box model the corner closes by CSS mitre at any weight; what scales
  // with weight is the centring inset (-half on the near sides). thin = -0.5,
  // medium = -1, thick = -1.5.
  const sandbox = createSandbox();
  const leftInset = (style) => {
    sandbox.localCells = { C3: { style: { borders: { top: { color: '#000', style }, left: { color: '#000', style } } } } };
    const el = makeEl();
    sandbox.applyCellBorders(el, sandbox.localCells.C3.style, 'C3');
    return boxInset(el, 'left');
  };
  assert.strictEqual(leftInset('thin'), -0.5, 'thin centred (half = 0.5)');
  assert.strictEqual(leftInset('medium'), -1, 'medium centred (half = 1)');
  assert.strictEqual(leftInset('thick'), -1.5, 'thick centred (half = 1.5)');
});

const edgeSet = (el) => boxEdgeSet(el);

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

test('a cell\'s edges share one box, so none can chip another at a crossing (#80)', () => {
  // Regression (#80): when each edge was a separate overlay line sharing one
  // z-index, a horizontal line spanning the full track chipped a gap out of a
  // differently-coloured perpendicular vertical at every crossing (the reported
  // broken right edge / intact left edge asymmetry), which a deterministic
  // append order had to work around. With one box per cell the four edges are a
  // single element and CSS mitres their shared corners — there are no separate
  // line elements to mis-order, so the chipping cannot occur. Mixed weights still
  // all live in the one box.
  const sandbox = createSandbox();
  // C3 (interior): thick top/bottom horizontals, thin left/right verticals.
  sandbox.localCells = {
    C3: { style: { borders: { top: thick(), bottom: thick(), left: thin(), right: thin() } } },
  };
  const el = makeEl();
  sandbox.applyCellBorders(el, sandbox.localCells.C3.style, 'C3');

  assert.strictEqual(lines(el).length, 1, 'every edge is carried by a single box element');
  const sides = boxSides(el);
  assert.ok(/^3px /.test(sides.top) && /^3px /.test(sides.bottom), 'thick horizontals present in the box');
  assert.ok(/^1px /.test(sides.left) && /^1px /.test(sides.right), 'thin verticals present in the box');
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

// Column letter for a 0-based index (A, B, … Z, AA, …) — mirrors getColLetter.
const colLetterFor = (c) => {
  let s = '';
  c += 1;
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
};

test('rendering a fully-bordered sheet stays within the 1s budget (#88)', () => {
  // The grid is not virtualised: every render walks all TOTAL_ROWS (1000) rows ×
  // colCount columns and calls applyCellBorders on each cell — even blank ones,
  // since a bordered neighbour's edge is drawn into the blank cell beside it. On a
  // borders-heavy sheet (a fully gridded table) the old renderer emitted ~4 overlay
  // <div>s per cell (~100k extra nodes for a 1000×26 grid); laying out and painting
  // that many absolutely-positioned overlays froze opening / switching for seconds
  // (#88). Collapsing a cell's four edges into ONE box overlay cut that to ~1 node
  // per cell (~26k, plus a reinforcer per grid-frame cell). This guards the JS half
  // of the pass against an accidental super-linear regression: the whole-grid border
  // pass must finish well inside one second. (Browser layout/paint cost is not
  // measurable here, but it scales with the overlay-node count this fix slashed.)
  const ROWS = 1000, COLS = 26;
  const sandbox = createSandbox();
  const allFour = { borders: { top: thick(), right: thick(), bottom: thick(), left: thick() } };
  const cells = {};
  for (let r = 1; r <= ROWS; r++)
    for (let c = 0; c < COLS; c++) cells[`${colLetterFor(c)}${r}`] = { style: allFour };
  sandbox.localCells = cells;

  const t0 = process.hrtime.bigint();
  for (let r = 1; r <= ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const id = `${colLetterFor(c)}${r}`;
      sandbox.applyCellBorders(makeEl(), cells[id].style, id);
    }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.ok(elapsedMs < 1000,
    `border render pass over ${ROWS * COLS} cells must finish within 1s, took ${elapsedMs.toFixed(0)}ms`);
});
