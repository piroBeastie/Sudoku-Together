/**
 * Keeps a warm pool of puzzles per difficulty so starting a game is instant.
 *
 * Generation runs in a worker thread — a hard puzzle costs ~100ms of solid CPU
 * and would otherwise stall moves and chat for everyone in every room.
 *
 * Swapping in a third-party puzzle API: replace the body of `produce()` with
 * your fetch call. It must return { puzzle, solution } as 81-length arrays.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { generate } from './sudoku.js';

const POOL_TARGET = { easy: 4, medium: 4, hard: 8 };
const WORKER_URL = new URL('./generator-worker.js', import.meta.url);

const pools = { easy: [], medium: [], hard: [] };
const pending = new Map();

let worker = null;
let seq = 0;
let filling = false;

function startWorker() {
  if (worker) return worker;
  worker = new Worker(fileURLToPath(WORKER_URL));
  worker.unref(); // never keep the process alive just for generation

  worker.on('message', (msg) => {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    if (resolve) resolve(msg.puzzle);
  });

  worker.on('error', (err) => {
    console.error('[pool] worker error:', err.message);
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
    worker = null;
  });

  worker.on('exit', () => {
    worker = null;
  });

  return worker;
}

function produce(difficulty) {
  return new Promise((resolve) => {
    const w = startWorker();
    if (!w) return resolve(generate(difficulty));
    const id = ++seq;
    pending.set(id, resolve);
    w.postMessage({ id, difficulty });
  });
}

/** Tops every pool back up to target, one puzzle at a time. */
async function refill() {
  if (filling) return;
  filling = true;
  try {
    for (const [difficulty, target] of Object.entries(POOL_TARGET)) {
      while (pools[difficulty].length < target) {
        const puzzle = await produce(difficulty);
        if (!puzzle) return; // worker died; try again on the next take
        pools[difficulty].push(puzzle);
      }
    }
  } finally {
    filling = false;
  }
}

/** Warms the pools in the background at boot. */
export function warmUp() {
  refill().catch((err) => console.error('[pool] warm-up failed:', err.message));
}

/**
 * Hands out a puzzle. Served from the pool when possible; otherwise generated
 * inline (a one-off stall beats making the caller wait on the worker).
 */
export async function takePuzzle(difficulty = 'hard') {
  const pool = pools[difficulty] || pools.hard;
  const puzzle = pool.pop() || (await produce(difficulty)) || generate(difficulty);
  refill().catch(() => {});
  return puzzle;
}

export function poolStats() {
  return Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length]));
}
