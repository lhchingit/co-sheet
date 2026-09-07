process.env.NODE_ENV = 'test';

/**
 * @file ws-file-key.test.js
 * @description The `?file=` parameter used to be sent only when a real file was
 * open, because the server defaults an absent one to the legacy 'default' workbook
 * anyway. That stopped being harmless once routing depends on it.
 *
 * The parameter is the key a file-affine load balancer hashes on to send everyone
 * editing one file to one replica (#273). A request that omits it gives the proxy
 * nothing to hash, so it picks an arbitrary backend — which meant 'default', the one
 * workbook every signed-in user may edit, was the only file with no affinity at all.
 *
 * These read the URL the client actually builds, in a sandbox with no `?file=` on the
 * page (the 'default' case, the one that used to be wrong). Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';
import { createMockElement } from './helpers/cell-editor-sandbox.js';

/**
 * Boot the client bundle with `search` on window.location, and hand back the socket
 * URL it decided on.
 * @param {string} search e.g. '' or '?file=<24 hex>'
 * @returns {{ wsUrl: string, opened: string[] }}
 */
function bootClient(search) {
  const opened = [];
  const sandbox = {
    document: {
      getElementById: () => createMockElement(),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      createElement: () => createMockElement(),
      createDocumentFragment: () => createMockElement('#fragment'),
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      activeElement: { tagName: 'BODY', getAttribute: () => null }
    },
    getComputedStyle: () => ({ color: '' }),
    window: {
      location: { protocol: 'http:', host: 'localhost:3000', search, origin: 'http://localhost:3000' },
      addEventListener() {}
    },
    navigator: { clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') } },
    // Record what the client tries to connect to; never actually opens anything.
    WebSocket: class {
      static OPEN = 1;
      constructor(url) { opened.push(url); this.readyState = 1; }
      send() {}
      close() {}
    },
    URLSearchParams,
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    setTimeout: () => {},
    clearTimeout: () => {},
    queueMicrotask: (fn) => fn(),
    console, Math, parseFloat, parseInt, isNaN, isFinite, encodeURIComponent,
    String, Object, Array, JSON, Date, Number, Set, Map, RegExp, Promise, Error
  };

  vm.createContext(sandbox);
  // Top-level const/let in a vm script stay in the script's own lexical scope, so the
  // value has to be handed out explicitly — the same trick the other bundle tests use.
  vm.runInContext(readAppBundle() + '\nglobalThis.__wsUrl = wsUrl;', sandbox);
  return { wsUrl: sandbox.__wsUrl, opened };
}

test('the socket URL names the default workbook explicitly', () => {
  // --- Arrange / Act: no ?file= on the page, i.e. the legacy 'default' workbook. ---
  const { wsUrl } = bootClient('');

  // --- Assert ---
  assert.match(wsUrl, /[?&]file=default(&|$)/, 'the default workbook must be named, not implied');
  assert.ok(wsUrl.startsWith('ws://localhost:3000/'), `unexpected base: ${wsUrl}`);
});

test('the socket URL carries a real file id when one is open', () => {
  // --- Arrange ---
  const fileId = 'a1b2c3d4e5f6a1b2c3d4e5f6'; // 24 hex, the shape POST /api/files mints

  // --- Act ---
  const { wsUrl } = bootClient(`?file=${fileId}`);

  // --- Assert ---
  assert.match(wsUrl, new RegExp(`[?&]file=${fileId}(&|$)`), 'an open file is named');
});

test('an unusable file id still yields a hashable key rather than none', () => {
  // --- Arrange: the client only accepts a 24-hex id, so these all resolve to the
  //     default workbook. Previously that meant sending no key whatsoever. ---
  for (const search of ['?file=', '?file=not-a-file-id', '?other=1']) {
    // --- Act ---
    const { wsUrl } = bootClient(search);

    // --- Assert ---
    assert.match(
      wsUrl, /[?&]file=default(&|$)/,
      `an unusable id must fall back to a named default, not an absent key (${search})`
    );
  }
});
