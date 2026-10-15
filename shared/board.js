/* UMD: CommonJS in Node (require), window.RR.board in the browser, no build step. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.RR = root.RR || {}).board = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * Board definition: eight countries, two to three cities each.
 *
 * The board is a fixed array of 40 tiles, indexed 0..39 clockwise from GO.
 * Every tile has a stable string `id` (used by cards and saved state) and an
 * `index` (its position on the board). This module is pure data plus small
 * lookup helpers; it holds no game state.
 */

const BOARD_SIZE = 40;

const TILE = Object.freeze({
  GO: 'go',
  CITY: 'city',
  AIRPORT: 'airport',
  UTILITY: 'utility',
  TAX: 'tax',
  SURPRISE: 'surprise',
  TREASURE: 'treasure',
  JAIL: 'jail',
  VACATION: 'vacation',
  GO_TO_JAIL: 'goToJail',
});

/**
 * Colour sets, cheapest first. houseCost applies to every city in the set.
 * Each set is one country. `color` is a data fallback; the client paints sets
 * from the --set-<key> custom properties in css/tokens.css.
 */
const country = (name, flag) => Object.freeze({ name, flag });
/** `landmark` is the monument a fully built set can crown itself with in landmarks mode. */
const COLOR_GROUPS = Object.freeze({
  brown:     Object.freeze({ name: 'Brown',      color: '#8d5a3b', houseCost: 50,  country: country('Brazil', '🇧🇷'),         landmark: 'Christ the Redeemer' }),
  lightBlue: Object.freeze({ name: 'Light blue', color: '#7cc6e8', houseCost: 50,  country: country('Israel', '🇮🇱'),         landmark: 'The Western Wall' }),
  pink:      Object.freeze({ name: 'Pink',       color: '#d9529b', houseCost: 100, country: country('Italy', '🇮🇹'),          landmark: 'The Colosseum' }),
  orange:    Object.freeze({ name: 'Orange',     color: '#f28c28', houseCost: 100, country: country('Germany', '🇩🇪'),         landmark: 'Brandenburg Gate' }),
  red:       Object.freeze({ name: 'Red',        color: '#d93a3a', houseCost: 150, country: country('China', '🇨🇳'),          landmark: 'The Great Wall' }),
  yellow:    Object.freeze({ name: 'Yellow',     color: '#f2c94c', houseCost: 150, country: country('France', '🇫🇷'),         landmark: 'The Eiffel Tower' }),
  green:     Object.freeze({ name: 'Green',      color: '#2e9e5b', houseCost: 200, country: country('United Kingdom', '🇬🇧'), landmark: 'Big Ben' }),
  darkBlue:  Object.freeze({ name: 'Dark blue',  color: '#2f4aa8', houseCost: 200, country: country('United States', '🇺🇸'),   landmark: 'Statue of Liberty' }),
});

/** Net-worth value of a landmark, in multiples of the set's house cost (matches rules.LANDMARK.costMultiplier). */
const LANDMARK_WORTH = 3;

/** Rent by number of airports owned by the same player (1..4). */
const AIRPORT_RENT = Object.freeze([25, 50, 100, 200]);
const AIRPORT_PRICE = 200;

/** Utility rent = dice total × multiplier, keyed by utilities owned (1 or 2). */
const UTILITY_MULTIPLIER = Object.freeze({ 1: 4, 2: 10 });
const UTILITY_PRICE = 150;

/** Houses 1-4, then 5 means a hotel. Rent tables therefore have 6 entries. */
const MAX_BUILDINGS = 5;

// ---------------------------------------------------------------------------
// Tile factories
// ---------------------------------------------------------------------------

/**
 * rent = [base, 1 house, 2 houses, 3 houses, 4 houses, hotel]
 * Base rent is doubled by the engine when the owner holds the full set
 * and the city has no buildings.
 */
function city(id, name, group, price, rent) {
  return {
    type: TILE.CITY,
    id,
    name,
    group,
    price,
    houseCost: COLOR_GROUPS[group].houseCost,
    rent: Object.freeze(rent),
  };
}

function airport(id, name) {
  return { type: TILE.AIRPORT, id, name, group: 'airport', price: AIRPORT_PRICE };
}

function utility(id, name) {
  return { type: TILE.UTILITY, id, name, group: 'utility', price: UTILITY_PRICE };
}

function tax(id, name, amount) {
  return { type: TILE.TAX, id, name, amount };
}

function special(type, id, name) {
  return { type, id, name };
}

// ---------------------------------------------------------------------------
// The board, in order from GO (index 0) clockwise
// ---------------------------------------------------------------------------

const RAW_TILES = [
  /*  0 */ special(TILE.GO, 'go', 'GO'),
  /*  1 */ city('salvador', 'Salvador', 'brown', 60, [2, 10, 30, 90, 160, 250]),
  /*  2 */ special(TILE.TREASURE, 'treasure-1', 'Treasure'),
  /*  3 */ city('rio', 'Rio', 'brown', 60, [4, 20, 60, 180, 320, 450]),
  /*  4 */ tax('income-tax', 'Income Tax', 200),
  /*  5 */ airport('tlv-airport', 'TLV Airport'),
  /*  6 */ city('tel-aviv', 'Tel Aviv', 'lightBlue', 100, [6, 30, 90, 270, 400, 550]),
  /*  7 */ special(TILE.SURPRISE, 'surprise-1', 'Surprise'),
  /*  8 */ city('haifa', 'Haifa', 'lightBlue', 100, [6, 30, 90, 270, 400, 550]),
  /*  9 */ city('jerusalem', 'Jerusalem', 'lightBlue', 120, [8, 40, 100, 300, 450, 600]),
  /* 10 */ special(TILE.JAIL, 'jail', 'Jail'),
  /* 11 */ city('venice', 'Venice', 'pink', 140, [10, 50, 150, 450, 625, 750]),
  /* 12 */ utility('electric-company', 'Electric Company'),
  /* 13 */ city('milan', 'Milan', 'pink', 140, [10, 50, 150, 450, 625, 750]),
  /* 14 */ city('rome', 'Rome', 'pink', 160, [12, 60, 180, 500, 700, 900]),
  /* 15 */ airport('muc-airport', 'MUC Airport'),
  /* 16 */ city('frankfurt', 'Frankfurt', 'orange', 180, [14, 70, 200, 550, 750, 950]),
  /* 17 */ special(TILE.TREASURE, 'treasure-2', 'Treasure'),
  /* 18 */ city('munich', 'Munich', 'orange', 180, [14, 70, 200, 550, 750, 950]),
  /* 19 */ city('berlin', 'Berlin', 'orange', 200, [16, 80, 220, 600, 800, 1000]),
  /* 20 */ special(TILE.VACATION, 'vacation', 'Vacation'),
  /* 21 */ city('shenzhen', 'Shenzhen', 'red', 220, [18, 90, 250, 700, 875, 1050]),
  /* 22 */ special(TILE.SURPRISE, 'surprise-2', 'Surprise'),
  /* 23 */ city('beijing', 'Beijing', 'red', 220, [18, 90, 250, 700, 875, 1050]),
  /* 24 */ city('shanghai', 'Shanghai', 'red', 240, [20, 100, 300, 750, 925, 1100]),
  /* 25 */ airport('cdg-airport', 'CDG Airport'),
  /* 26 */ city('lyon', 'Lyon', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
  /* 27 */ city('toulouse', 'Toulouse', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
  /* 28 */ utility('water-company', 'Water Company'),
  /* 29 */ city('paris', 'Paris', 'yellow', 280, [24, 120, 360, 850, 1025, 1200]),
  /* 30 */ special(TILE.GO_TO_JAIL, 'go-to-jail', 'Go to Jail'),
  /* 31 */ city('liverpool', 'Liverpool', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
  /* 32 */ city('manchester', 'Manchester', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
  /* 33 */ special(TILE.TREASURE, 'treasure-3', 'Treasure'),
  /* 34 */ city('london', 'London', 'green', 320, [28, 150, 450, 1000, 1200, 1400]),
  /* 35 */ airport('jfk-airport', 'JFK Airport'),
  /* 36 */ special(TILE.SURPRISE, 'surprise-3', 'Surprise'),
  /* 37 */ city('california', 'California', 'darkBlue', 350, [35, 175, 500, 1100, 1300, 1500]),
  /* 38 */ tax('luxury-tax', 'Luxury Tax', 100),
  /* 39 */ city('new-york', 'New York', 'darkBlue', 400, [50, 200, 600, 1400, 1700, 2000]),
];

/** Final, frozen board with index and mortgage value attached. */
const BOARD = Object.freeze(
  RAW_TILES.map((tile, index) =>
    Object.freeze({
      ...tile,
      index,
      ...(tile.price ? { mortgageValue: tile.price / 2 } : {}),
    })
  )
);

// ---------------------------------------------------------------------------
// Lookups (computed once)
// ---------------------------------------------------------------------------

const TILE_BY_ID = Object.freeze(Object.fromEntries(BOARD.map((t) => [t.id, t])));

/** group key -> array of tile indexes, for cities, airports and utilities. */
const GROUP_MEMBERS = Object.freeze(
  BOARD.reduce((acc, t) => {
    if (t.group) (acc[t.group] ||= []).push(t.index);
    return acc;
  }, {})
);

const JAIL_INDEX = TILE_BY_ID['jail'].index;
const VACATION_INDEX = TILE_BY_ID['vacation'].index;
const GO_TO_JAIL_INDEX = TILE_BY_ID['go-to-jail'].index;

const OWNABLE_TYPES = new Set([TILE.CITY, TILE.AIRPORT, TILE.UTILITY]);

function getTile(index) {
  return BOARD[((index % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE];
}

function getTileById(id) {
  return TILE_BY_ID[id];
}

function isOwnable(tile) {
  return OWNABLE_TYPES.has(tile.type);
}

/** { name, flag } of the country a city belongs to, or null for other tiles. */
function countryOf(tile) {
  const group = tile && COLOR_GROUPS[tile.group];
  return group ? group.country : null;
}

function groupMembers(group) {
  return GROUP_MEMBERS[group] || [];
}

/** Index of the first tile of `type` strictly ahead of `from`, moving clockwise. */
function nearestAhead(from, type) {
  for (let step = 1; step <= BOARD_SIZE; step++) {
    const idx = (from + step) % BOARD_SIZE;
    if (BOARD[idx].type === type) return idx;
  }
  return -1;
}

/**
 * CSS grid placement (1-based) for an 11×11 board with GO in the top-left
 * corner. Play runs left to right along the top, down the right side, right
 * to left along the bottom and up the left side (Jail top-right, Vacation
 * bottom-right, Go to Jail bottom-left).
 */
function gridPosition(index) {
  if (index <= 10) return { row: 1, col: 1 + index };
  if (index <= 20) return { row: 1 + (index - 10), col: 11 };
  if (index <= 30) return { row: 11, col: 11 - (index - 20) };
  return { row: 11 - (index - 30), col: 1 };
}

/**
 * Net worth for standings and stats: cash (never below zero) plus what the
 * player's tiles and buildings cost. A mortgaged tile counts at its price
 * minus the mortgage.
 */
function netWorth(player, properties) {
  let worth = Math.max(0, player.cash);
  for (const tile of BOARD) {
    const prop = properties[tile.id];
    if (!prop || prop.ownerId !== player.id) continue;
    worth += prop.mortgaged ? tile.price - tile.mortgageValue : tile.price;
    worth += prop.buildings * (tile.houseCost || 0);
    if (prop.landmark) worth += LANDMARK_WORTH * (tile.houseCost || 0);
  }
  return worth;
}

/**
 * Which edge a tile sits on. The UI uses it to put each tile's colour band on
 * the edge facing the centre and to lay its content out for a tall (top and
 * bottom rows) or wide (left and right columns) cell.
 */
function boardSide(index) {
  if (index % 10 === 0) return 'corner';
  if (index < 10) return 'top';
  if (index < 20) return 'right';
  if (index < 30) return 'bottom';
  return 'left';
}

return {
  BOARD_SIZE,
  TILE,
  COLOR_GROUPS,
  AIRPORT_RENT,
  AIRPORT_PRICE,
  UTILITY_MULTIPLIER,
  UTILITY_PRICE,
  MAX_BUILDINGS,
  BOARD,
  TILE_BY_ID,
  GROUP_MEMBERS,
  JAIL_INDEX,
  VACATION_INDEX,
  GO_TO_JAIL_INDEX,
  getTile,
  getTileById,
  isOwnable,
  groupMembers,
  countryOf,
  nearestAhead,
  gridPosition,
  boardSide,
  netWorth,
};
});
