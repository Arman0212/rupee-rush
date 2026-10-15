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
  // Landmarks mode
  BUILD_LANDMARK: 'buildLandmark',
  SELL_LANDMARK: 'sellLandmark',
  // Team mode: a fee-free gift of cash and/or tiles to a teammate
  SEND_TO_TEAMMATE: 'sendToTeammate',
  PAY_JAIL_FINE: 'payJailFine',
  USE_JAIL_CARD: 'useJailCard',
  BANKRUPT: 'bankrupt',
  // Auctions (only while phase is 'auction'; closing is server-only, via game.closeAuction()).
  BID: 'bid',
  PASS: 'pass',
  // Trades
  PROPOSE_TRADE: 'proposeTrade',
  ACCEPT_TRADE: 'acceptTrade',
  DECLINE_TRADE: 'declineTrade',
  CANCEL_TRADE: 'cancelTrade',
  COUNTER_TRADE: 'counterTrade',
  // Chat goes through the socket layer, never the engine.
  CHAT: 'chat',
});

const NOT_IMPLEMENTED = Object.freeze(new Set([ACTIONS.CHAT]));

/** The only actions allowed while an auction is running. */
const AUCTION_ACTIONS = Object.freeze(new Set([ACTIONS.BID, ACTIONS.PASS]));

/** Actions that name a property and therefore carry a `tileId`. */
const TILE_ACTIONS = Object.freeze([
  ACTIONS.BUILD, ACTIONS.SELL_HOUSE, ACTIONS.MORTGAGE, ACTIONS.UNMORTGAGE,
  ACTIONS.BUILD_LANDMARK, ACTIONS.SELL_LANDMARK,
]);

const PHASE = Object.freeze({
  LOBBY: 'lobby',
  AWAITING_ROLL: 'awaitingRoll',
  BUY_DECISION: 'buyDecision',
  AUCTION: 'auction', // a declined tile is being auctioned
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

module.exports = { ACTIONS, NOT_IMPLEMENTED, AUCTION_ACTIONS, TILE_ACTIONS, PHASE, BANK, JACKPOT };
