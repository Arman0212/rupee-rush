// Game settings and gameplay rules: one row per setting with an icon, a bold
// title, a one-line description and a control on the right (a pill toggle
// switch or a select). Editable by the host in the lobby, read-only otherwise.
import { rules } from '../shared.js';
import { el, render, $ } from '../dom.js';
import { money } from '../format.js';
import { toast } from './toast.js';

const { SETTING_LIMITS } = rules;

const seconds = (s) => (s ? `${s} seconds` : 'Off');
const range = (key, step) => {
  const { min, max } = SETTING_LIMITS[key];
  const out = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
};

/** Each row: icon, title, description, and either a toggle or a select with options. */
const GAME_SETTINGS = [
  { key: 'maxPlayers', icon: '👥', title: 'Maximum players', help: 'How many seats this room has.', options: range('maxPlayers', 1), label: (v) => `${v} players` },
  { key: 'isPrivate', icon: '🔒', title: 'Private room', help: 'Hide this room from the public list.' },
  { key: 'turnTimerSeconds', icon: '⏱️', title: 'Turn timer', help: 'Out of time? The game plays your turn safely.', options: [0, 30, 45, 60, 90, 120, 180, 300], label: seconds },
  { key: 'startingCash', icon: '💰', title: 'Starting cash', help: 'Money each player begins with.', options: [500, 1000, 1500, 2000, 2500, 3000, 4000, 5000], label: money },
  { key: 'allowBots', icon: '🤖', title: 'Allow bots', help: 'The host can fill seats with computer players.' },
  { key: 'botChat', icon: '💬', title: 'Bot chat', help: 'Bots say a short line at big moments.' },
];
const GAMEPLAY_RULES = [
  { key: 'goSalary', icon: '🏁', title: 'GO salary', help: 'Paid whenever you pass or land on GO.', options: range('goSalary', 50), label: money },
  { key: 'doubleRentOnFullSet', icon: '🏘️', title: 'Double rent on full sets', help: 'A whole set doubles rent on its empty cities.' },
  { key: 'collectRentInJail', icon: '⛓️', title: 'Collect rent in jail', help: 'Owners still collect rent while in jail.' },
  { key: 'vacationJackpot', icon: '🏖️', title: 'Vacation jackpot', help: 'Taxes and fines pile up for whoever lands on Vacation.' },
  { key: 'auctions', icon: '🔨', title: 'Auctions', help: 'Unbought cities go to a quick auction.' },
  { key: 'auctionSeconds', icon: '⏳', title: 'Auction timer', help: 'Every bid restarts the clock.', options: [5, 10, 15, 20, 30], label: seconds },
];

/** The two lobby modes, shown as big cards. */
const MODE_CARDS = [
  { mode: 'classic', icon: '♟️', title: 'Classic', desc: 'The standard game. No surprises.' },
  { mode: 'chaos', icon: '🎲', title: 'Chaos', desc: 'World events, bounties, landmarks and teams — all on.' },
];
/** Settings the Chaos preset fixes, so they are read-only in Chaos. */
const CHAOS_LOCKED = new Set(['startingCash', 'auctions', 'auctionSeconds', 'vacationJackpot']);

export function createSettings({ store, net }) {
  const hosts = { game: $('#settings-game'), rules: $('#settings-rules'), picker: $('#mode-picker') };
  const note = $('#sec-settings .settings-note');

  async function save(key, value) {
    const r = await net.emit('updateSettings', { settings: { [key]: value } });
    if (!r.ok) toast(r.error, { kind: 'bad', important: true });
  }

  function control(def, value, editable) {
    const id = `set-${def.key}`;
    const describedBy = `${id}-help`;
    if (typeof value === 'boolean') {
      const input = el('input', {
        type: 'checkbox', className: 'switch', id, name: def.key, checked: value, disabled: !editable,
        attrs: { role: 'switch', 'aria-describedby': describedBy },
      });
      input.addEventListener('change', () => save(def.key, input.checked));
      return input;
    }
    // Keep a value the host set some other way (e.g. an old room) selectable.
    const options = def.options.includes(value) ? def.options : [...def.options, value].sort((a, b) => a - b);
    const select = el('select', {
      className: 'select', id, name: def.key, disabled: !editable,
      attrs: { 'aria-describedby': describedBy },
    }, options.map((o) => el('option', { value: String(o), text: def.label(o), selected: o === value })));
    select.addEventListener('change', () => save(def.key, Number(select.value)));
    return select;
  }

  function rows(defs, settings, editable) {
    const chaos = settings.mode === 'chaos';
    return defs.map((def) => {
      const id = `set-${def.key}`;
      const rowEditable = editable && !(chaos && CHAOS_LOCKED.has(def.key));
      return el('div', { className: `setting-row${rowEditable ? '' : ' is-locked'}` },
        el('span', { className: 'setting-icon', text: def.icon, attrs: { 'aria-hidden': 'true' } }),
        el('div', { className: 'setting-text' },
          el('label', { className: 'setting-title', htmlFor: id, text: def.title }),
          el('p', { className: 'setting-help', id: `${id}-help`, text: chaos && CHAOS_LOCKED.has(def.key) ? `Set by Chaos mode.` : def.help })),
        el('div', { className: 'setting-control' }, control(def, settings[def.key], rowEditable)));
    });
  }

  /** The Classic / Chaos picker: two big cards. */
  function picker(settings, editable) {
    return MODE_CARDS.map((card) => el('button', {
      className: `mode-card${settings.mode === card.mode ? ' is-active' : ''} mode-${card.mode}`,
      type: 'button', disabled: !editable,
      attrs: { 'aria-pressed': String(settings.mode === card.mode) },
      on: { click: () => save('mode', card.mode) },
    },
    el('span', { className: 'mode-card-icon', text: card.icon, attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'mode-card-title', text: card.title }),
    el('span', { className: 'mode-card-desc', text: card.desc })));
  }

  store.subscribe(
    (d) => d.state && { settings: d.state.room.settings, editable: d.state.room.status === 'lobby' && Boolean(d.you && d.you.isHost), status: d.state.room.status },
    (v) => {
      if (!v) return;
      note.textContent = v.status !== 'lobby' ? '(locked during the game)' : v.editable ? '' : '(host only)';
      // Don't rebuild under the host's pointer: just refresh the other values.
      const panels = [hosts.game, hosts.rules];
      const focused = panels.some((h) => h.contains(document.activeElement));
      if (focused && hosts.game.dataset.editable === String(v.editable) && hosts.game.dataset.mode === v.settings.mode) {
        for (const input of panels.flatMap((h) => [...h.querySelectorAll('input, select')])) {
          if (input === document.activeElement) continue;
          if (input.type === 'checkbox') input.checked = v.settings[input.name];
          else input.value = String(v.settings[input.name]);
        }
        return;
      }
      hosts.game.dataset.editable = String(v.editable);
      hosts.game.dataset.mode = v.settings.mode;
      render(hosts.picker, picker(v.settings, v.editable));
      render(hosts.game, rows(GAME_SETTINGS, v.settings, v.editable));
      render(hosts.rules, rows(GAMEPLAY_RULES, v.settings, v.editable));
    },
  );
}
