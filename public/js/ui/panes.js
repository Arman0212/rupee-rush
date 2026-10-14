// Room panes: which panel is visible where.
//
//   ≥1200px  left pane (share, chat, log) | board | right pane (players + settings,
//            or players + a My properties / Trades switch). No tab bar.
//   <1200px  board | one panel picked by the tab bar (Chat shows the left pane).
//   <900px   board on top, the same tabs as a bottom bar.
//
// State lives in data attributes on #screen-room (data-mode, data-tab,
// data-subtab) and the CSS does the showing and hiding.
import { $, $$ } from '../dom.js';

const TABS = ['chat', 'players', 'properties', 'trades', 'settings'];
const GAME_ONLY = new Set(['properties', 'trades']);
export const wideQuery = window.matchMedia('(min-width: 1200px)');

export function createPanes({ chat }) {
  const screen = $('#screen-room');
  const tabs = $$('#screen-room .tab');
  const subtabs = $$('#screen-room .subtab');
  let tab = 'players';

  const chatVisible = () => wideQuery.matches || tab === 'chat';
  const visible = (node) => getComputedStyle(node).display !== 'none';

  function paintChatBadge(n) {
    for (const badge of $$('.chat-badge')) {
      badge.hidden = !n;
      badge.textContent = n ? String(n) : '';
    }
  }

  /** Show a panel. On wide screens properties/trades are the right pane's switch instead. */
  function select(name, { focus = false } = {}) {
    if (!TABS.includes(name)) name = 'players';
    if (GAME_ONLY.has(name)) {
      selectSub(name);
      if (screen.dataset.mode !== 'game') name = 'players';
    }
    tab = name;
    screen.dataset.tab = name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus && visible(t)) t.focus();
    }
    if (chatVisible()) chat.markSeen();
  }

  function selectSub(name, { focus = false } = {}) {
    screen.dataset.subtab = name;
    for (const t of subtabs) {
      const on = t.dataset.subtab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
  }

  /** WAI-ARIA tabs: click to select, arrow keys to move between visible tabs. */
  function wire(list, pick, key) {
    for (const t of list) {
      t.addEventListener('click', () => pick(t.dataset[key]));
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const shown = list.filter(visible);
        const at = shown.indexOf(t);
        const next = shown[(at + (e.key === 'ArrowRight' ? 1 : -1) + shown.length) % shown.length];
        pick(next.dataset[key], { focus: true });
        e.preventDefault();
      });
    }
  }
  wire(tabs, select, 'tab');
  wire(subtabs, selectSub, 'subtab');

  chat.onUnseen((n) => {
    if (n && chatVisible()) chat.markSeen();
    else paintChatBadge(n);
  });
  wideQuery.addEventListener('change', () => select(tab));
  select('players');
  selectSub('properties');

  return {
    select,
    /** Lobby or game: game-only tabs disappear in the lobby. */
    setMode(mode) {
      screen.dataset.mode = mode;
      select(mode === 'lobby' && GAME_ONLY.has(tab) ? 'players' : tab);
    },
    get tab() { return tab; },
  };
}
