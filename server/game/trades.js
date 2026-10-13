'use strict';

/**
 * Trade offers: reading untrusted input and checking an offer against the
 * game state. Pure functions shared by the engine, the simulator and tests.
 *
 * A trade is { id, fromId, toId, give, get, status, createdAt } where `give`
 * is what the proposer hands over and `get` is what they receive. Each side is
 * { tileIds: string[], cash: number, jailCards: string[] (card ids) }.
 */

const { BOARD, groupMembers, getTileById } = require('../../shared/board');
const { MORTGAGE, formatRupees } = require('../../shared/rules');

const MAX_TILES = BOARD.length;
const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStringList = (xs, max) => Array.isArray(xs) && xs.length <= max && xs.every((x) => typeof x === 'string' && x.length <= 64);

/** Read one side of an offer from untrusted input. Returns { side } or { error }. */
function normalizeSide(raw) {
  if (raw === undefined || raw === null) return { side: { tileIds: [], cash: 0, jailCards: [] } };
  if (!isPlainObject(raw)) return { error: 'invalid trade offer' };
  const { tileIds = [], cash = 0, jailCards = [] } = raw;
  if (!isStringList(tileIds, MAX_TILES)) return { error: 'invalid tiles in trade' };
  if (new Set(tileIds).size !== tileIds.length) return { error: 'a tile appears twice in the trade' };
  if (!Number.isInteger(cash) || cash < 0 || cash > 1e7) return { error: 'trade cash must be a whole, non-negative number of rupees' };
  if (!isStringList(jailCards, 4) || new Set(jailCards).size !== jailCards.length) return { error: 'invalid jail-free cards in trade' };
  return { side: { tileIds: [...tileIds], cash, jailCards: [...jailCards] } };
}

const isEmptySide = (side) => side.tileIds.length === 0 && side.cash === 0 && side.jailCards.length === 0;

const setHasBuildings = (state, group) => groupMembers(group).some((i) => state.properties[BOARD[i].id].buildings > 0);

/** Why `owner` can't put this tile into a trade, or null. Used by the UI for tooltips too. */
function tileProblem(state, ownerId, tileId) {
  if (typeof tileId !== 'string' || !Object.hasOwn(state.properties, tileId)) return 'unknown property';
  const tile = getTileById(tileId);
  if (state.properties[tileId].ownerId !== ownerId) return `${tile.name} has changed hands`;
  if (setHasBuildings(state, tile.group)) return `sell the buildings in ${tile.name}'s set first`;
  return null;
}

function sideProblem(state, owner, side) {
  for (const tileId of side.tileIds) {
    const problem = tileProblem(state, owner.id, tileId);
    if (problem) return problem;
  }
  if (side.cash > 0 && side.cash > owner.cash) return `${owner.name} doesn't have ${formatRupees(side.cash)}`;
  for (const cardId of side.jailCards) {
    if (!owner.jailFreeCards.some((c) => c.cardId === cardId)) return `${owner.name} no longer holds that jail-free card`;
  }
  return null;
}

/** Why this trade can't happen in `state` right now, or null if it can. */
function tradeProblem(state, { fromId, toId, give, get }) {
  const from = state.players.find((p) => p.id === fromId);
  const to = state.players.find((p) => p.id === toId);
  if (!from || !to || from === to) return 'pick another player to trade with';
  if (from.bankrupt) return `${from.name} is out of the game`;
  if (to.bankrupt) return `${to.name} is out of the game`;
  if (isEmptySide(give) && isEmptySide(get)) return 'a trade must include something';
  return sideProblem(state, from, give) || sideProblem(state, to, get);
}

/** 10% of the mortgage value, charged to whoever receives a mortgaged tile. */
const transferFee = (tile) => Math.round(tile.mortgageValue * MORTGAGE.transferFeeRatio);

/** Total fee for receiving these tiles (only mortgaged ones cost anything). */
function mortgageFees(state, tileIds) {
  return tileIds.reduce((total, id) => {
    const tile = getTileById(id);
    return total + (state.properties[id].mortgaged ? transferFee(tile) : 0);
  }, 0);
}

module.exports = { normalizeSide, isEmptySide, tileProblem, tradeProblem, transferFee, mortgageFees, setHasBuildings };
