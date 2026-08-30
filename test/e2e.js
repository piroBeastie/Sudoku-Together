/**
 * End-to-end check against a running server: two players share a room, fill the
 * grid, chat, and only the room owner may skip to the next puzzle.
 *
 *   node server/index.js &
 *   node test/e2e.js
 */

import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'http://localhost:3000';
const WS = BASE.replace('http', 'ws') + '/ws';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** A test client that records every message it receives. */
function client(name) {
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
    name,
    socket,
    inbox,
    open: () => new Promise((r) => (socket.readyState === 1 ? r() : socket.once('open', r))),
    send: (t, payload = {}) => socket.send(JSON.stringify({ t, ...payload })),
    /** Cursor into the inbox — take one before an action that may reply fast. */
    mark: () => inbox.length,
    /**
     * Waits for a matching message, considering only those that arrive from
     * `since` onward — matching the whole backlog would let a stale message
     * satisfy a later assertion and hide a real failure.
     */
    next: (match, ms = 4000, since = inbox.length) =>
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

const isType = (t) => (m) => m.t === t;

async function main() {
  console.log('--- health ---');
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check('server is up', health.ok === true);
  check('puzzle pool warming', typeof health.pool === 'object', JSON.stringify(health.pool));

  console.log('\n--- Play opens a room with a code ---');
  const alice = client('Alice');
  await alice.open();
  alice.send('join', { name: 'Alice', mode: 'play', difficulty: 'hard' });

  const joined = await alice.next(isType('joined'));
  check('alice joined', !!joined);
  const room = joined.state;
  check('room has a 5-char code', /^[A-Z0-9]{5}$/.test(room.code), room.code);
  check('difficulty is hard', room.difficulty === 'hard', `level ${room.level}`);
  check('grid has 81 cells', room.grid.length === 81);
  const clues = room.givens.filter(Boolean).length;
  check('puzzle has 22-32 clues', clues >= 22 && clues <= 32, `${clues} clues`);
  check('alice is alone', room.players.length === 1);
  check('alice owns the room', room.ownerId === joined.you.id);

  console.log('\n--- second player joins by code ---');
  const bob = client('Bob');
  await bob.open();
  bob.send('join', { name: 'Bob', mode: 'code', code: room.code });
  const bobJoined = await bob.next(isType('joined'));
  check('bob joined by code', !!bobJoined);
  check('bob sees the same grid', bobJoined?.state.code === room.code);
  check('two players in room', bobJoined?.state.players.length === 2);
  check(
    'players got different seats',
    bobJoined?.state.players[0].seat !== bobJoined?.state.players[1].seat
  );
  check('bob does not own the room', bobJoined?.state.ownerId !== bobJoined?.you.id);
  const aliceSawBob = await alice.next((m) => m.t === 'players' && m.players.length === 2);
  check('alice was told bob arrived', !!aliceSawBob);

  console.log('\n--- a third player is refused ---');
  const carol = client('Carol');
  await carol.open();
  carol.send('join', { name: 'Carol', mode: 'code', code: room.code });
  const refused = await carol.next(isType('error'));
  check('third player rejected', !!refused && refused.fatal === true, refused?.text);
  carol.close();

  console.log('\n--- an unknown code is refused ---');
  const dan = client('Dan');
  await dan.open();
  dan.send('join', { name: 'Dan', mode: 'code', code: 'ZZZZZ' });
  const noRoom = await dan.next(isType('error'));
  check('unknown code rejected', !!noRoom && noRoom.fatal === true, noRoom?.text);
  dan.close();

  console.log('\n--- moves propagate ---');
  const emptyIndex = room.givens.findIndex((v) => v === 0);
  alice.send('move', { index: emptyIndex, value: 5 });
  const bobSawMove = await bob.next((m) => m.t === 'move' && m.index === emptyIndex);
  check('bob saw alice move', !!bobSawMove, `value ${bobSawMove?.value}`);
  check('move is attributed to alice', bobSawMove?.by === joined.you.id);

  console.log('\n--- givens are immutable ---');
  const givenIndex = room.givens.findIndex((v) => v !== 0);
  bob.send('move', { index: givenIndex, value: 9 });
  const rejected = await bob.next(isType('reject'));
  check('cannot overwrite a given', rejected?.reason === 'given');

  console.log('\n--- erase clears a cell ---');
  alice.send('move', { index: emptyIndex, value: 0 });
  const cleared = await bob.next((m) => m.t === 'move' && m.index === emptyIndex);
  check('erase propagates', cleared?.value === 0);

  console.log('\n--- chat ---');
  bob.send('chat', { text: 'try a 7 in the top left box' });
  const chat = await alice.next((m) => m.t === 'chat' && m.message.kind === 'chat');
  check('chat delivered', chat?.message.text === 'try a 7 in the top left box');
  check('chat carries the sender name', chat?.message.name === 'Bob');

  console.log('\n--- only the owner may skip ---');
  const bobTries = bob.mark();
  bob.send('nextPuzzle', {});
  const denied = await bob.next(isType('error'), 2500, bobTries);
  check('non-owner is refused', !!denied, denied?.text);

  const aliceSkips = alice.mark();
  alice.send('nextPuzzle', { difficulty: 'easy' });
  const fresh = await alice.next(isType('state'), 6000, aliceSkips);
  check('owner can skip', !!fresh);
  check('new puzzle loaded', fresh?.state.difficulty === 'easy');
  check('grid reset to the givens', fresh?.state.grid.filter(Boolean).length === fresh?.state.givens.filter(Boolean).length);

  console.log('\n--- solving the whole grid ---');
  const { solve } = await import('../server/sudoku.js');
  const puzzle = fresh.state.givens;
  const solution = solve(puzzle);
  check('server puzzle is solvable', !!solution);

  // The win fires on the final move, so mark the inbox before playing.
  const beforeSolve = bob.mark();
  for (let i = 0; i < 81; i++) {
    if (puzzle[i] === 0) {
      // Alternate who plays, so both players contribute to the solve.
      (i % 2 ? bob : alice).send('move', { index: i, value: solution[i] });
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  const solved = await bob.next(isType('solved'), 8000, beforeSolve);
  check('solved event fired', !!solved, solved ? `in ${Math.round(solved.timeMs / 1000)}s` : '');
  check('winner is named', !!solved?.solvedBy?.name, solved?.solvedBy?.name);
  check(
    'both players credited',
    solved?.contributions?.length === 2 && solved.contributions.every((c) => c.filled > 0),
    solved?.contributions?.map((c) => `${c.name}:${c.filled}`).join(' ')
  );
  check(
    'contributions add up to the blanks',
    solved?.contributions?.reduce((a, c) => a + c.filled, 0) === puzzle.filter((v) => v === 0).length
  );

  console.log('\n--- leaving frees the seat and hands over ownership ---');
  alice.close(); // the owner leaves
  const handover = await bob.next((m) => m.t === 'players' && m.players.length === 1, 3000);
  check('seat freed on disconnect', !!handover);
  check('ownership passed to bob', handover?.ownerId === bobJoined.you.id);

  const erin = client('Erin');
  await erin.open();
  erin.send('join', { name: 'Erin', mode: 'code', code: room.code });
  const erinJoined = await erin.next(isType('joined'));
  check('new player can take the free seat', !!erinJoined);
  check('newcomer does not seize ownership', erinJoined?.state.ownerId === bobJoined.you.id);
  erin.close();
  bob.close();

  await new Promise((r) => setTimeout(r, 300));
  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'All checks passed.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
