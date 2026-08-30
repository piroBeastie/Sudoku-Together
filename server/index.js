/**
 * Sudoku Together — HTTP + WebSocket server.
 *
 * One WebSocket per player. Every mutation goes through the server, which owns
 * the authoritative grid, so the two clients can never drift apart.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { warmUp, poolStats, takePuzzle } from './puzzle-pool.js';
import {
  DIFFICULTY_LEVELS,
  createRoom,
  createRoomFromSave,
  getRoom,
  roomCount,
  sanitizeName,
  sanitizeText,
  sweepRooms,
} from './rooms.js';
import * as db from './db.js';

const PORT = process.env.PORT || 3000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');

const HEARTBEAT_MS = 30000;
const CHAT_MIN_GAP_MS = 400;

// Flood protection. Sized well above human speed (a fast solver peaks around
// 5 moves/sec) so real play is never throttled — and when it does trip, the
// client is told, because a silently dropped move looks like a lost digit.
const RATE_BURST = 60;
const RATE_REFILL_PER_SEC = 25;

const app = express();

// Cache hard in production; in development revalidate every time, otherwise an
// edited stylesheet keeps serving from the browser cache.
app.use(
  express.static(PUBLIC_DIR, {
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    etag: true,
  })
);

app.use(express.json({ limit: '4kb' }));

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    rooms: roomCount(),
    pool: poolStats(),
    accounts: db.isEnabled(),
    uptime: process.uptime(),
  })
);

/* ------------------------------------------------------------------ accounts */

const MIN_PASSWORD = 6;

// Signing in is the one place worth guessing at, and scrypt makes each attempt
// cost real CPU — so cap attempts per address rather than let someone grind.
const AUTH_ATTEMPTS = new Map(); // ip -> { count, resetAt }
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_ATTEMPTS = 12;

function authThrottled(req) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = AUTH_ATTEMPTS.get(ip);
  if (!entry || now > entry.resetAt) {
    AUTH_ATTEMPTS.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > AUTH_MAX_ATTEMPTS;
}

const bearer = (req) => String(req.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;

/** Everything the lobby needs to draw itself for a signed-in player. */
async function accountPayload(user, token) {
  const [stats, save] = await Promise.all([db.getStats(user.id), db.progressSummary(user.id)]);
  return { user, token, stats, save };
}

function requireDb(res) {
  if (db.isEnabled()) return true;
  res.status(503).json({ error: 'Accounts are unavailable right now.' });
  return false;
}

app.post('/api/signup', async (req, res) => {
  if (!requireDb(res)) return;
  if (authThrottled(req)) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!db.USERNAME_RE.test(username)) {
    return res.status(400).json({ error: '3–16 letters, numbers or underscores.' });
  }
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password needs ${MIN_PASSWORD}+ characters.` });
  }

  try {
    const { user, error } = await db.createUser(username, password);
    if (error) return res.status(409).json({ error });
    res.json(await accountPayload(user, await db.startSession(user.id)));
  } catch (err) {
    console.error('[auth] signup failed:', err.message);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

app.post('/api/signin', async (req, res) => {
  if (!requireDb(res)) return;
  if (authThrottled(req)) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  try {
    const { user, error } = await db.signIn(username, password);
    if (error) return res.status(401).json({ error });
    res.json(await accountPayload(user, await db.startSession(user.id)));
  } catch (err) {
    console.error('[auth] signin failed:', err.message);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});

app.post('/api/signout', async (req, res) => {
  if (db.isEnabled()) await db.endSession(bearer(req)).catch(() => {});
  res.json({ ok: true });
});

/** Restores a session on page load, and refreshes stats and the saved puzzle. */
app.get('/api/me', async (req, res) => {
  if (!db.isEnabled()) return res.status(503).json({ error: 'Accounts are unavailable.' });
  const token = bearer(req);
  try {
    const user = await db.userForToken(token);
    if (!user) return res.status(401).json({ error: 'Signed out.' });
    res.json(await accountPayload(user, token));
  } catch (err) {
    console.error('[auth] session lookup failed:', err.message);
    res.status(500).json({ error: 'Could not read the session.' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** socket -> { room, player } */
const sessions = new Map();

const asDifficulty = (value, fallback = 'hard') =>
  DIFFICULTY_LEVELS.includes(value) ? value : fallback;

function send(socket, type, payload = {}) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ t: type, ...payload }));
  }
}

/** Sends to everyone in a room, optionally skipping one socket. */
function broadcast(room, type, payload = {}, except = null) {
  for (const [socket, session] of sessions) {
    if (session.room !== room || socket === except) continue;
    send(socket, type, payload);
  }
}

function roster(room) {
  return {
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      connected: p.connected,
      signedIn: !!p.userId,
    })),
    ownerId: room.ownerId,
  };
}

function systemMessage(room, text) {
  const entry = { kind: 'system', text, ts: Date.now() };
  room.pushChat(entry);
  broadcast(room, 'chat', { message: entry });
}

/* ------------------------------------------------------- saving and stats */

const signedInPlayers = (room) => room.players.filter((p) => p.userId);

/**
 * Stores the unfinished grid against every signed-in player in the room, so
 * either of them can pick it up later. Fire-and-forget: a storage hiccup must
 * never interrupt play.
 */
function persistRoom(room) {
  if (!db.isEnabled() || room.solvedAt) return;
  // Nothing filled in yet is nothing worth resuming — otherwise opening a room
  // and leaving would offer "continue" on a puzzle you never touched.
  const touched = room.grid.some((v, i) => room.puzzle[i] === 0 && v !== 0);
  if (!touched) return;
  const state = room.saveState();
  for (const player of signedInPlayers(room)) {
    db.saveProgress(player.userId, state).catch((err) =>
      console.error('[db] save failed:', err.message)
    );
  }
}

/** Credits the solve to everyone signed in who was there, and clears the save. */
function recordSolve(room) {
  if (!db.isEnabled()) return;
  for (const player of signedInPlayers(room)) {
    db.recordSolve(player.userId, room.difficulty).catch((err) =>
      console.error('[db] solve count failed:', err.message)
    );
    db.clearProgress(player.userId).catch(() => {});
  }
}

// Writing on every keystroke would hammer the database for no benefit, so
// changed rooms are collected and flushed on a timer instead.
const dirtyRooms = new Set();
const SAVE_FLUSH_MS = 8000;

function markDirty(room) {
  if (db.isEnabled() && signedInPlayers(room).length) dirtyRooms.add(room);
}

const saveFlusher = setInterval(() => {
  for (const room of dirtyRooms) persistRoom(room);
  dirtyRooms.clear();
}, SAVE_FLUSH_MS);
saveFlusher.unref();

/** Sends a player their refreshed stats after a solve, without a page reload. */
async function pushAccount(socket, player) {
  if (!db.isEnabled() || !player.userId) return;
  try {
    const [stats, save] = await Promise.all([
      db.getStats(player.userId),
      db.progressSummary(player.userId),
    ]);
    send(socket, 'account', { stats, save });
  } catch {
    /* stats are cosmetic; never surface a failure mid-game */
  }
}

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  let lastChatAt = 0;
  let tokens = RATE_BURST;
  let tokensAt = Date.now();

  /** Token bucket; false means this message should be refused, not dropped. */
  const allow = () => {
    const now = Date.now();
    tokens = Math.min(RATE_BURST, tokens + ((now - tokensAt) / 1000) * RATE_REFILL_PER_SEC);
    tokensAt = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  socket.on('message', async (raw) => {
    if (!allow()) return send(socket, 'error', { text: 'Slow down a moment.' });

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(socket, 'error', { text: 'Malformed message.' });
    }

    const session = sessions.get(socket);

    /* ------------------------------------------------------------- joining */
    if (msg.t === 'join') {
      if (session) return send(socket, 'error', { text: 'Already in a room.' });

      // A token means an account: the stored name wins over anything typed.
      const account = db.isEnabled() ? await db.userForToken(msg.token).catch(() => null) : null;
      const name = account ? account.username : sanitizeName(msg.name);
      let room;

      if (msg.mode === 'code') {
        room = getRoom(msg.code);
        if (!room) {
          return send(socket, 'error', {
            text: 'No room with that code. Check it and try again.',
            fatal: true,
          });
        }
        if (room.isFull) {
          return send(socket, 'error', { text: 'That room already has two players.', fatal: true });
        }
      } else if (msg.mode === 'continue') {
        if (!account) {
          return send(socket, 'error', { text: 'Sign in to pick up where you left off.', fatal: true });
        }
        const save = await db.loadProgress(account.id).catch(() => null);
        if (!save) {
          return send(socket, 'error', { text: 'Nothing saved to continue.', fatal: true });
        }
        room = createRoomFromSave(save);
      } else {
        // "Play" always opens a fresh room with its own code to share.
        room = await createRoom({ difficulty: asDifficulty(msg.difficulty) });
      }

      const player = room.addPlayer(name, account?.id || null);
      sessions.set(socket, { room, player });

      send(socket, 'joined', { you: player, state: room.snapshot() });
      broadcast(room, 'players', roster(room), socket);
      systemMessage(room, `${name} joined`);
      return;
    }

    if (!session) return send(socket, 'error', { text: 'Join a room first.' });
    const { room, player } = session;

    /* -------------------------------------------------------------- in-game */
    switch (msg.t) {
      case 'move': {
        const index = Number(msg.index) | 0;
        const result = room.setCell(index, msg.value, player.id);
        if (!result.ok) return send(socket, 'reject', { index, reason: result.reason });

        broadcast(room, 'move', {
          index,
          value: Number(msg.value) | 0,
          by: player.id,
        });

        if (result.solved) {
          broadcast(room, 'solved', {
            timeMs: room.timeMs(),
            solvedBy: room.solvedBy,
            contributions: room.contributions(),
          });
          systemMessage(room, `${player.name} placed the last number — solved!`);
          recordSolve(room);
          // Give each player their updated counts straight away.
          for (const [sock, s] of sessions) {
            if (s.room === room) pushAccount(sock, s.player);
          }
        } else {
          markDirty(room);
        }
        return;
      }

      case 'select': {
        // Cursor sharing: fire-and-forget, never persisted, sender excluded.
        const index = msg.index === null ? null : Number(msg.index) | 0;
        broadcast(room, 'select', { index, by: player.id }, socket);
        return;
      }

      case 'chat': {
        const now = Date.now();
        if (now - lastChatAt < CHAT_MIN_GAP_MS) return;
        lastChatAt = now;
        const text = sanitizeText(msg.text);
        if (!text) return;
        const entry = {
          kind: 'chat',
          text,
          by: player.id,
          name: player.name,
          seat: player.seat,
          ts: now,
        };
        room.pushChat(entry);
        broadcast(room, 'chat', { message: entry });
        return;
      }

      case 'nextPuzzle': {
        // Skipping wipes the grid for both players, so it is the room owner's
        // call alone — otherwise either player could bin the other's progress.
        if (!room.isOwner(player.id)) {
          return send(socket, 'error', { text: 'Only the person who opened the room can skip.' });
        }
        const difficulty = asDifficulty(msg.difficulty, room.difficulty);
        room.loadPuzzle(await takePuzzle(difficulty));
        persistRoom(room);
        broadcast(room, 'state', { state: room.snapshot() });
        systemMessage(room, `${player.name} started a new ${difficulty} puzzle`);
        return;
      }

      case 'ping':
        return send(socket, 'pong');

      default:
        return;
    }
  });

  socket.on('close', () => {
    const session = sessions.get(socket);
    sessions.delete(socket);
    if (!session) return;
    const { room, player } = session;
    // Flush before dropping them, while they are still counted as in the room.
    persistRoom(room);
    dirtyRooms.delete(room);
    room.removePlayer(player.id);
    broadcast(room, 'players', roster(room));
    systemMessage(room, `${player.name} left`);
  });

  socket.on('error', () => socket.terminate());
});

// Drop sockets that stopped answering — otherwise a dead tab holds a seat.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

const sweeper = setInterval(sweepRooms, 1000 * 60);
sweeper.unref();

warmUp();

// Serve straight away and connect to the database alongside. A sleeping Neon
// takes seconds to wake, and waiting for it would hold up every page load and
// risk a failed health check on a cold start. Until it lands, accounts are
// simply unavailable and guests play as normal.
db.initDb().catch((err) => console.error('[db] init failed:', err.message));

server.listen(PORT, () => {
  console.log(`Sudoku Together on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
