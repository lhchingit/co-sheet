/**
 * @file store.test.js
 * @description Integration tests for co-sheet cell state persistence and API security.
 * Verifies that cell state is correctly loaded from and saved to the store.json file.
 * Verifies input validation, prototype pollution prevention, and API access control using session cookie auth.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import vm from 'vm';


// Define the store path.
const STORE_PATH = path.resolve('store.test.json');

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

/**
 * Logs in via the test-only authentication route and returns the session cookie.
 * @param {number} port - The server port.
 * @param {string} [username] - The username to log in with.
 * @returns {Promise<string>} Resolves with the cookie string.
 */
async function loginAndGetCookie(port, username = 'Test User') {
  const loginRes = await makeRequest(`http://localhost:${port}/auth/test-login`, 'POST', { username });
  assert.strictEqual(loginRes.statusCode, 200);
  assert.strictEqual(loginRes.data.success, true);
  const setCookie = loginRes.headers['set-cookie'];
  assert.ok(setCookie, 'Should receive set-cookie header on successful login');
  return Array.isArray(setCookie) ? setCookie[0] : setCookie;
}

/**
 * Helper that polls for a file to exist and be fully written.
 * Resolves with the parsed JSON data once loaded.
 * @param {string} filePath - Absolute path to the file.
 * @param {number} [timeoutMs] - Maximum time to wait.
 * @returns {Promise<Object>} The parsed JSON file content.
 */
async function waitForFile(filePath, timeoutMs = 2000, validator = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      try {
        const data = fs.readFileSync(filePath, 'utf8');
        if (data.trim().startsWith('{')) {
          const parsed = JSON.parse(data);
          if (!validator || validator(parsed)) {
            return parsed;
          }
        }
      } catch (e) {
        // File may be locked/partially written, retry
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout waiting for file: ${filePath}`);
}

test('Sheet cell state is correctly loaded from and saved to store.json', async (t) => {
  // --- Arrange ---
  // Ensure we start with no store.json file to test initial boot behavior.
  if (fs.existsSync(STORE_PATH)) {
    fs.unlinkSync(STORE_PATH);
  }

  // Start the server process on a custom port (31260) in test mode to expose /auth/test-login.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31260', NODE_ENV: 'test', STORE_PATH: 'store.test.json' }
  });

  // Wait 1.5 seconds for the Express server to boot up and start listening.
  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    // Authenticate and obtain the session cookie
    const cookie = await loginAndGetCookie(31260);

    // --- Act 1: Fetch initial cells (should be empty) ---
    const initialRes = await makeRequest('http://localhost:31260/api/cells', 'GET', null, { Cookie: cookie });
    
    // --- Assert 1 ---
    assert.strictEqual(initialRes.statusCode, 200);
    assert.deepStrictEqual(initialRes.data, {});

    // --- Act 2: Save a new cell via the API ---
    const cellData = {
      cellId: 'A1',
      formula: '=1+2',
      value: '3',
      style: { bold: true }
    };
    const saveRes = await makeRequest('http://localhost:31260/api/cells', 'POST', cellData, { Cookie: cookie });

    // --- Assert 2 ---
    assert.strictEqual(saveRes.statusCode, 200);
    assert.strictEqual(saveRes.data.success, true);

    // Verify that the file store.test.json was created and contains the cell data.
    const storeContents = await waitForFile(STORE_PATH, 2000, (content) => {
      return content && content.sheets && content.sheets.Sheet1 && content.sheets.Sheet1['A1'] !== undefined;
    });
    assert.deepStrictEqual(storeContents.sheets.Sheet1['A1'], {
      formula: '=1+2',
      value: '3',
      style: { bold: true }
    });

    // --- Act 3: Restart the server to check persistence ---
    // Stop the running server.
    child.kill();
    // Wait a short moment for the process to exit.
    await new Promise(resolve => setTimeout(resolve, 500));

    // Spawn a new server instance.
    const secondChild = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: '31260', NODE_ENV: 'test', STORE_PATH: 'store.test.json' }
    });

    // Wait for the server to boot up.
    await new Promise(resolve => setTimeout(resolve, 1500));

    try {
      // Authenticate against the restarted server to get a new session
      const secondCookie = await loginAndGetCookie(31260);

      // Query the cells again.
      const loadedRes = await makeRequest('http://localhost:31260/api/cells', 'GET', null, { Cookie: secondCookie });

      // --- Assert 3 ---
      assert.strictEqual(loadedRes.statusCode, 200);
      assert.deepStrictEqual(loadedRes.data['A1'], {
        formula: '=1+2',
        value: '3',
        style: { bold: true }
      });
    } finally {
      secondChild.kill();
    }

  } finally {
    // Clean up
    child.kill();
    if (fs.existsSync(STORE_PATH)) {
      fs.unlinkSync(STORE_PATH);
    }
  }
});

test('Access to /api/cells requires authentication when not authenticated', async (t) => {
  // --- Arrange ---
  // Spawn the server in test mode, but do not log in.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31261', NODE_ENV: 'test', STORE_PATH: 'store.test.json' }
  });
  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    // --- Act ---
    // Make GET request to /api/cells without providing authentication session cookies.
    const res = await makeRequest('http://localhost:31261/api/cells', 'GET');

    // --- Assert ---
    // Verify it returns 401 Unauthorized with the expected JSON payload instead of redirecting.
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.data, { error: 'unauthorized', message: 'Authentication required' });
  } finally {
    child.kill();
  }
});

test('POST /api/cells validates cell ID, prototype keys, and strict payload schema', async (t) => {
  // --- Arrange ---
  // Spawn the server in test mode.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31262', NODE_ENV: 'test', STORE_PATH: 'store.test.json' }
  });
  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    // Login to obtain authentication cookie.
    const cookie = await loginAndGetCookie(31262);

    // --- Act & Assert ---
    
    // 1. Invalid cellId format: A0
    const res1 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A0',
      formula: '1',
      value: '1',
      style: {}
    }, { Cookie: cookie });
    assert.strictEqual(res1.statusCode, 400);
    assert.strictEqual(res1.data.error, 'bad_request');

    // 2. Invalid cellId format: A1000
    const res2 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A1000',
      formula: '1',
      value: '1',
      style: {}
    }, { Cookie: cookie });
    assert.strictEqual(res2.statusCode, 400);
    assert.strictEqual(res2.data.error, 'bad_request');

    // 3. Prototype pollution key: __proto__
    const res3 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: '__proto__',
      formula: '1',
      value: '1',
      style: {}
    }, { Cookie: cookie });
    assert.strictEqual(res3.statusCode, 400);
    assert.strictEqual(res3.data.error, 'bad_request');

    // 4. Invalid formula length (> 200 characters)
    const longString = 'a'.repeat(201);
    const res4 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A1',
      formula: longString,
      value: '1',
      style: {}
    }, { Cookie: cookie });
    assert.strictEqual(res4.statusCode, 400);
    assert.strictEqual(res4.data.error, 'bad_request');

    // 5. Invalid value length (> 200 characters)
    const res5 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A1',
      formula: '1',
      value: longString,
      style: {}
    }, { Cookie: cookie });
    assert.strictEqual(res5.statusCode, 400);
    assert.strictEqual(res5.data.error, 'bad_request');

    // 6. Invalid style property (an unrecognised key is not allowed)
    const res6 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A1',
      formula: '1',
      value: '1',
      style: { notARealStyle: true }
    }, { Cookie: cookie });
    assert.strictEqual(res6.statusCode, 400);
    assert.strictEqual(res6.data.error, 'bad_request');

    // 7. Invalid style type (bold must be boolean)
    const res7 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A1',
      formula: '1',
      value: '1',
      style: { bold: 'yes' }
    }, { Cookie: cookie });
    assert.strictEqual(res7.statusCode, 400);
    assert.strictEqual(res7.data.error, 'bad_request');

    // 8. Invalid style color format (must match hex color regex)
    const res8 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A1',
      formula: '1',
      value: '1',
      style: { color: 'blue' }
    }, { Cookie: cookie });
    assert.strictEqual(res8.statusCode, 400);
    assert.strictEqual(res8.data.error, 'bad_request');

    // 9. Invalid border style type (must be boolean)
    const res9 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A1',
      formula: '1',
      value: '1',
      style: { border: 'yes' }
    }, { Cookie: cookie });
    assert.strictEqual(res9.statusCode, 400);
    assert.strictEqual(res9.data.error, 'bad_request');

    // 10. Invalid alignment style type/value (must be left, center, or right)
    const res10 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A1',
      formula: '1',
      value: '1',
      style: { align: 'justify' }
    }, { Cookie: cookie });
    assert.strictEqual(res10.statusCode, 400);
    assert.strictEqual(res10.data.error, 'bad_request');

    // 11. Invalid link style format (must be string up to 200 characters)
    const res11 = await makeRequest('http://localhost:31262/api/cells', 'POST', {
      cellId: 'A1',
      formula: '1',
      value: '1',
      style: { link: 'a'.repeat(201) }
    }, { Cookie: cookie });
    assert.strictEqual(res11.statusCode, 400);
    assert.strictEqual(res11.data.error, 'bad_request');

    // 11.5. Invalid vertical alignment style type/value (must be top, center, or bottom)
    // Arrange
    const invalidVerticalAlignPayload = {
      cellId: 'A1',
      formula: '1',
      value: '1',
      style: { verticalAlign: 'middle' }
    };
    // Act
    const res11_5 = await makeRequest('http://localhost:31262/api/cells', 'POST', invalidVerticalAlignPayload, { Cookie: cookie });
    // Assert
    assert.strictEqual(res11_5.statusCode, 400);
    assert.strictEqual(res11_5.data.error, 'bad_request');

    // 12. Valid payload with extended styles (bold, italic, color, border, align, link, verticalAlign)
    // Arrange
    const validPayloadExtended = {
      cellId: 'ZZ999',
      formula: '=1+1',
      value: '2',
      style: { bold: true, italic: false, underline: true, color: '#FF0000', border: true, align: 'center', link: 'https://example.com', verticalAlign: 'top', numberFormat: 'currency', textWrap: 'wrap' }
    };
    // Act
    const res12 = await makeRequest('http://localhost:31262/api/cells', 'POST', validPayloadExtended, { Cookie: cookie });
    // Assert
    assert.strictEqual(res12.statusCode, 200);
    assert.strictEqual(res12.data.success, true);

    // 13. Valid payload with structured per-side borders (the real shape the
    // border menu sends — previously rejected, which broke border sync).
    // Arrange
    const validBordersPayload = {
      cellId: 'A10',
      formula: '',
      value: '',
      style: { borders: { top: { color: '#717686', style: 'thin' }, bottom: { color: '#000000', style: 'double' }, left: null, right: null } }
    };
    // Act
    const res13 = await makeRequest('http://localhost:31262/api/cells', 'POST', validBordersPayload, { Cookie: cookie });
    // Assert
    assert.strictEqual(res13.statusCode, 200);
    assert.strictEqual(res13.data.success, true);

    // 14. Invalid structured border (bad style value) must be rejected.
    // Arrange
    const invalidBordersPayload = {
      cellId: 'A11',
      formula: '',
      value: '',
      style: { borders: { top: { color: '#717686', style: 'wavy' } } }
    };
    // Act
    const res14 = await makeRequest('http://localhost:31262/api/cells', 'POST', invalidBordersPayload, { Cookie: cookie });
    // Assert
    assert.strictEqual(res14.statusCode, 400);
    assert.strictEqual(res14.data.error, 'bad_request');

    // 15. numberFormat null (automatic) is valid — previously dropped silently.
    const autoFormatPayload = { cellId: 'A12', formula: '', value: '', style: { numberFormat: null } };
    const res15 = await makeRequest('http://localhost:31262/api/cells', 'POST', autoFormatPayload, { Cookie: cookie });
    assert.strictEqual(res15.statusCode, 200);
    assert.strictEqual(res15.data.success, true);

    // 16. Unknown numberFormat value must be rejected.
    const badFormatPayload = { cellId: 'A13', formula: '', value: '', style: { numberFormat: 'bogus' } };
    const res16 = await makeRequest('http://localhost:31262/api/cells', 'POST', badFormatPayload, { Cookie: cookie });
    assert.strictEqual(res16.statusCode, 400);
    assert.strictEqual(res16.data.error, 'bad_request');

    // 17. Invalid textWrap value must be rejected.
    const badWrapPayload = { cellId: 'A14', formula: '', value: '', style: { textWrap: 'nowrap' } };
    const res17 = await makeRequest('http://localhost:31262/api/cells', 'POST', badWrapPayload, { Cookie: cookie });
    assert.strictEqual(res17.statusCode, 400);
    assert.strictEqual(res17.data.error, 'bad_request');
  } finally {
    child.kill();
    if (fs.existsSync(STORE_PATH)) {
      fs.unlinkSync(STORE_PATH);
    }
  }
});

test('State - loadState initializes default sheet metadata and migrates legacy formats', async (t) => {
  // --- Arrange ---
  // Read the server.js source code to extract the loadState function for execution.
  const code = fs.readFileSync(path.resolve('server.js'), 'utf8');
  const tempStorePath = path.resolve('store.test.init.json');
  if (fs.existsSync(tempStorePath)) {
    fs.unlinkSync(tempStorePath);
  }
  
  // Write a legacy store file containing only a flat 'cells' object to test migration.
  fs.writeFileSync(tempStorePath, JSON.stringify({
    cells: {
      'A1': { formula: '', value: 'LegacyValue', style: {} }
    }
  }, null, 2), 'utf8');

  // Create a minimal sandbox to evaluate server.js loadState function in isolation
  const sandbox = {
    process: { env: { STORE_PATH: tempStorePath } },
    console: console,
    require: (name) => {
      if (name === 'fs') return fs;
      if (name === 'path') return path;
      return {};
    },
    __dirname: path.resolve('.'),
    Object: Object,
    pool: {
      async query(sql, params) {
        if (/SELECT\s+state/i.test(sql)) {
          if (fs.existsSync(tempStorePath)) {
            const data = fs.readFileSync(tempStorePath, 'utf8');
            const parsed = JSON.parse(data);
            return { rows: [{ state: parsed }] };
          }
        }
        return { rows: [] };
      }
    },
    // loadState now reads through the db/workbook repository rather than calling
    // pool.query directly, so the sandbox supplies a matching stub.
    workbookRepo: {
      async getWorkbookState(key) {
        if (fs.existsSync(tempStorePath)) {
          const data = fs.readFileSync(tempStorePath, 'utf8');
          return JSON.parse(data);
        }
        return undefined;
      }
    }
  };

  const vmContext = vm.createContext(sandbox);
  // Extract setupCellsProxy and loadState functions from server.js to avoid executing server-start code.
  const loadStateStartIndex = code.indexOf('const setupCellsProxy =');
  const loadStateEndIndex = code.indexOf('let sheetState =', loadStateStartIndex);
  const loadStateFunction = code.substring(loadStateStartIndex, loadStateEndIndex);

  // Evaluate helper libraries mocked in the sandbox and execute loadState
  vm.runInContext(`
    const fs = require('fs');
    const path = require('path');
    const STORE_PATH = process.env.STORE_PATH;
  ` + loadStateFunction + `\nglobalThis.loadState = loadState;`, vmContext);

  // --- Act ---
  // Call the extracted loadState function within the VM context to initialize/migrate state
  const loadedState = await vmContext.loadState();

  // --- Assert ---
  // Verify that sheets were correctly migrated and initialized with defaults
  assert.ok(loadedState.sheets, 'State should have sheets');
  assert.ok(loadedState.sheets['Sheet1'], 'Sheet1 should exist');
  assert.strictEqual(loadedState.sheets['Sheet1']['A1'].value, 'LegacyValue', 'Legacy cell value should be migrated to Sheet1');
  assert.deepStrictEqual(Array.from(loadedState.sheetOrder), ['Sheet1'], 'sheetOrder should default to a single Sheet1 (legacy cells migrate into it)');
  assert.deepStrictEqual(loadedState.sheetColors, Object.create(null), 'sheetColors should default to empty object');
  assert.deepStrictEqual(Array.from(loadedState.hiddenSheets), [], 'hiddenSheets should default to empty array');
  assert.strictEqual(loadedState.cells['A1'].value, 'LegacyValue', 'cells getter should map to first visible sheet (Sheet1)');

  // Verify that cells property descriptor is non-enumerable
  const descriptor = Object.getOwnPropertyDescriptor(loadedState, 'cells');
  assert.ok(descriptor, 'cells property descriptor should exist');
  assert.strictEqual(descriptor.enumerable, false, 'cells property should be non-enumerable');

  // Verify that assigning a value to cells propagates to the first visible sheet
  const newCellsVal = { 'B2': { formula: '', value: 'NewVal', style: {} } };
  loadedState.cells = newCellsVal;
  assert.strictEqual(loadedState.sheets['Sheet1']['B2'].value, 'NewVal', 'Assigning to loadedState.cells should propagate changes to the first visible sheet');

  // Clean up the temporary store file
  if (fs.existsSync(tempStorePath)) {
    fs.unlinkSync(tempStorePath);
  }
});

