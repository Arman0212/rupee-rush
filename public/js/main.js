import { $, $$, el, clear, storage } from './dom.js';
import { rules } from './shared.js';
import { createNet, statusPill, tokens } from './net.js';
import { createStore, selectMe } from './store.js';
import { createSound } from './sound.js';
import { initToasts, initNotifications, toast } from './ui/toast.js';
import { confirmDialog } from './ui/modal.js';
import { createChat } from './ui/chat.js';
import { createLog } from './ui/log.js';
import { openHelp } from './ui/help.js';
import { createPanes, wideQuery } from './ui/panes.js';
import { icon, setIcon } from './ui/icons.js';
import { createHomeScreen, normalizeCode } from './screens/home.js';
import { createLobbyScreen } from './screens/lobby.js';
import { createGameScreen } from './screens/game.js';

// The game's name and tagline come from shared/rules.js, everywhere.
for (const node of $$('[data-game-name]')) node.textContent = rules.GAME_NAME;
for (const node of $$('[data-game-tagline]')) node.textContent = rules.GAME_TAGLINE;
setIcon($('#help-btn'), 'help');
$('#leave-btn').prepend(icon('leave', { size: 16 }));

const store = createStore();
initToasts($('#toasts'));
initNotifications($('#notif-toggle'));
initTheme($('#theme-toggle'));
const sound = createSound($('#sound-toggle'));

function initTheme(toggleBtn) {
  let theme = storage.get('rr:theme') || 'dark';
  function apply() {
    document.documentElement.dataset.theme = theme;
    if (toggleBtn) {
      const isDark = theme === 'dark';
      toggleBtn.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
      toggleBtn.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
      setIcon(toggleBtn, isDark ? 'sun' : 'moon');
    }
  }
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      storage.set('rr:theme', theme);
      apply();
    });
  }
  apply();
}

const net = createNet({ onStatus: statusPill($('#conn')), onRejoin: handleRejoin });
const chat = createChat({ net, store });
const log = createLog({ store });
chat.mount($('#room-chat'), { label: 'Chat message' });
log.mount($('#room-log'));
log.onLatest((text) => { $('#log-latest').textContent = text; });
const panes = createPanes({ chat });

// ---------------------------------------------------------------------------
// App actions shared by the screens
// ---------------------------------------------------------------------------

const app = {
  async create(name) {
    forgetRoom();
    return afterJoin(await net.emit('createRoom', { name }));
  },

  /** Join by code, reclaiming the seat if we hold a token for it. */
  async join(code, name) {
    const token = tokens.get(code);
    forgetRoom();
    const result = await net.emit('joinRoom', { code, ...(name ? { name } : {}), ...(token ? { token } : {}) });
    if (!result.ok && token && result.error === 'game already started') tokens.remove(code); // stale token
    return afterJoin(result);
  },

  /** Leave the room (resigning mid-game), after confirming. */
  async leave({ confirm = true } = {}) {
    const state = store.state;
    if (!state) return;
    const me = selectMe(store);
    const resigning = state.room.status === 'playing' && me && !me.bankrupt;
    if (confirm) {
      const yes = await confirmDialog(resigning
        ? { title: 'Resign and leave?', body: 'Your cities go back to the bank and you cannot rejoin this game.', confirmLabel: 'Resign', danger: true }
        : { title: 'Leave this room?', body: 'You can rejoin with the code while the room is still in the lobby.', confirmLabel: 'Leave' });
      if (!yes) return;
    }
    const code = state.room.code;
    await net.emit('leaveRoom');
    tokens.remove(code);
    leaveToHome();
  },
};

/** Send a game action. Only one request is in flight at a time, so double-clicks never fire twice. */
async function act(action) {
  if (store.ui.busy) return null;
  store.setUi({ busy: true });
  document.body.classList.add('is-busy');
  try {
    const result = await net.emit('action', action);
    if (!result.ok) toast(result.error, { kind: 'bad' });
    return result;
  } finally {
    store.setUi({ busy: false });
    document.body.classList.remove('is-busy');
  }
}

function afterJoin(result) {
  if (!result.ok) {
    toast(result.error, { kind: 'bad' });
    return result;
  }
  tokens.set(result.code, result.token);
  net.setSession(result.code, result.token);
  history.replaceState(null, '', `/r/${result.code}`);
  return result;
}

/** Clear everything tied to the current room before joining another. */
function forgetRoom() {
  net.clearSession();
  store.reset();
  chat.clear();
  log.clear();
  game.reset();
}

function leaveToHome(message) {
  forgetRoom();
  history.replaceState(null, '', '/');
  home.show({ message });
}

async function handleRejoin(result) {
  if (result.ok) {
    toast('Reconnected.', { kind: 'good', timeout: 2000 });
    return;
  }
  const code = net.session && net.session.code;
  if (code && result.error !== 'You are offline.') tokens.remove(code);
  leaveToHome(`Couldn't get back into the room: ${result.error}`);
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

net.on('state', (payload) => store.applyState(payload));
net.on('you', (payload) => store.applyYou(payload));
net.on('chatHistory', ({ messages }) => chat.setHistory(messages));
net.on('chat', (message) => chat.add(message));
net.on('replaced', () => {
  net.clearSession(); // the other tab owns the seat now; don't fight it
  leaveToHome('This seat is now open in another tab or window.');
});
net.on('kicked', ({ code }) => {
  tokens.remove(code);
  leaveToHome('The host removed you from the room.');
});
net.on('roomClosed', ({ code, reason }) => {
  tokens.remove(code);
  const why = { expired: `This ${rules.GAME_NAME} room reached its time limit and closed.`, idle: `This ${rules.GAME_NAME} room closed after being idle.` }[reason]
    || `The server restarted, so this ${rules.GAME_NAME} room has closed.`;
  leaveToHome(why);
});
store.onEvents((events) => log.addEvents(events));

// ---------------------------------------------------------------------------
// Screens and routing
// ---------------------------------------------------------------------------

const home = createHomeScreen({ net, app });
const lobby = createLobbyScreen({ store, net });
const game = createGameScreen({ store, net, act, sound, app, panes });
const screens = { home, lobby, game };
let current = null;

/** Lobby and game share the room screen; only its mode changes. */
function showScreen(name) {
  if (current === name) return;
  if (current) screens[current].hide();
  if (current === 'game' && name === 'lobby') game.reset(); // play again
  $('#screen-home').hidden = name !== 'home';
  $('#screen-room').hidden = name === 'home';
  if (name !== 'home') panes.setMode(name);
  document.body.dataset.screen = name;
  current = name;
  placeControls();
  if (name !== 'home') screens[name].show();
}

/**
 * On wide room screens the top bar disappears and its controls (sound, help,
 * notifications, theme, connection, leave) sit under the logo in the left
 * pane. Moving the nodes keeps their listeners.
 */
function placeControls() {
  const wide = wideQuery.matches && current && current !== 'home';
  const target = wide ? $('#pane-controls') : $('.topbar');
  const controls = $('#app-controls');
  if (controls.parentElement !== target) target.append(controls);
  document.body.classList.toggle('room-wide', Boolean(wide));
}
wideQuery.addEventListener('change', placeControls);

store.subscribe(
  (d) => (!d.state ? 'home' : d.state.room.status === 'lobby' ? 'lobby' : 'game'),
  (name) => showScreen(name),
);

// Top bar: room chip, leave button, page title.
store.subscribe(
  (d) => d.state && { code: d.state.room.code, status: d.state.room.status, chaos: d.state.room.settings.mode === 'chaos' },
  (v) => {
    const chip = $('#topbar-room');
    chip.hidden = !v;
    clear(chip);
    if (v) {
      chip.append(document.createTextNode(`Room ${v.code}`));
      if (v.chaos) chip.append(el('span', { className: 'chaos-badge', text: 'Chaos' }));
    }
    document.documentElement.setAttribute('data-mode-chaos', String(Boolean(v && v.chaos)));
    $('#leave-btn').hidden = !v;
    document.title = v ? `${rules.GAME_NAME} · ${v.code}` : rules.GAME_NAME;
  },
);
$('#leave-btn').addEventListener('click', () => app.leave());
$('#help-btn').addEventListener('click', openHelp);
$('#home-help').addEventListener('click', openHelp);
for (const brand of $$('.brand')) {
  brand.addEventListener('click', (e) => {
    if (!store.state) return;
    e.preventDefault(); // don't silently drop a seat by navigating away
    app.leave();
  });
}

// ---------------------------------------------------------------------------
// Boot: /r/CODE joins straight away when we know who you are
// ---------------------------------------------------------------------------

async function boot() {
  const match = location.pathname.match(/^\/r\/([^/]+)\/?$/);
  const code = match && normalizeCode(match[1]);
  if (!code) {
    home.show();
    return;
  }
  const name = storage.get('rr:name');
  if (!tokens.get(code) && !name) {
    home.show({ code, message: `Enter your name to join room ${code}.` });
    return;
  }
  const result = await app.join(code, name);
  if (!result.ok) home.show({ code, message: `Couldn't join ${code}: ${result.error}` });
}

boot();
