'use strict';

/**
 * Plays one game between bots with no server: the engine, a fake clock and
 * the server's auction timer emulated by closing an auction once no bidder
 * wants to act. Used by scripts/tournament.js, scripts/tune.js and the tests.
 *
 * Every bot sees only publicState(), exactly as it would in a real room.
 */

const { Game, PHASE } = require('../game/Game');
const { createRng, randomInt } = require('../game/rng');
const { netWorth } = require('../../shared/board');
const { Bot } = require('./Bot');
const v = require('./valuation');

const MAX_ACTIONS = 100000;

/**
 * @param {object}   opts
 * @param {number}   opts.seed
 * @param {object[]} opts.seats     [{ type: 'easy'|'medium'|'hard'|'random', params? }]
 * @param {object}   [opts.settings]
 * @param {number}   [opts.maxTurns]
 * @param {Function} [opts.onStep]  ({ game, playerId, action, state, legal, bot }) after each bot decision, before dispatch
 * @param {object}   [opts.log]     passed to every bot (it warns about illegal choices)
 * @returns {{ finished, turns, winnerSeat, worth: number[], setsCompleted: boolean[], tally }}
 */
function playBotGame({ seed, seats, settings = {}, maxTurns = 1000, onStep, log }) {
  let clock = 0;
  const game = new Game({ seed, now: () => (clock += 1000), settings });
  const order = createRng((seed ^ 0x5bd1e995) >>> 0);
  const bots = seats.map((seat, i) => new Bot({
    id: `p${i}`, difficulty: seat.type, params: seat.params, seed: (seed * 31 + i * 7919) >>> 0, log,
  }));
  const byId = new Map(bots.map((b) => [b.id, b]));
  bots.forEach((b, i) => {
    const r = game.addPlayer({ id: b.id, name: b.id, team: settings.teams ? (i % 2 === 0 ? 'A' : 'B') : undefined });
    if (!r.ok) throw new Error(r.error);
  });
  game.start();
  const tally = { auctions: 0, auctionsSold: 0, tradesProposed: 0, tradesAccepted: 0, illegal: 0 };
  const setsCompleted = bots.map(() => false);

  const dispatch = (id, action) => {
    const result = game.dispatch(id, action);
    if (!result.ok) {
      tally.illegal++;
      throw new Error(`bot ${id} (${byId.get(id).difficulty}) sent a rejected action ${JSON.stringify(action)}: ${result.error}`);
    }
    for (const e of result.events) {
      if (e.type === 'auctionStarted') tally.auctions++;
      if (e.type === 'auctionClosed' && e.winnerId) tally.auctionsSold++;
      if (e.type === 'tradeProposed') tally.tradesProposed++;
      if (e.type === 'tradeAccepted') tally.tradesAccepted++;
    }
    const state = game.state;
    bots.forEach((b, i) => {
      if (!setsCompleted[i] && v.fullSets(state, b.id).length) setsCompleted[i] = true;
    });
  };

  /** Ask one bot; dispatch and return true if it acted. */
  const ask = (bot, mustAct) => {
    const legal = game.getLegalActions(bot.id);
    if (!legal.length) return false;
    const state = game.publicState();
    const action = bot.act({ state, legalActions: legal, mustAct });
    if (!action) return false;
    if (onStep) onStep({ game, playerId: bot.id, action, state, legal, bot });
    dispatch(bot.id, action);
    return true;
  };

  const live = () => game.state.players.filter((p) => !p.bankrupt).map((p) => byId.get(p.id));
  const shuffled = (xs) => {
    const copy = [...xs];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = randomInt(order, i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  let actions = 0;
  while (game.state.phase !== PHASE.GAME_OVER && game.state.turnNumber <= maxTurns) {
    if (++actions > MAX_ACTIONS) throw new Error(`game ${seed} is stuck`);
    if (game.state.phase === PHASE.AUCTION) {
      // Bidders answer in a random order; when nobody wants to bid, the timer runs out.
      if (!shuffled(live()).some((b) => ask(b, false))) game.closeAuction();
      continue;
    }
    // Others first: debtors raise cash, trade recipients answer.
    const current = byId.get(game.state.currentPlayerId);
    if (shuffled(live()).some((b) => b !== current && ask(b, false))) continue;
    if (!ask(current, true)) throw new Error(`current player ${current.id} has nothing to do in ${game.state.phase}`);
  }

  const state = game.state;
  const finished = state.phase === PHASE.GAME_OVER;
  return {
    finished,
    turns: state.turnNumber,
    winnerSeat: finished ? bots.findIndex((b) => b.id === state.winnerId) : -1,
    worth: bots.map((b) => {
      const p = state.players.find((x) => x.id === b.id);
      return p.bankrupt ? 0 : netWorth(p, state.properties);
    }),
    setsCompleted,
    tally,
  };
}

module.exports = { playBotGame };
