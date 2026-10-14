'use strict';

/**
 * What things are worth to a bot, computed only from publicState (what every
 * client can see): never the deck order, the seed or the RNG state.
 *
 * All the numbers come from the bot's params object (see Bot.js), so the
 * tuner can adjust them.
 */

const board = require('../../shared/board');

const { BOARD, BOARD_SIZE, TILE, AIRPORT_RENT, UTILITY_MULTIPLIER, groupMembers, getTileById, isOwnable } = board;

const CITY_GROUPS = [...new Set(BOARD.filter((t) => t.type === TILE.CITY).map((t) => t.group))];

/** tileIds of a group. */
const groupTiles = (group) => groupMembers(group).map((i) => BOARD[i].id);

/** How many tiles of `group` each player owns: Map(playerId -> count). */
function groupOwners(state, group) {
  const owners = new Map();
  for (const id of groupTiles(group)) {
    const owner = state.properties[id].ownerId;
    if (owner) owners.set(owner, (owners.get(owner) || 0) + 1);
  }
  return owners;
}

const ownsAll = (state, playerId, group) => groupTiles(group).every((id) => state.properties[id].ownerId === playerId);
const setHasBuildings = (state, group) => groupTiles(group).some((id) => state.properties[id].buildings > 0);

/** Would `playerId` own the whole set if they also had `extraIds` (and lost `lostIds`)? Returns completed groups. */
function setsCompletedBy(state, playerId, extraIds, lostIds = []) {
  const done = [];
  const groups = new Set(extraIds.map((id) => getTileById(id).group).filter((g) => CITY_GROUPS.includes(g)));
  for (const group of groups) {
    if (ownsAll(state, playerId, group)) continue;
    const complete = groupTiles(group).every((id) => !lostIds.includes(id)
      && (state.properties[id].ownerId === playerId || extraIds.includes(id)));
    if (complete) done.push(group);
  }
  return done;
}

/** Full colour sets a player owns. */
const fullSets = (state, playerId) => CITY_GROUPS.filter((g) => ownsAll(state, playerId, g));

/** Rent an owned tile charges right now (mirrors the engine's rules; dice total for utilities). */
function rentFor(state, tileId, diceTotal = 7) {
  const tile = getTileById(tileId);
  const prop = state.properties[tileId];
  if (!prop || !prop.ownerId || prop.mortgaged) return 0;
  const owner = state.players.find((p) => p.id === prop.ownerId);
  if (owner && owner.inJail && !state.settings.collectRentInJail) return 0;
  if (tile.type === TILE.CITY) {
    if (prop.buildings > 0) return tile.rent[prop.buildings];
    const double = state.settings.doubleRentOnFullSet && ownsAll(state, prop.ownerId, tile.group);
    return tile.rent[0] * (double ? 2 : 1);
  }
  const count = groupOwners(state, tile.group).get(prop.ownerId) || 0;
  if (tile.type === TILE.AIRPORT) return AIRPORT_RENT[count - 1] || 0;
  if (tile.type === TILE.UTILITY) return diceTotal * (UTILITY_MULTIPLIER[count] || 0);
  return 0;
}

/** The highest rent `me` could face on the next roll: opponents' tiles 2-12 squares ahead. */
function nextRollThreat(state, me) {
  const player = state.players.find((p) => p.id === me);
  let worst = 0;
  for (let d = 2; d <= 12; d++) {
    const tile = BOARD[(player.position + d) % BOARD_SIZE];
    if (!isOwnable(tile)) continue;
    const owner = state.properties[tile.id].ownerId;
    if (!owner || owner === me) continue;
    worst = Math.max(worst, rentFor(state, tile.id, d));
  }
  return worst;
}

/** The biggest rent any opponent's built-up tile charges (how dangerous the board is). */
function maxOpponentRent(state, me) {
  let worst = 0;
  for (const tile of BOARD) {
    if (!isOwnable(tile)) continue;
    const owner = state.properties[tile.id].ownerId;
    if (owner && owner !== me) worst = Math.max(worst, rentFor(state, tile.id, 7));
  }
  return worst;
}

/** Cash a bot keeps back: max(minReserve, k × the worst rent on the next roll). */
function reserveFor(state, me, params) {
  return Math.max(params.minReserve, params.reserveK * nextRollThreat(state, me));
}

/**
 * What a tile is worth to `playerId`, whether they're buying it or keeping it:
 * the price times multipliers for set progress, completing a set, blocking an
 * opponent's set, rent potential and how early in the game it is.
 */
function tileValue(state, tileId, playerId, params) {
  const tile = getTileById(tileId);
  if (!isOwnable(tile)) return 0;
  const owners = groupOwners(state, tile.group);
  const current = state.properties[tileId].ownerId;
  // Count the rest of the set, as if this tile were not yet anyone's.
  if (current) owners.set(current, owners.get(current) - 1);
  const size = groupMembers(tile.group).length;
  const mine = owners.get(playerId) || 0;
  const rivals = [...owners.entries()].filter(([id, n]) => id !== playerId && n > 0);

  let m = 1;
  if (tile.type === TILE.CITY) {
    m += params.setProgress * (mine / size);
    if (mine === size - 1) m += params.completeSetBonus;
    if (rivals.some(([, n]) => n === size - 1)) m += params.blockBonus;
    if (rivals.length >= 2 || (rivals.length === 1 && mine > 0)) m -= params.deadSetPenalty; // nobody can easily finish it
    m += params.rentWeight * (tile.rent[3] / tile.price / 4);
  } else if (tile.type === TILE.AIRPORT) {
    m += params.airportBonus * mine;
  } else {
    m -= params.utilityPenalty;
  }
  const early = Math.max(0, 1 - state.turnNumber / params.earlyTurns);
  m *= 1 + params.earlyBonus * early;
  let value = tile.price * Math.max(0.2, m);
  if (state.properties[tileId].mortgaged) value -= tile.mortgageValue * 1.1; // costs that much to make it earn again
  return Math.max(0, value);
}

/** Total value of what someone hands over in a trade side, from `viewer`'s point of view. */
function sideValue(state, side, viewer, params, { receiving }) {
  let value = side.cash + side.jailCards.length * params.jailCardValue;
  for (const id of side.tileIds) {
    value += tileValue(state, id, viewer, params);
    if (receiving && state.properties[id].mortgaged) value -= Math.round(getTileById(id).mortgageValue * 0.1); // transfer fee
  }
  return value;
}

module.exports = {
  CITY_GROUPS,
  groupTiles,
  groupOwners,
  ownsAll,
  setHasBuildings,
  setsCompletedBy,
  fullSets,
  rentFor,
  nextRollThreat,
  maxOpponentRent,
  reserveFor,
  tileValue,
  sideValue,
};
