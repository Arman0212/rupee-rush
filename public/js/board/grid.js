// Builds the 40 tiles once, then updates ownership, buildings and mortgages.
//
// The board is an 11×11 CSS grid with corners 1.6× the size of a side tile
// and no gaps, so tile geometry is easy to compute in % of the board (used to
// place tokens). GO is top-left and play runs clockwise.
//
// Every side tile is a dark card laid out for the top row: owner bar and
// price pill on the outer edge, the name (or a big icon) in the middle, and
// houses, a thin set-colour strip and the flag circle on the inner edge, the
// flag overlapping the board centre slightly. board.css mirrors that for the
// bottom row (text stays horizontal) and turns the card a quarter turn for
// the left and right columns, so their text runs along the tile.
import { board } from '../shared.js';
import { el } from '../dom.js';
import { money, groupName, buildingWord } from '../format.js';
import { renderBuildings } from './buildings.js';

const { BOARD, TILE, COLOR_GROUPS, gridPosition, boardSide, isOwnable } = board;

/** Side tile = 1 unit, corner = 1.6 units, 9 + 2 × 1.6 = 12.2 units across. */
const CORNER_RATIO = 1.6;
const UNIT = 100 / (9 + 2 * CORNER_RATIO);
const SIZES = [CORNER_RATIO * UNIT, ...Array(9).fill(UNIT), CORNER_RATIO * UNIT];
const STARTS = SIZES.map((_, i) => SIZES.slice(0, i).reduce((a, b) => a + b, 0));

/** A tile's box in % of the board: { x, y, w, h }. */
export function cellRect(index) {
  const { row, col } = gridPosition(index);
  return { x: STARTS[col - 1], y: STARTS[row - 1], w: SIZES[col - 1], h: SIZES[row - 1] };
}
export const UNIT_PERCENT = UNIT;

/** Three-letter codes for small boards; two-word names get a familiar code instead of their first letters. */
const SHORT = { 'New York': 'NYC', 'Tel Aviv': 'TLV' };
const shortName = (tile) => SHORT[tile.name] || tile.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();


/** Name length class: longer words get a smaller face so they never break mid-word or overflow. */
function nameSize(name) {
  const longest = Math.max(...name.split(' ').map((w) => w.length));
  if (longest > 9) return ' is-longer';
  if (longest > 7 || name.length > 12) return ' is-long';
  return '';
}

/** Big original icons for the special tiles, instead of text-heavy layouts. */
function specialIcon(tile) {
  switch (tile.type) {
    case TILE.AIRPORT: return '✈️';
    case TILE.UTILITY: return tile.id === 'electric-company' ? '⚡' : '💧';
    case TILE.TAX: return /luxury/i.test(tile.name) ? '💎' : '💰';
    case TILE.SURPRISE: return '❓';
    case TILE.TREASURE: return '🎁';
    default: return '';
  }
}

/** The pieces of a side tile; their order doesn't matter, board.css positions them. */
function tileContent(tile) {
  const name = el('span', { className: `tile-name${nameSize(tile.name)}`, text: tile.name });
  const pill = (text) => el('span', { className: 'tile-price', text });
  const ownerBar = el('span', { className: 'owner-bar', attrs: { 'aria-hidden': 'true' } });
  if (tile.type === TILE.CITY) {
    const group = COLOR_GROUPS[tile.group];
    const country = group && group.country;
    const groupVar = tile.group === 'lightBlue' ? 'light-blue' : tile.group === 'darkBlue' ? 'dark-blue' : tile.group;
    const setColour = `var(--set-${groupVar}, ${group.color})`;
    return [
      ownerBar,
      pill(money(tile.price)),
      el('span', { className: 'tile-body' }, name, el('span', { className: 'tile-short', text: shortName(tile), attrs: { 'aria-hidden': 'true' } })),
      el('span', { className: 'buildings' }),
      el('span', { className: 'set-strip', style: { '--set': setColour }, attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'tile-flag', style: { '--set': setColour }, attrs: { 'aria-hidden': 'true' } },
        el('span', { className: 'flag-glyph', text: country && country.flag ? country.flag : '' })),
    ];
  }
  const price = tile.type === TILE.TAX ? `Pay ${money(tile.amount)}` : tile.price ? money(tile.price) : null;
  return [
    board.isOwnable(tile) ? ownerBar : null,
    price ? pill(price) : null,
    el('span', { className: 'tile-body' },
      el('span', { className: 'tile-icon', text: specialIcon(tile), attrs: { 'aria-hidden': 'true' } }),
      name),
  ].filter(Boolean);
}

function cornerContent(tile) {
  switch (tile.type) {
    case TILE.GO:
      return [
        el('span', { className: 'go-row' },
          el('span', { className: 'corner-glyph', text: '🏁', attrs: { 'aria-hidden': 'true' } }),
          el('span', { className: 'corner-big', text: 'GO' }),
          el('span', { className: 'go-arrow', text: '→', attrs: { 'aria-hidden': 'true' } })), // play runs left to right along the top
        el('span', { className: 'corner-note', text: 'Collect salary as you pass' }),
      ];
    case TILE.JAIL:
      return [
        el('span', { className: 'jail-cell' },
          el('span', { className: 'jail-icon', text: '🔒', attrs: { 'aria-hidden': 'true' } }),
          el('span', { className: 'jail-label', text: 'In jail' })),
        el('span', { className: 'visiting', text: 'Just visiting' }),
      ];
    case TILE.VACATION:
      return [
        el('span', { className: 'corner-glyph', text: '🏖️', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'corner-big corner-mid', text: 'Vacation' }),
        el('span', { className: 'corner-note jackpot-note' }),
      ];
    case TILE.GO_TO_JAIL:
      return [
        el('span', { className: 'corner-glyph', text: '🚓', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'corner-big corner-mid', text: 'Go to jail' }),
      ];
    default:
      return [];
  }
}

/**
 * Build the tiles into `boardNode`. onSelect(tileId) is called on click / Enter.
 * Returns { update(publicState, playersById, settings), tileButton(id) }.
 */
export function buildGrid(boardNode, { onSelect }) {
  const tiles = new Map(); // tileId -> { button, tile, buildings, last }

  for (const tile of BOARD) {
    const { row, col } = gridPosition(tile.index);
    const side = boardSide(tile.index);
    const inner = el('span', { className: 'tile-inner' }, side === 'corner' ? cornerContent(tile) : tileContent(tile));
    const button = el('button', {
      className: `tile tile-${tile.type} tile-${tile.id} side-${side}`,
      type: 'button',
      dataset: { tileId: tile.id, index: String(tile.index) },
      style: { 'grid-row': String(row), 'grid-column': String(col) },
      attrs: { 'aria-label': tile.name },
      on: { click: () => onSelect(tile.id) },
    }, inner);
    boardNode.append(button);
    tiles.set(tile.id, { button, tile, buildings: inner.querySelector('.buildings'), last: '' });
  }

  function describe(tile, prop, owner) {
    const bits = [tile.name];
    if (tile.group) bits.push(groupName(tile.group));
    if (!isOwnable(tile)) return bits.join(', ');
    if (!owner) bits.push(`for sale at ${money(tile.price)}`);
    else bits.push(`owned by ${owner.name}`);
    if (prop.buildings) bits.push(buildingWord(prop.buildings));
    if (prop.mortgaged) bits.push('mortgaged');
    return bits.join(', ');
  }

  /** Repaint only the tiles whose owner / buildings / mortgage changed. */
  function update(publicState, playersById, settings) {
    for (const [id, entry] of tiles) {
      const { tile, button } = entry;
      if (!isOwnable(tile)) continue;
      const prop = publicState.properties[id];
      const owner = prop.ownerId ? playersById.get(prop.ownerId) : null;
      const key = `${prop.ownerId}|${prop.buildings}|${prop.mortgaged}|${prop.landmark}|${owner ? owner.color : ''}`;
      if (key === entry.last) continue;
      entry.last = key;
      button.classList.toggle('owned', Boolean(owner));
      button.classList.toggle('mortgaged', prop.mortgaged);
      if (owner) button.style.setProperty('--owner', owner.color);
      else button.style.removeProperty('--owner');
      if (entry.buildings) renderBuildings(entry.buildings, prop.buildings);
      // Landmark marker (gold monument) on the tile.
      let mark = button.querySelector('.tile-landmark');
      if (prop.landmark && !mark) { mark = el('span', { className: 'tile-landmark', text: '🏛️', attrs: { 'aria-hidden': 'true' } }); button.querySelector('.tile-inner').append(mark); }
      else if (!prop.landmark && mark) mark.remove();
      button.setAttribute('aria-label', describe(tile, prop, owner));
    }
    // Corner notes that depend on settings / the jackpot.
    const vacation = tiles.get('vacation').button.querySelector('.jackpot-note');
    vacation.textContent = settings.vacationJackpot ? `Jackpot ${money(publicState.jackpot)}` : '';
    const go = tiles.get('go').button.querySelector('.corner-note');
    go.textContent = `Collect ${money(settings.goSalary)} as you pass`;
  }

  return { update, tileButton: (id) => tiles.get(id).button };
}

