/* UMD: CommonJS in Node (require), window.RR.rules in the browser, no build step. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.RR = root.RR || {}).rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * Game-wide constants and the default room settings.
 *
 * DEFAULT_SETTINGS are the values a host can change in the lobby;
 * SETTING_LIMITS bounds them so the server can validate host input.
 * Everything else here is fixed by the rules.
 */

/** The game's name and one-line pitch. Every place that shows the name reads it from here. */
const GAME_NAME = 'Monopoly';
const GAME_TAGLINE = 'Buy, build, bid and trade your way around the world.';

/** The lobby's single mode choice. Maps to the feature flags below. */
const MODES = Object.freeze(['classic', 'chaos']);

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'classic', // 'classic' | 'chaos'; the lobby sets the feature flags from this
  startingCash: 1500,
  goSalary: 200,
  maxPlayers: 6,
  vacationJackpot: false, // taxes and card fines pool on Vacation; landing there collects it
  doubleRentOnFullSet: true,
  auctions: true, // declining a purchase starts an auction
  collectRentInJail: true, // owners still collect rent while jailed
  auctionSeconds: 10, // timer resets on every bid
  turnTimerSeconds: 0, // 0 = no turn timer
  isPrivate: false, // hidden from the public room list
  allowBots: true, // the host may add computer players
  botChat: true, // computer players say a line now and then
  // Optional game modes, all off by default.
  worldEvents: false, // a world event sweeps the board every few rounds
  worldEventEvery: 3, // full rounds between world events
  chaosEvents: false, // include the wilder chaos-only world events
  bounties: false, // rivalries and bounties on dangerous players
  bountyRentThreshold: 500, // a single rent this large places a bounty
  landmarks: false, // a landmark can crown a fully built set
  teams: false, // two teams; teammates share sets and don't pay each other rent
  startingCities: 0, // cities dealt free to each player at the start (Chaos opening)
});

const SETTING_LIMITS = Object.freeze({
  startingCash: { min: 500, max: 5000, step: 100 },
  goSalary: { min: 0, max: 500, step: 50 },
  maxPlayers: { min: 2, max: 8, step: 1 },
  auctionSeconds: { min: 5, max: 30, step: 1 },
  turnTimerSeconds: { min: 0, max: 300, step: 15 },
  worldEventEvery: { min: 1, max: 10, step: 1 },
  bountyRentThreshold: { min: 200, max: 2000, step: 100 },
  startingCities: { min: 0, max: 4, step: 1 },
});

const JAIL = Object.freeze({
  fine: 50,
  maxTurns: 3, // after the 3rd failed doubles attempt, pay the fine and move
});

const DICE = Object.freeze({
  count: 2,
  sides: 6,
  maxDoublesBeforeJail: 3,
});

const BUILDING = Object.freeze({
  sellBackRatio: 0.5,
});

/** Landmarks mode: the single monument a fully built set may crown itself with. */
const LANDMARK = Object.freeze({
  costMultiplier: 3, // cost = 3 × the set's house cost
  rentMultiplier: 1.5, // landmark rent = 1.5 × hotel rent…
  rentRounding: 5, // …rounded to the nearest ₹5
  setBonus: 1.1, // +10% rent on the other cities in the set
  sellBackRatio: 0.5, // selling returns half the cost and restores the hotel
});

/** Rivalries and bounties mode. */
const BOUNTY = Object.freeze({
  base: 200, // first trigger
  perExtra: 100, // each further trigger
  max: 1000,
  thirdSetTrigger: 3, // completing this many colour sets places a bounty
});

const MORTGAGE = Object.freeze({
  ratio: 0.5,
  unmortgageMultiplier: 1.1, // pay back mortgage value + 10%
  transferFeeRatio: 0.1, // receiving a mortgaged tile in a trade costs 10% of its mortgage value
});

const TRADE = Object.freeze({
  maxOpenPerPlayer: 3,
});

const AUCTION = Object.freeze({
  minIncrement: 1,
  quickBids: [2, 10, 100],
});

const ROOM = Object.freeze({
  codeLength: 6,
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // no 0/O/1/I to avoid confusion
  nameMaxLength: 16,
  chatMaxLength: 200,
});

const PLAYER_COLORS = Object.freeze([
  '#e63946', '#f4a261', '#e9c46a', '#2a9d8f',
  '#457b9d', '#9b5de5', '#f15bb5', '#00bbf9',
]);

/** Round to a whole rupee, since all money in the game is integer. */
function rupees(x) {
  return Math.round(x);
}

function unmortgageCost(price) {
  // Integer maths: 100 * 1.1 is 110.00000000000001 in floating point.
  const mortgage = Math.round(price * MORTGAGE.ratio);
  return Math.ceil((mortgage * Math.round(MORTGAGE.unmortgageMultiplier * 100)) / 100);
}

function formatRupees(amount) {
  const sign = amount < 0 ? '-' : '';
  return `${sign}₹${Math.abs(amount).toLocaleString('en-IN')}`;
}

/** Clamp and validate a partial settings object from the host. */
function sanitizeSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in input)) continue;
    const def = DEFAULT_SETTINGS[key];
    const val = input[key];
    if (typeof def === 'boolean') {
      if (typeof val === 'boolean') out[key] = val;
    } else if (typeof def === 'number') {
      const n = Number(val);
      const lim = SETTING_LIMITS[key];
      if (!Number.isFinite(n) || !lim) continue;
      const stepped = Math.round(n / lim.step) * lim.step;
      out[key] = Math.min(lim.max, Math.max(lim.min, stepped));
    } else if (key === 'mode') {
      if (MODES.includes(val)) out[key] = val;
    }
  }
  return out;
}

/**
 * The feature flags for a mode. Classic turns the four mode features off;
 * Chaos turns them on with the chaos tuning. `teams` is decided by the lobby
 * from the player count (4 or 6 → teams; otherwise free-for-all), so it is not
 * set here. The engine always reads the individual flags, never `mode`, so
 * tests and scripts can switch features on one at a time.
 */
function modeSettings(mode) {
  if (mode === 'chaos') {
    return {
      worldEvents: true, worldEventEvery: 2, chaosEvents: true,
      bounties: true, bountyRentThreshold: 300,
      landmarks: true, auctions: true, auctionSeconds: 8,
      vacationJackpot: true, startingCash: 2000, startingCities: 2,
    };
  }
  // Classic restores the standard game.
  return {
    worldEvents: false, worldEventEvery: 3, chaosEvents: false,
    bounties: false, bountyRentThreshold: 500, landmarks: false, teams: false,
    startingCities: 0, startingCash: 1500, auctions: true, auctionSeconds: 10, vacationJackpot: false,
  };
}

return {
  GAME_NAME,
  MODES,
  GAME_TAGLINE,
  DEFAULT_SETTINGS,
  SETTING_LIMITS,
  JAIL,
  DICE,
  BUILDING,
  LANDMARK,
  BOUNTY,
  MORTGAGE,
  TRADE,
  AUCTION,
  ROOM,
  PLAYER_COLORS,
  rupees,
  unmortgageCost,
  formatRupees,
  sanitizeSettings,
  modeSettings,
};
});
