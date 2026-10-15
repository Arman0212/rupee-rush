// "My properties": what you own, grouped by set, with quick build / sell /
// mortgage / unmortgage buttons built only from your legal actions.
import { board } from '../shared.js';
import { el, render, $ } from '../dom.js';
import { groupName, buildingWord, shortActionLabel } from '../format.js';
import { selectLegal } from '../store.js';

const { BOARD, COLOR_GROUPS, GROUP_MEMBERS, isOwnable } = board;

export function createProperties({ store, act, onSelectTile }) {
  const panel = $('#panel-cities');
  store.subscribe(
    (d) => d.state && d.state.publicState && d.you && {
      props: d.state.publicState.properties,
      legal: selectLegal(d).filter((a) => a.tileId),
      me: d.you.playerId,
      busy: d.ui.busy,
    },
    (v) => {
      if (!v) return render(panel);
      const publicState = store.state.publicState;
      const groups = Object.keys(GROUP_MEMBERS).filter((g) => GROUP_MEMBERS[g].some((i) => isOwnable(BOARD[i]) && v.props[BOARD[i].id].ownerId === v.me));
      if (!groups.length) {
        return render(panel, el('div', { className: 'empty-state' },
          el('p', { className: 'empty-title', text: 'No properties yet' }),
          el('p', { className: 'muted', text: 'Land on an unowned city, airport or utility to buy it. Own a whole set to start building.' })));
      }
      return render(panel, groups.map((group) => {
        const members = GROUP_MEMBERS[group].map((i) => BOARD[i]);
        const mine = members.filter((t) => v.props[t.id].ownerId === v.me);
        const colour = COLOR_GROUPS[group] ? COLOR_GROUPS[group].color : 'var(--ink-faint)';
        return el('section', { className: 'city-group', style: { '--band': colour } },
          el('h3', { className: 'city-group-title' },
            el('span', { text: groupName(group) }),
            el('span', { className: 'muted', text: `${mine.length} of ${members.length}${mine.length === members.length ? ' · full set' : ''}` })),
          el('ul', { className: 'city-rows' }, mine.map((tile) => {
            const prop = v.props[tile.id];
            const status = prop.landmark ? '🏛️ Landmark' : prop.mortgaged ? 'Mortgaged' : prop.buildings ? buildingWord(prop.buildings) : 'No buildings';
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
}
