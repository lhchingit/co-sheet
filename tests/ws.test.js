process.env.NODE_ENV = 'test';

/**
 * @file ws.test.js
 * @description Integration tests for co-sheet WebSocket server.
 * Verifies WebSocket connection, initialization payload, session cookie extraction,
 * event routing (cell-edit and cursor-move broadcasts), and disconnect user-leave event.
 * Follows the AAA pattern and ensures proper cleanups to avoid port/socket leaks.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import http from 'http';
import { createTestDb } from './helpers/db.js';

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
 * @param {string} port - The server port to target.
 * @param {string} username - The username to log in with.
 * @returns {Promise<string>} Resolves with the cookie string.
 */
async function loginAndGetCookie(port, username) {
  const loginRes = await makeRequest(`http://localhost:${port}/auth/test-login`, 'POST', { username });
  assert.strictEqual(loginRes.statusCode, 200);
  assert.strictEqual(loginRes.data.success, true);
  const setCookie = loginRes.headers['set-cookie'];
  assert.ok(setCookie, 'Should receive set-cookie header on successful login');
  return Array.isArray(setCookie) ? setCookie[0] : setCookie;
}

test('WebSocket - Client receives init payload on connect', async (t) => {
  // --- Arrange ---
  const PORT = '31301';
  const db = await createTestDb('ws-init');

  // Spawn the server process on a unique port in test mode.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: PORT, NODE_ENV: 'test', DATABASE_URL: db.url }
  });
  child.stderr.on('data', (data) => console.error(`[Server ${PORT} STDERR] ${data.toString().trim()}`));

  // Wait 1.5 seconds for the server to start listening.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  let ws;
  try {
    // We will connect as a guest user (unauthenticated) to check fallback username logic.
    const wsUrl = `ws://localhost:${PORT}/`;

    // --- Act ---
    ws = new WebSocket(wsUrl);
    const initMessage = await new Promise((resolve, reject) => {
      ws.on('message', (data) => {
        const message = JSON.parse(data);
        if (message.type === 'init') {
          resolve(message);
        }
      });
      ws.on('error', reject);
      // Timeout if no init message is received within 2 seconds.
      setTimeout(() => reject(new Error('Timeout waiting for init message')), 2000);
    });

    // --- Assert ---
    assert.strictEqual(initMessage.type, 'init');
    assert.ok(initMessage.payload.cells);
    assert.ok(Array.isArray(initMessage.payload.users));
    assert.ok(initMessage.payload.users.some(user => user.username.startsWith('User-')));
  } finally {
    // Cleanup
    if (ws) {
      ws.close();
      await new Promise(resolve => ws.on('close', resolve));
    }
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.cleanup();
  }
});

test('WebSocket - Active cursor presence and cursor-move events are broadcasted to other clients', async (t) => {
  // --- Arrange ---
  const PORT = '31302';
  const db = await createTestDb('ws-cursor');

  // Spawn the server process on a unique port in test mode.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: PORT, NODE_ENV: 'test', DATABASE_URL: db.url }
  });
  child.stderr.on('data', (data) => console.error(`[Server ${PORT} STDERR] ${data.toString().trim()}`));

  // Wait 1.5 seconds for the server to start listening.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  let wsA, wsB;
  try {
    // Authenticate Client A and get session cookie
    const cookieA = await loginAndGetCookie(PORT, 'Alice');
    
    // Create connection objects.
    wsA = new WebSocket(`ws://localhost:${PORT}/`, {
      headers: { Cookie: cookieA }
    });
    wsB = new WebSocket(`ws://localhost:${PORT}/`);

    // Capture messages on Client B immediately when socket is created to avoid missing any.
    const clientBMessages = [];
    wsB.on('message', (data) => {
      clientBMessages.push(JSON.parse(data));
    });

    // Wait for both sockets to open.
    await Promise.all([
      new Promise((resolve) => wsA.on('open', resolve)),
      new Promise((resolve) => wsB.on('open', resolve))
    ]);

    // Give a short window for connections to stabilize.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // --- Act ---
    // Send a cursor-move event from Alice (Client A)
    wsA.send(JSON.stringify({
      type: 'cursor-move',
      payload: { cellId: 'B2' }
    }));

    // Wait for the cursor-update message to be broadcasted to Client B
    const cursorUpdateMessage = await new Promise((resolve, reject) => {
      const check = () => {
        const found = clientBMessages.find(m => m.type === 'cursor-update' && m.payload.activeCell === 'B2');
        if (found) {
          resolve(found);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
      setTimeout(() => reject(new Error('Timeout waiting for cursor-update')), 2500);
    });

    // --- Assert ---
    assert.strictEqual(cursorUpdateMessage.type, 'cursor-update');
    assert.strictEqual(cursorUpdateMessage.payload.username, 'Alice');
    assert.strictEqual(cursorUpdateMessage.payload.activeCell, 'B2');
    assert.ok(cursorUpdateMessage.payload.color);
  } finally {
    // Cleanup
    if (wsA) {
      wsA.close();
      await new Promise(resolve => wsA.on('close', resolve));
    }
    if (wsB) {
      wsB.close();
      await new Promise(resolve => wsB.on('close', resolve));
    }
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.cleanup();
  }
});

test('WebSocket - Cell-edit events are processed, saved to store, and broadcasted to other clients', async (t) => {
  // --- Arrange ---
  const PORT = '31303';
  const db = await createTestDb('ws-celledit');

  // Spawn the server process on a unique port in test mode.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: PORT, NODE_ENV: 'test', DATABASE_URL: db.url }
  });
  child.stderr.on('data', (data) => console.error(`[Server ${PORT} STDERR] ${data.toString().trim()}`));

  // Wait 1.5 seconds for the server to start listening.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  let wsA, wsB;
  try {
    wsA = new WebSocket(`ws://localhost:${PORT}/`);
    wsB = new WebSocket(`ws://localhost:${PORT}/`);

    // Capture messages on Client B immediately.
    const clientBMessages = [];
    wsB.on('message', (data) => {
      clientBMessages.push(JSON.parse(data));
    });

    // Wait for both sockets to open.
    await Promise.all([
      new Promise((resolve) => wsA.on('open', resolve)),
      new Promise((resolve) => wsB.on('open', resolve))
    ]);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // --- Act ---
    // Send a cell-edit event from Client A
    wsA.send(JSON.stringify({
      type: 'cell-edit',
      payload: {
        cellId: 'C3',
        formula: '=5*5',
        value: '25',
        style: { bold: true, color: '#1471e6' }
      }
    }));

    // Wait for the cell-update message to be broadcasted to Client B
    const cellUpdateMessage = await new Promise((resolve, reject) => {
      const check = () => {
        const found = clientBMessages.find(m => m.type === 'cell-update' && m.payload.cellId === 'C3');
        if (found) {
          resolve(found);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
      setTimeout(() => reject(new Error('Timeout waiting for cell-update')), 2500);
    });

    // --- Assert ---
    assert.strictEqual(cellUpdateMessage.type, 'cell-update');
    assert.strictEqual(cellUpdateMessage.payload.cellId, 'C3');
    assert.strictEqual(cellUpdateMessage.payload.formula, '=5*5');
    assert.strictEqual(cellUpdateMessage.payload.value, '25');
    assert.deepStrictEqual(cellUpdateMessage.payload.style, { bold: true, color: '#1471e6' });

    // Verify that the database was updated with the edited cell.
    await new Promise((resolve) => setTimeout(resolve, 300)); // wait for persistence
    const cells = await db.getCells('default', 'Sheet1');
    assert.deepStrictEqual(cells['C3'], {
      formula: '=5*5',
      value: '25',
      style: { bold: true, color: '#1471e6' }
    });
  } finally {
    // Cleanup
    if (wsA) {
      wsA.close();
      await new Promise(resolve => wsA.on('close', resolve));
    }
    if (wsB) {
      wsB.close();
      await new Promise(resolve => wsB.on('close', resolve));
    }
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.cleanup();
  }
});

test('WebSocket - Client disconnect broadcasts user-leave event to remaining clients', async (t) => {
  // --- Arrange ---
  const PORT = '31304';
  const db = await createTestDb('ws-leave');

  // Spawn the server process on a unique port in test mode.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: PORT, NODE_ENV: 'test', DATABASE_URL: db.url }
  });
  child.stderr.on('data', (data) => console.error(`[Server ${PORT} STDERR] ${data.toString().trim()}`));

  // Wait 1.5 seconds for the server to start listening.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  let wsA, wsB;
  try {
    wsA = new WebSocket(`ws://localhost:${PORT}/`);
    wsB = new WebSocket(`ws://localhost:${PORT}/`);

    // Capture messages on Client B immediately.
    const clientBMessages = [];
    wsB.on('message', (data) => {
      clientBMessages.push(JSON.parse(data));
    });

    // Wait for both sockets to open.
    await Promise.all([
      new Promise((resolve) => wsA.on('open', resolve)),
      new Promise((resolve) => wsB.on('open', resolve))
    ]);

    // Wait for connections to stabilize.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Find Client A's userId from Client B's message history.
    // Client B gets a 'cursor-update' broadcast from the server when Client A connects.
    let joinedUserId = null;
    const joinMsg = clientBMessages.find(m => m.type === 'cursor-update');
    if (joinMsg) {
      joinedUserId = joinMsg.payload.userId;
    }

    // --- Act ---
    // Close Client A
    wsA.close();

    // Wait for Client B to receive a user-leave event
    const userLeaveMessage = await new Promise((resolve, reject) => {
      const check = () => {
        const found = clientBMessages.find(m => m.type === 'user-leave');
        if (found) {
          resolve(found);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
      setTimeout(() => reject(new Error('Timeout waiting for user-leave')), 2500);
    });

    // --- Assert ---
    assert.strictEqual(userLeaveMessage.type, 'user-leave');
    if (joinedUserId) {
      assert.strictEqual(userLeaveMessage.payload.userId, joinedUserId);
    } else {
      assert.ok(userLeaveMessage.payload.userId);
    }
  } finally {
    // Cleanup
    if (wsA && wsA.readyState === WebSocket.OPEN) {
      wsA.close();
      await new Promise(resolve => wsA.on('close', resolve));
    }
    if (wsB && wsB.readyState === WebSocket.OPEN) {
      wsB.close();
      await new Promise(resolve => wsB.on('close', resolve));
    }
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.cleanup();
  }
});

test('WebSocket - Collaborative sheet additions, sheet isolation, and sheet-specific cursors', async (t) => {
  // --- Arrange ---
  const wsUrl = 'ws://localhost:31305';
  const db = await createTestDb('ws-sheets');
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31305', NODE_ENV: 'test', DATABASE_URL: db.url }
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const clientA = new WebSocket(wsUrl);
  const clientB = new WebSocket(wsUrl);

  const clientAMessages = [];
  const clientBMessages = [];

  clientA.on('message', (data) => clientAMessages.push(JSON.parse(data.toString())));
  clientB.on('message', (data) => clientBMessages.push(JSON.parse(data.toString())));

  await new Promise((resolve) => {
    let connected = 0;
    const check = () => { if (++connected === 2) resolve(); };
    clientA.on('open', check);
    clientB.on('open', check);
  });

  try {
    // --- Act 1: Client A adds a new sheet ---
    clientA.send(JSON.stringify({ type: 'add-sheet', payload: { sheetName: 'Sheet3' } }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    // --- Assert 1: Client B receives add-sheet broadcast ---
    const addSheetMsg = clientBMessages.find(m => m.type === 'add-sheet');
    assert.ok(addSheetMsg);
    assert.strictEqual(addSheetMsg.payload.sheetName, 'Sheet3');

    // --- Act 2: Client A moves cursor and edits a cell on Sheet3 ---
    clientA.send(JSON.stringify({ type: 'cursor-move', payload: { cellId: 'A1', sheetName: 'Sheet3' } }));
    clientA.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'A1', formula: '', value: 'Sheet3 Value', style: {}, sheetName: 'Sheet3' }
    }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    // --- Assert 2: Client B receives cell-update and cursor-update containing Sheet3 context ---
    const cellUpdateMsg = clientBMessages.find(m => m.type === 'cell-update' && m.payload.sheetName === 'Sheet3');
    assert.ok(cellUpdateMsg);
    assert.strictEqual(cellUpdateMsg.payload.value, 'Sheet3 Value');

    const cursorUpdateMsg = clientBMessages.find(m => m.type === 'cursor-update' && m.payload.activeCell === 'A1');
    assert.ok(cursorUpdateMsg);
    assert.strictEqual(cursorUpdateMsg.payload.activeSheet, 'Sheet3');
  } finally {
    clientA.close();
    clientB.close();
    serverProcess.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await db.cleanup();
  }
});

/**
 * Integration test verifying that the server handles collaborative sheet
 * modifications (delete, copy, rename, color, hide, reorder) and broadcasts them correctly.
 * Follows the AAA pattern.
 */
test('WebSocket - Collaborative sheet delete, copy, rename, color, hide, and reorder', async (t) => {
  // --- Arrange ---
  // Define WebSocket URL and clean up any pre-existing test files on port 31306
  const wsUrl = 'ws://localhost:31306';
  const db = await createTestDb('ws-sheetops');
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31306', NODE_ENV: 'test', DATABASE_URL: db.url }
  });

  // Wait 1.5 seconds for the server to start listening
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Initialize two WebSocket client instances to verify broadcasts
  const clientA = new WebSocket(wsUrl);
  const clientB = new WebSocket(wsUrl);

  const clientAMessages = [];
  const clientBMessages = [];

  // Capture all incoming messages from server
  clientA.on('message', (data) => clientAMessages.push(JSON.parse(data.toString())));
  clientB.on('message', (data) => clientBMessages.push(JSON.parse(data.toString())));

  // Wait for both clients to connect successfully
  await new Promise((resolve) => {
    let connected = 0;
    const check = () => { if (++connected === 2) resolve(); };
    clientA.on('open', check);
    clientB.on('open', check);
  });

  try {
    // --- Act 0: Client A adds Sheet2 ---
    // New workbooks start with a single sheet, so create Sheet2 explicitly before
    // exercising the hide/reorder operations that reference it below.
    clientA.send(JSON.stringify({ type: 'add-sheet', payload: { sheetName: 'Sheet2' } }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // --- Act 1: Client A renames Sheet1 to Revenue ---
    clientA.send(JSON.stringify({ type: 'rename-sheet', payload: { oldName: 'Sheet1', newName: 'Revenue' } }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // --- Assert 1 ---
    // Check that Client B and Client A both received the rename broadcast with correct payloads
    const renameMsg = clientBMessages.find(m => m.type === 'rename-sheet');
    assert.ok(renameMsg, 'rename-sheet message should be broadcasted to client B');
    assert.strictEqual(renameMsg.payload.oldName, 'Sheet1');
    assert.strictEqual(renameMsg.payload.newName, 'Revenue');

    const renameMsgA = clientAMessages.find(m => m.type === 'rename-sheet');
    assert.ok(renameMsgA, 'rename-sheet message should be broadcasted to client A (initiator)');
    assert.strictEqual(renameMsgA.payload.oldName, 'Sheet1');
    assert.strictEqual(renameMsgA.payload.newName, 'Revenue');

    // --- Act 2: Client A copies Revenue ---
    clientA.send(JSON.stringify({ type: 'copy-sheet', payload: { sheetName: 'Revenue' } }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // --- Assert 2 ---
    // Check that Client B and Client A both received the add-sheet broadcast for the cloned sheet
    const copyMsg = clientBMessages.find(m => m.type === 'add-sheet' && m.payload.sheetName.includes('Revenue'));
    assert.ok(copyMsg, 'add-sheet message for copied sheet should be broadcasted to client B');

    const copyMsgA = clientAMessages.find(m => m.type === 'add-sheet' && m.payload.sheetName.includes('Revenue'));
    assert.ok(copyMsgA, 'add-sheet message for copied sheet should be broadcasted to client A (initiator)');

    // --- Act 3: Client A colors Revenue to Red ---
    clientA.send(JSON.stringify({ type: 'color-sheet', payload: { sheetName: 'Revenue', color: '#EA4335' } }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // --- Assert 3 ---
    // Check that Client B and Client A both received the color-sheet broadcast
    const colorMsg = clientBMessages.find(m => m.type === 'color-sheet');
    assert.ok(colorMsg, 'color-sheet message should be broadcasted to client B');
    assert.strictEqual(colorMsg.payload.color, '#EA4335');

    const colorMsgA = clientAMessages.find(m => m.type === 'color-sheet');
    assert.ok(colorMsgA, 'color-sheet message should be broadcasted to client A (initiator)');
    assert.strictEqual(colorMsgA.payload.color, '#EA4335');

    // --- Act 4: Client A hides Sheet2 ---
    clientA.send(JSON.stringify({ type: 'hide-sheet', payload: { sheetName: 'Sheet2' } }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // --- Assert 4 ---
    // Check that Client B and Client A both received the hide-sheet broadcast
    const hideMsg = clientBMessages.find(m => m.type === 'hide-sheet');
    assert.ok(hideMsg, 'hide-sheet message should be broadcasted to client B');
    assert.strictEqual(hideMsg.payload.sheetName, 'Sheet2');

    const hideMsgA = clientAMessages.find(m => m.type === 'hide-sheet');
    assert.ok(hideMsgA, 'hide-sheet message should be broadcasted to client A (initiator)');
    assert.strictEqual(hideMsgA.payload.sheetName, 'Sheet2');

    // --- Act 5: Client A reorders sheets ---
    clientA.send(JSON.stringify({ type: 'reorder-sheets', payload: { sheetOrder: ['Sheet2', 'Revenue (Copy)', 'Revenue'] } }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // --- Assert 5 ---
    // Check that Client B and Client A both received the reorder-sheets broadcast with the new sheet order list
    const reorderMsg = clientBMessages.find(m => m.type === 'reorder-sheets');
    assert.ok(reorderMsg, 'reorder-sheets message should be broadcasted to client B');
    assert.deepStrictEqual(reorderMsg.payload.sheetOrder, ['Sheet2', 'Revenue (Copy)', 'Revenue']);

    const reorderMsgA = clientAMessages.find(m => m.type === 'reorder-sheets');
    assert.ok(reorderMsgA, 'reorder-sheets message should be broadcasted to client A (initiator)');
    assert.deepStrictEqual(reorderMsgA.payload.sheetOrder, ['Sheet2', 'Revenue (Copy)', 'Revenue']);

    // --- Act 6: Client A deletes Revenue (Copy) ---
    clientA.send(JSON.stringify({ type: 'delete-sheet', payload: { sheetName: 'Revenue (Copy)' } }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // --- Assert 6 ---
    // Check that Client B and Client A both received the delete-sheet broadcast
    const deleteMsg = clientBMessages.find(m => m.type === 'delete-sheet');
    assert.ok(deleteMsg, 'delete-sheet message should be broadcasted to client B');
    assert.strictEqual(deleteMsg.payload.sheetName, 'Revenue (Copy)');

    const deleteMsgA = clientAMessages.find(m => m.type === 'delete-sheet');
    assert.ok(deleteMsgA, 'delete-sheet message should be broadcasted to client A (initiator)');
    assert.strictEqual(deleteMsgA.payload.sheetName, 'Revenue (Copy)');
  } finally {
    // --- Cleanup ---
    // Make sure we close connections, kill the spawned server, and delete test files
    clientA.close();
    clientB.close();
    serverProcess.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await db.cleanup();
  }
});


