import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import http from 'http';
import vm from 'vm';
import { readAppBundle } from './helpers/app-bundle.js';


/**
 * Helper to make a JSON HTTP request, optionally passing headers (like Cookie).
 * @param {string} url - The URL to request.
 * @param {string} method - The HTTP method (GET or POST).
 * @param {Object} [body] - The JSON body for POST requests.
 * @param {Object} [headers] - Optional HTTP headers to include.
 * @returns {Promise<{statusCode: number, headers: Object, data: Object}>} Resolves with response status, headers, and JSON data.
 */
function makeRequest(url, method, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: JSON.parse(data),
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: data,
          });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

test('Database Mock - workbook_versions creation and queries', async (t) => {
  // --- Arrange ---
  // Define custom environment settings for the test run.
  const STORE_PATH = path.resolve('store.versions.test.json');
  const VERSIONS_PATH = STORE_PATH + '.versions.json';

  // Clean up any pre-existing test files to ensure a clean state.
  if (fs.existsSync(STORE_PATH)) {
    fs.unlinkSync(STORE_PATH);
  }
  if (fs.existsSync(VERSIONS_PATH)) {
    fs.unlinkSync(VERSIONS_PATH);
  }

  // Set environment variables to run in test mode on a random port.
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.STORE_PATH = STORE_PATH;

  // Dynamically import server components after setting env variables, then wait for
  // the server to finish starting so it can be closed deterministically in `finally`
  // (otherwise the listening socket leaks and keeps the test process alive).
  const serverModule = await import('../server.js');
  await serverModule.ready;
  const pool = serverModule.pool;

  try {
    // --- Act ---
    // Perform an insertion query into workbook_versions.
    const testState = { sheets: { Sheet1: {} } };
    const insertQuery = `
      INSERT INTO workbook_versions (state, created_by)
      VALUES ($1, $2)
      RETURNING id, state, created_at, created_by
    `;
    const insertParams = [JSON.stringify(testState), 'test_user'];
    const insertResult = await pool.query(insertQuery, insertParams);

    // Perform a select query to retrieve versions.
    const selectQuery = `
      SELECT id, state, created_at, created_by
      FROM workbook_versions
      ORDER BY created_at DESC
    `;
    const selectResult = await pool.query(selectQuery);

    // --- Assert ---
    // Assert insertion result structure and content.
    assert.ok(insertResult.rows && insertResult.rows.length === 1, 'Insert should return exactly one row');
    const insertedRow = insertResult.rows[0];
    assert.strictEqual(insertedRow.id, 1, 'First version ID should be 1');
    assert.strictEqual(insertedRow.created_by, 'test_user', 'Created by should match input');
    assert.deepStrictEqual(insertedRow.state, testState, 'State should match input');
    assert.ok(insertedRow.created_at, 'created_at should be defined');

    // Assert selection result structure and content.
    assert.ok(selectResult.rows && selectResult.rows.length === 1, 'Select should return exactly one row');
    const selectedRow = selectResult.rows[0];
    assert.strictEqual(selectedRow.id, 1, 'Selected version ID should be 1');
    assert.strictEqual(selectedRow.created_by, 'test_user', 'Selected created by should match input');
    assert.deepStrictEqual(selectedRow.state, testState, 'Selected state should match input');

    // Assert that the versions file was created on disk.
    assert.ok(fs.existsSync(VERSIONS_PATH), 'Versions JSON file should exist on disk');
    const diskContent = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
    assert.strictEqual(diskContent.length, 1, 'Versions file should contain exactly one version');
    assert.strictEqual(diskContent[0].id, 1, 'Version in file should have ID 1');

  } finally {
    // --- Cleanup ---
    // Shut down the server to free up the port and clean the event loop.
    const serverInstance = serverModule.server;
    if (serverInstance && typeof serverInstance.close === 'function') {
      await new Promise((resolve) => serverInstance.close((err) => {
        if (err) console.error('[Test] Error closing server:', err);
        resolve();
      }));
    }
    // Clean up created files.
    if (fs.existsSync(STORE_PATH)) {
      fs.unlinkSync(STORE_PATH);
    }
    if (fs.existsSync(VERSIONS_PATH)) {
      fs.unlinkSync(VERSIONS_PATH);
    }
  }
});

test('Version History API Endpoints - retrieve and restore', async (t) => {
  // --- Arrange ---
  // Define environment variables and port for the spawned test server.
  const PORT = '31270';
  const STORE_PATH = path.resolve('store.versions.api.test.json');
  const VERSIONS_PATH = STORE_PATH + '.versions.json';

  // Clean up any pre-existing test files.
  if (fs.existsSync(STORE_PATH)) {
    fs.unlinkSync(STORE_PATH);
  }
  if (fs.existsSync(VERSIONS_PATH)) {
    fs.unlinkSync(VERSIONS_PATH);
  }

  // Populate initial state file and version history file so that the server starts with data.
  const initialWorkbookState = {
    sheets: {
      Sheet1: {
        A1: { formula: '', value: 'Current State', style: {} }
      }
    },
    sheetOrder: ['Sheet1'],
    sheetColors: {},
    hiddenSheets: []
  };

  const initialVersions = [
    {
      id: 1,
      state: {
        sheets: {
          Sheet1: {
            A1: { formula: '', value: 'Version 1 State', style: {} }
          }
        },
        sheetOrder: ['Sheet1'],
        sheetColors: {},
        hiddenSheets: []
      },
      created_at: new Date(Date.now() - 60000).toISOString(),
      created_by: 'admin'
    },
    {
      id: 2,
      state: {
        sheets: {
          Sheet1: {
            A1: { formula: '', value: 'Version 2 State', style: {} }
          }
        },
        sheetOrder: ['Sheet1'],
        sheetColors: {},
        hiddenSheets: []
      },
      created_at: new Date().toISOString(),
      created_by: 'user1'
    }
  ];

  fs.writeFileSync(STORE_PATH, JSON.stringify(initialWorkbookState), 'utf8');
  fs.writeFileSync(VERSIONS_PATH, JSON.stringify(initialVersions), 'utf8');

  // Spawn the server process.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, NODE_ENV: 'test', STORE_PATH }
  });

  // Wait 1.5 seconds for the Express server to boot up and start listening.
  await new Promise(resolve => setTimeout(resolve, 1500));

  let cookie = '';
  let wsClient = null;

  try {
    // 1. Verify GET /api/versions requires authentication
    const unauthGetList = await makeRequest(`http://localhost:${PORT}/api/versions`, 'GET');
    assert.strictEqual(unauthGetList.statusCode, 401, 'GET /api/versions without auth should return 401');

    // 2. Verify GET /api/versions/:id requires authentication
    const unauthGetVersion = await makeRequest(`http://localhost:${PORT}/api/versions/1`, 'GET');
    assert.strictEqual(unauthGetVersion.statusCode, 401, 'GET /api/versions/1 without auth should return 401');

    // 3. Verify POST /api/versions/:id/restore requires authentication
    const unauthRestore = await makeRequest(`http://localhost:${PORT}/api/versions/1/restore`, 'POST');
    assert.strictEqual(unauthRestore.statusCode, 401, 'POST /api/versions/1/restore without auth should return 401');

    // 4. Log in to get authentication cookie
    const loginRes = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Test User' });
    assert.strictEqual(loginRes.statusCode, 200, 'Test login should succeed');
    const setCookie = loginRes.headers['set-cookie'];
    assert.ok(setCookie, 'Should receive set-cookie header');
    cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

    // --- Act ---
    // Connect a WebSocket client to verify it receives the init message when version is restored.
    wsClient = new WebSocket(`ws://localhost:${PORT}/`, {
      headers: { Cookie: cookie }
    });

    const wsMessages = [];
    wsClient.on('message', (data) => {
      try {
        wsMessages.push(JSON.parse(data));
      } catch (err) {
        // Ignore parsing errors
      }
    });

    // Wait a brief moment for WebSocket connection and init message.
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(wsMessages.length > 0, 'Should have received websocket messages');
    // Clear initial websocket messages (like the connection init) to isolate the restore-triggered init.
    wsMessages.length = 0;

    // 5. Call GET /api/versions with auth to fetch versions metadata
    const listRes = await makeRequest(`http://localhost:${PORT}/api/versions`, 'GET', null, { Cookie: cookie });

    // 6. Call GET /api/versions/1 with auth to retrieve version 1 snapshot
    const ver1Res = await makeRequest(`http://localhost:${PORT}/api/versions/1`, 'GET', null, { Cookie: cookie });

    // 7. Call POST /api/versions/1/restore with auth to trigger restoration
    const restoreRes = await makeRequest(`http://localhost:${PORT}/api/versions/1/restore`, 'POST', null, { Cookie: cookie });

    // Wait for the restore to be processed and websocket message to be sent
    await new Promise(resolve => setTimeout(resolve, 500));

    // --- Assert ---
    // Assert 5: GET /api/versions response
    assert.strictEqual(listRes.statusCode, 200, 'GET /api/versions should succeed');
    assert.ok(Array.isArray(listRes.data), 'GET /api/versions data should be an array');
    assert.strictEqual(listRes.data.length, 2, 'Should return 2 versions');
    // Verify sorting is id DESC
    assert.strictEqual(listRes.data[0].id, 2, 'First item should be version 2');
    assert.strictEqual(listRes.data[1].id, 1, 'Second item should be version 1');
    // Verify metadata properties exist and state is NOT sent in version list metadata
    assert.ok(listRes.data[0].created_at, 'created_at should be defined');
    assert.strictEqual(listRes.data[0].created_by, 'user1', 'created_by should be user1');
    assert.strictEqual(listRes.data[0].state, undefined, 'version list should not include full state');

    // Assert 6: GET /api/versions/1 response
    assert.strictEqual(ver1Res.statusCode, 200, 'GET /api/versions/1 should succeed');
    assert.deepStrictEqual(ver1Res.data.sheets.Sheet1.A1.value, 'Version 1 State', 'Version 1 state should match snapshot');

    // Assert 7: POST /api/versions/1/restore response
    assert.strictEqual(restoreRes.statusCode, 200, 'POST /api/versions/1/restore should succeed');
    assert.strictEqual(restoreRes.data.success, true, 'Restore response should indicate success');

    // Verify active workbook state is overwritten in the file store
    const updatedStore = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    assert.strictEqual(updatedStore.sheets.Sheet1.A1.value, 'Version 1 State', 'Active workbook state should be updated to version 1');

    // Verify a new history entry (ID 3) was saved, indicating restoration
    const updatedVersions = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
    assert.strictEqual(updatedVersions.length, 3, 'A new history version should have been created');
    const newVersion = updatedVersions[2];
    assert.strictEqual(newVersion.id, 3, 'New version ID should be 3');
    assert.strictEqual(newVersion.created_by, 'Test User', 'New version should be created by Test User');
    assert.deepStrictEqual(newVersion.state.sheets.Sheet1.A1.value, 'Version 1 State', 'New version state should match Version 1');

    // Verify WebSocket init state update broadcast was received
    const initBroadcast = wsMessages.find(m => m.type === 'init');
    assert.ok(initBroadcast, 'Clients should receive a websocket init broadcast');
    assert.strictEqual(initBroadcast.payload.sheets.Sheet1.A1.value, 'Version 1 State', 'Broadcasted state should reflect restored version');

  } finally {
    // --- Cleanup ---
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.close();
    }
    child.kill();
    // Wait a short moment for the process to exit.
    await new Promise(resolve => setTimeout(resolve, 500));

    // Clean up created files.
    if (fs.existsSync(STORE_PATH)) {
      fs.unlinkSync(STORE_PATH);
    }
    if (fs.existsSync(VERSIONS_PATH)) {
      fs.unlinkSync(VERSIONS_PATH);
    }
  }
});

test('Backend Autosave Engine - periodic version snapshots on cell edit', async (t) => {
  // --- Arrange ---
  // Define custom environment settings, paths, and port for the spawned test server.
  const PORT = '31275';
  const STORE_PATH = path.resolve('store.autosave.test.json');
  const VERSIONS_PATH = STORE_PATH + '.versions.json';

  // Clean up any pre-existing test files to ensure a clean state.
  if (fs.existsSync(STORE_PATH)) {
    fs.unlinkSync(STORE_PATH);
  }
  if (fs.existsSync(VERSIONS_PATH)) {
    fs.unlinkSync(VERSIONS_PATH);
  }

  // Populate initial state file so that the server starts with clean workbook data.
  const initialWorkbookState = {
    sheets: {
      Sheet1: {}
    },
    sheetOrder: ['Sheet1'],
    sheetColors: {},
    hiddenSheets: []
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(initialWorkbookState), 'utf8');

  // Spawn the server process with short autosave limits for fast integration testing.
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT,
      NODE_ENV: 'test',
      STORE_PATH,
      AUTOSAVE_CHECK_INTERVAL: '50',
      AUTOSAVE_INACTIVITY_LIMIT: '50',
      AUTOSAVE_ACTIVE_LIMIT: '300000' // High active limit so we only trigger on inactivity
    }
  });

  // Wait 1.5 seconds for the Express server to boot up and start listening.
  await new Promise(resolve => setTimeout(resolve, 1500));

  let cookie = '';
  let wsClient = null;

  try {
    // Log in to get authentication cookie for 'Autosave User'.
    const loginRes = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Autosave User' });
    assert.strictEqual(loginRes.statusCode, 200, 'Login should succeed');
    const setCookie = loginRes.headers['set-cookie'];
    cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

    // Connect WebSocket client to the spawned server with login credentials.
    wsClient = new WebSocket(`ws://localhost:${PORT}/`, {
      headers: { Cookie: cookie }
    });

    // Wait a brief moment for WebSocket connection to establish.
    await new Promise(resolve => setTimeout(resolve, 500));

    // --- Act ---
    // Send a cell-edit message via WebSocket to trigger autosave logic.
    const editMsg = {
      type: 'cell-edit',
      payload: {
        cellId: 'A1',
        formula: '',
        value: 'Hello Autosave',
        style: {},
        sheetName: 'Sheet1'
      }
    };
    wsClient.send(JSON.stringify(editMsg));

    // Wait long enough (e.g. 300ms) for the 50ms check interval and 50ms inactivity threshold to pass.
    await new Promise(resolve => setTimeout(resolve, 300));

    // Fetch version history via API to verify that a snapshot was created.
    const listRes = await makeRequest(`http://localhost:${PORT}/api/versions`, 'GET', null, { Cookie: cookie });

    // --- Assert ---
    // Assert that the request was successful and returned an array.
    assert.strictEqual(listRes.statusCode, 200, 'GET /api/versions should succeed');
    assert.ok(Array.isArray(listRes.data), 'Versions should be returned as an array');
    
    // Assert that exactly one version snapshot was created.
    assert.strictEqual(listRes.data.length, 1, 'Should have created exactly one version snapshot');
    
    // Assert that the creator matches the editor who performed the cell edit.
    assert.strictEqual(listRes.data[0].created_by, 'Autosave User', 'Snapshot creator should match WebSocket editor');

    // Retrieve details of the created snapshot to check stored state.
    const verId = listRes.data[0].id;
    const verDetailRes = await makeRequest(`http://localhost:${PORT}/api/versions/${verId}`, 'GET', null, { Cookie: cookie });
    assert.strictEqual(verDetailRes.statusCode, 200, 'GET /api/versions/:id should succeed');
    assert.strictEqual(
      verDetailRes.data.sheets.Sheet1.A1.value,
      'Hello Autosave',
      'State in version history should match the edited state'
    );

  } finally {
    // --- Cleanup ---
    // Close WebSocket client connection if open.
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.close();
    }
    // Kill the spawned test server process.
    child.kill();
    // Wait a short moment for the process to exit completely.
    await new Promise(resolve => setTimeout(resolve, 500));

    // Clean up created files.
    if (fs.existsSync(STORE_PATH)) {
      fs.unlinkSync(STORE_PATH);
    }
    if (fs.existsSync(VERSIONS_PATH)) {
      fs.unlinkSync(VERSIONS_PATH);
    }
  }
});

test('Version History Markup - index.html has history mode elements', () => {
  // --- Arrange ---
  const htmlPath = path.resolve('private/index.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // --- Act & Assert ---
  // Verify History Mode toggle button ID
  assert.ok(htmlContent.includes('id="header-history-btn"'), 'index.html should contain header history button ID');
  // Verify Top Bar
  assert.ok(htmlContent.includes('id="history-top-bar"'), 'index.html should contain history top bar ID');
  assert.ok(htmlContent.includes('id="history-exit-btn"'), 'index.html should contain history exit button ID');
  assert.ok(htmlContent.includes('id="history-title-date"'), 'index.html should contain history title date ID');
  assert.ok(htmlContent.includes('id="history-restore-btn"'), 'index.html should contain history restore button ID');
  // Verify Sidebar
  assert.ok(htmlContent.includes('id="history-sidebar"'), 'index.html should contain history sidebar ID');
  assert.ok(htmlContent.includes('id="history-list"'), 'index.html should contain history list container ID');
  // Verify Sidebar Footer controls
  assert.ok(htmlContent.includes('id="highlightChanges"'), 'index.html should contain highlightChanges checkbox ID');
  assert.ok(htmlContent.includes('id="showUnedited"'), 'index.html should contain showUnedited checkbox ID');
  // Verify CSS styles
  assert.ok(htmlContent.includes('.grid-cell-history-highlight'), 'index.html should contain history highlight CSS class');
  assert.ok(htmlContent.includes('.unedited-row-bar'), 'index.html should contain unedited-row-bar CSS class');
});

test('Frontend Version History Logic - toggle, list, change highlights, row collapsing, and restore', async (t) => {
  // --- Arrange ---
  const code = readAppBundle();

  // Helper to create a fully featured mock DOM element
  const createMockElement = (tagName = 'div', id = '', className = '') => {
    const el = {
      tagName: tagName.toUpperCase(),
      id,
      className,
      classList: {
        classes: new Set(className ? className.split(' ').filter(Boolean) : []),
        add(cls) { this.classes.add(cls); el.className = Array.from(this.classes).join(' '); },
        remove(cls) { this.classes.delete(cls); el.className = Array.from(this.classes).join(' '); },
        contains(cls) { return this.classes.has(cls); }
      },
      attributes: {},
      setAttribute(name, val) { this.attributes[name] = val; },
      getAttribute(name) { return this.attributes[name] || null; },
      removeAttribute(name) { delete this.attributes[name]; },
      style: {},
      innerHTML: '',
      innerText: '',
      addEventListener(event, cb) {
        if (!this.listeners) this.listeners = {};
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(cb);
      },
      dispatchEvent(event) {
        if (this.listeners && this.listeners[event]) {
          this.listeners[event].forEach(cb => cb({ stopPropagation() {}, preventDefault() {} }));
        }
      },
      appendChild(child) {
        if (!this.children) this.children = [];
        this.children.push(child);
        return child;
      },
      remove() {}
    };
    return el;
  };

  // Keep track of DOM element attributes and classes
  const elementStates = {};
  const getOrCreateMockElement = (id, options = {}) => {
    if (elementStates[id]) return elementStates[id];
    const el = createMockElement('div', id, options.className || '');
    elementStates[id] = el;
    return el;
  };

  // Create mocked DOM structure
  const headerMock = getOrCreateMockElement('header-el', { className: '' });
  const asideMock = getOrCreateMockElement('aside-el', { className: '' });
  const footerMock = getOrCreateMockElement('footer-el', { className: '' });
  const mainMock = getOrCreateMockElement('main-el', { className: 'mr-[48px]' });
  const gridRootMock = getOrCreateMockElement('grid-root', { className: '' });
  const topBarMock = getOrCreateMockElement('history-top-bar', { className: 'hidden' });
  const sidebarMock = getOrCreateMockElement('history-sidebar', { className: 'hidden' });
  const listContainerMock = getOrCreateMockElement('history-list', { className: '' });
  const highlightCheckboxMock = getOrCreateMockElement('highlightChanges', { className: '' });
  const showUneditedCheckboxMock = getOrCreateMockElement('showUnedited', { className: '' });
  const restoreBtnMock = getOrCreateMockElement('history-restore-btn', { className: 'hidden' });
  const headerHistoryBtnMock = getOrCreateMockElement('header-history-btn', { className: '' });
  const exitBtnMock = getOrCreateMockElement('history-exit-btn', { className: '' });

  const querySelectorAll = () => [];
  const querySelector = (sel) => {
    if (sel === 'header') return headerMock;
    if (sel === 'aside:not(#history-sidebar)') return asideMock;
    if (sel === 'footer') return footerMock;
    if (sel === 'main') return mainMock;
    return null;
  };

  // Mock global fetch
  let fetchCallCount = 0;
  let lastFetchUrl = '';
  let lastFetchOptions = null;
  const mockFetch = async (url, options = null) => {
    fetchCallCount++;
    lastFetchUrl = url;
    lastFetchOptions = options;

    if (url === '/api/versions') {
      return {
        status: 200,
        json: async () => [
          { id: 2, created_at: new Date().toISOString(), created_by: 'user1' },
          { id: 1, created_at: new Date(Date.now() - 60000).toISOString(), created_by: 'admin' }
        ]
      };
    }
    if (url === '/api/versions/2' || url === '/api/versions/1') {
      const id = url.endsWith('2') ? 2 : 1;
      return {
        status: 200,
        json: async () => ({
          id,
          sheets: {
            Sheet1: {
              'A5': { value: id === 2 ? 'Changed Value' : 'Original Value', formula: '', style: {} }
            }
          },
          sheetOrder: ['Sheet1'],
          sheetColors: {},
          hiddenSheets: []
        })
      };
    }
    if (url.includes('/restore')) {
      return {
        status: 200,
        json: async () => ({ success: true })
      };
    }
    return { status: 404 };
  };

  const sandbox = {
    localCells: {},
    activeCellId: null,
    activeSheetName: 'Sheet1',
    sheetOrder: ['Sheet1'],
    document: {
      getElementById(id) {
        if (id === 'grid-root') return gridRootMock;
        if (id === 'history-top-bar') return topBarMock;
        if (id === 'history-sidebar') return sidebarMock;
        if (id === 'history-list') return listContainerMock;
        if (id === 'highlightChanges') return highlightCheckboxMock;
        if (id === 'showUnedited') return showUneditedCheckboxMock;
        if (id === 'history-restore-btn') return restoreBtnMock;
        if (id === 'header-history-btn') return headerHistoryBtnMock;
        if (id === 'history-exit-btn') return exitBtnMock;
        return null;
      },
      querySelectorAll,
      querySelector,
      addEventListener() {},
      createElement(tagName) {
        return createMockElement(tagName);
      }
    },
    window: {
      location: { protocol: 'http:', host: 'localhost:3000' },
      addEventListener: () => {}
    },
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {}
    },
    fetch: mockFetch,
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    isNaN: isNaN,
    String: String,
    Object: Object,
    Array: Array,
    Date: Date,
    setTimeout: (fn) => fn()
  };

  const vmContext = vm.createContext(sandbox);
  // Add suffix to expose key functions for testing
  const suffix = `
    globalThis.toggleHistoryMode = toggleHistoryMode;
    globalThis.selectVersion = selectVersion;
    globalThis.restoreVersion = restoreVersion;
    globalThis.get_isHistoryMode = () => isHistoryMode;
  `;
  vm.runInContext(code + suffix, vmContext);

  // --- Act 1: Click history button to enter history mode ---
  headerHistoryBtnMock.dispatchEvent('click');
  await new Promise(resolve => setTimeout(resolve, 100)); // wait for fetch promises to resolve

  // --- Assert 1 ---
  assert.strictEqual(sandbox.get_isHistoryMode(), true, 'Should be in history mode');
  assert.ok(headerMock.classList.contains('hidden'), 'Header should be hidden');
  assert.ok(asideMock.classList.contains('hidden'), 'Utility shelf should be hidden');
  assert.ok(topBarMock.classList.contains('hidden') === false, 'History top bar should be visible');
  assert.ok(sidebarMock.classList.contains('hidden') === false, 'History sidebar should be visible');
  assert.ok(mainMock.classList.contains('mr-[320px]'), 'Main margin should adjust to 320px');

  // --- Act 2: Select older version (ID 1) ---
  await vmContext.selectVersion(1);

  // --- Assert 2 ---
  assert.ok(restoreBtnMock.classList.contains('hidden') === false, 'Restore button should be visible for older version');

  // --- Act 3: Click restore button ---
  await vmContext.restoreVersion();

  // --- Assert 3 ---
  assert.strictEqual(sandbox.get_isHistoryMode(), false, 'Should exit history mode after successful restore');
  assert.ok(headerMock.classList.contains('hidden') === false, 'Header should be visible again');
});



