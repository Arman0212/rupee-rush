'use strict';

/**
 * Sanity checks for the board, card and rules data.
 * Run with `npm run validate`. Exits non-zero on any failure.
 */

const board = require('../shared/board');
const { DECKS } = require('../shared/cards');
const rules = require('../shared/rules');

const { BOARD, TILE, COLOR_GROUPS, BOARD_SIZE } = board;
const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };

const countType = (type) => BOARD.filter((t) => t.type === type).length;

// --- Shape -----------------------------------------------------------------
check(BOARD.length === BOARD_SIZE, `board has ${BOARD.length} tiles, expected ${BOARD_SIZE}`);
BOARD.forEach((t, i) => check(t.index === i, `${t.id} has index ${t.index}, expected ${i}`));
check(new Set(BOARD.map((t) => t.id)).size === BOARD.length, 'tile ids are not unique');

// --- Tile counts -----------------------------------------------------------
const expected = {
  [TILE.GO]: 1, [TILE.CITY]: 22, [TILE.AIRPORT]: 4, [TILE.UTILITY]: 2,
  [TILE.TAX]: 2, [TILE.SURPRISE]: 3, [TILE.TREASURE]: 3,
  [TILE.JAIL]: 1, [TILE.VACATION]: 1, [TILE.GO_TO_JAIL]: 1,
};
for (const [type, n] of Object.entries(expected)) {
  check(countType(type) === n, `expected ${n} ${type} tiles, found ${countType(type)}`);
}

// --- Corners ---------------------------------------------------------------
check(BOARD[0].type === TILE.GO, 'tile 0 must be GO');
check(BOARD[10].type === TILE.JAIL, 'tile 10 must be Jail');
check(BOARD[20].type === TILE.VACATION, 'tile 20 must be Vacation');
check(BOARD[30].type === TILE.GO_TO_JAIL, 'tile 30 must be Go to Jail');

// --- Colour sets -----------------------------------------------------------
const groupKeys = Object.keys(COLOR_GROUPS);
check(groupKeys.length === 8, `expected 8 colour sets, found ${groupKeys.length}`);
for (const g of groupKeys) {
  const members = board.groupMembers(g);
  const size = members.length;
  const edge = g === 'brown' || g === 'darkBlue';
  check(size === (edge ? 2 : 3), `set ${g} has ${size} cities, expected ${edge ? 2 : 3}`);
}

let prevMaxPrice = 0;
for (const g of groupKeys) {
  const cities = board.groupMembers(g).map((i) => BOARD[i]);
  const prices = cities.map((c) => c.price);
  check(Math.min(...prices) >= prevMaxPrice, `set ${g} is cheaper than the set before it`);
  prevMaxPrice = Math.max(...prices);
}

for (const t of BOARD.filter((t) => t.type === TILE.CITY)) {
  check(COLOR_GROUPS[t.group], `${t.id} has unknown group ${t.group}`);
  check(Number.isInteger(t.price) && t.price > 0, `${t.id} has invalid price`);
  check(t.houseCost === COLOR_GROUPS[t.group].houseCost, `${t.id} house cost mismatch`);
  check(Array.isArray(t.rent) && t.rent.length === board.MAX_BUILDINGS + 1, `${t.id} rent table must have 6 steps`);
  check(t.rent.every((r, i) => i === 0 || r > t.rent[i - 1]), `${t.id} rent must strictly increase`);
  check(t.rent.every(Number.isInteger), `${t.id} rent must be whole rupees`);
  check(t.mortgageValue === t.price / 2, `${t.id} mortgage value must be half the price`);
  check(Number.isInteger(t.mortgageValue), `${t.id} mortgage value is fractional`);
}

// --- Airports and utilities -------------------------------------------------
check(board.groupMembers('airport').length === 4, 'need 4 airports');
check(board.groupMembers('utility').length === 2, 'need 2 utilities');
check(board.AIRPORT_RENT.length === 4, 'airport rent table must have 4 entries');

// --- Grid layout: every tile on the 11×11 rim, no collisions ----------------
const cells = new Set();
for (const t of BOARD) {
  const { row, col } = board.gridPosition(t.index);
  const onRim = row === 1 || row === 11 || col === 1 || col === 11;
  check(onRim && row >= 1 && row <= 11 && col >= 1 && col <= 11, `${t.id} grid cell off the rim`);
  cells.add(`${row},${col}`);
}
check(cells.size === BOARD_SIZE, 'grid positions collide');

// --- Cards -----------------------------------------------------------------
const KINDS = new Set(['collect', 'pay', 'collectFromEach', 'payEach', 'moveTo', 'moveBy', 'nearest', 'goToJail', 'jailFree', 'repairs']);
for (const [deckName, deck] of Object.entries(DECKS)) {
  check(deck.length >= 10, `${deckName} deck is too small`);
  check(new Set(deck.map((c) => c.id)).size === deck.length, `${deckName} card ids not unique`);
  for (const c of deck) {
    const e = c.effect;
    check(KINDS.has(e.kind), `${c.id} has unknown effect ${e.kind}`);
    check(typeof c.text === 'string' && c.text.length > 0, `${c.id} missing text`);
    if (e.kind === 'moveTo') check(board.getTileById(e.tileId), `${c.id} targets unknown tile ${e.tileId}`);
    if (e.kind === 'nearest') check(board.nearestAhead(0, e.tileType) !== -1, `${c.id} targets missing type ${e.tileType}`);
    if ('amount' in e) check(Number.isInteger(e.amount) && e.amount > 0, `${c.id} has invalid amount`);
  }
  check(deck.filter((c) => c.effect.kind === 'jailFree').length === 1, `${deckName} needs exactly one jail-free card`);
}

// --- Rules -----------------------------------------------------------------
check(rules.DEFAULT_SETTINGS.startingCash === 1500, 'default starting cash should be ₹1500');
check(rules.DEFAULT_SETTINGS.goSalary === 200, 'default GO salary should be ₹200');
check(rules.unmortgageCost(200) === 110, 'unmortgage cost for a ₹200 property should be ₹110');
const s = rules.sanitizeSettings({ startingCash: 99999, maxPlayers: 'x', auctions: 'yes', goSalary: 260 });
check(s.startingCash === 5000 && s.maxPlayers === 6 && s.auctions === true && s.goSalary === 250, 'sanitizeSettings misbehaves');

// --- Report ----------------------------------------------------------------
const realErrors = errors.filter(Boolean);
if (realErrors.length) {
  console.error(`✗ ${realErrors.length} problem(s):`);
  realErrors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}

const cityValue = BOARD.filter((t) => t.price).reduce((a, t) => a + t.price, 0);
console.log('✓ Board, cards and rules look good');
console.log(`  ${BOARD.length} tiles, ${countType(TILE.CITY)} cities in ${groupKeys.length} sets, total property value ${rules.formatRupees(cityValue)}`);
console.log(`  ${DECKS.surprise.length} Surprise and ${DECKS.treasure.length} Treasure cards`);
