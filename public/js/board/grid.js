// Builds the 40 tiles once, then updates ownership, buildings and mortgages.
//
// The board is an 11×11 CSS grid with corners 1.6× the size of a side tile
// and no gaps, so tile geometry is easy to compute in % of the board (used to
// place tokens). Each tile's content is laid out as if on the bottom edge
// (set band towards the centre) and rotated for the other sides.
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

const SHORT = { 'new-delhi': 'DEL', chandigarh: 'CHD', kochi: 'KOC' };
const shortName = (tile) => SHORT[tile.id] || tile.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();

const GLYPHS = { [TILE.AIRPORT]: '✈', [TILE.SURPRISE]: '?', [TILE.TREASURE]: '✦', [TILE.TAX]: '₹' };
const utilityGlyph = (tile) => (tile.id === 'electricity-board' ? '⚡' : '💧');

function tileContent(tile) {
  const price = tile.price ? el('span', { className: 'tile-price', text: money(tile.price) }) : null;
  // Long single words ("Visakhapatnam") get a slightly smaller face so they don't break mid-word.
  const longWord = tile.name.split(' ').some((w) => w.length > 8);
  const name = el('span', { className: `tile-name${longWord ? ' is-long' : ''}`, text: tile.name });
  switch (tile.type) {
    case TILE.CITY:
      return [
        el('span', { className: 'tile-band', style: { '--band': COLOR_GROUPS[tile.group].color } }, el('span', { className: 'buildings' })),
        name,
        el('span', { className: 'tile-short', text: shortName(tile) }),
        price,
      ];
    case TILE.AIRPORT:
    case TILE.UTILITY:
      return [
        el('span', { className: 'tile-glyph', text: tile.type === TILE.UTILITY ? utilityGlyph(tile) : GLYPHS[tile.type], attrs: { 'aria-hidden': 'true' } }),
        name,
        price,
      ];
    case TILE.TAX:
      return [el('span', { className: 'tile-glyph', text: '₹', attrs: { 'aria-hidden': 'true' } }), name, el('span', { className: 'tile-price', text: `Pay ${money(tile.amount)}` })];
    case TILE.SURPRISE:
    case TILE.TREASURE:
      return [el('span', { className: 'tile-glyph tile-glyph-big', text: GLYPHS[tile.type], attrs: { 'aria-hidden': 'true' } }), name];
    default:
      return [name];
  }
}

function cornerContent(tile) {
  switch (tile.type) {
    case TILE.GO:
      return [
        el('span', { className: 'corner-note', text: 'Collect salary as you pass' }),
        el('span', { className: 'corner-big', text: 'GO' }),
        el('span', { className: 'go-arrow', text: '←', attrs: { 'aria-hidden': 'true' } }),
      ];
    case TILE.JAIL:
      return [
        el('span', { className: 'jail-cell' }, el('span', { className: 'jail-label', text: 'In jail' })),
        el('span', { className: 'visiting', text: 'Just visiting' }),
      ];
    case TILE.VACATION:
      return [
        el('span', { className: 'corner-glyph', text: '☀', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'corner-big corner-mid', text: 'Vacation' }),
        el('span', { className: 'corner-note jackpot-note' }),
      ];
    case TILE.GO_TO_JAIL:
      return [
        el('span', { className: 'corner-glyph', text: '⛓', attrs: { 'aria-hidden': 'true' } }),
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
  const tiles = new Map(); // tileId -> { button, buildings, stamp, last }

  for (const tile of BOARD) {
    const { row, col } = gridPosition(tile.index);
    const side = boardSide(tile.index);
    const inner = el('span', { className: 'tile-inner' }, side === 'corner' ? cornerContent(tile) : tileContent(tile));
    const button = el('button', {
      className: `tile tile-${tile.type} side-${side}`,
      type: 'button',
      dataset: { tileId: tile.id, index: String(tile.index) },
      style: { 'grid-row': String(row), 'grid-column': String(col) },
      attrs: { 'aria-label': tile.name },
      on: { click: () => onSelect(tile.id) },
    }, inner);
    if (isOwnable(tile)) inner.append(el('span', { className: 'stamp', text: 'Mortgaged', attrs: { 'aria-hidden': 'true' } }));
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
      const key = `${prop.ownerId}|${prop.buildings}|${prop.mortgaged}|${owner ? owner.color : ''}`;
      if (key === entry.last) continue;
      entry.last = key;
      button.classList.toggle('owned', Boolean(owner));
      button.classList.toggle('mortgaged', prop.mortgaged);
      if (owner) button.style.setProperty('--owner', owner.color);
      else button.style.removeProperty('--owner');
      if (entry.buildings) renderBuildings(entry.buildings, prop.buildings);
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

