/**
 * Exercises the storage layer against a real Postgres running in-process
 * (PGlite), so the SQL is actually executed rather than assumed.
 *
 *   node test/db.js
 */

import { PGlite } from '@electric-sql/pglite';
import * as db from '../server/db.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const pg = new PGlite();
  await db.useClient(pg);
  check('schema created', db.isEnabled());

  console.log('\n--- accounts ---');
  const created = await db.createUser('Nanak', 'hunter2');
  check('account created', !!created.user, created.user?.username);
  check('username preserved as typed', created.user?.username === 'Nanak');

  const dupe = await db.createUser('nanak', 'other');
  check('name taken is rejected case-insensitively', !!dupe.error, dupe.error);

  console.log('\n--- signing in ---');
  const good = await db.signIn('nanak', 'hunter2');
  check('correct password signs in', !!good.user);
  check('sign-in is case-insensitive', good.user?.id === created.user.id);

  const bad = await db.signIn('nanak', 'wrong');
  check('wrong password refused', !!bad.error);

  const missing = await db.signIn('nobody', 'hunter2');
  check('unknown user refused', !!missing.error);
  check(
    'same message for wrong password and unknown user',
    bad.error === missing.error,
    JSON.stringify(bad.error)
  );

  const stored = await pg.query('SELECT pass_hash FROM users LIMIT 1');
  check(
    'password is not stored in the clear',
    !stored.rows[0].pass_hash.includes('hunter2') && stored.rows[0].pass_hash.startsWith('scrypt$')
  );

  console.log('\n--- sessions ---');
  const token = await db.startSession(created.user.id);
  check('session issued', typeof token === 'string' && token.length > 20);
  const me = await db.userForToken(token);
  check('token resolves to the user', me?.id === created.user.id, me?.username);
  check('garbage token resolves to nothing', (await db.userForToken('nope')) === null);
  check('empty token resolves to nothing', (await db.userForToken('')) === null);

  await db.endSession(token);
  check('signing out invalidates the token', (await db.userForToken(token)) === null);

  console.log('\n--- solve counts ---');
  const uid = created.user.id;
  check('stats start at zero', (await db.getStats(uid)).total === 0);
  await db.recordSolve(uid, 'hard');
  await db.recordSolve(uid, 'hard');
  await db.recordSolve(uid, 'easy');
  const stats = await db.getStats(uid);
  check('hard counted twice', stats.hard === 2, JSON.stringify(stats));
  check('easy counted once', stats.easy === 1);
  check('medium still zero', stats.medium === 0);
  check('total adds up', stats.total === 3);

  console.log('\n--- saved puzzle ---');
  check('no save to begin with', (await db.progressSummary(uid)) === null);

  const puzzle = Array.from({ length: 81 }, (_, i) => (i < 30 ? ((i % 9) + 1) : 0));
  const solution = Array.from({ length: 81 }, (_, i) => ((i % 9) + 1));
  const grid = puzzle.slice();
  grid[30] = 4; // one cell filled in by the player
  grid[31] = 7;

  await db.saveProgress(uid, { difficulty: 'hard', puzzle, solution, grid, elapsedMs: 91_000 });
  const loaded = await db.loadProgress(uid);
  check('puzzle round-trips exactly', JSON.stringify(loaded.puzzle) === JSON.stringify(puzzle));
  check('grid round-trips exactly', JSON.stringify(loaded.grid) === JSON.stringify(grid));
  check('solution round-trips exactly', JSON.stringify(loaded.solution) === JSON.stringify(solution));
  check('elapsed time kept', loaded.elapsedMs === 91_000);
  check('difficulty kept', loaded.difficulty === 'hard');

  const summary = await db.progressSummary(uid);
  check('summary counts blanks', summary.blanks === 51, `blanks=${summary.blanks}`);
  check('summary counts what is filled', summary.filled === 2, `filled=${summary.filled}`);

  // Saving again must replace, not accumulate — one save per user.
  grid[32] = 9;
  await db.saveProgress(uid, { difficulty: 'easy', puzzle, solution, grid, elapsedMs: 5000 });
  const rows = await pg.query('SELECT count(*)::int AS n FROM saves WHERE user_id = $1', [uid]);
  check('still exactly one save per user', rows.rows[0].n === 1);
  const replaced = await db.progressSummary(uid);
  check('save was overwritten', replaced.difficulty === 'easy' && replaced.filled === 3);

  await db.clearProgress(uid);
  check('finishing clears the save', (await db.progressSummary(uid)) === null);

  console.log('\n--- two users stay separate ---');
  const other = await db.createUser('Asya', 'pw');
  await db.recordSolve(other.user.id, 'medium');
  const mine = await db.getStats(uid);
  const theirs = await db.getStats(other.user.id);
  check('stats do not bleed between users', mine.medium === 0 && theirs.medium === 1);

  await db.saveProgress(other.user.id, { difficulty: 'medium', puzzle, solution, grid, elapsedMs: 1 });
  check('my save is still gone', (await db.progressSummary(uid)) === null);
  check('their save exists', (await db.progressSummary(other.user.id))?.difficulty === 'medium');

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'All checks passed.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('db test crashed:', err);
  process.exit(1);
});
