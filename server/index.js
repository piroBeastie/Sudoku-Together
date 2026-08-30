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
  getRoom,
  roomCount,
  sanitizeName,
  sanitizeText,
  sweepRooms,
} from './rooms.js';

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

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, rooms: roomCount(), pool: poolStats(), uptime: process.uptime() })
);

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
    })),
    ownerId: room.ownerId,
  };
}

function systemMessage(room, text) {
  const entry = { kind: 'system', text, ts: Date.now() };
  room.pushChat(entry);
  broadcast(room, 'chat', { message: entry });
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

      const name = sanitizeName(msg.name);
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
      } else {
        // "Play" always opens a fresh room with its own code to share.
        room = await createRoom({ difficulty: asDifficulty(msg.difficulty) });
      }

      const player = room.addPlayer(name);
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

server.listen(PORT, () => {
  console.log(`Sudoku Together on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
