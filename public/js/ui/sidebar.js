// Sidebar: tabs (bottom tab bar on small screens), Players and My cities.
import { board } from '../shared.js';
import { el, render, $, $$ } from '../dom.js';
import { money, groupName, initial, buildingWord, shortActionLabel, nameLookup, tokenStyle } from '../format.js';
import { toast } from './toast.js';
import { selectLegal } from '../store.js';

const { BOARD, COLOR_GROUPS, GROUP_MEMBERS, isOwnable } = board;
const AWAY_GRACE_MS = 60_000;
const mobileQuery = window.matchMedia('(max-width: 899px)');

/** Net worth for standings: cash plus what property and buildings are worth. */
export function netWorth(player, properties) {
  let worth = Math.max(0, player.cash);
  for (const tile of BOARD) {
    const prop = properties[tile.id];
    if (!prop || prop.ownerId !== player.id) continue;
    worth += prop.mortgaged ? 0 : tile.mortgageValue;
    if (prop.buildings) worth += (prop.buildings * tile.houseCost) / 2;
  }
  return worth;
}

export function createSidebar({ store, net, act, onSelectTile, chat }) {
  const tabs = $$('.sidebar .tab');
  const panels = $$('.sidebar .panel');
  let current = null;

  // --- Tabs -------------------------------------------------------------------
  const visibleTab = (name) => {
    const tab = tabs.find((t) => t.dataset.tab === name);
    return tab && getComputedStyle(tab).display !== 'none';
  };

  function selectTab(name, { focus = false } = {}) {
    if (!visibleTab(name)) name = mobileQuery.matches ? 'actions' : 'players';
    current = name;
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    for (const panel of panels) panel.hidden = panel.id !== `panel-${name}`;
    if (name === 'chat') chat.markSeen();
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    // Arrow keys move between tabs (WAI-ARIA tabs pattern).
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const visible = tabs.filter((t) => getComputedStyle(t).display !== 'none');
      const at = visible.indexOf(tab);
      const next = visible[(at + (e.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
      selectTab(next.dataset.tab, { focus: true });
      e.preventDefault();
    });
  });
  mobileQuery.addEventListener('change', () => selectTab(mobileQuery.matches ? 'actions' : 'players'));
  selectTab(mobileQuery.matches ? 'actions' : 'players');

  chat.onUnseen((n) => {
    const badge = $('#chat-badge');
    const show = n > 0 && current !== 'chat';
    badge.hidden = !show;
    badge.textContent = show ? String(n) : '';
  });

  // --- Players ------------------------------------------------------------------
  const playersPanel = $('#panel-players');
  store.subscribe(
    (d) => d.state && d.state.publicState && {
      players: d.state.publicState.players,
      seats: d.state.room.players,
      hostId: d.state.room.hostId,
      current: d.state.publicState.currentPlayerId,
      status: d.state.room.status,
      me: d.you && d.you.playerId,
      isHost: d.you && d.you.isHost,
      cities: d.state.publicState.properties,
    },
    (v) => {
      if (!v) return;
      const name = nameLookup(store.state);
      render(playersPanel, el('ul', { className: 'player-cards' }, v.players.map((p) => {
        const seat = v.seats.find((s) => s.id === p.id);
        const offline = seat ? !seat.connected : true;
        const owned = Object.values(v.cities).filter((c) => c.ownerId === p.id).length;
        const badges = [];
        if (p.id === v.hostId) badges.push(['👑 Host', 'host']);
        if (p.id === v.me) badges.push(['You', 'you']);
        if (p.inJail) badges.push(['In jail', 'warn']);
        if (p.bankrupt) badges.push(['Bankrupt', 'bad']);
        else if (offline) badges.push([seat ? 'Offline' : 'Left', 'muted']);
        if (p.jailFreeCards.length) badges.push([`Jail-free ×${p.jailFreeCards.length}`, 'good']);
        const kickable = v.isHost && seat && p.id !== v.me && !seat.connected && Date.now() - seat.disconnectedAt >= AWAY_GRACE_MS;
        return el('li', {
          className: `player-card${p.id === v.current ? ' is-current' : ''}${p.bankrupt ? ' is-bankrupt' : ''}${offline ? ' is-offline' : ''}`,
          attrs: { 'aria-current': p.id === v.current ? 'true' : null },
        },
        el('span', { className: 'token-disc', text: initial(p.name), style: tokenStyle(p.color), attrs: { 'aria-hidden': 'true' } }),
        el('div', { className: 'player-main' },
          el('p', { className: 'player-name' }, el('span', { text: p.name }), p.id === v.current ? el('span', { className: 'turn-tag', text: 'Turn' }) : null),
          el('p', { className: 'badges' }, badges.map(([text, kind]) => el('span', { className: `badge badge-${kind}`, text }))),
          el('p', { className: 'player-sub muted', text: `${owned} ${owned === 1 ? 'property' : 'properties'}${p.cash < 0 ? ` · owes ${money(p.debt.amount)} to ${name(p.debt.creditorId)}` : ''}` })),
        el('p', { className: `player-cash${p.cash < 0 ? ' negative' : ''}`, text: money(p.cash) }),
        kickable ? el('button', {
          className: 'btn btn-ghost btn-sm', type: 'button', text: 'Kick',
          attrs: { 'aria-label': `Remove ${p.name} from the game` },
          on: { click: async () => { const r = await net.emit('kick', { playerId: p.id }); if (!r.ok) toast(r.error, { kind: 'bad' }); } },
        }) : null);
      })));
    },
  );

  // --- My cities ------------------------------------------------------------------
  const citiesPanel = $('#panel-cities');
  store.subscribe(
    (d) => d.state && d.state.publicState && d.you && {
      props: d.state.publicState.properties,
      legal: selectLegal(d).filter((a) => a.tileId),
      me: d.you.playerId,
      busy: d.ui.busy,
    },
    (v) => {
      if (!v) return;
      const publicState = store.state.publicState;
      const groups = Object.keys(GROUP_MEMBERS).filter((g) => GROUP_MEMBERS[g].some((i) => isOwnable(BOARD[i]) && v.props[BOARD[i].id].ownerId === v.me));
      if (!groups.length) {
        render(citiesPanel, el('div', { className: 'empty-state' },
          el('p', { className: 'empty-title', text: 'No cities yet' }),
          el('p', { className: 'muted', text: 'Land on an unowned city, airport or utility to buy it. Complete a colour set to start building.' })));
        return;
      }
      render(citiesPanel, groups.map((group) => {
        const members = GROUP_MEMBERS[group].map((i) => BOARD[i]);
        const mine = members.filter((t) => v.props[t.id].ownerId === v.me);
        const colour = COLOR_GROUPS[group] ? COLOR_GROUPS[group].color : 'var(--ink-faint)';
        return el('section', { className: 'city-group', style: { '--band': colour } },
          el('h3', { className: 'city-group-title' },
            el('span', { text: groupName(group) }),
            el('span', { className: 'muted', text: `${mine.length} of ${members.length}${mine.length === members.length ? ' · full set' : ''}` })),
          el('ul', { className: 'city-rows' }, mine.map((tile) => {
            const prop = v.props[tile.id];
            const status = prop.mortgaged ? 'Mortgaged' : prop.buildings ? buildingWord(prop.buildings) : 'No buildings';
            const actions = v.legal.filter((a) => a.tileId === tile.id);
            return el('li', { className: `city-row${prop.mortgaged ? ' is-mortgaged' : ''}` },
              el('button', {
                className: 'link-btn city-name', type: 'button', text: tile.name,
                attrs: { 'aria-label': `${tile.name} details` },
                on: { click: () => onSelectTile(tile.id) },
              }),
              el('span', { className: 'city-status muted', text: status }),
              el('span', { className: 'city-actions' }, actions.map((a) => el('button', {
                className: 'btn btn-chip', type: 'button',
                text: shortActionLabel(a, { publicState }),
                disabled: v.busy,
                dataset: { action: a.type, tileId: a.tileId },
                on: { click: () => act(a) },
              }))));
          })));
      }));
    },
  );

  return { selectTab, get tab() { return current; } };
}
