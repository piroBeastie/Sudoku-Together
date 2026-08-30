/**
 * Room state: the shared grid, the two players in it, and the chat log.
 *
 * Everything lives in this process's memory and nothing is written to disk.
 * A room exists while people are in it and is swept once it has been empty a
 * few minutes; a server restart clears the lot. Puzzles are generated fresh
 * rather than stored, so there is nothing to keep.
 */

import { takePuzzle } from './puzzle-pool.js';

export const MAX_PLAYERS = 2;
export const DIFFICULTY_LEVELS = ['easy', 'medium', 'hard'];

const CHAT_HISTORY = 120;
const EMPTY_ROOM_GRACE_MS = 1000 * 60 * 3; // keep an empty room briefly so a refresh can rejoin

// Ambiguous characters (0/O, 1/I) left out so codes survive being read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SEATS = [0, 1];

/** @type {Map<string, Room>} */
const rooms = new Map();

function newCode() {
  let code;
  do {
    code = Array.from(
      { length: 5 },
      () => CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]
    ).join('');
  } while (rooms.has(code));
  return code;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function sanitizeName(raw) {
  const name = String(raw || '')
    .replace(CONTROL_CHARS, '')
    .trim()
    .slice(0, 16);
  return name || 'Player';
}

export function sanitizeText(raw) {
  return String(raw || '')
    .replace(CONTROL_CHARS, ' ')
    .trim()
    .slice(0, 400);
}

class Room {
  constructor(code, puzzle) {
    this.code = code;
    this.puzzle = puzzle.puzzle;
    this.solution = puzzle.solution;
    this.difficulty = puzzle.difficulty;
    this.level = puzzle.level;
    this.grid = puzzle.puzzle.slice();
    this.authors = new Array(81).fill(null); // who filled each cell
    this.players = []; // { id, name, seat, connected, lastSeen }
    this.ownerId = null; // whoever opened the room; may start the next puzzle
    this.chat = [];
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.startedAt = Date.now();
    this.elapsedMs = 0;
    this.running = false;
    this.solvedAt = null;
    this.solvedBy = null; // { id, name } of whoever placed the final digit
    this.credits = new Map(); // player id -> name, kept after they leave
    this.emptiedAt = Date.now(); // when the last player left; drives the sweep
  }

  get isFull() {
    return this.players.length >= MAX_PLAYERS;
  }

  /** Wall-clock solve time, counting only while at least one player is present. */
  timeMs() {
    if (this.solvedAt) return this.elapsedMs;
    return this.elapsedMs + (this.running ? Date.now() - this.startedAt : 0);
  }

  startClock() {
    if (!this.running && !this.solvedAt) {
      this.running = true;
      this.startedAt = Date.now();
    }
  }

  stopClock() {
    if (this.running) {
      this.elapsedMs += Date.now() - this.startedAt;
      this.running = false;
    }
  }

  addPlayer(name, userId = null) {
    const taken = new Set(this.players.map((p) => p.seat));
    const seat = SEATS.find((s) => !taken.has(s)) ?? 0;
    const player = {
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      seat,
      userId,
      connected: true,
      lastSeen: Date.now(),
    };
    this.players.push(player);
    this.credits.set(player.id, name);
    this.emptiedAt = 0;
    if (!this.ownerId) this.ownerId = player.id;
    this.startClock();
    this.touch();
    return player;
  }

  removePlayer(id) {
    this.players = this.players.filter((p) => p.id !== id);
    // Ownership follows the room, not the person: if the owner walks away, the
    // player still solving inherits the right to move on to the next puzzle.
    if (this.ownerId === id) this.ownerId = this.players[0]?.id || null;
    if (this.players.length === 0) {
      this.stopClock();
      this.emptiedAt = Date.now();
    }
    this.touch();
  }

  /**
   * Cells filled per player, so the win card can credit both of them.
   * Names come from `credits`, which outlives leaving, so a player who steps
   * away before the last digit still gets credit for the work they did.
   */
  contributions() {
    const counts = new Map();
    for (let i = 0; i < 81; i++) {
      if (this.puzzle[i] !== 0 || !this.grid[i]) continue;
      const id = this.authors[i];
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    // Everyone currently here shows up, even with nothing filled yet.
    for (const p of this.players) if (!counts.has(p.id)) counts.set(p.id, 0);

    return [...counts.entries()]
      .map(([id, filled]) => ({
        id,
        name: this.credits.get(id) || 'Player',
        filled,
        present: this.players.some((p) => p.id === id),
      }))
      .sort((a, b) => b.filled - a.filled);
  }

  /** The shape stored for 'continue where you left off'. */
  saveState() {
    return {
      difficulty: this.difficulty,
      puzzle: this.puzzle,
      solution: this.solution,
      grid: this.grid,
      elapsedMs: this.timeMs(),
    };
  }

  isOwner(id) {
    return this.ownerId === id;
  }

  isSolved() {
    for (let i = 0; i < 81; i++) if (this.grid[i] !== this.solution[i]) return false;
    return true;
  }

  /**
   * Applies a move. Givens are immutable; everything else is shared, so either
   * player may overwrite the other's entry.
   */
  setCell(index, value, playerId) {
    if (index < 0 || index > 80) return { ok: false, reason: 'bad-cell' };
    if (this.puzzle[index] !== 0) return { ok: false, reason: 'given' };
    if (this.solvedAt) return { ok: false, reason: 'solved' };
    const v = Number(value) | 0;
    if (v < 0 || v > 9) return { ok: false, reason: 'bad-value' };

    this.grid[index] = v;
    this.authors[index] = v ? playerId : null;
    this.touch();

    const solved = this.isSolved();
    if (solved && !this.solvedAt) {
      this.stopClock();
      this.solvedAt = Date.now();
      this.solvedBy = { id: playerId, name: this.credits.get(playerId) || 'Player' };
    }
    return { ok: true, solved };
  }

  loadPuzzle(puzzle) {
    this.puzzle = puzzle.puzzle;
    this.solution = puzzle.solution;
    this.difficulty = puzzle.difficulty;
    this.level = puzzle.level;
    this.grid = puzzle.puzzle.slice();
    this.authors = new Array(81).fill(null);
    this.credits = new Map(this.players.map((p) => [p.id, p.name]));
    this.solvedAt = null;
    this.solvedBy = null;
    this.elapsedMs = 0;
    this.running = false;
    this.startClock();
    this.touch();
  }

  pushChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.touch();
  }

  touch() {
    this.updatedAt = Date.now();
  }

  /** The full snapshot a joining client needs to render the room. */
  snapshot() {
    return {
      code: this.code,
      givens: this.puzzle,
      grid: this.grid,
      authors: this.authors,
      difficulty: this.difficulty,
      level: this.level,
      ownerId: this.ownerId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        connected: p.connected,
        signedIn: !!p.userId,
      })),
      chat: this.chat,
      timeMs: this.timeMs(),
      running: this.running,
      solved: !!this.solvedAt,
      solvedBy: this.solvedBy,
      contributions: this.contributions(),
      maxPlayers: MAX_PLAYERS,
    };
  }
}

export async function createRoom({ difficulty = 'hard' } = {}) {
  const puzzle = await takePuzzle(difficulty);
  const room = new Room(newCode(), puzzle);
  rooms.set(room.code, room);
  return room;
}

/** Rebuilds a room around a puzzle someone left unfinished. */
export function createRoomFromSave(save) {
  const room = new Room(newCode(), {
    puzzle: save.puzzle,
    solution: save.solution,
    difficulty: save.difficulty,
    level: 0,
  });
  room.grid = save.grid.slice();
  room.elapsedMs = save.elapsedMs || 0;
  rooms.set(room.code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase().trim()) || null;
}

/**
 * Drops rooms nobody is in. The grace period is what makes a refresh or a
 * dropped signal survivable: the room is still there when you come back, but
 * an abandoned one is gone minutes later rather than sitting in memory.
 */
export function sweepRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.length === 0 && now - room.emptiedAt > EMPTY_ROOM_GRACE_MS) {
      rooms.delete(code);
    }
  }
}

export function roomCount() {
  return rooms.size;
}
