/**
 * Sudoku engine: generation, uniqueness checking and difficulty rating.
 *
 * Grids are flat arrays of 81 numbers, 0 = empty, row-major.
 * Candidates are tracked as 9-bit masks (bit 0 => digit 1).
 */

const ROWS = [];
const COLS = [];
const BOXES = [];
const PEERS = [];
const UNITS = [];

for (let i = 0; i < 81; i++) {
  const r = (i / 9) | 0;
  const c = i % 9;
  const b = ((r / 3) | 0) * 3 + ((c / 3) | 0);
  (ROWS[r] ||= []).push(i);
  (COLS[c] ||= []).push(i);
  (BOXES[b] ||= []).push(i);
}
for (const unit of [...ROWS, ...COLS, ...BOXES]) UNITS.push(unit);

for (let i = 0; i < 81; i++) {
  const r = (i / 9) | 0;
  const c = i % 9;
  const b = ((r / 3) | 0) * 3 + ((c / 3) | 0);
  const set = new Set([...ROWS[r], ...COLS[c], ...BOXES[b]]);
  set.delete(i);
  PEERS[i] = [...set];
}

export const boxOf = (i) => (((i / 9) | 0) / 3 | 0) * 3 + ((i % 9) / 3 | 0);

const ALL = 0b111111111;
const BIT = (d) => 1 << (d - 1);

const popcount = (m) => {
  let n = 0;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
};

const lowestDigit = (m) => Math.log2(m & -m) + 1;

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** Candidate mask for every empty cell, or null if the grid is contradictory. */
function candidates(grid) {
  const cand = new Array(81).fill(ALL);
  for (let i = 0; i < 81; i++) {
    if (!grid[i]) continue;
    cand[i] = 0;
    const bit = BIT(grid[i]);
    for (const p of PEERS[i]) {
      if (grid[p] === grid[i]) return null; // duplicate inside a unit
      cand[p] &= ~bit;
    }
  }
  for (let i = 0; i < 81; i++) if (!grid[i] && cand[i] === 0) return null;
  return cand;
}

/**
 * Counts solutions, stopping as soon as `limit` is reached.
 * Constraint propagation on naked singles + minimum-remaining-values branching.
 */
export function countSolutions(grid, limit = 2) {
  const work = Int8Array.from(grid);
  let found = 0;

  const search = () => {
    if (found >= limit) return;
    const filled = [];
    let cand = candidates(work);
    if (!cand) return;

    for (;;) {
      let progressed = false;
      for (let i = 0; i < 81; i++) {
        if (work[i] || cand[i] === 0) continue;
        if (popcount(cand[i]) === 1) {
          work[i] = lowestDigit(cand[i]);
          filled.push(i);
          progressed = true;
        }
      }
      if (!progressed) break;
      cand = candidates(work);
      if (!cand) {
        for (const i of filled) work[i] = 0;
        return;
      }
    }

    let best = -1;
    let bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (work[i]) continue;
      const n = popcount(cand[i]);
      if (n < bestCount) {
        bestCount = n;
        best = i;
        if (n === 2) break;
      }
    }

    if (best === -1) {
      found++;
    } else {
      let mask = cand[best];
      while (mask && found < limit) {
        const d = lowestDigit(mask);
        mask &= mask - 1;
        work[best] = d;
        search();
        work[best] = 0;
      }
    }

    for (const i of filled) work[i] = 0;
  };

  search();
  return found;
}

/** Returns a solved copy of the grid, or null if unsolvable. */
export function solve(grid) {
  const work = Int8Array.from(grid);
  const rec = () => {
    const cand = candidates(work);
    if (!cand) return false;
    let best = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (work[i]) continue;
      const n = popcount(cand[i]);
      if (n < bestCount) {
        bestCount = n;
        best = i;
        bestMask = cand[i];
      }
    }
    if (best === -1) return true;
    let mask = bestMask;
    while (mask) {
      const d = lowestDigit(mask);
      mask &= mask - 1;
      work[best] = d;
      if (rec()) return true;
      work[best] = 0;
    }
    return false;
  };
  return rec() ? Array.from(work) : null;
}

/** A random complete, valid grid. */
function generateSolved(rand) {
  const grid = new Int8Array(81);
  const rec = (pos) => {
    if (pos === 81) return true;
    const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rand);
    for (const d of digits) {
      let ok = true;
      for (const p of PEERS[pos]) {
        if (grid[p] === d) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      grid[pos] = d;
      if (rec(pos + 1)) return true;
      grid[pos] = 0;
    }
    return false;
  };
  rec(0);
  return Array.from(grid);
}

/**
 * Rates a puzzle by the hardest human technique it needs.
 *   1 naked singles only                      -> easy
 *   2 hidden singles                          -> medium
 *   3 locked candidates / naked pairs         -> hard
 *   4 beyond the above (chains, trial)        -> harder than we offer
 */
export function rate(grid) {
  const work = Int8Array.from(grid);
  const cand = candidates(grid);
  if (!cand) return 0;
  let hardest = 1;

  const assign = (i, d) => {
    work[i] = d;
    cand[i] = 0;
    const bit = BIT(d);
    for (const p of PEERS[i]) cand[p] &= ~bit;
  };

  const nakedSingle = () => {
    for (let i = 0; i < 81; i++) {
      if (!work[i] && popcount(cand[i]) === 1) {
        assign(i, lowestDigit(cand[i]));
        return true;
      }
    }
    return false;
  };

  const hiddenSingle = () => {
    for (const unit of UNITS) {
      for (let d = 1; d <= 9; d++) {
        const bit = BIT(d);
        let spot = -1;
        let n = 0;
        let placed = false;
        for (const i of unit) {
          if (work[i] === d) {
            placed = true;
            break;
          }
          if (!work[i] && cand[i] & bit) {
            n++;
            spot = i;
          }
        }
        if (!placed && n === 1) {
          assign(spot, d);
          return true;
        }
      }
    }
    return false;
  };

  // Pointing / claiming: a digit confined to one line inside a unit can be
  // eliminated from the rest of the intersecting unit.
  const lockedCandidates = () => {
    let changed = false;
    for (const unit of UNITS) {
      for (let d = 1; d <= 9; d++) {
        const bit = BIT(d);
        const spots = unit.filter((i) => !work[i] && cand[i] & bit);
        if (spots.length < 2 || spots.length > 3) continue;
        const rows = new Set(spots.map((i) => (i / 9) | 0));
        const cols = new Set(spots.map((i) => i % 9));
        const boxes = new Set(spots.map(boxOf));
        const targets = [];
        if (rows.size === 1) targets.push(ROWS[[...rows][0]]);
        if (cols.size === 1) targets.push(COLS[[...cols][0]]);
        if (boxes.size === 1) targets.push(BOXES[[...boxes][0]]);
        for (const target of targets) {
          for (const i of target) {
            if (work[i] || spots.includes(i)) continue;
            if (cand[i] & bit) {
              cand[i] &= ~bit;
              changed = true;
            }
          }
        }
      }
    }
    return changed;
  };

  const nakedPairs = () => {
    let changed = false;
    for (const unit of UNITS) {
      const open = unit.filter((i) => !work[i]);
      for (let a = 0; a < open.length; a++) {
        if (popcount(cand[open[a]]) !== 2) continue;
        for (let b = a + 1; b < open.length; b++) {
          if (cand[open[b]] !== cand[open[a]]) continue;
          const pair = cand[open[a]];
          for (const i of open) {
            if (i === open[a] || i === open[b]) continue;
            if (cand[i] & pair) {
              cand[i] &= ~pair;
              changed = true;
            }
          }
        }
      }
    }
    return changed;
  };

  for (;;) {
    let solved = true;
    for (let i = 0; i < 81; i++) {
      if (!work[i]) {
        solved = false;
        break;
      }
    }
    if (solved) return hardest;
    if (nakedSingle()) continue;
    if (hiddenSingle()) {
      hardest = Math.max(hardest, 2);
      continue;
    }
    if (lockedCandidates() || nakedPairs()) {
      hardest = Math.max(hardest, 3);
      continue;
    }
    return 4;
  }
}

export const DIFFICULTIES = {
  easy: { min: 1, max: 1, clues: [36, 45] },
  medium: { min: 2, max: 2, clues: [30, 36] },
  hard: { min: 3, max: 3, clues: [24, 30] },
};

/**
 * Digs a unique-solution puzzle out of a solved grid, removing cells in
 * rotationally symmetric pairs so the result looks like a printed puzzle.
 */
function dig(solved, targetClues, rand) {
  const puzzle = solved.slice();
  const order = shuffle([...Array(81).keys()], rand);
  let clues = 81;
  for (const i of order) {
    if (clues <= targetClues) break;
    const mirror = 80 - i;
    const cells = i === mirror ? [i] : [i, mirror];
    if (cells.some((c) => puzzle[c] === 0)) continue;
    const backup = cells.map((c) => puzzle[c]);
    for (const c of cells) puzzle[c] = 0;
    if (countSolutions(puzzle, 2) !== 1) {
      cells.forEach((c, k) => {
        puzzle[c] = backup[k];
      });
    } else {
      clues -= cells.length;
    }
  }
  return { puzzle, clues };
}

/**
 * Generates one puzzle at the requested difficulty. Falls back to the closest
 * achievable rating after `attempts` tries rather than spinning forever.
 */
export function generate(difficulty = 'hard', rand = Math.random, attempts = 30) {
  const spec = DIFFICULTIES[difficulty] || DIFFICULTIES.hard;
  let fallback = null;

  for (let a = 0; a < attempts; a++) {
    const solution = generateSolved(rand);
    const span = spec.clues[1] - spec.clues[0] + 1;
    const target = spec.clues[0] + ((rand() * span) | 0);
    const { puzzle, clues } = dig(solution, target, rand);
    const level = rate(puzzle);
    const candidate = { puzzle, solution, clues, level, difficulty };
    if (level >= spec.min && level <= spec.max) return candidate;
    if (!fallback || Math.abs(level - spec.min) < Math.abs(fallback.level - spec.min)) {
      fallback = candidate;
    }
  }
  return fallback;
}

