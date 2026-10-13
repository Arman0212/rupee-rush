'use strict';

/**
 * Shared vocabulary for the game engine: action types, turn phases and the
 * reserved party ids used in money events and debts.
 */

const ACTIONS = Object.freeze({
  ROLL: 'roll',
  BUY: 'buy',
  DECLINE: 'decline',
  END_TURN: 'endTurn',
  BUILD: 'build',
  SELL_HOUSE: 'sellHouse',
  MORTGAGE: 'mortgage',
  UNMORTGAGE: 'unmortgage',
  PAY_JAIL_FINE: 'payJailFine',
  USE_JAIL_CARD: 'useJailCard',
  BANKRUPT: 'bankrupt',
  // Accepted but not built yet: dispatch answers { ok: false, error: 'not implemented' }.
  BID: 'bid',
  TRADE: 'trade',
  CHAT: 'chat',
});

const NOT_IMPLEMENTED = Object.freeze(new Set([ACTIONS.BID, ACTIONS.TRADE, ACTIONS.CHAT]));

/** Actions that name a property and therefore carry a `tileId`. */
const TILE_ACTIONS = Object.freeze([ACTIONS.BUILD, ACTIONS.SELL_HOUSE, ACTIONS.MORTGAGE, ACTIONS.UNMORTGAGE]);

const PHASE = Object.freeze({
  LOBBY: 'lobby',
  AWAITING_ROLL: 'awaitingRoll',
  BUY_DECISION: 'buyDecision',
  AUCTION: 'auction', // reserved for a later phase
  AWAITING_END: 'awaitingEnd',
  GAME_OVER: 'gameOver',
});

/**
 * Money parties other than players. In events `from`/`to` and in
 * `debt.creditorId`, null is the bank and 'jackpot' is the Vacation pot.
 * 'jackpot' is therefore not allowed as a player id.
 */
const BANK = null;
const JACKPOT = 'jackpot';

module.exports = { ACTIONS, NOT_IMPLEMENTED, TILE_ACTIONS, PHASE, BANK, JACKPOT };
