// Tile popup: everything about one tile, plus the build / sell / mortgage /
// unmortgage buttons that are legal for you right now. Live while open.
import { board, rules } from '../shared.js';
import { el, render } from '../dom.js';
import { money, groupName, buildingWord, actionLabel } from '../format.js';
import { openDialog } from './modal.js';
import { selectMe, selectLegal } from '../store.js';

const { getTileById, TILE, COLOR_GROUPS, AIRPORT_RENT, UTILITY_MULTIPLIER, groupMembers, BOARD, isOwnable } = board;
const { JAIL, unmortgageCost } = rules;

const ownsAll = (properties, ownerId, group) => groupMembers(group).every((i) => properties[BOARD[i].id].ownerId === ownerId);
const countOwned = (properties, ownerId, group) => groupMembers(group).filter((i) => properties[BOARD[i].id].ownerId === ownerId).length;

/** [label, amount, isCurrent] rows for the rent table. */
function rentRows(tile, publicState) {
  const prop = publicState.properties[tile.id];
  const owner = prop.ownerId;
  const settings = publicState.settings;
  if (tile.type === TILE.CITY) {
    const fullSet = owner && ownsAll(publicState.properties, owner, tile.group);
    const rows = [['Rent', money(tile.rent[0]), owner && prop.buildings === 0 && !(fullSet && settings.doubleRentOnFullSet)]];
    if (settings.doubleRentOnFullSet) rows.push(['With the whole set', money(tile.rent[0] * 2), owner && prop.buildings === 0 && fullSet]);
    for (let b = 1; b <= 5; b++) rows.push([b === 5 ? 'With a hotel' : `With ${buildingWord(b)}`, money(tile.rent[b]), prop.buildings === b]);
    return rows;
  }
  if (tile.type === TILE.AIRPORT) {
    const n = owner ? countOwned(publicState.properties, owner, 'airport') : 0;
    return AIRPORT_RENT.map((r, i) => [i === 0 ? '1 airport owned' : `${i + 1} airports owned`, money(r), n === i + 1]);
  }
  const n = owner ? countOwned(publicState.properties, owner, 'utility') : 0;
  return [
    ['1 utility owned', `${UTILITY_MULTIPLIER[1]} × dice`, n === 1],
    ['Both utilities owned', `${UTILITY_MULTIPLIER[2]} × dice`, n === 2],
  ];
}

function infoText(tile, publicState) {
  const s = publicState.settings;
  switch (tile.type) {
    case TILE.GO: return `Collect ${money(s.goSalary)} every time you pass or land on GO.`;
    case TILE.JAIL: return `Sent here? Roll doubles, pay the ${money(JAIL.fine)} fine or use a jail-free card to get out. After three failed rolls you pay and move. Otherwise you're just visiting.`;
    case TILE.VACATION:
      return s.vacationJackpot
        ? `Taxes and card fines pile up here. Land on Vacation to win the jackpot, currently ${money(publicState.jackpot)}.`
        : 'A free rest stop. Nothing happens here.';
    case TILE.GO_TO_JAIL: return 'Go directly to jail. You do not pass GO and do not collect salary.';
    case TILE.TAX: return `Pay ${money(tile.amount)} ${s.vacationJackpot ? 'into the Vacation jackpot' : 'to the bank'}.`;
    case TILE.SURPRISE: return 'Draw a Surprise card: anything from a windfall to a trip to jail.';
    case TILE.TREASURE: return 'Draw a Treasure card: mostly money, sometimes a bill.';
    default: return '';
  }
}

export function createTilePopup({ store, act, onProposeTrade }) {
  let open = null; // { tileId, handle, unsubscribe }

  function body(tile, d) {
    const publicState = d.state && d.state.publicState;
    if (!publicState) return [el('p', { text: tile.name })];
    const parts = [];
    if (!isOwnable(tile)) {
      parts.push(el('p', { className: 'popup-info', text: infoText(tile, publicState) }));
      return parts;
    }
    const prop = publicState.properties[tile.id];
    const owner = publicState.players.find((p) => p.id === prop.ownerId);
    parts.push(el('p', { className: 'popup-owner' },
      owner ? el('span', { className: 'swatch', style: { '--swatch': owner.color } }) : null,
      owner ? `Owned by ${owner.name}` : `For sale: ${money(tile.price)}`,
      prop.buildings ? ` · ${buildingWord(prop.buildings)}` : '',
      prop.mortgaged ? el('span', { className: 'badge badge-bad', text: 'Mortgaged' }) : null));

    const table = el('table', { className: 'rent-table' },
      el('caption', { className: 'visually-hidden', text: `Rent for ${tile.name}` }),
      el('tbody', {}, rentRows(tile, publicState).map(([label, amount, current]) =>
        el('tr', { className: current ? 'current' : '', attrs: { 'aria-current': current ? 'true' : null } },
          el('th', { scope: 'row', text: label }),
          el('td', {}, amount, current ? el('span', { className: 'visually-hidden', text: ' (current)' }) : null)))));
    parts.push(table);

    const facts = [['Price', money(tile.price)]];
    if (tile.type === TILE.CITY) facts.push(['House cost', money(tile.houseCost)]);
    facts.push(['Mortgage value', money(tile.mortgageValue)], ['Unmortgage cost', money(unmortgageCost(tile.price))]);
    parts.push(el('dl', { className: 'facts' }, facts.map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: v })))));

    const me = selectMe(d);
    const legal = selectLegal(d).filter((a) => a.tileId === tile.id);
    // Someone else's tile: offer to trade for it.
    const tradeable = owner && me && owner.id !== me.id && !owner.bankrupt && !me.bankrupt && me.cash >= 0
      && !['auction', 'gameOver'].includes(publicState.phase);
    if (tradeable) {
      parts.push(el('button', {
        className: 'btn btn-secondary', type: 'button', text: `Propose trade for ${tile.name}`, dataset: { action: 'tradeFor' },
        on: { click: () => { close(); onProposeTrade(tile.id); } },
      }));
    }
    if (legal.length) {
      parts.push(el('div', { className: 'popup-actions' }, legal.map((a) => el('button', {
        className: `btn ${a.type === 'build' ? 'btn-primary' : 'btn-secondary'}`,
        type: 'button',
        text: actionLabel(a, { publicState, me }),
        disabled: d.ui.busy,
        dataset: { action: a.type, tileId: a.tileId },
        on: { click: () => act(a) },
      }))));
    }
    return parts;
  }

  function show(tileId) {
    if (open) open.handle.close();
    const tile = getTileById(tileId);
    const country = tile.type === TILE.CITY && COLOR_GROUPS[tile.group] && COLOR_GROUPS[tile.group].country;
    const titleText = country ? `${tile.name}, ${country.name}` : tile.name;
    const groupText = country ? `${country.flag} ${COLOR_GROUPS[tile.group].name}` : (tile.group ? groupName(tile.group) : '');
    const groupVar = tile.group === 'lightBlue' ? 'light-blue' : tile.group === 'darkBlue' ? 'dark-blue' : tile.group;
    const band = tile.group ? `var(--set-${groupVar}, ${COLOR_GROUPS[tile.group].color})` : 'var(--primary)';
    const content = el('div', { className: 'popup-body' });
    const header = el('header', { className: 'popup-head', style: { '--band': band } },
      el('p', { className: 'popup-group', text: groupText }),
      el('h2', { className: 'popup-title', text: titleText }));
    const closeBtn = el('button', { className: 'icon-btn popup-close', type: 'button', text: '×', attrs: { 'aria-label': 'Close' } });
    const handle = openDialog({
      className: 'dialog-tile',
      label: titleText,
      content: [closeBtn, header, content],
      onClose: () => {
        if (open && open.handle === handle) {
          open.unsubscribe();
          open = null;
        }
      },
    });
    closeBtn.addEventListener('click', () => handle.close());
    const unsubscribe = store.subscribe(
      (d) => ({ ps: d.state && d.state.publicState, legal: selectLegal(d), busy: d.ui.busy }),
      (_v, d) => render(content, body(tile, d)),
    );
    open = { tileId, handle, unsubscribe };
  }

  function close() {
    if (open) open.handle.close();
  }

  return { show, close };
}
