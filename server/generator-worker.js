/** Worker thread: generates puzzles off the main event loop. */

import { parentPort } from 'node:worker_threads';
import { generate } from './sudoku.js';

parentPort.on('message', ({ id, difficulty }) => {
  try {
    parentPort.postMessage({ id, puzzle: generate(difficulty) });
  } catch (err) {
    parentPort.postMessage({ id, puzzle: null, error: err.message });
  }
});
