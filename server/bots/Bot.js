'use strict';

/**
 * Computer players.
 *
 *   const bot = new Bot({ id, difficulty: 'medium', seed });
 *   const action = bot.decide({ state, me, legalActions, rng });
 *
 * decide() looks only at publicState() (what every client sees) and returns
 * ONE action: an entry of legalActions, a bid of at least the listed minimum,
 * or a proposeTrade (which the engine can't enumerate). It returns null when
 * there's nothing it wants to do right now (say, a trade reply can wait or it
 * holds the high bid). The bot keeps a little memory of its own (when it last
 * proposed a trade, which offers it has already made, when it first saw each open
 * trade) but never reads the deck order, the seed or the engine's RNG; its
 * randomness comes from its own seeded rng.
 *
 * Every number the strategy uses is a named param (see params/), so the tuner
 * can change them and a human can read them.
 */

const { getTileById, BOARD, isOwnable, groupMembers } = require('../../shared/board');
const { JAIL, TRADE, unmortgageCost: unmortgagePrice } = require('../../shared/rules');
const { tradeProblem, tileProblem, mortgageFees } = require('../game/trades');
const { createRng, randomSeed, randomInt } = require('../game/rng');
const v = require('./valuation');
const PARAMS = require('./params');

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const emptySide = () => ({ tileIds: [], cash: 0, jailCards: [] });

const find = (legal, type, tileId) => legal.find((a) => a.type === type && (tileId === undefined || a.tileId === tileId));
const ofType = (legal, type) => legal.filter((a) => a.type === type);

/**
 * Is `action` one the bot may send, given the engine's legal list?
 * Bids may be raised above the listed minimum (up to the bot's cash), and a
 * proposeTrade is checked against the trade rules, since neither can be listed.
 */
function isAllowed(action, legalActions, state, me) {
  if (!action || typeof action.type !== 'string') return false;
  if (action.type === 'bid') {
    const min = legalActions.find((a) => a.type === 'bid');
    const player = state.players.find((p) => p.id === me);
    return Boolean(min) && Number.isInteger(action.amount) && action.amount >= min.amount && action.amount <= player.cash;
  }
  if (action.type === 'proposeTrade') {
    const player = state.players.find((p) => p.id === me);
    if (!player || player.bankrupt || player.cash < 0 || state.phase === 'auction' || state.phase === 'gameOver' || state.phase === 'lobby') return false;
    if (state.trades.filter((t) => t.fromId === me).length >= TRADE.maxOpenPerPlayer) return false;
    return !tradeProblem(state, { fromId: me, toId: action.toId, give: action.give, get: action.get });
  }
  return legalActions.some((a) => a.type === action.type && a.tileId === action.tileId && a.tradeId === action.tradeId && a.amount === action.amount);
}

/**
 * The least harmful legal action, used when a strategy returns something it
 * shouldn't: pass an auction, decline a trade, raise cash when in debt, then
 * move the game on. Bankruptcy only when nothing else is left.
 */
function safestAction(legalActions, state, me) {
  const order = ['pass', 'declineTrade', 'endTurn', 'roll', 'decline'];
  const player = state && state.players.find((p) => p.id === me);
  if (player && player.cash < 0) {
    const raise = find(legalActions, 'mortgage') || find(legalActions, 'sellHouse');
    if (raise) return raise;
  }
  for (const type of order) {
    const a = find(legalActions, type);
    if (a) return a;
  }
  if (player && player.cash < 0) return find(legalActions, 'bankrupt') || null;
  return null;
}

class Bot {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} [opts.difficulty] easy | medium | hard (or 'random', a baseline used by the tournament)
   * @param {object} [opts.params]     overrides, mainly for the tuner
   * @param {number} [opts.seed]       seeds the bot's own rng
   * @param {object} [opts.log]        logger with warn()
   */
  constructor({ id, difficulty = 'medium', params, seed, log } = {}) {
    this.id = id;
    this.difficulty = difficulty;
    this.params = { ...PARAMS.forDifficulty(difficulty), ...(params || {}) };
    this.rng = createRng(seed ?? randomSeed());
    this.log = log || null;
    this.memory = { lastProposalTurn: -Infinity, asked: new Map(), seenTrades: new Map(), lastTargetTurn: new Map() };
  }

  /**
   * The checked entry point: whatever the strategy picks is validated against
   * the legal actions; anything else is logged and replaced by the safest legal
   * action. With `mustAct` (it's the bot's turn and the game waits on it) it
   * never returns null while something is legal.
   */
  act({ state, legalActions, humans, mustAct = false }) {
    if (!legalActions.length) return null;
    let action = null;
    try {
      action = this.decide({ state, me: this.id, legalActions, rng: this.rng, humans });
    } catch (err) {
      this.#warn(`decide threw: ${err.message}`);
      action = undefined;
    }
    if (action === null && !mustAct) return null;
    if (action && isAllowed(action, legalActions, state, this.id)) return action;
    if (action) this.#warn(`illegal choice ${JSON.stringify(action)}; falling back`);
    return safestAction(legalActions, state, this.id);
  }

  /** Pick one action. Pure apart from the bot's own memory and rng. */
  decide({ state, me = this.id, legalActions, rng = this.rng, humans }) {
    const player = state.players.find((p) => p.id === me);
    if (!player || player.bankrupt || !legalActions.length) return null;
    const ctx = { state, me, player, legal: legalActions, rng, p: this.params, humans: humans || new Set() };
    this.#remember(ctx);
    if (this.difficulty === 'random') return this.#randomChoice(ctx);

    if (state.phase === 'auction') return this.#auction(ctx);
    if (player.cash < 0) return this.#raiseCash(ctx);

    const reply = this.#tradeReplies(ctx);
    if (reply) return reply;
    const myTurn = state.currentPlayerId === me;
    if (!myTurn) return null;

    switch (state.phase) {
      case 'buyDecision': return this.#manage(ctx, { beforeBuy: true }) || this.#buyDecision(ctx);
      case 'awaitingRoll': return this.#jail(ctx) || this.#manage(ctx) || this.#proposeTrade(ctx) || find(legalActions, 'roll');
      case 'awaitingEnd': return this.#manage(ctx) || this.#proposeTrade(ctx) || find(legalActions, 'endTurn');
      default: return null;
    }
  }

  #warn(msg) {
    if (this.log && this.log.warn) this.log.warn(`bot ${this.id}: ${msg}`);
  }

  /** Note when each open trade involving us was first seen, and forget closed ones. */
  #remember({ state, me }) {
    const open = new Set(state.trades.map((t) => t.id));
    for (const id of this.memory.seenTrades.keys()) if (!open.has(id)) this.memory.seenTrades.delete(id);
    for (const t of state.trades) {
      if ((t.fromId === me || t.toId === me) && !this.memory.seenTrades.has(t.id)) this.memory.seenTrades.set(t.id, state.turnNumber);
    }
  }

  // ---------------------------------------------------------------------------
  // Random baseline and easy
  // ---------------------------------------------------------------------------

  /** Uniformly random, except it never resigns while it can still raise cash. */
  #randomChoice({ legal, rng, player }) {
    let options = legal.filter((a) => a.type !== 'counterTrade' && a.type !== 'cancelTrade');
    if (player.cash >= 0 || options.some((a) => a.type !== 'bankrupt')) options = options.filter((a) => a.type !== 'bankrupt');
    return options.length ? options[randomInt(rng, options.length)] : legal[0];
  }

  // ---------------------------------------------------------------------------
  // Auctions
  // ---------------------------------------------------------------------------

  /** Most a bot will pay for the tile on the block. */
  auctionCap({ state, me, player, p }) {
    const tileId = state.auction.tileId;
    const value = v.tileValue(state, tileId, me, p);
    const completes = v.setsCompletedBy(state, me, [tileId]).length > 0;
    const blocks = state.players.some((o) => o.id !== me && !o.bankrupt && v.setsCompletedBy(state, o.id, [tileId]).length > 0);
    const factor = p.bidFactor * (completes ? p.bidCompleteBoost : blocks ? p.bidBlockBoost : 1);
    const reserve = completes ? p.minReserve * p.completeReserveRatio : v.reserveFor(state, me, p);
    return Math.floor(Math.min(value * factor, player.cash - reserve));
  }

  #auction(ctx) {
    const { legal, rng, p, state } = ctx;
    const bid = find(legal, 'bid');
    if (!bid) return find(legal, 'pass') || null; // holding the high bid, or already out
    let cap = this.auctionCap(ctx);
    if (this.difficulty === 'easy') cap = Math.min(ctx.player.cash, Math.round(getTileById(state.auction.tileId).price * (p.easyBidMin + rng.next() * p.easyBidSpread)));
    if (bid.amount > cap) return { type: 'pass' };
    const step = rng.next() < p.bidJumpChance ? 1 + randomInt(rng, p.bidMaxJump) : 0;
    return { type: 'bid', amount: Math.min(cap, bid.amount + step) };
  }

  // ---------------------------------------------------------------------------
  // Buying
  // ---------------------------------------------------------------------------

  #buyDecision(ctx) {
    const { state, me, player, legal, rng, p } = ctx;
    const tileId = state.turn.pendingTileId;
    const tile = getTileById(tileId);
    const buy = find(legal, 'buy');
    if (!buy) return find(legal, 'decline');
    if (this.difficulty === 'easy') return rng.next() < p.easyBuyChance ? buy : find(legal, 'decline');
    const completes = v.setsCompletedBy(state, me, [tileId]).length > 0;
    if (completes) return buy;
    const value = v.tileValue(state, tileId, me, p);
    const after = player.cash - tile.price;
    if (after >= v.reserveFor(state, me, p) && value >= tile.price * p.buyThreshold) return buy;
    return find(legal, 'decline');
  }

  // ---------------------------------------------------------------------------
  // Jail
  // ---------------------------------------------------------------------------

  /** Early on, get out and keep buying; late, sit in jail and let others land on you. */
  #jail({ state, player, legal, p, me }) {
    if (!player.inJail) return null;
    const unowned = BOARD.filter((t) => isOwnable(t) && !state.properties[t.id].ownerId).length;
    const ownable = BOARD.filter(isOwnable).length;
    const early = unowned / ownable >= p.jailLeaveUnowned && v.maxOpponentRent(state, me) < p.jailDangerRent;
    if (!early) return null;
    const card = find(legal, 'useJailCard');
    if (card) return card;
    const pay = find(legal, 'payJailFine');
    if (pay && player.cash - JAIL.fine >= v.reserveFor(state, me, p)) return pay;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Building and unmortgaging on our own turn
  // ---------------------------------------------------------------------------

  /** One management step (unmortgage or build), or null when there's nothing worth doing. */
  #manage(ctx, { beforeBuy = false } = {}) {
    const { state, me, player, legal, p, rng } = ctx;
    if (beforeBuy) return this.#raiseForPurchase(ctx);
    if (this.difficulty === 'easy') {
      const builds = ofType(legal, 'build');
      if (builds.length && rng.next() < p.easyBuildChance && player.cash - getTileById(builds[0].tileId).houseCost >= p.minReserve) {
        return builds[randomInt(rng, builds.length)];
      }
      return null;
    }
    const reserve = v.reserveFor(state, me, p);
    const fullSets = new Set(v.fullSets(state, me));

    // 1. Unmortgage tiles in a full set, so the set can be built on.
    for (const a of ofType(legal, 'unmortgage')) {
      const tile = getTileById(a.tileId);
      if (fullSets.has(tile.group) && player.cash - unmortgageCost(tile) >= reserve) return a;
    }
    // 2. Build: best extra rent per rupee, with a bonus for reaching the third house.
    let best = null;
    let bestScore = -Infinity;
    for (const a of ofType(legal, 'build')) {
      const tile = getTileById(a.tileId);
      if (player.cash - tile.houseCost < reserve) continue;
      const n = state.properties[a.tileId].buildings;
      let score = (tile.rent[n + 1] - (n === 0 ? tile.rent[0] * 2 : tile.rent[n])) / tile.houseCost;
      if (n + 1 === 3) score *= 1 + p.thirdHouseBonus;
      if (n + 1 === 5) score *= p.hotelFactor;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (best) return best;
    // 3. Unmortgage anything else, once there's plenty of cash.
    for (const a of ofType(legal, 'unmortgage')) {
      const tile = getTileById(a.tileId);
      if (player.cash - unmortgageCost(tile) >= reserve * p.unmortgageSlack) return a;
    }
    return null;
  }

  /** Mortgage a spare tile to afford a city that completes a set. */
  #raiseForPurchase({ state, me, player, legal, p }) {
    if (this.difficulty === 'easy' || !p.mortgageToComplete) return null;
    const tileId = state.turn.pendingTileId;
    const tile = getTileById(tileId);
    if (player.cash >= tile.price || !v.setsCompletedBy(state, me, [tileId]).length) return null;
    const spare = this.#mortgageOptions({ state, me, legal, p }, { keepSets: true });
    const raisable = spare.reduce((t, a) => t + getTileById(a.tileId).mortgageValue, 0);
    if (player.cash + raisable < tile.price) return null;
    return spare[0] || null;
  }

  // ---------------------------------------------------------------------------
  // Debt
  // ---------------------------------------------------------------------------

  /** Mortgage options, least valuable first (per rupee raised). Tiles in sets we're building on come last. */
  #mortgageOptions({ state, me, legal, p }, { keepSets = false } = {}) {
    const full = new Set(v.fullSets(state, me));
    return ofType(legal, 'mortgage')
      .filter((a) => !keepSets || !full.has(getTileById(a.tileId).group))
      .map((a) => {
        const tile = getTileById(a.tileId);
        const keep = v.tileValue(state, a.tileId, me, p) * (full.has(tile.group) ? p.setKeepFactor : 1);
        return [a, keep / tile.mortgageValue];
      })
      .sort((x, y) => x[1] - y[1])
      .map(([a]) => a);
  }

  /**
   * In debt: mortgage the least valuable tiles first; sell houses only once
   * nothing unbuilt is left, from the least valuable set; resign only when
   * nothing else is possible.
   */
  #raiseCash(ctx) {
    const { state, legal } = ctx;
    const mortgage = this.#mortgageOptions(ctx)[0];
    if (mortgage) return mortgage;
    const sells = ofType(legal, 'sellHouse');
    if (sells.length) {
      // Rent the set earns per rupee of house cost: sell from the weakest set first.
      const earning = (a) => {
        const tile = getTileById(a.tileId);
        return groupMembers(tile.group).reduce((t, i) => t + v.rentFor(state, BOARD[i].id), 0) / tile.houseCost;
      };
      return sells.sort((a, b) => earning(a) - earning(b))[0];
    }
    // Nothing left to sell or mortgage: resign.
    return find(legal, 'bankrupt') || null;
  }

  // ---------------------------------------------------------------------------
  // Trades
  // ---------------------------------------------------------------------------

  /** What owning a full colour set is worth on top of its tiles: a flat bonus plus its rent potential. */
  setWorth(group, p = this.params) {
    return p.tradeSetBonus + p.setRentValue * v.groupTiles(group).reduce((t, id) => t + getTileById(id).rent[3], 0);
  }

  /**
   * How a trade looks to `me` as its recipient (trade.give is what we get).
   * Sets we'd complete add their worth to what we gain; full sets we'd break,
   * and sets we'd hand the proposer, add to what we give. A set handed over
   * counts in full (× 1 + setGiftPremium) unless we complete one too, when it
   * counts at mutualSetWeight. `ok` says whether we'd accept.
   */
  judgeTrade(state, me, trade, p = this.params) {
    const receive = trade.give;
    const giveUp = trade.get;
    let gained = v.sideValue(state, receive, me, p, { receiving: true });
    let given = v.sideValue(state, giveUp, me, p, { receiving: false });
    const mySets = v.setsCompletedBy(state, me, receive.tileIds, giveUp.tileIds);
    const theirSets = v.setsCompletedBy(state, trade.fromId, giveUp.tileIds, receive.tileIds);
    for (const group of mySets) gained += this.setWorth(group, p);
    for (const group of v.fullSets(state, me)) {
      if (giveUp.tileIds.some((id) => getTileById(id).group === group)) given += this.setWorth(group, p);
    }
    const gift = mySets.length ? p.mutualSetWeight : 1 + p.setGiftPremium;
    for (const group of theirSets) given += gift * this.setWorth(group, p);
    const self = state.players.find((x) => x.id === me);
    const cashAfter = self.cash + receive.cash - giveUp.cash - mortgageFees(state, receive.tileIds);
    const ok = cashAfter >= 0 && gained - given > p.acceptMargin && (mySets.length > 0 || cashAfter >= Math.min(self.cash, p.minReserve));
    return { gained, given, net: gained - given, ok, givesSet: theirSets.length > 0, getsSet: mySets.length > 0, cashAfter };
  }

  /** Accept, decline or (for proposals of our own) cancel. Returns null to think about it later. */
  #tradeReplies(ctx) {
    const { state, me, player, legal, rng, p } = ctx;
    for (const t of state.trades) {
      if (t.fromId === me) {
        const age = state.turnNumber - (this.memory.seenTrades.get(t.id) ?? state.turnNumber);
        if (age >= p.tradeTtlTurns && find(legal, 'cancelTrade')) {
          const cancel = legal.find((a) => a.type === 'cancelTrade' && a.tradeId === t.id);
          if (cancel) return cancel;
        }
        continue;
      }
      if (t.toId !== me) continue;
      const accept = legal.find((a) => a.type === 'acceptTrade' && a.tradeId === t.id);
      const decline = legal.find((a) => a.type === 'declineTrade' && a.tradeId === t.id);
      if (!decline) continue;
      const verdict = this.judgeTrade(state, me, t, p);
      let ok = Boolean(accept) && verdict.ok;
      if (this.difficulty === 'easy') {
        // Easy accepts roughly fair offers, but still never gives a set away for nothing.
        ok = Boolean(accept) && verdict.cashAfter >= 0 && (!verdict.givesSet || verdict.getsSet)
          && verdict.gained >= (verdict.given) * (p.easyAcceptMin + rng.next() * p.easyAcceptSpread);
      }
      return ok ? accept : decline;
    }
    return null;
  }

  /**
   * At most one open proposal, one new one every few turns (longer towards
   * humans): ask for the tile(s) that complete one of our sets, offering a
   * spare tile and/or cash that the other player should value at least as much.
   */
  #proposeTrade(ctx) {
    const { state, me, p, humans } = ctx;
    if (this.difficulty === 'easy' || !p.proposeTrades) return null;
    if (state.trades.some((t) => t.fromId === me)) return null;
    if (state.turnNumber - this.memory.lastProposalTurn < p.proposeEveryTurns) return null;
    const offer = this.planTrade(ctx);
    if (!offer) return null;
    const isHuman = humans.has(offer.toId);
    const lastAtTarget = this.memory.lastTargetTurn.get(offer.toId) ?? -Infinity;
    if (isHuman && state.turnNumber - lastAtTarget < p.humanCooldownTurns) return null;
    this.memory.lastProposalTurn = state.turnNumber;
    this.memory.lastTargetTurn.set(offer.toId, state.turnNumber);
    return offer;
  }

  /**
   * The best set-completing trade we could offer right now, or null. Candidate
   * payments: cash alone, a spare tile plus cash, or a swap that completes one
   * of their sets too. Cash is set to what they'd need to accept by our model
   * of them (our own judgeTrade), plus offerPremium; we only offer when the
   * trade is still worth it to us. Exposed for tests.
   */
  planTrade({ state, me, player, p }) {
    const spendable = player.cash - p.minReserve * p.completeReserveRatio;
    const tradeable = (ownerId) => Object.keys(state.properties).filter((id) => state.properties[id].ownerId === ownerId && !tileProblem(state, ownerId, id));
    const myFull = new Set(v.fullSets(state, me));
    let best = null;
    for (const group of v.CITY_GROUPS) {
      const tiles = v.groupTiles(group);
      const missing = tiles.filter((id) => state.properties[id].ownerId !== me);
      if (missing.length === tiles.length || !missing.length || missing.length > p.maxMissingForTrade) continue;
      const ownerId = state.properties[missing[0]].ownerId;
      if (!ownerId || missing.some((id) => state.properties[id].ownerId !== ownerId)) continue;
      const owner = state.players.find((o) => o.id === ownerId);
      if (!owner || owner.bankrupt || missing.some((id) => tileProblem(state, ownerId, id))) continue;
      const key = `${ownerId}:${missing.join(',')}`;
      const askedAt = this.memory.asked.get(key);
      if (askedAt !== undefined && state.turnNumber - askedAt < p.retryAskTurns) continue;

      const get = { ...emptySide(), tileIds: missing };
      const spares = tradeable(me).filter((id) => {
        const g = getTileById(id).group;
        return g !== group && !myFull.has(g);
      });
      const offers = [[], ...spares.map((id) => [id])];
      for (const tileIds of offers) {
        const give = { ...emptySide(), tileIds };
        const trade = { fromId: me, toId: ownerId, give, get };
        // Cash that makes it acceptable to them: close the gap, then add the premium.
        const them = this.judgeTrade(state, ownerId, trade, p);
        const gap = Math.max(0, p.acceptMargin + 1 - them.net);
        give.cash = gap > 0 ? Math.ceil(gap * (1 + p.offerPremium)) : 0;
        if (give.cash > spendable) continue;
        if (!give.cash && !give.tileIds.length) continue;
        if (!this.judgeTrade(state, ownerId, trade, p).ok) continue;
        // How it looks to us: the mirror image, with us as the recipient.
        const us = this.judgeTrade(state, me, { fromId: ownerId, toId: me, give: get, get: give }, p);
        if (us.net <= 0) continue;
        if (!best || us.net > best.margin) best = { margin: us.net, key, action: { type: 'proposeTrade', toId: ownerId, give: { ...give }, get } };
      }
    }
    if (!best) return null;
    // Remember the ask, so a declined offer isn't repeated straight away.
    this.memory.asked.set(best.key, state.turnNumber);
    return best.action;
  }
}

const unmortgageCost = (tile) => unmortgagePrice(tile.price);

module.exports = { Bot, DIFFICULTIES, isAllowed, safestAction };
