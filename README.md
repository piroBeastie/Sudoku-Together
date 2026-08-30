# Sudoku Together

Two people, one sudoku, in real time. Enter a name, start a grid or join one
with its code, fill cells together and talk it through in room chat. Two players
per room, maximum.

## Run it

```bash
npm install
```

```bash
npm start
```

Open <http://localhost:3000>. To invite someone, tap the room code in the header
— it copies an invite link. On another machine, use your LAN address
(`http://192.168.x.x:3000`) rather than `localhost`.

Dev mode with auto-restart on file changes:

```bash
npm run dev
```

## Accounts

Optional. Without one you type a name and play as a guest, exactly as before.

Sign in from the badge above the lobby card — the card itself stays clear of
account chrome. Signing out sits behind that badge's menu and a confirmation,
so it cannot be hit by accident.

As a guest the lobby asks only for a name, a difficulty, and Play or a room code.
Signed in it greets you by name and shows your record instead, and you get:

- **Solve counts per difficulty**, easy / medium / hard, updated the moment a
  puzzle is finished.
- **Continue last puzzle** — leave a grid half-done and the button appears in
  the lobby with how much is left. It reopens in a fresh room with your progress
  and the clock where you left it.

A solve counts for every signed-in player in the room, so finishing together
credits both of you. Progress is stored for each signed-in player as they play,
flushed every few seconds and immediately when someone leaves.

Passwords are hashed with scrypt (Node's own crypto — no dependency) and never
stored in the clear. A wrong password and an unknown username return the same
message, so the form cannot be used to discover who has an account.

Failed sign-ins are capped two ways: per address, which stops one machine
grinding through accounts, and per username, which stops a spread-out attack on
one account. Only failures count and a success clears the slate, so mistyping
your password and then getting it right leaves you no closer to a lockout.
`trust proxy` is set to one hop, so behind a load balancer the limiter sees the
real client rather than lumping everyone under the proxy's address.

## How a game works

- **Play** — opens a new room at the chosen difficulty. Every room has a
  five-character code; share it and your partner drops straight into your grid,
  mid-solve if need be.
- **Join** — enter a room code, or open an invite link.

The server owns the grid. Every move and message goes through it, so the two
clients cannot drift apart.

Rooms live in the server process only — a room survives a refresh or a dropped
signal (it is kept for three minutes after the last player leaves), but an empty
room is swept after that and a server restart clears the live games. What does
survive is the account data: your solve counts and the puzzle you left
unfinished. Puzzles themselves are generated fresh rather than drawn from a set.

Whoever opens the room owns it, and only they can skip to the next puzzle —
otherwise either player could bin the other's progress mid-solve. If the owner
leaves, ownership passes to whoever is still there.

## Playing

Tap a cell, then a digit. Tapping the digit already in a cell clears it, and
**Erase** clears the selected cell. That is the whole toolbar, plus **Chat**.

A digit that repeats in its row, column or box turns red — it cannot possibly
be right, and you could see that yourself, so flagging it gives nothing away.
Nothing is checked against the solution: a digit that is merely wrong looks
exactly like a digit that is right. Your own entries are ink, your partner's are
grey, and their live cursor is a dashed outline.

Keyboard: arrows or `WASD` to move, `1`–`9` to fill, `0`/backspace to erase,
`Enter` to jump to chat.

## Finishing a puzzle

The win card names whoever placed the last number, then credits both players by
how many cells each one filled — including a player who left before the end, so
their work still counts. Lilies drift up the screen behind it.

From there the room owner chooses **New sudoku** or **Exit**, while the other
player stays in the room and sees who they are waiting on. Only the owner gets
that choice, since starting a new grid wipes the board for both.

## Latency

Every move is relayed through the server, so what the other player waits for is
one trip: you -> server -> them. The server holds all state in memory and never
touches the disk, so its own cost is about a millisecond.

Measured on localhost with `node test/latency.js` (100 samples):

| Path | mean | p50 | p95 |
| ---- | ---- | --- | --- |
| ping round trip (you -> server -> you) | 0.93ms | 0.96ms | 1.54ms |
| move you -> partner | 1.04ms | 1.03ms | 1.65ms |

In real use, add the network. Roughly what to expect end to end:

| Both players | Typical |
| ------------ | ------- |
| same machine | ~1ms |
| same wifi, server on the LAN | 5–30ms |
| same country, hosted server | 30–70ms |
| different continents | 150–300ms |

Point the probe at a deployed host to measure your own setup:

```bash
BASE=http://your-host:3000 node test/latency.js
```

Anything under ~100ms feels immediate for this kind of game — a digit appears on
the other screen before the person who typed it has looked up.

## Chat

On a phone chat is a bottom sheet behind the **Chat** button. When a message
arrives while the sheet is closed, it pops up above the button so it can be read
without opening anything, and an unread count sits on the button until you do.
From 900px up the chat is a permanent column beside the board and the popup is
skipped, since the messages are already on screen.

## Where the puzzles come from

Generated locally, not fetched from a puzzle API. Public sudoku APIs rate-limit,
go down, and mostly serve easy grids — a generator gives unlimited puzzles,
offline, with the difficulty actually verified.

`server/sudoku.js` fills a random grid, digs cells out in rotationally symmetric
pairs, and after every removal confirms the puzzle still has exactly one
solution. It then rates the result by the hardest technique needed to crack it:

| Level | Needs | Typical clues |
| ----- | ----- | ------------- |
| Easy | naked singles | 36–45 |
| Medium | hidden singles | 30–36 |
| Hard | locked candidates, naked pairs | 24–30 |

Because a hard puzzle costs ~100ms of solid CPU, generation runs in a worker
thread (`server/generator-worker.js`) and a warm pool is kept topped up
(`server/puzzle-pool.js`), so starting a game is instant.

**To use a puzzle API instead:** replace the body of `produce()` in
`server/puzzle-pool.js` with your fetch call. It must resolve to
`{ puzzle, solution }`, each an 81-length array, row-major, `0` for blanks.

## Colour and layout

Off-white and near-black, following the system light/dark setting, with red
reserved for the one thing that needs it: an impossible digit. Nothing else
depends on hue — givens are bold, entries are lighter, your partner reads as
grey and their caret as a dashed outline.

Built mobile-first — the app shell is fixed height with no page scrolling and
touch targets are at least 44px. The header carries only what is needed while
playing: the room code, who is here, the clock, and the owner's skip button.

## Layout of the code

```
server/
  index.js             HTTP + WebSocket server, auth endpoints, message routing
  db.js                accounts, solve counts, saved puzzles (Postgres)
  rate-limit.js        failure counter behind the sign-in lockout
  rooms.js             room state, moves, chat, ownership (memory only)
  sudoku.js            generator, solver, uniqueness check, difficulty rating
  puzzle-pool.js       warm pool of ready puzzles  <- swap in an API here
  generator-worker.js  worker thread that runs generation
public/
  index.html  style.css  app.js
test/
  e2e.js               drives two real clients through a whole game
  db.js                storage layer against a real in-process Postgres
  rate-limit.js        sign-in lockout logic, with time injected
  accounts.js          sign-up, sign-in, stats and continue, end to end
  latency.js           measures move latency between two players
Dockerfile             container image for any host that runs one
fly.toml               Fly.io config (single always-on machine)
```

## Connecting a database

Accounts need Postgres. Set `DATABASE_URL` and the tables create themselves
on first boot; leave it unset and the app runs guest-only.

On Render: **your service -> Environment -> Add Environment Variable**, key
`DATABASE_URL`, value the connection string, then redeploy. Use the **pooled**
string if your provider offers one (Neon marks it `-pooler`) — it copes better
with a server that reconnects as it restarts.

Locally, put it in `.env` (git-ignored) and run:

```bash
npm run start:local
```

TLS is verified by default. If a provider uses a self-signed certificate, set
`DATABASE_SSL_NO_VERIFY=1` — it weakens the connection, so avoid it otherwise.

The server starts serving before the database finishes connecting, so a
sleeping database delays only sign-in, never the game.

## Tests

These two need nothing running — the storage layer runs against a real Postgres
inside the test process, and the lockout logic has time injected:

```bash
node test/db.js
```

```bash
node test/rate-limit.js
```

The others need the server running. For the account tests it must have a
database — `DATABASE_URL=pglite npm start` gives you one in-process for local
work, no signup required:

```bash
node test/e2e.js
```

```bash
node test/accounts.js
```

Two WebSocket clients share a room and the script checks that moves propagate,
a third joiner and an unknown code are refused, givens cannot be overwritten,
erase works, chat is delivered, only the owner can skip, a full solve fires the
win with the finisher named and both players credited, and a seat plus
ownership pass on when someone leaves.

## Notes

- Rooms are in-memory only and are dropped three minutes after the last player
  leaves. Restarting the server ends every game in progress.
- A disconnected client reconnects on its own with a backoff and rejoins by
  room code.
- Static assets carry a `?v=N` query. Bump it in `index.html` after editing
  `style.css` or `app.js` so browsers do not serve a stale copy.
- Set `DATABASE_URL` to a Postgres connection string to turn accounts on; with
  it unset the app runs guest-only and nothing else changes.
- `DATABASE_URL=pglite` runs Postgres inside the process for local development.
- Set `PORT` to serve somewhere other than 3000. Set `NODE_ENV=production` to
  turn on long static-asset caching.
- Deploying behind a proxy: it needs WebSocket upgrade forwarding on `/ws`.
