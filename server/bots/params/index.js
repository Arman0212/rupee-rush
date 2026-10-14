'use strict';

/**
 * Strategy parameters per difficulty. Every number the bots use lives here,
 * named, so it can be read, argued about and tuned.
 *
 * easy:   mostly random, with a mild lean towards buying.
 * medium: the heuristic strategy with hand-picked values.
 * hard:   the same strategy with values found by scripts/tune.js, stored in
 *         hard.json (falls back to medium for any key the file lacks).
 */

const fs = require('node:fs');
const path = require('node:path');

const HARD_FILE = path.join(__dirname, 'hard.json');

const MEDIUM = Object.freeze({
  // Cash reserve: max(minReserve, reserveK × the worst rent on the next roll).
  minReserve: 150,
  reserveK: 1,
  completeReserveRatio: 0.2, // reserve kept when the purchase/bid completes a set (× minReserve)

  // Tile value = price × multiplier.
  setProgress: 0.6, // × share of the set already owned
  completeSetBonus: 1.2, // the tile would complete my set
  blockBonus: 0.5, // the tile would complete an opponent's set
  deadSetPenalty: 0.25, // the set is split between players
  rentWeight: 0.3, // × (rent with 3 houses ÷ price ÷ 4)
  airportBonus: 0.25, // per airport already owned
  utilityPenalty: 0.2,
  earlyBonus: 0.3, // extra value at the start, fading out by earlyTurns
  earlyTurns: 60,
  jailCardValue: 40,

  // Buying and auctions.
  buyThreshold: 0.9, // buy when value ≥ price × this and the reserve survives
  bidFactor: 0.9, // bid up to value × this…
  bidCompleteBoost: 1.6, // …× this when it completes my set
  bidBlockBoost: 1.25, // …× this when it would complete an opponent's set
  bidJumpChance: 0.35, // chance of bidding a little over the minimum
  bidMaxJump: 10,
  mortgageToComplete: 1, // mortgage spare tiles to afford a set-completing city (0 = never)

  // Building.
  thirdHouseBonus: 0.5, // the third house is the sweet spot
  hotelFactor: 0.8,
  unmortgageSlack: 2, // unmortgage tiles outside sets only with this × reserve to spare
  setKeepFactor: 3, // tiles in my full sets are mortgaged last

  // Jail: leave early while there's land to buy, stay late when the board is dangerous.
  jailLeaveUnowned: 0.3, // share of ownable tiles still unowned
  jailDangerRent: 400, // stay in when any opponent tile charges this much

  // Trades.
  acceptMargin: 20, // accept when value gained - value given > this
  tradeSetBonus: 150, // a full set is worth this much on top of its tiles…
  setRentValue: 0.3, // …plus this × the set's total rent with 3 houses
  setGiftPremium: 1.0, // a set handed to an opponent counts (1 + this) × its worth against the trade…
  mutualSetWeight: 0.5, // …or this × its worth when we complete a set in the same trade
  proposeTrades: 1,
  proposeEveryTurns: 8, // game turns between new proposals
  humanCooldownTurns: 20, // and between proposals to the same human
  retryAskTurns: 30, // before repeating an offer for the same tiles
  tradeTtlTurns: 6, // cancel our own proposal after this many game turns
  maxMissingForTrade: 2, // ask for at most this many tiles of a set at once
  offerPremium: 0.15, // offer this much over what they'd value the tiles at

  // easy only.
  easyBuyChance: 0.7,
  easyBuildChance: 0.4,
  easyBidMin: 0.3,
  easyBidSpread: 0.8,
  easyAcceptMin: 0.8,
  easyAcceptSpread: 0.6,
});

const EASY = Object.freeze({ ...MEDIUM, proposeTrades: 0, mortgageToComplete: 0, minReserve: 50 });

function loadHard() {
  try {
    return Object.freeze({ ...MEDIUM, ...JSON.parse(fs.readFileSync(HARD_FILE, 'utf8')).params });
  } catch {
    return MEDIUM;
  }
}

const HARD = loadHard();


function forDifficulty(difficulty) {
  if (difficulty === 'easy') return EASY;
  if (difficulty === 'hard') return HARD;
  return MEDIUM;
}

module.exports = { EASY, MEDIUM, HARD, HARD_FILE, forDifficulty, loadHard };
