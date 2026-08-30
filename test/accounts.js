/**
 * End-to-end account checks against a running server that has a database.
 *
 *   node test/accounts.js
 *
 * Skips itself with a clear message if the server is running without one.
 */

import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'http://localhost:3000';
const WS = BASE.replace('http', 'ws') + '/ws';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const post = async (path, body, token) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const get = async (path, token) => {
  const res = await fetch(BASE + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

function client() {
  const socket = new WebSocket(WS);
  const inbox = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    open: () => new Promise((r) => (socket.readyState === 1 ? r() : socket.once('open', r))),
    send: (t, payload = {}) => socket.send(JSON.stringify({ t, ...payload })),
    mark: () => inbox.length,
    next: (match, ms = 5000, since = inbox.length) =>
      new Promise((resolve) => {
        const hit = inbox.slice(since).find(match);
        if (hit) return resolve(hit);
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) {
            waiters.splice(at, 1);
            resolve(null);
          }
        }, ms);
      }),
    close: () => socket.close(),
  };
}

// Prefixed so anything left behind is obviously test data.
const unique = () => 'zztest' + Math.random().toString(36).slice(2, 8);

/**
 * Deletes the accounts this run created. Only possible when the test process
 * can reach the database itself; against a remote server it is skipped, and
 * the prefix makes leftovers easy to find.
 */
async function cleanUp() {
  if (!process.env.DATABASE_URL) return;
  try {
    const db = await import('../server/db.js');
    if (!(await db.initDb())) return;
    const removed = await db.deleteUsersMatching('zztest%');
    console.log(`cleaned up ${removed} test account(s)`);
    await db.closeDb();
  } catch (err) {
    console.log('cleanup skipped:', err.message);
  }
}

async function main() {
  const health = await get('/api/health');
  if (!health.data.accounts) {
    console.log('SKIP — server is running without a database (no DATABASE_URL).');
    console.log('Start it with DATABASE_URL set to run these checks.');
    process.exit(0);
  }

  console.log('--- creating an account ---');
  const name = unique();
  const signup = await post('/api/signup', { username: name, password: 'hunter2' });
  check('account created', signup.status === 200 && !!signup.data.token, name);
  const token = signup.data.token;
  check('starts with no solves', signup.data.stats?.total === 0);
  check('starts with nothing saved', signup.data.save === null);

  console.log('\n--- validation ---');
  const short = await post('/api/signup', { username: 'ab', password: 'hunter2' });
  check('short username refused', short.status === 400, short.data.error);
  const weak = await post('/api/signup', { username: unique(), password: '123' });
  check('short password refused', weak.status === 400, weak.data.error);
  const taken = await post('/api/signup', { username: name.toUpperCase(), password: 'hunter2' });
  check('duplicate name refused', taken.status === 409, taken.data.error);

  console.log('\n--- sessions ---');
  const me = await get('/api/me', token);
  check('token restores the session', me.status === 200 && me.data.user.username === name);
  const anon = await get('/api/me', 'garbage');
  check('bad token refused', anon.status === 401);

  const again = await post('/api/signin', { username: name, password: 'hunter2' });
  check('can sign in again', again.status === 200 && !!again.data.token);
  const wrong = await post('/api/signin', { username: name, password: 'nope' });
  check('wrong password refused', wrong.status === 401);

  console.log('\n--- the account name is used in game ---');
  const alice = client();
  await alice.open();
  alice.send('join', { name: 'IgnoreThisName', mode: 'play', difficulty: 'easy', token });
  const joined = await alice.next((m) => m.t === 'joined');
  check('joined with a token', !!joined);
  check('account name overrides the typed one', joined.you.name === name, joined.you.name);
  check('player is marked signed in', joined.state.players[0].signedIn === true);

  console.log('\n--- an unfinished puzzle is saved ---');
  const { solve } = await import('../server/sudoku.js');
  const givens = joined.state.givens;
  const solution = solve(givens);
  const blanks = givens.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);

  // Fill a few, then leave without finishing.
  for (const i of blanks.slice(0, 5)) {
    alice.send('move', { index: i, value: solution[i] });
    await new Promise((r) => setTimeout(r, 40));
  }
  alice.close();
  await new Promise((r) => setTimeout(r, 700));

  const afterLeaving = await get('/api/me', token);
  const save = afterLeaving.data.save;
  check('save exists after leaving mid-puzzle', !!save, save ? JSON.stringify(save) : '');
  check('save records what was filled', save?.filled === 5, `filled=${save?.filled}`);
  check('save keeps the difficulty', save?.difficulty === 'easy');

  console.log('\n--- continuing where you left off ---');
  const back = client();
  await back.open();
  back.send('join', { mode: 'continue', token });
  const resumed = await back.next((m) => m.t === 'joined');
  check('continue puts you back in a room', !!resumed);
  check('same puzzle came back', JSON.stringify(resumed.state.givens) === JSON.stringify(givens));
  check(
    'the five cells are still filled',
    blanks.slice(0, 5).every((i) => resumed.state.grid[i] === solution[i])
  );
  check('it is a fresh room code', resumed.state.code !== joined.state.code);

  console.log('\n--- finishing counts the solve and clears the save ---');
  const beforeWin = back.mark();
  for (const i of blanks) {
    if (resumed.state.grid[i] !== solution[i]) {
      back.send('move', { index: i, value: solution[i] });
      await new Promise((r) => setTimeout(r, 35));
    }
  }
  const solved = await back.next((m) => m.t === 'solved', 8000, beforeWin);
  check('puzzle solved', !!solved);
  await new Promise((r) => setTimeout(r, 700));

  const done = await get('/api/me', token);
  check('easy solve counted', done.data.stats.easy === 1, JSON.stringify(done.data.stats));
  check('total went up', done.data.stats.total === 1);
  check('save cleared once finished', done.data.save === null);

  console.log('\n--- continue with nothing saved is refused ---');
  const empty = client();
  await empty.open();
  empty.send('join', { mode: 'continue', token });
  const refused = await empty.next((m) => m.t === 'error');
  check('nothing to continue is refused', !!refused, refused?.text);
  empty.close();

  console.log('\n--- guests still play without an account ---');
  const guest = client();
  await guest.open();
  guest.send('join', { name: 'Guest', mode: 'play', difficulty: 'easy' });
  const guestJoined = await guest.next((m) => m.t === 'joined');
  check('guest can still play', !!guestJoined && guestJoined.you.name === 'Guest');
  check('guest is not marked signed in', guestJoined.state.players[0].signedIn === false);
  guest.close();
  back.close();

  console.log('\n--- signing out ---');
  const out = await post('/api/signout', {}, token);
  check('sign out succeeds', out.status === 200);
  const dead = await get('/api/me', token);
  check('token no longer works', dead.status === 401);

  await new Promise((r) => setTimeout(r, 300));
  await cleanUp();
  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'All checks passed.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('accounts test crashed:', err);
  process.exit(1);
});
