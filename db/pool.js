// @ts-check
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * @file db/pool.js
 * @description Database connection layer. Exports a single `pool` object exposing a
 * `query(text, params)` / `end()` interface. In test mode the pool is replaced with a
 * file-backed mock (JSON sidecars under STORE_PATH) so the integration suite runs
 * without a real PostgreSQL server; otherwise a real `pg.Pool` backed by DATABASE_URL
 * is used. The rest of the application depends only on this `query` contract.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the store.json file where the default workbook's cell state is persisted in
// test mode. Defaults to the repository root (one level up from this db/ directory) so
// the location matches the historical behavior when this lived in server.js.
export const STORE_PATH = process.env.STORE_PATH || path.join(__dirname, '..', 'store.json');

/** @type {{ query(text: string, params?: any[]): Promise<{ rows: any[], rowCount?: number }>, end(): Promise<void> }} */
let pool;

if (process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event === 'test') {
  // Ensure NODE_ENV is set to 'test' so other modules/tests know we are in test mode.
  process.env.NODE_ENV = 'test';
  pool = {
    // Intercept query calls to read/write from/to the local file specified by STORE_PATH,
    // so that integration tests can run without a real PostgreSQL server.
    async query(text, params) {
      const sql = text.trim();

      // Map a workbook key to its backing file. The legacy 'default' workbook lives
      // at STORE_PATH (preserving existing test expectations); every other file id
      // gets an isolated sidecar so per-file workbooks do not collide in test mode.
      const pathForKey = (key) => {
        if (!key || key === 'default') return STORE_PATH;
        const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
        return `${STORE_PATH}.wb.${safe}.json`;
      };
      // Sidecar JSON file holding the file-manager registry (list of files).
      const filesRegistryPath = `${STORE_PATH}.files.json`;
      const readFilesRegistry = () => {
        if (fs.existsSync(filesRegistryPath)) {
          try { return JSON.parse(fs.readFileSync(filesRegistryPath, 'utf8')); } catch (e) { return []; }
        }
        return [];
      };
      const writeFilesRegistry = (list) => {
        fs.writeFileSync(filesRegistryPath, JSON.stringify(list, null, 2), 'utf8');
      };

      // ----- files registry table mocks -----
      if (/INSERT\s+INTO\s+["']?files["']?/i.test(sql)) {
        const list = readFilesRegistry();
        const row = {
          id: params && params[0],
          name: (params && params[1]) || 'Untitled spreadsheet',
          created_at: new Date().toISOString(),
          created_by: (params && params[2]) || 'anonymous',
          link_access: 'restricted'
        };
        list.push(row);
        writeFilesRegistry(list);
        return { rows: [row] };
      }
      if (/UPDATE\s+["']?files["']?\s+SET\s+name/i.test(sql)) {
        const list = readFilesRegistry();
        const target = params && params[1];
        const row = list.find(f => f.id === target);
        if (row) { row.name = params[0]; writeFilesRegistry(list); }
        return { rows: row ? [row] : [] };
      }
      if (/UPDATE\s+["']?files["']?\s+SET\s+link_access/i.test(sql)) {
        const list = readFilesRegistry();
        const target = params && params[1];
        const row = list.find(f => f.id === target);
        if (row) { row.link_access = params[0]; writeFilesRegistry(list); }
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/DELETE\s+FROM\s+["']?files["']?/i.test(sql)) {
        let list = readFilesRegistry();
        const target = params && params[0];
        const before = list.length;
        list = list.filter(f => f.id !== target);
        writeFilesRegistry(list);
        // Also drop the workbook sidecar for that file.
        const wbPath = pathForKey(target);
        if (wbPath !== STORE_PATH && fs.existsSync(wbPath)) fs.unlinkSync(wbPath);
        return { rows: [], rowCount: before - list.length };
      }
      if (/SELECT\s+.*\s+FROM\s+["']?files["']?/i.test(sql)) {
        let list = readFilesRegistry();
        if (/WHERE\s+id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter(f => f.id === params[0]);
        } else if (/WHERE\s+created_by\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter(f => f.created_by === params[0]);
        } else if (/ORDER\s+BY\s+created_at\s+DESC/i.test(sql)) {
          list = [...list].reverse();
        }
        // Default link_access for rows persisted before the column existed.
        return { rows: list.map((f) => ({ link_access: 'restricted', ...f })) };
      }

      // ----- users table mocks (permissions page) -----
      const usersRegistryPath = `${STORE_PATH}.users.json`;
      const readUsers = () => {
        if (fs.existsSync(usersRegistryPath)) {
          try { return JSON.parse(fs.readFileSync(usersRegistryPath, 'utf8')); } catch (e) { return []; }
        }
        return [];
      };
      const writeUsers = (list) => {
        fs.writeFileSync(usersRegistryPath, JSON.stringify(list, null, 2), 'utf8');
      };

      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["']?users["']?/i.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT\s+INTO\s+["']?users["']?/i.test(sql)) {
        const list = readUsers();
        const now = new Date().toISOString();
        const row = {
          id: params && params[0],
          username: (params && params[1]) || null,
          email: (params && params[2]) || null,
          role: (params && params[3]) || 'user',
          provider: (params && params[4]) || null,
          created_at: now,
          last_login: now
        };
        if (!list.find((u) => u.id === row.id)) list.push(row);
        writeUsers(list);
        return { rows: [row] };
      }
      // Role-only update (PATCH /api/users/:id): UPDATE users SET role = $1 WHERE id = $2
      if (/UPDATE\s+["']?users["']?\s+SET\s+role\s*=\s*\$1/i.test(sql)) {
        const list = readUsers();
        const row = list.find((u) => u.id === (params && params[1]));
        if (row) { row.role = params[0]; writeUsers(list); }
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      // Login touch update: UPDATE users SET username,email,provider,role,last_login WHERE id = $5
      if (/UPDATE\s+["']?users["']?\s+SET/i.test(sql)) {
        const list = readUsers();
        const row = list.find((u) => u.id === (params && params[4]));
        if (row) {
          row.username = params[0];
          row.email = params[1];
          row.provider = params[2];
          row.role = params[3];
          row.last_login = new Date().toISOString();
          writeUsers(list);
        }
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/SELECT\s+.*\s+FROM\s+["']?users["']?/i.test(sql)) {
        let list = readUsers();
        if (/WHERE\s+id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((u) => u.id === params[0]);
        } else if (/ORDER\s+BY\s+last_login\s+DESC/i.test(sql)) {
          list = [...list].sort((a, b) => String(b.last_login).localeCompare(String(a.last_login)));
        }
        return { rows: list };
      }

      // ----- file_shares table mocks (file sharing) -----
      const sharesRegistryPath = `${STORE_PATH}.shares.json`;
      const readShares = () => {
        if (fs.existsSync(sharesRegistryPath)) {
          try { return JSON.parse(fs.readFileSync(sharesRegistryPath, 'utf8')); } catch (e) { return []; }
        }
        return [];
      };
      const writeShares = (list) => {
        fs.writeFileSync(sharesRegistryPath, JSON.stringify(list, null, 2), 'utf8');
      };

      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["']?file_shares["']?/i.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT\s+INTO\s+["']?file_shares["']?/i.test(sql)) {
        const list = readShares();
        const role = (params && params[2]) || 'viewer';
        const existing = list.find((s) => s.file_id === (params && params[0]) && s.user_id === (params && params[1]));
        let row;
        if (existing) {
          // Mirror ON CONFLICT (file_id, user_id) DO UPDATE SET role = EXCLUDED.role.
          existing.role = role;
          row = existing;
        } else {
          row = { file_id: params && params[0], user_id: params && params[1], role, created_at: new Date().toISOString() };
          list.push(row);
        }
        writeShares(list);
        return { rows: [row] };
      }
      if (/UPDATE\s+["']?file_shares["']?\s+SET\s+role/i.test(sql)) {
        const list = readShares();
        const row = list.find((s) => s.file_id === (params && params[0]) && s.user_id === (params && params[1]));
        if (row) { row.role = params[2]; writeShares(list); }
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/DELETE\s+FROM\s+["']?file_shares["']?/i.test(sql)) {
        let list = readShares();
        const before = list.length;
        if (/user_id\s*=\s*\$2/i.test(sql) && params && params.length > 1) {
          list = list.filter((s) => !(s.file_id === params[0] && s.user_id === params[1]));
        } else if (params && params.length > 0) {
          list = list.filter((s) => s.file_id !== params[0]);
        }
        writeShares(list);
        return { rows: [], rowCount: before - list.length };
      }
      if (/SELECT\s+.*\s+FROM\s+["']?file_shares["']?/i.test(sql)) {
        let list = readShares();
        // Combined filter (file_id AND user_id) must be checked first.
        if (/file_id\s*=\s*\$1/i.test(sql) && /user_id\s*=\s*\$2/i.test(sql) && params && params.length > 1) {
          list = list.filter((s) => s.file_id === params[0] && s.user_id === params[1]);
        } else if (/WHERE\s+file_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.file_id === params[0]);
        } else if (/WHERE\s+user_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.user_id === params[0]);
        }
        // Ensure a role is always present for older rows persisted before roles existed.
        return { rows: list.map((s) => ({ role: 'viewer', ...s })) };
      }

      // ----- file_stars table mocks (per-user starred files) -----
      const starsRegistryPath = `${STORE_PATH}.stars.json`;
      const readStars = () => {
        if (fs.existsSync(starsRegistryPath)) {
          try { return JSON.parse(fs.readFileSync(starsRegistryPath, 'utf8')); } catch (e) { return []; }
        }
        return [];
      };
      const writeStars = (list) => {
        fs.writeFileSync(starsRegistryPath, JSON.stringify(list, null, 2), 'utf8');
      };

      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["']?file_stars["']?/i.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT\s+INTO\s+["']?file_stars["']?/i.test(sql)) {
        const list = readStars();
        const fileId = params && params[0];
        const userId = params && params[1];
        // Mirror ON CONFLICT (file_id, user_id) DO NOTHING.
        if (!list.find((s) => s.file_id === fileId && s.user_id === userId)) {
          list.push({ file_id: fileId, user_id: userId, created_at: new Date().toISOString() });
          writeStars(list);
        }
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE\s+FROM\s+["']?file_stars["']?/i.test(sql)) {
        let list = readStars();
        const before = list.length;
        if (/user_id\s*=\s*\$2/i.test(sql) && params && params.length > 1) {
          list = list.filter((s) => !(s.file_id === params[0] && s.user_id === params[1]));
        } else if (/WHERE\s+user_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.user_id !== params[0]);
        } else if (params && params.length > 0) {
          list = list.filter((s) => s.file_id !== params[0]);
        }
        writeStars(list);
        return { rows: [], rowCount: before - list.length };
      }
      if (/SELECT\s+.*\s+FROM\s+["']?file_stars["']?/i.test(sql)) {
        let list = readStars();
        if (/file_id\s*=\s*\$1/i.test(sql) && /user_id\s*=\s*\$2/i.test(sql) && params && params.length > 1) {
          list = list.filter((s) => s.file_id === params[0] && s.user_id === params[1]);
        } else if (/WHERE\s+user_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.user_id === params[0]);
        } else if (/WHERE\s+file_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.file_id === params[0]);
        }
        return { rows: list };
      }

      // Handle workbook_versions table creation query mock.
      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["']?workbook_versions["']?/i.test(sql)) {
        return { rows: [] };
      }

      // Handle workbook_versions database insertion mock.
      // Stores versions in a separate JSON file named like '${STORE_PATH}.versions.json'.
      if (/INSERT\s+INTO\s+["']?workbook_versions["']?/i.test(sql)) {
        let versions = [];
        const versionsPath = STORE_PATH + '.versions.json';
        if (fs.existsSync(versionsPath)) {
          try {
            versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
          } catch (e) {
            versions = [];
          }
        }
        const newId = versions.length + 1;
        const rawState = params && params[0];
        let parsedState = rawState;
        if (typeof rawState === 'string') {
          try {
            parsedState = JSON.parse(rawState);
          } catch (e) {
            // Keep as is if not valid JSON string
          }
        }
        const newVersion = {
          id: newId,
          state: parsedState,
          created_at: new Date().toISOString(),
          created_by: (params && params[1]) || 'anonymous'
        };
        versions.push(newVersion);
        fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2), 'utf8');
        return { rows: [newVersion] };
      }

      // Handle workbook_versions query mock selection.
      // Parses version logs, handles filtering by ID, and optionally reverses them for DESC sorting.
      if (/SELECT\s+.*\s+FROM\s+["']?workbook_versions["']?/i.test(sql)) {
        let versions = [];
        const versionsPath = STORE_PATH + '.versions.json';
        if (fs.existsSync(versionsPath)) {
          try {
            versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
          } catch (e) {
            versions = [];
          }
        }
        const mappedVersions = versions.map(v => {
          let parsedState = v.state;
          if (typeof parsedState === 'string') {
            try {
              parsedState = JSON.parse(parsedState);
            } catch (e) {
              // Keep as is if not valid JSON string
            }
          }
          return {
            ...v,
            state: parsedState
          };
        });
        let resultRows = mappedVersions;
        if (/WHERE\s+id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          const targetId = parseInt(params[0], 10);
          resultRows = mappedVersions.filter(v => v.id === targetId);
        } else if (/ORDER\s+BY\s+(created_at|id)\s+DESC/i.test(sql)) {
          resultRows = [...mappedVersions].reverse();
        }
        return { rows: resultRows };
      }

      // CREATE TABLE / INSERT INTO workbook_state: return empty rows, and for INSERT
      // write the state JSON (params[0]) to the path for its key (params[1], default 'default').
      if (/CREATE\s+TABLE/i.test(sql) || /INSERT\s+INTO\s+["']?workbook_state["']?/i.test(sql)) {
        if (/INSERT\s+INTO\s+["']?workbook_state["']?/i.test(sql) && params && params[0]) {
          fs.writeFileSync(pathForKey(params[1]), params[0], 'utf8');
        }
        return { rows: [] };
      }

      // SELECT key FROM workbook_state: report existence of the backing file for the requested key.
      if (/SELECT\s+key\s+FROM\s+["']?workbook_state["']?/i.test(sql)) {
        const key = (params && params[0]) || 'default';
        if (fs.existsSync(pathForKey(key))) {
          return { rows: [{ key }] };
        }
        return { rows: [] };
      }

      // SELECT state FROM workbook_state: read state for the requested key (params[0], default 'default').
      if (/SELECT\s+state\s+FROM\s+["']?workbook_state["']?/i.test(sql)) {
        const key = (params && params[0]) || 'default';
        const p = pathForKey(key);
        if (fs.existsSync(p)) {
          const data = fs.readFileSync(p, 'utf8');
          const parsed = JSON.parse(data);
          return { rows: [{ state: parsed }] };
        }
        return { rows: [] };
      }

      // UPDATE workbook_state SET state = $1 WHERE key = $2: write state (params[0]) to the key's path.
      if (/UPDATE\s+["']?workbook_state["']?\s+SET\s+state\s*=/i.test(sql)) {
        if (params && params[0]) {
          fs.writeFileSync(pathForKey(params[1]), params[0], 'utf8');
        }
        return { rows: [] };
      }

      // DELETE FROM workbook_state WHERE key = $1: remove the key's backing sidecar (never the default store here).
      if (/DELETE\s+FROM\s+["']?workbook_state["']?/i.test(sql)) {
        const p = pathForKey(params && params[0]);
        if (p !== STORE_PATH && fs.existsSync(p)) fs.unlinkSync(p);
        return { rows: [] };
      }

      return { rows: [] };
    },
    async end() {
      // Noop in mock mode.
    }
  };
} else {
  // Use real pg connection pool with DATABASE_URL in production/development.
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
  });
}

export { pool };
