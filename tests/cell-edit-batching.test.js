process.env.NODE_ENV = 'test';

/**
 * @file cell-edit-batching.test.js
 * @description A bulk edit is written one cell at a time, so the client used to
 * emit one `cell-edit` per cell — each costing the server a validate, a
 * whole-workbook write and a fan-out. Outgoing edits are now collected for the
 * rest of the task and flushed as a single `cell-edit-bulk` (see
 * applySendWrapper), and peers receive one `cell-update-bulk` in return.
 *
 * These tests run microtasks on demand rather than inline, which is what makes
 * the batching observable: with an immediate queueMicrotask (as the other client
 * sandboxes use) each edit flushes alone and no batch ever forms. Follows the AAA
 * pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';
import { createMockElement } from './helpers/cell-editor-sandbox.js';

/** Boots the bundle with a capturing socket and a hand-driven microtask queue. */
function createSandbox() {
  const sentMessages = [];
  const microtasks = [];
  const cellsDOM = {};

  const sandbox = {
    document: {
      getElementById: () => createMockElement(),
      querySelectorAll: () => [],
      querySelector(selector) {
        const m = selector.match(/\[data-cell-id="([^"]+)"\]/);
        if (!m) return null;
        if (!cellsDOM[m[1]]) cellsDOM[m[1]] = createMockElement();
        return cellsDOM[m[1]];
      },
      addEventListener() {},
      createElement: () => createMockElement(),
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: () => ({ color: '' }),
    window: { location: { protocol: 'http:', host: 'localhost:3000' }, addEventListener() {} },
    navigator: { clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') } },
    WebSocket: class {
      static OPEN = 1;
      constructor() { this.readyState = 1; }
      send(msg) { sentMessages.push(JSON.parse(msg)); }
    },
    setTimeout: () => {},
    clearTimeout: () => {},
    // The point of this sandbox: microtasks queue instead of running inline.
    queueMicrotask: (fn) => microtasks.push(fn),
    console, Math, parseFloat, parseInt, isNaN, isFinite,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp
  };

  vm.createContext(sandbox);
  vm.runInContext(readAppBundle() + `
    Object.defineProperty(globalThis, 'localCells', {
      get: () => localCells, set: (v) => { localCells = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'activeCellId', {
      get: () => activeCellId, set: (v) => { activeCellId = v; }, configurable: true
    });
    Object.defineProperty(globalThis, 'localSheets', { get: () => localSheets, configurable: true });
    globalThis.pasteCellGrid = pasteCellGrid;
    globalThis.saveCellUpdate = saveCellUpdate;
    globalThis.setActiveColCount = setActiveColCount;
    globalThis.handleSocketMessage = handleSocketMessage;
  `, sandbox);

  sandbox.sentMessages = sentMessages;
  /** Runs everything queued so far, as the event loop would at the end of a task. */
  sandbox.flushMicrotasks = () => {
    const due = microtasks.splice(0, microtasks.length);
    due.forEach((fn) => fn());
  };
  sentMessages.length = 0; // drop anything the bundle's own start-up sent
  return sandbox;
}

/** A `rows` x 1 paste grid. pasteCellGrid takes { text, style } cells per row. */
const column = (rows) => Array.from({ length: rows }, (_, i) => [{ text: `v${i + 1}` }]);

test('a multi-cell edit goes out as ONE cell-edit-bulk carrying every cell', () => {
  // --- Arrange ---
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'A1';

  // --- Act ---
  s.pasteCellGrid([[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }, { text: 'd' }]]);
  s.flushMicrotasks();

  // --- Assert ---
  const bulk = s.sentMessages.filter((m) => m.type === 'cell-edit-bulk');
  assert.strictEqual(bulk.length, 1, 'four written cells produce a single message');
  assert.strictEqual(
    s.sentMessages.filter((m) => m.type === 'cell-edit').length, 0,
    'and no per-cell messages alongside it'
  );
  const ids = bulk[0].payload.cells.map((c) => c.cellId).sort();
  assert.deepStrictEqual(ids, ['A1', 'A2', 'B1', 'B2'], 'every written cell is in the batch');
  // The sheet each edit belongs to still travels with it.
  assert.ok(bulk[0].payload.cells.every((c) => c.sheetName === 'Sheet1'), 'each entry keeps its sheet');
});

test('a single-cell edit still goes out as a plain cell-edit', () => {
  // The interactive path is the common one; batching must not change its shape.
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'A1';

  s.saveCellUpdate('A1', 'hello');
  s.flushMicrotasks();

  const types = s.sentMessages.map((m) => m.type);
  assert.ok(types.includes('cell-edit'), 'a lone edit keeps the single-cell wire format');
  assert.ok(!types.includes('cell-edit-bulk'), 'and is not wrapped in a batch');
});

test('a following op never overtakes the edits queued before it', () => {
  // The batch is flushed on a microtask, so an op sent later in the same task
  // would arrive first unless sending it flushes the queue — and ordering matters
  // when the later op is something like a column-count change.
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'A1';

  s.pasteCellGrid([[{ text: 'a' }, { text: 'b' }]]); // queued, not yet sent
  s.setActiveColCount(40);          // must flush the queue ahead of itself
  s.flushMicrotasks();

  const order = s.sentMessages.map((m) => m.type);
  assert.deepStrictEqual(
    order, ['cell-edit-bulk', 'set-col-count'],
    'the edits are on the wire before the op that followed them'
  );
});

test('a burst larger than the cap is chunked, never sent over it', () => {
  const s = createSandbox();
  s.localCells = {};
  s.activeCellId = 'A1';

  s.pasteCellGrid(column(700));      // over the 500-cell cap
  s.flushMicrotasks();

  const bulk = s.sentMessages.filter((m) => m.type === 'cell-edit-bulk');
  assert.strictEqual(bulk.length, 2, '700 cells are split into two messages');
  assert.ok(bulk.every((m) => m.payload.cells.length <= 500), 'no message exceeds the cap');
  assert.strictEqual(
    bulk.reduce((n, m) => n + m.payload.cells.length, 0), 700,
    'and every cell is still sent exactly once'
  );
});

test('an inbound cell-update-bulk applies every cell it carries', () => {
  // The receive side mirrors the send side: peers get one message for the batch.
  const s = createSandbox();
  s.localCells = {};

  s.handleSocketMessage({
    data: JSON.stringify({
      type: 'cell-update-bulk',
      payload: {
        cells: [
          { cellId: 'A1', formula: '', value: '1', style: {}, sheetName: 'Sheet1' },
          { cellId: 'A2', formula: '', value: '2', style: { bold: true }, sheetName: 'Sheet1' }
        ]
      }
    })
  });

  assert.strictEqual(s.localSheets.Sheet1.A1.value, '1');
  assert.strictEqual(s.localSheets.Sheet1.A2.value, '2');
  assert.deepStrictEqual(s.localSheets.Sheet1.A2.style, { bold: true });
});
