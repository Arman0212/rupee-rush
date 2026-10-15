// The player list in the right pane, for the lobby and the game: avatar in
// the player's colour, name, host badge, bot badge, cash (in game), status
// badges, and "Change appearance" (your colour), Kick / Remove bot or
// "Replace with bot" where allowed. Below it, the host's "Add bot" control.
import { board } from '../shared.js';
import { el, render, $ } from '../dom.js';
import { money, initial, tokenStyle, nameLookup } from '../format.js';

const { BOARD, GROUP_MEMBERS } = board;
import { openDialog } from './modal.js';
import { toast } from './toast.js';
import { icon } from './icons.js';

const AWAY_GRACE_MS = 60_000;
export const COLOUR_NAMES = ['Chilli red', 'Apricot', 'Mustard', 'Teal', 'Steel blue', 'Violet', 'Rose pink', 'Sky blue'];
const DIFFICULTY_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

export function createPlayerList({ store, net }) {
  const list = $('#player-list');
  const count = $('#players-count');
  const addBox = $('#add-bot');
  const addButton = $('#add-bot-btn');
  const difficulty = $('#add-bot-difficulty');
  const teamTools = $('#team-tools');
  const shuffleButton = $('#shuffle-teams-btn');
  const teamPanel = $('#team-panel');

  const send = async (event, payload) => {
    const r = await net.emit(event, payload);
    if (!r.ok) toast(r.error, { kind: 'bad', important: true });
    return r;
  };
  const kick = (playerId) => send('kick', { playerId });

  addButton.prepend(icon('robot', { size: 16 }));
  addButton.addEventListener('click', () => send('addBot', { difficulty: difficulty.value }));
  shuffleButton.addEventListener('click', () => send('shuffleTeams', {}));

  const TEAM_CHIP = { A: 'team-chip-A', B: 'team-chip-B' };
  const setTeam = (playerId, team) => send('setTeam', { playerId, team });

  function row(p, v) {
    const ps = v.ps;
    const seat = v.room.players.find((s) => s.id === p.id);
    const inGame = ps && ps.players.find((x) => x.id === p.id);
    const offline = seat ? !seat.connected : true;
    const isMe = p.id === v.me;
    const isHost = p.id === v.room.hostId;
    const bot = seat && seat.bot;
    const badges = [];
    if (inGame) {
      if (inGame.inJail) badges.push(['In jail', 'warn']);
      if (inGame.bankrupt) badges.push(['Bankrupt', 'bad']);
      else if (offline) badges.push([seat ? 'Offline' : 'Left', 'muted']);
      if (inGame.jailFreeCards.length) badges.push([`Jail-free ×${inGame.jailFreeCards.length}`, 'good']);
    }
    const botBadge = bot ? el('span', { className: 'badge badge-bot', title: `Computer player, ${DIFFICULTY_NAMES[bot]}` },
      icon('robot', { size: 13 }), `Bot · ${DIFFICULTY_NAMES[bot]}`) : null;
    const owned = ps ? Object.values(ps.properties).filter((c) => c.ownerId === p.id).length : 0;
    const sub = inGame
      ? (inGame.cash < 0 ? `Owes ${money(inGame.debt.amount)} to ${nameLookup(store.state)(inGame.debt.creditorId)}` : `${owned} ${owned === 1 ? 'property' : 'properties'}`)
      : (offline ? 'Reconnecting…' : 'Ready');
    const canKick = v.isHost && !isMe && seat && !bot && (!ps || (!seat.connected && Date.now() - seat.disconnectedAt >= AWAY_GRACE_MS));
    const canRemoveBot = v.isHost && bot && !ps;
    const canReplace = v.isHost && ps && seat && !bot && !seat.connected && inGame && !inGame.bankrupt && v.room.settings.allowBots;

    return el('li', {
      className: `player-row${ps && p.id === ps.currentPlayerId ? ' is-current' : ''}${inGame && inGame.bankrupt ? ' is-bankrupt' : ''}${offline ? ' is-offline' : ''}${isMe ? ' is-me' : ''}`,
      attrs: { 'aria-current': ps && p.id === ps.currentPlayerId ? 'true' : null },
    },
    el('span', { className: `avatar${bot ? ' is-bot' : ''}${v.room.settings.teams && seat && seat.team ? ` team-${seat.team}` : ''}`, text: initial(p.name), style: tokenStyle(p.color), attrs: { 'aria-hidden': 'true' } }),
    el('div', { className: 'player-main' },
      el('p', { className: 'player-name' },
        el('span', { className: 'player-name-text', text: p.name }),
        isHost ? el('span', { className: 'host-badge', title: 'Host' }, icon('crown', { size: 14, label: 'Host' })) : null,
        isMe ? el('span', { className: 'badge badge-you', text: 'You' }) : null,
        v.bounties && v.bounties.onPlayer[p.id] ? el('span', { className: 'bounty-badge', title: 'Bounty' }, `🎯 ${money(v.bounties.onPlayer[p.id].value)}`) : null),
      el('p', { className: 'player-sub' },
        botBadge,
        badges.length ? badges.map(([text, kind]) => el('span', { className: `badge badge-${kind}`, text })) : (bot && !ps ? null : el('span', { className: 'muted', text: sub })))),
    el('div', { className: 'player-side' },
      inGame ? el('p', { className: `player-cash${inGame.cash < 0 ? ' negative' : ''}`, text: money(inGame.cash) }) : null,
      v.room.settings.teams && !ps && seat ? teamControl(p, seat, v) : null,
      !ps && isMe ? el('button', {
        className: 'link-btn appearance-btn', type: 'button', dataset: { action: 'appearance' },
        on: { click: openAppearance },
      }, icon('palette', { size: 15 }), 'Change appearance') : null,
      canKick ? el('button', {
        className: 'icon-btn icon-btn-sm kick-btn', type: 'button', title: `Remove ${p.name}`,
        attrs: { 'aria-label': `Remove ${p.name} from the room` },
        on: { click: () => kick(p.id) },
      }, icon('kick', { size: 14 })) : null,
      canRemoveBot ? el('button', {
        className: 'icon-btn icon-btn-sm kick-btn remove-bot-btn', type: 'button', title: `Remove ${p.name}`,
        attrs: { 'aria-label': `Remove ${p.name} from the room` },
        on: { click: () => send('removeBot', { playerId: p.id }) },
      }, icon('kick', { size: 14 })) : null,
      canReplace ? el('button', {
        className: 'link-btn replace-btn', type: 'button',
        attrs: { 'aria-label': `Replace ${p.name} with a bot` },
        on: { click: () => openReplace(p) },
      }, icon('robot', { size: 14 }), 'Replace with bot') : null));
  }

  /** Team panel: each team's living members and their combined net worth. */
  function renderTeamPanel(v) {
    if (!v.ps || !v.room.settings.teams) { teamPanel.hidden = true; return render(teamPanel); }
    teamPanel.hidden = false;
    const rows = ['A', 'B'].map((team) => {
      const members = v.ps.players.filter((p) => p.team === team);
      const alive = members.filter((p) => !p.bankrupt);
      const worth = alive.reduce((sum, p) => sum + board.netWorth(p, v.ps.properties), 0);
      const myTeam = team === v.ps.players.find((p) => p.id === v.me)?.team;
      const mates = alive.filter((p) => p.id !== v.me);
      const canSend = myTeam && mates.length && v.ps.players.find((p) => p.id === v.me && !p.bankrupt);
      return el('div', { className: `team-panel-row team-${team}` },
        el('div', {},
          el('span', { className: `team-chip team-chip-${team}`, text: team }),
          el('span', { className: 'muted', text: ` ${alive.length ? members.map((m) => m.name).join(', ') : 'out'}` })),
        el('div', { className: 'player-side' },
          el('span', { className: 'team-worth', text: money(worth) }),
          canSend ? el('button', { className: 'link-btn replace-btn', type: 'button', text: 'Send →', on: { click: () => openSend(v, mates) } }) : null));
    });
    return render(teamPanel, rows);
  }

  /** Dialog to send cash and/or spare properties to a teammate (no fee). */
  function openSend(v, mates) {
    const cashInput = el('input', { type: 'number', className: 'select', attrs: { min: '0', step: '1', value: '0', 'aria-label': 'Cash to send' } });
    const toSelect = mates.length > 1
      ? el('select', { className: 'select' }, mates.map((m) => el('option', { value: m.id, text: m.name })))
      : null;
    const sendable = Object.keys(v.ps.properties).filter((id) => {
      const prop = v.ps.properties[id];
      if (prop.ownerId !== v.me) return false;
      const tile = board.getTileById(id);
      return !tile.group || !GROUP_MEMBERS[tile.group].some((i) => v.ps.properties[BOARD[i].id].buildings > 0);
    });
    const checks = sendable.map((id) => {
      const box = el('input', { type: 'checkbox', value: id });
      return { id, box, node: el('label', { className: 'send-tile' }, box, el('span', { text: board.getTileById(id).name })) };
    });
    const send = async () => {
      const toId = toSelect ? toSelect.value : mates[0].id;
      const cash = Math.max(0, Math.floor(Number(cashInput.value) || 0));
      const tileIds = checks.filter((c) => c.box.checked).map((c) => c.id);
      if (!cash && !tileIds.length) return toast('Add some cash or a property.', { kind: 'bad' });
      const r = await net.emit('action', { type: 'sendToTeammate', toId, give: { cash, tileIds } });
      if (!r.ok) return toast(r.error, { kind: 'bad', important: true });
      return handle.close();
    };
    const handle = openDialog({
      className: 'dialog-send',
      label: 'Send to teammate',
      content: [
        el('h2', { className: 'dialog-title', text: 'Send to a teammate' }),
        toSelect ? el('label', { className: 'send-field' }, el('span', { text: 'Teammate' }), toSelect) : null,
        el('label', { className: 'send-field' }, el('span', { text: 'Cash' }), cashInput),
        checks.length ? el('div', { className: 'send-tiles' }, el('p', { className: 'muted', text: 'Properties (no buildings in the set):' }), ...checks.map((c) => c.node)) : null,
        el('div', { className: 'dialog-actions' },
          el('button', { className: 'btn btn-ghost', type: 'button', text: 'Cancel', on: { click: () => handle.close() } }),
          el('button', { className: 'btn btn-primary', type: 'button', text: 'Send', on: { click: send } })),
      ],
    });
  }

  /** Lobby team control: an A/B toggle for the host, a static chip for everyone else. */
  function teamControl(p, seat, v) {
    if (!v.isHost) {
      return seat.team ? el('span', { className: `team-chip ${TEAM_CHIP[seat.team]}`, title: `Team ${seat.team}` }, seat.team) : null;
    }
    const mk = (team) => el('button', {
      className: `for-${team}`, type: 'button', text: team,
      attrs: { 'aria-label': `Put ${p.name} on team ${team}`, 'aria-pressed': String(seat.team === team) },
      on: { click: () => setTeam(p.id, seat.team === team ? null : team) },
    });
    return el('span', { className: 'team-toggle', attrs: { role: 'group', 'aria-label': `${p.name}'s team` } }, mk('A'), mk('B'));
  }

  /** Pick a difficulty for the bot taking over a player's seat. */
  function openReplace(p) {
    const choose = async (level) => {
      const r = await send('replaceWithBot', { playerId: p.id, difficulty: level });
      if (r.ok) handle.close();
    };
    const handle = openDialog({
      className: 'dialog-replace',
      label: `Replace ${p.name} with a bot`,
      content: [
        el('h2', { className: 'dialog-title', text: `Replace ${p.name} with a bot?` }),
        el('p', { className: 'dialog-body', text: `A computer player takes over ${p.name}'s seat, cash and properties for the rest of the game. ${p.name} won't be able to rejoin this game.` }),
        el('div', { className: 'dialog-actions' },
          el('button', { className: 'btn btn-ghost', type: 'button', text: 'Cancel', on: { click: () => handle.close() } }),
          ...Object.entries(DIFFICULTY_NAMES).map(([level, name]) => el('button', {
            className: `btn ${level === 'medium' ? 'btn-primary' : 'btn-secondary'}`, type: 'button', text: name, on: { click: () => choose(level) },
          }))),
      ],
    });
  }

  store.subscribe(
    (d) => d.state && {
      room: d.state.room,
      ps: d.state.publicState && {
        players: d.state.publicState.players,
        properties: d.state.publicState.properties,
        currentPlayerId: d.state.publicState.currentPlayerId,
      },
      bounties: d.state.publicState && d.state.publicState.bounties,
      me: d.you && d.you.playerId,
      isHost: d.you && d.you.isHost,
    },
    (v) => {
      if (!v) return render(list);
      // In the game, turn order (and bankrupt players stay listed); in the lobby, join order.
      const players = v.ps ? v.ps.players : v.room.players;
      count.textContent = v.ps ? '' : `${v.room.players.length}/${v.room.settings.maxPlayers}`;
      addBox.hidden = !(v.isHost && !v.ps && v.room.status === 'lobby' && v.room.settings.allowBots);
      teamTools.hidden = !(v.isHost && !v.ps && v.room.status === 'lobby' && v.room.settings.teams);
      const full = v.room.players.length >= v.room.settings.maxPlayers;
      addButton.disabled = full;
      addButton.title = full ? 'The room is full' : 'Add a computer player';
      render(list, players.map((p) => row(p, v)));
      // Rivalry read-out at the top of the list, in game.
      const rivalry = v.bounties && v.bounties.rivalry;
      if (rivalry && v.ps) {
        const nm = nameLookup(store.state);
        list.prepend(el('li', { className: 'rivalry', text: `⚔ Rivals: ${nm(rivalry.a)} vs ${nm(rivalry.b)} — ${money(rivalry.total)} in rent` }));
      }
      // Team panel: combined net worth per team, in game.
      renderTeamPanel(v);
      return undefined;
    },
  );

  // --- Change appearance: pick a free colour -------------------------------------
  function openAppearance() {
    const grid = el('div', { className: 'colour-grid', attrs: { role: 'radiogroup', 'aria-label': 'Your colour' } });
    const paint = () => {
      const room = store.state && store.state.room;
      if (!room) return;
      const me = room.players.find((p) => p.id === store.you.playerId);
      render(grid, room.colors.map((colour, i) => {
        const owner = room.players.find((p) => p.color === colour);
        const mine = me && me.color === colour;
        const takenBy = owner && !mine ? owner.name : null;
        return el('button', {
          className: `colour-swatch${mine ? ' is-mine' : ''}`, type: 'button',
          style: { '--swatch': colour, '--token-ink': tokenStyle(colour)['--token-ink'] },
          disabled: Boolean(takenBy),
          title: takenBy ? `${COLOUR_NAMES[i]} (taken by ${takenBy})` : COLOUR_NAMES[i],
          attrs: { role: 'radio', 'aria-checked': String(Boolean(mine)), 'aria-label': takenBy ? `${COLOUR_NAMES[i]}, taken by ${takenBy}` : COLOUR_NAMES[i] },
          on: { click: async () => { const r = await net.emit('pickColor', { color: colour }); if (!r.ok) toast(r.error, { kind: 'bad', important: true }); } },
        }, mine ? el('span', { text: '✓', attrs: { 'aria-hidden': 'true' } }) : null);
      }));
    };
    const unsubscribe = store.subscribe((d) => d.state && d.state.room.players.map((p) => p.color), paint);
    const handle = openDialog({
      className: 'dialog-appearance',
      label: 'Change appearance',
      content: [
        el('h2', { className: 'dialog-title', text: 'Change appearance' }),
        el('p', { className: 'dialog-body', text: 'Pick your token colour. Taken colours are greyed out.' }),
        grid,
        el('div', { className: 'dialog-actions' }, el('button', { className: 'btn btn-primary', type: 'button', text: 'Done', on: { click: () => handle.close() } })),
      ],
      onClose: unsubscribe,
    });
  }
}
