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

const DEFAULT_SETTINGS = Object.freeze({
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
});

const SETTING_LIMITS = Object.freeze({
  startingCash: { min: 500, max: 5000, step: 100 },
  goSalary: { min: 0, max: 500, step: 50 },
  maxPlayers: { min: 2, max: 8, step: 1 },
  auctionSeconds: { min: 5, max: 30, step: 1 },
  turnTimerSeconds: { min: 0, max: 300, step: 15 },
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
    }
  }
  return out;
}

return {
  DEFAULT_SETTINGS,
  SETTING_LIMITS,
  JAIL,
  DICE,
  BUILDING,
  MORTGAGE,
  TRADE,
  AUCTION,
  ROOM,
  PLAYER_COLORS,
  rupees,
  unmortgageCost,
  formatRupees,
  sanitizeSettings,
};
});
