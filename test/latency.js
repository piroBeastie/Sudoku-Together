/**
 * Measures how long a move takes to travel from one player to the other.
 *
 * Player A sends a move and player B timestamps its arrival, so the number is
 * the real end-to-end path: A -> server -> B. Run it against localhost for the
 * server's own overhead, or against a deployed host to include the network.
 *
 *   node test/latency.js
 *   BASE=http://your-host:3000 node test/latency.js
 */

import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'http://localhost:3000';
const WS = BASE.replace('http', 'ws') + '/ws';
const SAMPLES = Number(process.env.SAMPLES || 100);
// The server refills 25 message tokens a second; stay comfortably under it.
const GAP_MS = Number(process.env.GAP_MS || 60);

function client() {
  const socket = new WebSocket(WS);
  const handlers = [];
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    for (const h of handlers) h(msg);
  });
  return {
    socket,
    on: (fn) => handlers.push(fn),
    open: () => new Promise((r) => socket.once('open', r)),
    send: (t, payload = {}) => socket.send(JSON.stringify({ t, ...payload })),
    once: (match, ms = 5000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          handlers.splice(handlers.indexOf(h), 1);
          reject(new Error('timed out waiting for a reply'));
        }, ms);
        const h = (m) => {
          if (match(m)) {
            clearTimeout(timer);
            handlers.splice(handlers.indexOf(h), 1);
            resolve(m);
          }
        };
        handlers.push(h);
      }),
    close: () => socket.close(),
  };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const report = (label, values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  console.log(
    `${label.padEnd(26)} mean ${mean.toFixed(2)}ms  p50 ${percentile(sorted, 0.5).toFixed(2)}ms  ` +
      `p95 ${percentile(sorted, 0.95).toFixed(2)}ms  max ${sorted[sorted.length - 1].toFixed(2)}ms`
  );
};

async function main() {
  console.log(`Target: ${BASE}  (${SAMPLES} samples)\n`);

  const alice = client();
  await alice.open();
  alice.send('join', { name: 'A', mode: 'play', difficulty: 'easy' });
  const joined = await alice.once((m) => m.t === 'joined');
  const code = joined.state.code;
  const empties = joined.state.givens
    .map((v, i) => (v === 0 ? i : -1))
    .filter((i) => i >= 0);

  const bob = client();
  await bob.open();
  bob.send('join', { name: 'B', mode: 'code', code });
  await bob.once((m) => m.t === 'joined');

  // Round trip: A -> server -> A. Isolates the server's own handling cost.
  const roundTrip = [];
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    alice.send('ping');
    await alice.once((m) => m.t === 'pong');
    roundTrip.push(performance.now() - started);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  // Player to player: A sends a move, B sees it. This is what the other person
  // actually waits for.
  const crossPlayer = [];
  for (let i = 0; i < SAMPLES; i++) {
    const cell = empties[i % empties.length];
    const value = (i % 9) + 1;
    const arrival = bob.once((m) => m.t === 'move' && m.index === cell && m.value === value);
    const started = performance.now();
    alice.send('move', { index: cell, value });
    await arrival;
    crossPlayer.push(performance.now() - started);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  report('ping round trip (A->A)', roundTrip);
  report('move A -> B', crossPlayer);

  const sorted = [...crossPlayer].sort((a, b) => a - b);
  console.log(
    `\nServer-side cost is the floor here; add roughly one network RTT` +
      ` between the players and their server.\nMedian observed: ${percentile(sorted, 0.5).toFixed(2)}ms.`
  );

  alice.close();
  bob.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('latency probe failed:', err);
  process.exit(1);
});
