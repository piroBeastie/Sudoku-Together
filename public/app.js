/**
 * Client: renders the board, talks to the server over one WebSocket.
 *
 * The server owns the grid. This file never decides whether a move is legal —
 * it sends intent, then paints whatever comes back.
 */

const $ = (id) => document.getElementById(id);

const el = {
  lobby: $('lobby'),
  game: $('game'),
  nameInput: $('nameInput'),
  difficultyPicker: $('difficultyPicker'),
  playBtn: $('playBtn'),
  codeForm: $('codeForm'),
  codeInput: $('codeInput'),
  lobbyError: $('lobbyError'),
  topActions: $('topActions'),
  accountBtn: $('accountBtn'),
  accountMenu: $('accountMenu'),
  greetBox: $('greetBox'),
  greetName: $('greetName'),
  authOverlay: $('authOverlay'),
  authCloseBtn: $('authCloseBtn'),
  accountInitial: $('accountInitial'),
  statRow: $('statRow'),
  signOutBtn: $('signOutBtn'),
  nameField: $('nameField'),
  authForm: $('authForm'),
  authUser: $('authUser'),
  authPass: $('authPass'),
  authTitle: $('authTitle'),
  authSub: $('authSub'),
  authSubmit: $('authSubmit'),
  authUserHint: $('authUserHint'),
  authPassHint: $('authPassHint'),
  authSwitchBtn: $('authSwitchBtn'),
  authError: $('authError'),
  continueBtn: $('continueBtn'),
  continueDetail: $('continueDetail'),

  board: $('board'),
  digits: $('digits'),
  players: $('players'),
  roomCode: $('roomCode'),
  codeChip: $('codeChip'),
  timer: $('timer'),
  connState: $('connState'),
  backBtn: $('backBtn'),
  nextBtn: $('nextBtn'),

  eraseBtn: $('eraseBtn'),

  chatArea: $('chatArea'),
  chatBtn: $('chatBtn'),
  chatCloseBtn: $('chatCloseBtn'),
  sheetBackdrop: $('sheetBackdrop'),
  chatLog: $('chatLog'),
  chatForm: $('chatForm'),
  chatInput: $('chatInput'),
  unread: $('unread'),
  chatPeek: $('chatPeek'),
  peekName: $('peekName'),
  peekText: $('peekText'),

  winOverlay: $('winOverlay'),
  winDetail: $('winDetail'),
  winFinisher: $('winFinisher'),
  winScores: $('winScores'),
  winActions: $('winActions'),
  winNextBtn: $('winNextBtn'),
  winExitBtn: $('winExitBtn'),
  winWaiting: $('winWaiting'),
  bloom: $('bloom'),
  toast: $('toast'),
};

const state = {
  socket: null,
  you: null,
  room: null,
  selected: null,
  partnerCell: null,
  difficulty: 'hard',
  cells: [],
  timerId: null,
  clockBase: 0, // room time in ms at the moment we last synced
  clockSyncedAt: 0,
  reconnectDelay: 500,
  intentionalClose: false,
  joinArgs: null,
  unread: 0,
  token: null,
  account: null,
  authMode: 'signin',
};

/* ------------------------------------------------------------------ helpers */

function toast(text, ms = 2400) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.toast.hidden = true;
  }, ms);
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function send(type, payload = {}) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ t: type, ...payload }));
  }
}

const iAmOwner = () => !!state.room && state.room.ownerId === state.you?.id;

/* ------------------------------------------------------------------ account */

const TOKEN_KEY = 'sudoku:token';
const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

const authHeaders = () =>
  state.token ? { Authorization: `Bearer ${state.token}` } : {};

function showAuthError(text) {
  el.authError.textContent = text;
  el.authError.hidden = !text;
}

/** Swaps the lobby between guest mode and signed-in mode. */
function renderAccount() {
  const account = state.account;
  el.greetBox.hidden = !account;
  el.nameField.hidden = !!account;
  closeAccountMenu();

  if (!account) {
    // Guest: nothing about accounts belongs in the card, only the badge above it.
    el.accountInitial.textContent = '?';
    el.accountBtn.setAttribute('aria-label', 'Sign in');
    el.accountBtn.title = 'Sign in';
    el.continueBtn.hidden = true;
    el.playBtn.classList.add('btn-primary');
    el.playBtn.classList.remove('btn-secondary');
    el.playBtn.textContent = 'Play';
    return;
  }

  closeAuth();
  el.greetName.textContent = account.user.username;
  el.accountInitial.textContent = account.user.username.charAt(0).toUpperCase();
  el.accountBtn.setAttribute('aria-label', 'Account');
  el.accountBtn.title = account.user.username;

  const stats = account.stats || { easy: 0, medium: 0, hard: 0, total: 0 };
  el.statRow.replaceChildren(
    ...['easy', 'medium', 'hard'].map((key) => {
      const li = document.createElement('li');
      const n = document.createElement('strong');
      n.textContent = String(stats[key] ?? 0);
      const label = document.createElement('span');
      label.textContent = DIFFICULTY_LABELS[key];
      li.append(n, label);
      return li;
    })
  );

  // Continue only makes sense when there is an unfinished grid waiting.
  const save = account.save;
  el.continueBtn.hidden = !save;
  el.playBtn.classList.toggle('btn-secondary', !!save);
  el.playBtn.classList.toggle('btn-primary', !save);
  el.playBtn.textContent = save ? 'Start a new one' : 'Start new';
  if (save) {
    const left = save.blanks - save.filled;
    el.continueDetail.textContent =
      `${DIFFICULTY_LABELS[save.difficulty] || save.difficulty} · ` +
      `${left} cell${left === 1 ? '' : 's'} to go`;
  }
}

function setAccount(payload) {
  state.account = payload || null;
  state.token = payload?.token || null;
  if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
  else localStorage.removeItem(TOKEN_KEY);
  renderAccount();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

/**
 * The sign-in and create-account flows share one panel, so everything that
 * distinguishes them — wording, the submit button, and crucially the password
 * autocomplete hint — has to switch with the mode. Left on `current-password`,
 * a password manager offers an existing password instead of generating a new
 * one for a brand new account.
 */
const AUTH_MODES = {
  signin: {
    title: 'Sign in',
    sub: 'Pick up your stats and unfinished puzzles.',
    submit: 'Sign in',
    autocomplete: 'current-password',
    switchAction: 'Create an account',
    path: '/api/signin',
    // Rules only matter when choosing them, not when typing ones you have.
    showHints: false,
  },
  signup: {
    title: 'Create an account',
    sub: 'Keeps your solve counts and lets you resume a puzzle later.',
    submit: 'Create account',
    autocomplete: 'new-password',
    switchAction: 'Sign in',
    path: '/api/signup',
    showHints: true,
  },
};

function setAuthMode(mode) {
  state.authMode = mode;
  const config = AUTH_MODES[mode];
  el.authTitle.textContent = config.title;
  el.authSub.textContent = config.sub;
  el.authSubmit.textContent = config.submit;
  el.authPass.setAttribute('autocomplete', config.autocomplete);
  el.authUserHint.hidden = !config.showHints;
  el.authPassHint.hidden = !config.showHints;
  el.authSwitchBtn.textContent = config.switchAction;
  showAuthError('');
}

async function submitAuth() {
  const mode = state.authMode;
  const username = el.authUser.value.trim();
  const password = el.authPass.value;
  if (!username || !password) return showAuthError('Enter a username and password.');

  showAuthError('');
  el.authSubmit.disabled = true;
  try {
    const { ok, data } = await postJson(AUTH_MODES[mode].path, { username, password });
    if (!ok) return showAuthError(data.error || 'That did not work.');

    el.authPass.value = '';
    setAccount(data);
    // Creating an account is worth acknowledging; signing in speaks for itself.
    toast(mode === 'signup' ? `Account created — welcome, ${data.user.username}` : 'Signed in');
  } catch {
    showAuthError('Could not reach the server. Try again.');
  } finally {
    el.authSubmit.disabled = false;
  }
}

el.authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth();
});

el.authSwitchBtn.addEventListener('click', () => {
  setAuthMode(state.authMode === 'signin' ? 'signup' : 'signin');
  el.authUser.focus();
});

/* --------------------------------------------------- sign in / sign out UI */

function openAuth() {
  setAuthMode('signin');
  el.authOverlay.hidden = false;
  el.accountBtn.setAttribute('aria-expanded', 'true');
  el.authUser.focus();
}

function closeAuth() {
  el.authOverlay.hidden = true;
  el.accountBtn.setAttribute('aria-expanded', 'false');
  showAuthError('');
}

function closeAccountMenu() {
  el.accountMenu.hidden = true;
}

// The badge does one of two things: offer sign-in, or open the account menu.
el.accountBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!state.account) return el.authOverlay.hidden ? openAuth() : closeAuth();
  el.accountMenu.hidden = !el.accountMenu.hidden;
});

document.addEventListener('click', (e) => {
  if (!el.topActions.contains(e.target)) closeAccountMenu();
});

el.authCloseBtn.addEventListener('click', closeAuth);

// Clicking the backdrop dismisses, but clicking inside the panel must not.
el.authOverlay.addEventListener('click', (e) => {
  if (e.target === el.authOverlay) closeAuth();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.authOverlay.hidden) closeAuth();
  closeAccountMenu();
});

el.signOutBtn.addEventListener('click', async () => {
  closeAccountMenu();
  if (!confirm('Sign out? Your stats stay saved to your account.')) return;
  await postJson('/api/signout').catch(() => {});
  setAccount(null);
  toast('Signed out');
});

/** Restores a session on load; a dead token just drops you back to guest mode. */
async function restoreSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;
  state.token = token;
  try {
    const res = await fetch('/api/me', { headers: authHeaders() });
    if (!res.ok) return setAccount(null);
    setAccount(await res.json());
  } catch {
    setAccount(null);
  }
}

/** Pulls fresh stats after a solve, so the lobby is current when you return. */
async function refreshAccount() {
  if (!state.token) return;
  try {
    const res = await fetch('/api/me', { headers: authHeaders() });
    if (res.ok) setAccount(await res.json());
  } catch {
    /* stats are cosmetic */
  }
}

/* -------------------------------------------------------------------- lobby */

function showLobbyError(text) {
  el.lobbyError.textContent = text;
  el.lobbyError.hidden = !text;
}

el.difficultyPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-difficulty]');
  if (!btn) return;
  state.difficulty = btn.dataset.difficulty;
  const buttons = [...el.difficultyPicker.children];
  for (const b of buttons) b.setAttribute('aria-checked', String(b === btn));
  // Drives the sliding highlight behind the options.
  el.difficultyPicker.style.setProperty('--seg', String(buttons.indexOf(btn)));
});

function currentName() {
  if (state.account) return state.account.user.username;
  const name = el.nameInput.value.trim();
  if (!name) {
    showLobbyError('Enter a name first so your partner knows who you are.');
    el.nameInput.focus();
    return null;
  }
  localStorage.setItem('sudoku:name', name);
  return name;
}

el.playBtn.addEventListener('click', () => {
  const name = currentName();
  if (name) connect({ name, mode: 'play', difficulty: state.difficulty, token: state.token });
});

el.continueBtn.addEventListener('click', () => {
  if (!state.account) return;
  connect({ name: state.account.user.username, mode: 'continue', token: state.token });
});

el.codeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = currentName();
  const code = el.codeInput.value.trim().toUpperCase();
  if (!code) return showLobbyError('Enter a room code.');
  if (name) connect({ name, mode: 'code', code, token: state.token });
});

/* --------------------------------------------------------------- connection */

function setConn(stateName, text) {
  el.connState.dataset.state = stateName;
  el.connState.title = text;
}

// Bumped on every connect attempt. A socket only owns the reconnect logic
// while it is the newest one, so a superseded connection (double-tapped Play,
// or a link auto-join racing a manual one) dies quietly instead of stranding
// the player in an abandoned room.
let generation = 0;

function connect(args) {
  const gen = ++generation;
  const previous = state.socket;
  if (previous && previous.readyState <= WebSocket.OPEN) previous.close();

  state.joinArgs = args;
  state.intentionalClose = false;
  showLobbyError('');
  setConn('connecting', 'Connecting');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  state.socket = socket;

  socket.addEventListener('open', () => {
    if (gen !== generation) return socket.close();
    state.reconnectDelay = 500;
    setConn('open', 'Live');
    send('join', args);
  });

  socket.addEventListener('message', (event) => {
    if (gen !== generation) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  });

  socket.addEventListener('close', () => {
    if (state.intentionalClose || gen !== generation) return;
    setConn('closed', 'Reconnecting…');
    stopTimer();
    // Reconnecting rejoins by code so we land back in the same room.
    if (state.room) {
      state.joinArgs = { ...args, mode: 'code', code: state.room.code };
    }
    setTimeout(() => connect(state.joinArgs), state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 8000);
  });

  socket.addEventListener('error', () => setConn('closed', 'Offline'));
}

/**
 * Tears the game down and shows the lobby. Every exit runs through here so we
 * can never end up with a live-looking board backed by a room we have left —
 * which is what happens if a reconnect finds the room gone.
 */
function returnToLobby(message = '') {
  closeChat();
  state.intentionalClose = true;
  state.socket?.close();
  state.socket = null;
  state.room = null;
  state.you = null;
  state.selected = null;
  state.partnerCell = null;
  stopTimer();
  el.winOverlay.hidden = true;
  el.bloom.replaceChildren();
  el.game.hidden = true;
  el.lobby.hidden = false;
  history.replaceState(null, '', location.pathname);
  showLobbyError(message);
  // Back in the lobby: re-read stats and whether a puzzle is waiting.
  refreshAccount();
}

const leaveGame = () => returnToLobby();

el.backBtn.addEventListener('click', leaveGame);

/* ------------------------------------------------------------ message router */

function handle(msg) {
  if (!state.room && !['joined', 'error'].includes(msg.t)) return;

  switch (msg.t) {
    case 'joined':
      state.you = msg.you;
      enterGame(msg.state);
      break;

    case 'state':
      applyState(msg.state);
      break;

    case 'players':
      state.room.players = msg.players;
      state.room.ownerId = msg.ownerId;
      renderPlayers();
      renderOwnerControls();
      break;

    case 'move':
      state.room.grid[msg.index] = msg.value;
      state.room.authors[msg.index] = msg.by;
      renderBoard();
      if (msg.value) popCell(msg.index);
      break;

    case 'select':
      state.partnerCell = msg.index;
      renderBoard();
      break;

    case 'chat':
      state.room.chat.push(msg.message);
      appendChat(msg.message);
      break;

    case 'account':
      if (state.account) {
        state.account = { ...state.account, stats: msg.stats, save: msg.save };
        renderAccount();
      }
      break;

    case 'solved':
      state.room.solved = true;
      state.room.solvedBy = msg.solvedBy;
      state.room.contributions = msg.contributions;
      showWin(msg.timeMs);
      break;

    case 'reject':
      if (msg.reason === 'given') toast('That digit is part of the puzzle.');
      break;

    case 'error':
      if (msg.fatal) returnToLobby(msg.text);
      else toast(msg.text);
      break;
  }
}

/* ------------------------------------------------------------- game lifecycle */

function enterGame(snapshot) {
  closeAuth();
  closeAccountMenu();
  el.lobby.hidden = true;
  el.game.hidden = false;
  applyState(snapshot);
  history.replaceState(null, '', `#${snapshot.code}`);
  state.unread = 0;
  renderUnread();
}

function applyState(snapshot) {
  const firstRender = !state.room || state.room.code !== snapshot.code;
  state.room = snapshot;
  el.roomCode.textContent = snapshot.code;

  if (firstRender || el.board.childElementCount !== 81) buildBoard();
  state.selected = null;
  state.partnerCell = null;
  renderBoard();
  renderPlayers();
  renderOwnerControls();
  renderChat();

  state.clockBase = snapshot.timeMs;
  state.clockSyncedAt = Date.now();
  if (snapshot.solved) {
    showWin(snapshot.timeMs, true);
    stopTimer();
  } else {
    el.winOverlay.hidden = true;
    el.bloom.replaceChildren();
    startTimer();
  }
}

/* ------------------------------------------------------------------- board */

function buildBoard() {
  const frag = document.createDocumentFragment();
  state.cells = [];
  for (let i = 0; i < 81; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.index = String(i);
    cell.dataset.row = String((i / 9) | 0);
    cell.dataset.col = String(i % 9);
    cell.setAttribute('role', 'gridcell');
    frag.append(cell);
    state.cells.push(cell);
  }
  el.board.replaceChildren(frag);
}

function renderCell(i) {
  const cell = state.cells[i];
  if (!cell) return;
  const room = state.room;
  const given = room.givens[i];
  const value = room.grid[i];

  cell.classList.toggle('given', given !== 0);
  cell.classList.toggle('entered', given === 0 && value !== 0);
  cell.classList.toggle(
    'by-partner',
    given === 0 && !!room.authors[i] && room.authors[i] !== state.you?.id
  );

  cell.textContent = value ? String(value) : '';
  cell.setAttribute(
    'aria-label',
    `Row ${((i / 9) | 0) + 1} column ${(i % 9) + 1}${value ? `: ${value}` : ' empty'}`
  );
}

// Peer cells — same row, column or 3x3 box — computed once.
const PEERS = Array.from({ length: 81 }, (_, i) => {
  const row = (i / 9) | 0;
  const col = i % 9;
  const set = new Set();
  for (let k = 0; k < 9; k++) {
    set.add(row * 9 + k);
    set.add(k * 9 + col);
  }
  const br = ((row / 3) | 0) * 3;
  const bc = ((col / 3) | 0) * 3;
  for (let dr = 0; dr < 3; dr++) {
    for (let dc = 0; dc < 3; dc++) set.add((br + dr) * 9 + bc + dc);
  }
  set.delete(i);
  return [...set];
});

/**
 * Digits that cannot possibly be right because the same number already sits in
 * their row, column or box. This is plain logic off the visible grid — it gives
 * nothing away, unlike checking against the solution. Givens are never flagged:
 * a clue is never the mistake.
 */
function conflictedCells(room) {
  const bad = new Set();
  for (let i = 0; i < 81; i++) {
    const value = room.grid[i];
    if (!value) continue;
    for (const p of PEERS[i]) {
      if (room.grid[p] !== value) continue;
      if (room.givens[i] === 0) bad.add(i);
      if (room.givens[p] === 0) bad.add(p);
    }
  }
  return bad;
}

/** Brief scale-up on a cell that just received a digit. */
function popCell(index) {
  const cell = state.cells[index];
  if (!cell) return;
  cell.classList.remove('pop');
  void cell.offsetWidth; // restart the animation
  cell.classList.add('pop');
}

function renderBoard() {
  const room = state.room;
  if (!room) return;
  const clashes = conflictedCells(room);
  const sel = state.selected;
  const selRow = sel === null ? -1 : (sel / 9) | 0;
  const selCol = sel === null ? -1 : sel % 9;
  const selBox = sel === null ? -1 : ((selRow / 3) | 0) * 3 + ((selCol / 3) | 0);
  const selValue = sel === null ? 0 : room.grid[sel];

  for (let i = 0; i < 81; i++) {
    renderCell(i);
    const cell = state.cells[i];
    const row = (i / 9) | 0;
    const col = i % 9;
    const box = ((row / 3) | 0) * 3 + ((col / 3) | 0);

    cell.classList.toggle('selected', i === sel);
    cell.classList.toggle('partner', i === state.partnerCell && i !== sel);
    cell.classList.toggle(
      'peer',
      sel !== null && i !== sel && (row === selRow || col === selCol || box === selBox)
    );
    cell.classList.toggle('same-digit', selValue !== 0 && room.grid[i] === selValue && i !== sel);
    cell.classList.toggle('clash', clashes.has(i));
  }
  renderDigitPad();
}

/* --------------------------------------------------------------- number pad */

function renderDigitPad() {
  if (el.digits.childElementCount !== 9) {
    const frag = document.createDocumentFragment();
    for (let d = 1; d <= 9; d++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'digit';
      btn.dataset.digit = String(d);
      btn.textContent = String(d);
      frag.append(btn);
    }
    el.digits.replaceChildren(frag);
  }

  // Fade a digit once all nine of it are placed.
  const counts = new Array(10).fill(0);
  for (const v of state.room.grid) if (v) counts[v]++;
  for (const btn of el.digits.children) {
    btn.classList.toggle('done', counts[Number(btn.dataset.digit)] >= 9);
  }
}

el.digits.addEventListener('click', (e) => {
  const btn = e.target.closest('.digit');
  if (btn) enterDigit(Number(btn.dataset.digit));
});

/* -------------------------------------------------------------- interaction */

function selectCell(i) {
  if (!state.room) return;
  state.selected = i;
  send('select', { index: i });
  renderBoard();
}

el.board.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  selectCell(Number(cell.dataset.index));
});

function enterDigit(digit) {
  const i = state.selected;
  if (i === null || !state.room || state.room.solved) return;
  if (state.room.givens[i] !== 0) return toast('That digit is part of the puzzle.');
  // Tapping the digit already in the cell clears it.
  send('move', { index: i, value: state.room.grid[i] === digit ? 0 : digit });
}

function eraseCell() {
  const i = state.selected;
  if (i === null || !state.room || state.room.solved) return;
  if (state.room.givens[i] !== 0) return;
  send('move', { index: i, value: 0 });
}

function moveSelection(dr, dc) {
  const cur = state.selected ?? 0;
  const row = Math.min(8, Math.max(0, ((cur / 9) | 0) + dr));
  const col = Math.min(8, Math.max(0, (cur % 9) + dc));
  selectCell(row * 9 + col);
}

document.addEventListener('keydown', (e) => {
  if (el.game.hidden) return;
  if (document.activeElement === el.chatInput) {
    if (e.key === 'Escape') el.chatInput.blur();
    return;
  }
  if (e.key === 'Escape' && sheetOpen()) return closeChat();

  if (e.key >= '1' && e.key <= '9') {
    enterDigit(Number(e.key));
    e.preventDefault();
  } else if (['Backspace', 'Delete', '0'].includes(e.key)) {
    eraseCell();
    e.preventDefault();
  } else if (e.key === 'ArrowUp' || e.key === 'w') moveSelection(-1, 0);
  else if (e.key === 'ArrowDown' || e.key === 's') moveSelection(1, 0);
  else if (e.key === 'ArrowLeft' || e.key === 'a') moveSelection(0, -1);
  else if (e.key === 'ArrowRight' || e.key === 'd') moveSelection(0, 1);
  else if (e.key === 'Enter') {
    if (!chatVisible()) openChat();
    el.chatInput.focus();
  } else return;

  if (e.key.startsWith('Arrow')) e.preventDefault();
});

el.eraseBtn.addEventListener('click', eraseCell);

/* -------------------------------------------------------- owner-only controls */

function requestNextPuzzle() {
  if (!iAmOwner()) return;
  const others = state.room.players.length > 1;
  if (others && !state.room.solved) {
    if (!confirm('Skip to a new puzzle? This clears the grid for both of you.')) return;
  }
  send('nextPuzzle', { difficulty: state.difficulty });
}

/** Only the person who opened the room may skip, so hide it from everyone else. */
function renderOwnerControls() {
  if (!state.room) return;
  const owner = iAmOwner();
  const solved = !!state.room.solved;
  el.nextBtn.hidden = !owner || solved;
  el.winActions.hidden = !owner;
  el.winWaiting.hidden = owner;
  if (!owner) {
    const host = state.room.players.find((p) => p.id === state.room.ownerId);
    el.winWaiting.textContent = host
      ? `Waiting for ${host.name} to pick what's next.`
      : 'Waiting for the next puzzle.';
  }
}

el.nextBtn.addEventListener('click', requestNextPuzzle);
el.winNextBtn.addEventListener('click', requestNextPuzzle);
el.winExitBtn.addEventListener('click', () => returnToLobby());

/* --------------------------------------------------------------- room header */

function renderPlayers() {
  if (!state.room) return;
  el.players.replaceChildren(
    ...state.room.players.map((p) => {
      const avatar = document.createElement('span');
      avatar.className = 'avatar' + (p.connected ? '' : ' offline');
      avatar.dataset.seat = String(p.seat ?? 0);
      avatar.textContent = p.name.charAt(0).toUpperCase();
      avatar.title = p.name;
      return avatar;
    })
  );

  if (state.room.players.length < state.room.maxPlayers) {
    const open = document.createElement('span');
    open.className = 'avatar open';
    open.title = 'Seat open — share the room code';
    el.players.append(open);
  }
}

function startTimer() {
  stopTimer();
  const tick = () => {
    el.timer.textContent = formatTime(state.clockBase + (Date.now() - state.clockSyncedAt));
  };
  tick();
  state.timerId = setInterval(tick, 1000);
}

function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
}

el.codeChip.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${state.room.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied — send it to your partner');
  } catch {
    toast(`Room code: ${state.room.code}`);
  }
});

/* ------------------------------------------------------- chat sheet (mobile) */

// On phones the chat lives in a bottom sheet; on wide screens it is a column
// that is always open, so these controls are hidden by CSS there.
const sheetOpen = () => el.chatArea.classList.contains('open');

function openChat() {
  el.chatArea.classList.add('open');
  el.sheetBackdrop.hidden = false;
  el.chatBtn.setAttribute('aria-expanded', 'true');
  hidePeek();
  state.unread = 0;
  renderUnread();
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function closeChat() {
  el.chatArea.classList.remove('open');
  el.sheetBackdrop.hidden = true;
  el.chatBtn.setAttribute('aria-expanded', 'false');
  el.chatInput.blur();
}

function renderUnread() {
  el.unread.hidden = state.unread === 0;
  el.unread.textContent = state.unread > 9 ? '9+' : String(state.unread);
}

el.chatBtn.addEventListener('click', () => (sheetOpen() ? closeChat() : openChat()));
el.chatCloseBtn.addEventListener('click', closeChat);
el.sheetBackdrop.addEventListener('click', closeChat);

/** True when the chat is actually on screen — a column on desktop, or an open sheet. */
function chatVisible() {
  return window.matchMedia('(min-width: 900px)').matches || sheetOpen();
}

/* ------------------------------------------------- incoming message preview */

function hidePeek() {
  el.chatPeek.hidden = true;
  clearTimeout(hidePeek.timer);
}

/** Pops the message itself above the chat button so it can be read in place. */
function showPeek(message) {
  el.peekName.textContent = message.name;
  el.peekText.textContent = message.text;
  el.chatPeek.hidden = false;
  clearTimeout(hidePeek.timer);
  hidePeek.timer = setTimeout(hidePeek, 5000);
}

el.chatPeek.addEventListener('click', openChat);

/* -------------------------------------------------------------------- chat */

function chatBubble(message) {
  const li = document.createElement('li');
  if (message.kind === 'system') {
    li.className = 'msg system';
    li.textContent = message.text;
    return li;
  }
  const mine = message.by === state.you?.id;
  li.className = `msg ${mine ? 'mine' : 'theirs'}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = message.name;
  li.append(who, document.createTextNode(message.text));
  return li;
}

function atChatBottom() {
  return el.chatLog.scrollHeight - el.chatLog.scrollTop - el.chatLog.clientHeight < 60;
}

function appendChat(message) {
  const pinned = atChatBottom();
  el.chatLog.querySelector('.chat-empty')?.remove();
  el.chatLog.append(chatBubble(message));
  if (pinned) el.chatLog.scrollTop = el.chatLog.scrollHeight;

  // Anything the player cannot currently see gets a badge and a preview.
  const mine = message.by === state.you?.id;
  if (!mine && message.kind === 'chat' && !chatVisible()) {
    state.unread += 1;
    renderUnread();
    showPeek(message);
  }
}

function renderChat() {
  const messages = state.room.chat || [];
  if (!messages.length) {
    const empty = document.createElement('li');
    empty.className = 'chat-empty';
    empty.textContent = 'No messages yet. Talk through the grid together.';
    el.chatLog.replaceChildren(empty);
    return;
  }
  el.chatLog.replaceChildren(...messages.map(chatBubble));
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  send('chat', { text });
  el.chatInput.value = '';
});

/* --------------------------------------------------------------------- win */

/**
 * A lily drawn as five petals around a centre, so the celebration stays inside
 * the two-tone palette instead of dragging in a colour just for confetti.
 */
function lilySvg() {
  const petals = [0, 72, 144, 216, 288]
    .map((deg) => `<ellipse cx="12" cy="7" rx="2.7" ry="5" transform="rotate(${deg} 12 12)"/>`)
    .join('');
  return `<svg viewBox="0 0 24 24" fill="currentColor">${petals}<circle cx="12" cy="12" r="1.9"/></svg>`;
}

/** Sends a drift of lilies up the screen. Skipped when motion is reduced. */
function celebrate() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.bloom.replaceChildren();
  const count = 16;
  for (let i = 0; i < count; i++) {
    const lily = document.createElement('span');
    lily.className = 'lily';
    lily.innerHTML = lilySvg();
    const size = 16 + Math.random() * 24;
    lily.style.left = `${Math.random() * 100}%`;
    lily.style.width = `${size}px`;
    lily.style.height = `${size}px`;
    lily.style.opacity = String(0.25 + Math.random() * 0.5);
    lily.style.animationDelay = `${Math.random() * 1.4}s`;
    lily.style.animationDuration = `${3.2 + Math.random() * 2.2}s`;
    lily.style.setProperty('--drift', `${(Math.random() - 0.5) * 140}px`);
    lily.style.setProperty('--spin', `${(Math.random() - 0.5) * 480}deg`);
    el.bloom.append(lily);
  }
  clearTimeout(celebrate.timer);
  celebrate.timer = setTimeout(() => el.bloom.replaceChildren(), 6500);
}

function showWin(timeMs, silent = false) {
  const room = state.room;
  if (!room) return;
  el.timer.textContent = formatTime(timeMs);
  stopTimer();

  const finisher = room.solvedBy;
  el.winFinisher.textContent = finisher
    ? `${finisher.name} placed the winning number`
    : 'Puzzle complete';

  // Credit both players by how much of the grid each one filled.
  const scores = room.contributions || [];
  el.winScores.replaceChildren(
    ...scores.map((c) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = c.name + (finisher && c.id === finisher.id ? ' ★' : '') + (c.present === false ? ' (left)' : '');
      const filled = document.createElement('span');
      filled.className = 'score-count';
      filled.textContent = `${c.filled} cell${c.filled === 1 ? '' : 's'}`;
      li.append(name, filled);
      return li;
    })
  );

  el.winDetail.textContent = formatTime(timeMs);
  renderOwnerControls();
  el.winOverlay.hidden = false;
  if (!silent) {
    celebrate();
    toast('Solved!', 3000);
  }
}

/* -------------------------------------------------------------------- boot */

el.nameInput.value = localStorage.getItem('sudoku:name') || '';
renderAccount();

// Restore the session before deciding anything, so an invite link can join
// under the account name instead of asking a signed-in player to type one.
await restoreSession();

const hashCode = location.hash.replace('#', '').toUpperCase();
if (/^[A-Z0-9]{5}$/.test(hashCode)) {
  el.codeInput.value = hashCode;
  const name = state.account?.user.username || el.nameInput.value;
  if (name) {
    connect({ name, mode: 'code', code: hashCode, token: state.token });
  } else {
    el.nameInput.focus();
    showLobbyError(`Enter your name to join room ${hashCode}.`);
  }
} else if (!state.account) {
  el.nameInput.focus();
}
