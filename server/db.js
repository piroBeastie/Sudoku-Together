/**
 * Storage: accounts, solve counts, and a saved puzzle you can come back to.
 *
 * Everything goes through one `query(sql, params)` call, so the same code runs
 * against a real Postgres (Neon in production) or an in-process one in tests.
 *
 * The whole layer is optional. With no DATABASE_URL the app runs exactly as it
 * did before — guests type a name and play — and only the accounts disappear.
 */

import crypto from 'node:crypto';

let client = null;
let ready = false;

export const isEnabled = () => ready;

// Kept as separate statements: the extended query protocol accepts only one
// statement per call, so a single blob would fail on some drivers.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  handle      TEXT NOT NULL UNIQUE,        -- lowercased username, for lookups
  pass_hash   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`,

  `CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
)`,

  `CREATE TABLE IF NOT EXISTS solves (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  difficulty  TEXT NOT NULL,
  solved      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, difficulty)
)`,

  // One save per user: the puzzle they walked away from mid-solve.
  `CREATE TABLE IF NOT EXISTS saves (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  difficulty  TEXT NOT NULL,
  puzzle      TEXT NOT NULL,               -- 81 chars, '0' for a blank
  solution    TEXT NOT NULL,
  grid        TEXT NOT NULL,
  elapsed_ms  BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`,

  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`,
];

/**
 * Connects and creates the schema. Never throws: a database that is missing or
 * unreachable degrades to guest-only play rather than taking the game down.
 */
export async function initDb(url = process.env.DATABASE_URL) {
  if (!url) {
    console.log('[db] no DATABASE_URL — running without accounts');
    return false;
  }
  // `DATABASE_URL=pglite` runs Postgres inside this process — handy for local
  // testing of the account flows without signing up for anything. Development
  // only: the package is a devDependency and is absent from a production install.
  if (url === 'pglite') {
    try {
      const { PGlite } = await import('@electric-sql/pglite');
      await useClient(new PGlite());
      console.log('[db] in-process Postgres (development only) — accounts enabled');
      return true;
    } catch (err) {
      console.error('[db] pglite unavailable:', err.message);
      return false;
    }
  }

  try {
    const { default: pg } = await import('pg');
    const isLocal = /localhost|127\.0\.0\.1/.test(url);

    // TLS is configured below, explicitly. Leaving sslmode/channel_binding in
    // the string makes node-postgres warn that it will reinterpret them in a
    // future major version, so drop them and keep the behaviour ours.
    const clean = url.replace(/([?&])(sslmode|channel_binding)=[^&]*/g, '$1').replace(/[?&]$/, '');

    const pool = new pg.Pool({
      connectionString: clean,
      // Hosted Postgres needs TLS and presents a real certificate, so verify it.
      // DATABASE_SSL_NO_VERIFY=1 is the escape hatch for a provider using a
      // self-signed certificate; it weakens the connection, so leave it unset.
      ssl: isLocal ? false : { rejectUnauthorized: process.env.DATABASE_SSL_NO_VERIFY !== '1' },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    await pool.query('SELECT 1');
    client = pool;
    await applySchema();
    ready = true;
    console.log('[db] connected — accounts enabled');
    return true;
  } catch (err) {
    console.error('[db] unavailable, continuing without accounts:', err.message);
    client = null;
    ready = false;
    return false;
  }
}

/** Test hook: run against any object exposing query(sql, params) -> { rows }. */
export async function useClient(injected) {
  client = injected;
  await applySchema();
  ready = true;
}

async function applySchema() {
  for (const statement of SCHEMA) await client.query(statement);
}

export async function closeDb() {
  if (client?.end) await client.end();
  client = null;
  ready = false;
}

const query = (sql, params = []) => client.query(sql, params);

/* --------------------------------------------------------------- passwords */

/**
 * scrypt, from Node's own crypto — no dependency, and deliberately slow so a
 * stolen table cannot be brute-forced quickly.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  // Constant-time compare, so a wrong guess cannot be timed against a right one.
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const newToken = () => crypto.randomBytes(32).toString('base64url');

/* ------------------------------------------------------------------ grids */

// Grids move as 81-character strings; '0' is a blank.
const encodeGrid = (cells) => cells.map((v) => String(v || 0)).join('');
const decodeGrid = (text) => [...String(text)].map((c) => Number(c) || 0);

/* ------------------------------------------------------------- accounts */

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

export async function createUser(username, password) {
  const handle = username.toLowerCase();
  const existing = await query('SELECT 1 FROM users WHERE handle = $1', [handle]);
  if (existing.rows.length) return { error: 'That name is taken.' };

  const result = await query(
    'INSERT INTO users (username, handle, pass_hash) VALUES ($1, $2, $3) RETURNING id, username',
    [username, handle, hashPassword(password)]
  );
  const user = result.rows[0];
  return { user: { id: String(user.id), username: user.username } };
}

export async function signIn(username, password) {
  const result = await query('SELECT id, username, pass_hash FROM users WHERE handle = $1', [
    username.toLowerCase(),
  ]);
  const row = result.rows[0];
  // Same message either way, so the form cannot be used to discover usernames.
  if (!row || !verifyPassword(password, row.pass_hash)) {
    return { error: 'Wrong name or password.' };
  }
  return { user: { id: String(row.id), username: row.username } };
}

export async function startSession(userId) {
  const token = newToken();
  await query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  return token;
}

export async function endSession(token) {
  if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
}

/** Resolves a session token to its user, or null. */
export async function userForToken(token) {
  if (!token) return null;
  const result = await query(
    `SELECT u.id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [token]
  );
  const row = result.rows[0];
  if (!row) return null;
  query('UPDATE sessions SET last_seen = now() WHERE token = $1', [token]).catch(() => {});
  return { id: String(row.id), username: row.username };
}

/**
 * Removes accounts whose handle matches a LIKE pattern, and everything hanging
 * off them. Exists so the test suite can tidy up after itself instead of
 * leaving rows behind in a real database.
 */
export async function deleteUsersMatching(pattern) {
  const result = await query('DELETE FROM users WHERE handle LIKE $1', [pattern]);
  return result.rowCount ?? 0;
}

/* --------------------------------------------------------------- stats */

export async function recordSolve(userId, difficulty) {
  await query(
    `INSERT INTO solves (user_id, difficulty, solved) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, difficulty) DO UPDATE SET solved = solves.solved + 1`,
    [userId, difficulty]
  );
}

/** Solve counts per difficulty, always with all three keys present. */
export async function getStats(userId) {
  const result = await query('SELECT difficulty, solved FROM solves WHERE user_id = $1', [userId]);
  const stats = { easy: 0, medium: 0, hard: 0, total: 0 };
  for (const row of result.rows) {
    const n = Number(row.solved) || 0;
    if (row.difficulty in stats) stats[row.difficulty] = n;
    stats.total += n;
  }
  return stats;
}

/* --------------------------------------------------------------- saves */

/** Stores the puzzle in progress, replacing any earlier one for this user. */
export async function saveProgress(userId, { difficulty, puzzle, solution, grid, elapsedMs }) {
  await query(
    `INSERT INTO saves (user_id, difficulty, puzzle, solution, grid, elapsed_ms, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id) DO UPDATE SET
       difficulty = EXCLUDED.difficulty,
       puzzle     = EXCLUDED.puzzle,
       solution   = EXCLUDED.solution,
       grid       = EXCLUDED.grid,
       elapsed_ms = EXCLUDED.elapsed_ms,
       updated_at = now()`,
    [userId, difficulty, encodeGrid(puzzle), encodeGrid(solution), encodeGrid(grid), Math.round(elapsedMs)]
  );
}

export async function loadProgress(userId) {
  const result = await query(
    'SELECT difficulty, puzzle, solution, grid, elapsed_ms FROM saves WHERE user_id = $1',
    [userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    difficulty: row.difficulty,
    puzzle: decodeGrid(row.puzzle),
    solution: decodeGrid(row.solution),
    grid: decodeGrid(row.grid),
    elapsedMs: Number(row.elapsed_ms) || 0,
  };
}

export async function clearProgress(userId) {
  await query('DELETE FROM saves WHERE user_id = $1', [userId]);
}

/** How far along the saved puzzle is, for the lobby's Continue button. */
export async function progressSummary(userId) {
  const save = await loadProgress(userId);
  if (!save) return null;
  const blanks = save.puzzle.filter((v) => v === 0).length;
  const filled = save.puzzle.filter((v, i) => v === 0 && save.grid[i] !== 0).length;
  return { difficulty: save.difficulty, filled, blanks, elapsedMs: save.elapsedMs };
}
