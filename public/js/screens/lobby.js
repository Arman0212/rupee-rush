// Lobby: room code + invite, players, colour picker, settings, start, chat.
import { rules } from '../shared.js';
import { el, render, $ } from '../dom.js';
import { initial, tokenStyle } from '../format.js';
import { toast } from '../ui/toast.js';

const { SETTING_LIMITS } = rules;

export const COLOUR_NAMES = ['Chilli red', 'Apricot', 'Mustard', 'Teal', 'Steel blue', 'Violet', 'Rose pink', 'Sky blue'];

/** Lobby settings in display order, with a one-line explanation each. */
const SETTINGS = [
  { key: 'startingCash', label: 'Starting cash', help: 'Money each player starts with.', money: true },
  { key: 'goSalary', label: 'GO salary', help: 'Paid every time you pass or land on GO.', money: true },
  { key: 'maxPlayers', label: 'Seats', help: 'How many players can join this room.' },
  { key: 'turnTimerSeconds', label: 'Turn timer (seconds)', help: '0 means no timer. When time runs out the game plays your turn safely for you.' },
  { key: 'doubleRentOnFullSet', label: 'Double rent on full sets', help: 'Owning a whole colour set doubles the rent on its empty cities.' },
  { key: 'collectRentInJail', label: 'Collect rent in jail', help: 'Owners still collect rent while they sit in jail.' },
  { key: 'vacationJackpot', label: 'Vacation jackpot', help: 'Taxes and card fines pile up on Vacation; landing there wins the pot.' },
  { key: 'isPrivate', label: 'Private room', help: 'Hide this room from the public list. Friends join with the code.' },
  { key: 'auctions', label: 'Auctions', help: 'A city nobody buys goes up for a quick auction that everyone can bid in.' },
  { key: 'auctionSeconds', label: 'Auction timer (seconds)', help: 'How long an auction waits for the next bid. Every bid restarts the clock.' },
];

export function createLobbyScreen({ store, net, chat }) {
  const form = $('#lobby-settings');
  chat.mount($('#lobby-chat'), { label: 'Lobby chat message' });

  // --- Invite --------------------------------------------------------------------
  const inviteLink = () => `${location.origin}/r/${store.state.room.code}`;
  $('#lobby-copy').addEventListener('click', async () => {
    const url = inviteLink();
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (navigator.share && coarse) {
      try {
        await navigator.share({ title: rules.GAME_NAME, text: `Join my ${rules.GAME_NAME} game!`, url });
        return;
      } catch { /* cancelled or unsupported: fall back to copying */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.', { kind: 'good' });
    } catch {
      toast(`Copy this link: ${url}`, { timeout: 8000 });
    }
  });

  // --- Players, colours, start -------------------------------------------------------
  store.subscribe(
    (d) => d.state && d.state.room.status === 'lobby' && { room: d.state.room, you: d.you && { id: d.you.playerId, isHost: d.you.isHost } },
    (v) => {
      if (!v) return;
      const { room, you } = v;
      const me = you && room.players.find((p) => p.id === you.id);
      $('#lobby-code').textContent = room.code;
      $('#lobby-link').textContent = inviteLink().replace(/^https?:\/\//, '');
      $('#lobby-count').textContent = `${room.players.length}/${room.settings.maxPlayers}`;

      render($('#lobby-players'), room.players.map((p) => el('li', { className: `lobby-player${p.connected ? '' : ' is-offline'}` },
        el('span', { className: 'token-disc', text: initial(p.name), style: tokenStyle(p.color), attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'lobby-player-name', text: p.name }),
        p.isHost ? el('span', { className: 'crown', text: '👑', attrs: { title: 'Host', 'aria-label': 'host' } }) : null,
        me && p.id === me.id ? el('span', { className: 'badge badge-you', text: 'You' }) : null,
        p.connected ? null : el('span', { className: 'badge badge-muted', text: 'Reconnecting…' }),
        you && you.isHost && p.id !== you.id ? el('button', {
          className: 'btn btn-ghost btn-sm kick', type: 'button', text: 'Kick',
          attrs: { 'aria-label': `Remove ${p.name} from the room` },
          on: { click: async () => { const r = await net.emit('kick', { playerId: p.id }); if (!r.ok) toast(r.error, { kind: 'bad' }); } },
        }) : null)));

      render($('#lobby-colours'), room.colors.map((colour, i) => {
        const owner = room.players.find((p) => p.color === colour);
        const mine = me && me.color === colour;
        const takenBy = owner && !mine ? owner.name : null;
        return el('button', {
          className: `colour-swatch${mine ? ' is-mine' : ''}`, type: 'button',
          style: { '--swatch': colour, '--token-ink': tokenStyle(colour)['--token-ink'] },
          disabled: Boolean(takenBy),
          title: takenBy ? `${COLOUR_NAMES[i]} (taken by ${takenBy})` : COLOUR_NAMES[i],
          attrs: { role: 'radio', 'aria-checked': String(Boolean(mine)), 'aria-label': takenBy ? `${COLOUR_NAMES[i]}, taken by ${takenBy}` : COLOUR_NAMES[i] },
          on: { click: async () => { const r = await net.emit('pickColor', { color: colour }); if (!r.ok) toast(r.error, { kind: 'bad' }); } },
        }, mine ? el('span', { text: '✓', attrs: { 'aria-hidden': 'true' } }) : null);
      }));

      const start = $('#lobby-start');
      const hint = $('#lobby-start-hint');
      const enough = room.players.length >= 2;
      start.hidden = !(you && you.isHost);
      start.disabled = !enough;
      const host = room.players.find((p) => p.isHost);
      hint.textContent = you && you.isHost
        ? (enough ? 'Everyone ready? Start whenever you like.' : 'You need at least 2 players to start. Share the invite link!')
        : `Waiting for ${host ? host.name : 'the host'} to start the game…`;

      renderSettings(room.settings, Boolean(you && you.isHost));
    },
  );

  $('#lobby-start').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const r = await net.emit('startGame');
    if (!r.ok) {
      toast(r.error, { kind: 'bad' });
      e.currentTarget.disabled = false;
    }
  });

  // --- Settings ----------------------------------------------------------------------
  function renderSettings(settings, isHost) {
    $('#lobby-settings-note').textContent = isHost ? '' : '(only the host can change these)';
    // Don't rebuild under the host's cursor; just refresh values elsewhere.
    if (form.contains(document.activeElement) && form.dataset.host === String(isHost)) {
      for (const input of form.querySelectorAll('input')) {
        if (input === document.activeElement) continue;
        if (input.type === 'checkbox') input.checked = settings[input.name];
        else input.value = settings[input.name];
      }
      return;
    }
    form.dataset.host = String(isHost);
    render(form, SETTINGS.map((s) => {
      const value = settings[s.key];
      const id = `set-${s.key}`;
      const disabled = !isHost;
      const helpId = `${id}-help`;
      let input;
      if (typeof value === 'boolean') {
        input = el('input', { type: 'checkbox', id, name: s.key, checked: value, disabled, attrs: { 'aria-describedby': helpId } });
      } else {
        const lim = SETTING_LIMITS[s.key];
        input = el('input', {
          type: 'number', id, name: s.key, value: String(value), disabled, className: 'input input-num',
          min: lim.min, max: lim.max, step: lim.step, inputMode: 'numeric', attrs: { 'aria-describedby': helpId },
        });
      }
      input.addEventListener('change', async () => {
        const next = input.type === 'checkbox' ? input.checked : Number(input.value);
        const r = await net.emit('updateSettings', { settings: { [s.key]: next } });
        if (!r.ok) toast(r.error, { kind: 'bad' });
      });
      return el('div', { className: `setting${typeof value === 'boolean' ? ' setting-toggle' : ''}` },
        el('label', { className: 'setting-label', htmlFor: id }, s.label),
        el('div', { className: 'setting-control' }, s.money ? el('span', { className: 'rupee-prefix', text: '₹', attrs: { 'aria-hidden': 'true' } }) : null, input),
        el('p', { className: 'setting-help muted', id: helpId, text: s.help }));
    }));
  }

  return {
    show() { $('#lobby-copy').focus({ preventScroll: true }); },
    hide() {},
  };
}
