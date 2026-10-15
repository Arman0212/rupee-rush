'use strict';

/**
 * Monopoly game engine.
 *
 * A pure state machine: no networking, timers or I/O. Randomness comes from an
 * injected `rng` (anything with `next()` returning [0, 1)) and time from an
 * injected `now()`, so a game is fully reproducible from its seed and inputs.
 *
 * All state lives in `this.state`, a plain JSON-safe object. Callers change it
 * only through addPlayer / removePlayer / start / dispatch, each of which
 * returns { ok: true, events } or { ok: false, error } and never throws on bad
 * input. Every action is validated by a `#check*` method before its `#do*`
 * counterpart runs, and getLegalActions() reuses the same checks, so the list
 * of legal actions and what dispatch accepts can never drift apart.
 *
 * Money model
 *   Every movement of money goes through #transfer(from, to, amount), where a
 *   party is a player id, BANK (null) or JACKPOT ('jackpot'). If a payer can't
 *   cover a payment, they pay what they have, their cash goes negative and the
 *   shortfall is queued in player.debt.owed. Any money the debtor later
 *   receives (selling, mortgaging, rent) is forwarded to those creditors first,
 *   oldest debt first. So debt.amount always equals max(0, -cash), and negative
 *   cash is an IOU rather than money: the total money in play is
 *   Σ max(cash, 0) + jackpot, and it changes only through the bank.
 *
 * Events
 *   Every event is { type, at, ...fields }. Money events always carry
 *   { from, to, amount } using the party ids above, which is what lets the
 *   simulator keep an independent ledger. Types: playerJoined, playerLeft,
 *   gameStarted, turnStarted, turnEnded, diceRolled, moved, moneyCollected,
 *   moneyPaid, rentPaid, rentWaived, taxPaid, jackpotCollected, purchaseOffered,
 *   propertyBought, purchaseDeclined, built, houseSold, mortgaged, unmortgaged,
 *   cardDrawn, sentToJail, leftJail, jailRollFailed, debtIncurred, debtPaid,
 *   debtCleared, debtForgiven, propertyTransferred, propertyReturned,
 *   bankrupt, gameOver, auctionStarted, bidPlaced, auctionPassed,
 *   auctionClosed, tradeProposed, tradeAccepted, tradeDeclined,
 *   tradeCancelled, tradePayment, mortgageFee, worldEventStarted,
 *   worldEventEnded.
 *
 * Auctions
 *   With settings.auctions on, declining a purchase puts the tile up for
 *   auction (phase 'auction'). Players bid or pass; the auction ends early
 *   once everyone but the high bidder has passed, otherwise when the server
 *   calls closeAuction() (its timer). Nothing else can happen meanwhile.
 *
 * Trades
 *   Open trades live in state.trades and are re-checked after every change:
 *   any trade that is no longer valid is cancelled with a reason, so an open
 *   trade can always be accepted (subject to the mortgage transfer fee).
 */

const board = require('../../shared/board');
const { DECKS, getCard } = require('../../shared/cards');
const { EVENTS, getEvent } = require('../../shared/events');
const rules = require('../../shared/rules');
const { createRng, randomSeed, randomInt, shuffle } = require('./rng');
const { ACTIONS, NOT_IMPLEMENTED, AUCTION_ACTIONS, TILE_ACTIONS, PHASE, BANK, JACKPOT } = require('./actions');
const trades = require('./trades');

const { BOARD, BOARD_SIZE, TILE, AIRPORT_RENT, UTILITY_MULTIPLIER, MAX_BUILDINGS, JAIL_INDEX } = board;
const { JAIL, DICE, BUILDING, LANDMARK, BOUNTY, ROOM, PLAYER_COLORS, AUCTION, TRADE, formatRupees } = rules;

const STATE_VERSION = 1;
const MAX_ID_LENGTH = 64;
const ACTIVE_PHASES = [PHASE.AWAITING_ROLL, PHASE.BUY_DECISION, PHASE.AWAITING_END];
const OWNABLE_TILES = BOARD.filter(board.isOwnable);
const CITY_GROUPS = [...new Set(BOARD.filter((t) => t.type === TILE.CITY).map((t) => t.group))];
/** Net-worth snapshots kept for the end-of-game chart; older ones are thinned out beyond this. */
const MAX_WORTH_POINTS = 60;

/** Actions that take no arguments, in the order getLegalActions lists them. */
const SIMPLE_ACTIONS = [
  ACTIONS.ROLL, ACTIONS.BUY, ACTIONS.DECLINE, ACTIONS.END_TURN,
  ACTIONS.PAY_JAIL_FINE, ACTIONS.USE_JAIL_CARD, ACTIONS.BANKRUPT,
];

const ok = (events) => ({ ok: true, events });
const fail = (error) => ({ ok: false, error });
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
/**
 * Deep copy of plain JSON data. Several times faster than structuredClone or a
 * JSON round trip for this shape, which matters to the simulator. `__proto__`
 * keys are dropped so a crafted save can't pollute prototypes.
 */
function cloneData(x) {
  if (Array.isArray(x)) return x.map(cloneData);
  if (x === null || typeof x !== 'object') return x;
  const copy = {};
  for (const key of Object.keys(x)) if (key !== '__proto__') copy[key] = cloneData(x[key]);
  return copy;
}

class Game {
  /** Events produced by the call currently in progress. */
  #events = [];

  /**
   * @param {object}   [opts]
   * @param {object}   [opts.settings] host settings, passed through sanitizeSettings
   * @param {object}   [opts.rng]      { next(): number in [0,1) }, ideally with getState/setState
   * @param {number}   [opts.seed]         used to build a mulberry32 rng when `rng` is omitted
   * @param {Function} [opts.now]          clock returning ms since epoch
   * @param {Function} [opts.diceProvider] (playerId, reason, game) => [die1, die2]
   * @param {Function} [opts.cardHook]     (deck, deckArray, player, game) => void
   */
  constructor({ settings, rng, seed, now, diceProvider, cardHook } = {}) {
    this.now = typeof now === 'function' ? now : Date.now;
    this.rng = rng || createRng(seed ?? randomSeed());
    this.diceProvider = typeof diceProvider === 'function' ? diceProvider : null;
    this.cardHook = typeof cardHook === 'function' ? cardHook : null;
    const clean = rules.sanitizeSettings(isObject(settings) ? settings : {});
    this.state = Game.#initialState(clean, this.rng.seed ?? null, this.now());
  }

  static #initialState(settings, seed, createdAt) {
    const properties = {};
    for (const tile of OWNABLE_TILES) properties[tile.id] = { ownerId: null, buildings: 0, mortgaged: false, landmark: false };
    return {
      version: STATE_VERSION,
      seed,
      createdAt,
      startedAt: null,
      settings,
      phase: PHASE.LOBBY,
      turnNumber: 0,
      currentPlayerId: null,
      winnerId: null,
      winnerTeam: null,
      players: [],
      properties,
      decks: { surprise: [], treasure: [] },
      jackpot: 0,
      turn: Game.#freshTurn(),
      lastCard: null,
      auction: null, // { tileId, highBid, highBidderId, bidders, startedBy }
      trades: [], // open trades only
      tradeSeq: 0,
      stats: Game.#freshStats(),
      devLedger: { bankOut: 0, bankIn: 0 },
      // World events mode: at most one active event, drawn every few rounds.
      world: { activeEventId: null, anchorId: null, roundsElapsed: 0, nextEventAtRound: settings.worldEventEvery, lastSeatIndex: -1 },
      // Bounties mode: a bounty on dangerous players, and rent totals between pairs.
      bounties: { onPlayer: {}, setsAwarded: {}, rent: {} },
    };
  }

  /** End-of-game stats: net worth over time, landings per tile, biggest single rent. */
  static #freshStats() {
    return { worthEvery: 1, worth: [], landings: new Array(BOARD_SIZE).fill(0), biggestRent: null };
  }

  /** Per-turn scratch state, reset whenever a new turn begins. */
  static #freshTurn() {
    return { dice: null, canRollAgain: false, pendingTileId: null };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Join the lobby. Unknown or taken colours fall back to the first free one. */
  addPlayer(info) {
    return this.#run(() => this.#checkAddPlayer(info), () => this.#doAddPlayer(info));
  }

  /** Leave the game. Mid-game this counts as bankruptcy to the bank. */
  removePlayer(id) {
    const player = this.#player(id);
    return this.#run(() => (player ? null : 'unknown player'), () => this.#doRemovePlayer(player));
  }

  /** Shuffle the decks, randomise turn order, hand out starting cash. */
  start() {
    return this.#run(() => this.#checkStart(), () => this.#doStart());
  }

  /** Apply one player action. Returns { ok: true, events } or { ok: false, error }. */
  dispatch(playerId, action) {
    if (!isObject(action) || typeof action.type !== 'string') return fail('invalid action');
    if (NOT_IMPLEMENTED.has(action.type)) return fail('not implemented');
    // hasOwn, so names like 'toString' don't resolve to Object.prototype members.
    if (!Object.hasOwn(Game.#HANDLERS, action.type)) return fail('unknown action');
    const handler = Game.#HANDLERS[action.type];
    const player = this.#player(playerId);
    return this.#run(() => this.#checkAction(player, action), () => handler.run(this, player, action));
  }

  /** Every action `playerId` may dispatch right now, each ready to pass to dispatch(). */
  getLegalActions(playerId) {
    const player = this.#player(playerId);
    if (!player) return [];
    return this.#candidateActions(player).filter((a) => !this.#checkAction(player, a));
  }

  /**
   * End the running auction: the high bidder pays the bank and takes the
   * tile; with no bids it stays unowned. Called by the server's auction timer,
   * never by a client.
   */
  closeAuction() {
    return this.#run(() => (this.state.auction ? null : 'no auction is running'), () => this.#finishAuction());
  }

  /**
   * Developer silent cash adjustment: adds or removes money without emitting
   * player-visible events. Recorded in state.devLedger so simulator's money
   * conservation check treats it as an explicit bank flow.
   */
  devAdjustCash(playerId, amount) {
    const p = this.#player(playerId);
    if (!p || !Number.isInteger(amount) || amount === 0) return false;
    this.state.devLedger ??= { bankOut: 0, bankIn: 0 };
    if (amount > 0) {
      this.state.devLedger.bankOut += amount;
      p.cash += amount;
      let remaining = amount;
      while (remaining > 0 && p.debt.owed.length) {
        const entry = p.debt.owed[0];
        const part = Math.min(remaining, entry.amount);
        entry.amount -= part;
        remaining -= part;
        if (entry.amount === 0) p.debt.owed.shift();
        if (entry.creditorId && entry.creditorId !== BANK) {
          const cred = this.#player(entry.creditorId);
          if (cred) cred.cash += part;
        }
      }
      this.#syncDebt(p);
    } else {
      const deduct = Math.abs(amount);
      const prevCash = p.cash;
      p.cash -= deduct;
      const actualDeductedFromPlay = Math.max(0, Math.min(deduct, prevCash));
      this.state.devLedger.bankIn += actualDeductedFromPlay;
      const shortfall = Math.max(0, -p.cash);
      if (shortfall > 0) {
        const last = p.debt.owed[p.debt.owed.length - 1];
        if (last && last.creditorId === BANK) last.amount = shortfall;
        else p.debt.owed.push({ creditorId: BANK, amount: shortfall });
        this.#syncDebt(p);
      }
    }
    return true;
  }

  /** Full state for saving, including the hidden deck order and the rng state. */
  toJSON() {
    const rngState = typeof this.rng.getState === 'function' ? this.rng.getState() : null;
    return { ...cloneData(this.state), rngState };
  }

  /** Restore a game saved with toJSON(). Throws on data that isn't a saved game. */
  static fromJSON(data, { rng, now } = {}) {
    if (!isObject(data) || data.version !== STATE_VERSION || !Array.isArray(data.players)) {
      throw new Error(`Game.fromJSON: not a saved ${rules.GAME_NAME} game`);
    }
    const { rngState, ...state } = cloneData(data);
    let restoredRng = rng;
    if (!restoredRng) {
      restoredRng = createRng(state.seed ?? 0);
      if (rngState != null) restoredRng.setState(rngState);
    }
    const game = new Game({ settings: state.settings, rng: restoredRng, now });
    // Saves from before auctions, trades and stats existed.
    state.auction ??= null;
    state.trades ??= [];
    state.tradeSeq ??= 0;
    state.stats ??= Game.#freshStats();
    state.devLedger ??= { bankOut: 0, bankIn: 0 };
    state.world ??= { activeEventId: null, anchorId: null, roundsElapsed: 0, nextEventAtRound: state.settings.worldEventEvery || 3, lastSeatIndex: -1 };
    state.bounties ??= { onPlayer: {}, setsAwarded: {}, rent: {} };
    state.winnerTeam ??= null;
    game.state = state;
    return game;
  }

  /**
   * What clients may see: everything except the remaining deck order and the
   * seed / rng state, either of which would let a client predict dice and cards.
   */
  publicState() {
    const { seed, decks, stats, devLedger, world, ...visible } = cloneData(this.state);
    return {
      ...visible,
      // Stats only matter at the end, so they don't ride along on every broadcast.
      stats: this.state.phase === PHASE.GAME_OVER ? stats : null,
      decks: { surprise: { remaining: decks.surprise.length }, treasure: { remaining: decks.treasure.length } },
      // World events: the active event and how many rounds until the next one.
      world: this.state.settings.worldEvents ? {
        activeEvent: world.activeEventId ? getEvent(world.activeEventId) : null,
        nextInRounds: Math.max(0, world.nextEventAtRound - world.roundsElapsed),
      } : null,
      // Bounties: who carries a bounty, and the rivalry (top rent pair).
      bounties: this.state.settings.bounties ? {
        onPlayer: visible.bounties.onPlayer,
        rivalry: this.#topRivalry(),
      } : null,
    };
  }

  // =========================================================================
  // Dispatch plumbing
  // =========================================================================

  /** Validate, then apply, collecting the events produced. */
  #run(check, apply) {
    const error = check();
    if (error) return fail(error);
    this.#events = [];
    apply();
    if (this.state.settings.bounties) this.#checkThirdSets();
    if (this.state.trades.length) this.#sweepTrades();
    const events = this.#events;
    this.#events = [];
    return ok(events);
  }

  #emit(type, fields = {}) {
    this.#events.push({ type, ...fields, at: this.now() });
  }

  /** check: returns an error string or null. run: applies an already-validated action. */
  static #HANDLERS = {
    [ACTIONS.ROLL]: { check: (g, p) => g.#checkRoll(p), run: (g, p) => g.#doRoll(p) },
    [ACTIONS.BUY]: { check: (g, p) => g.#checkBuy(p), run: (g, p) => g.#doBuy(p) },
    [ACTIONS.DECLINE]: { check: (g, p) => g.#checkDecline(p), run: (g, p) => g.#doDecline(p) },
    [ACTIONS.END_TURN]: { check: (g, p) => g.#checkEndTurn(p), run: (g, p) => g.#doEndTurn(p) },
    [ACTIONS.BUILD]: { check: (g, p, a) => g.#checkBuild(p, a), run: (g, p, a) => g.#doBuild(p, a) },
    [ACTIONS.SELL_HOUSE]: { check: (g, p, a) => g.#checkSellHouse(p, a), run: (g, p, a) => g.#doSellHouse(p, a) },
    [ACTIONS.MORTGAGE]: { check: (g, p, a) => g.#checkMortgage(p, a), run: (g, p, a) => g.#doMortgage(p, a) },
    [ACTIONS.UNMORTGAGE]: { check: (g, p, a) => g.#checkUnmortgage(p, a), run: (g, p, a) => g.#doUnmortgage(p, a) },
    [ACTIONS.BUILD_LANDMARK]: { check: (g, p, a) => g.#checkBuildLandmark(p, a), run: (g, p, a) => g.#doBuildLandmark(p, a) },
    [ACTIONS.SELL_LANDMARK]: { check: (g, p, a) => g.#checkSellLandmark(p, a), run: (g, p, a) => g.#doSellLandmark(p, a) },
    [ACTIONS.SEND_TO_TEAMMATE]: { check: (g, p, a) => g.#checkSendToTeammate(p, a), run: (g, p, a) => g.#doSendToTeammate(p, a) },
    [ACTIONS.PAY_JAIL_FINE]: { check: (g, p) => g.#checkPayJailFine(p), run: (g, p) => g.#doPayJailFine(p) },
    [ACTIONS.USE_JAIL_CARD]: { check: (g, p) => g.#checkUseJailCard(p), run: (g, p) => g.#doUseJailCard(p) },
    [ACTIONS.BANKRUPT]: { check: (g, p) => g.#checkBankrupt(p), run: (g, p) => g.#declareBankruptcy(p, 'debt') },
    [ACTIONS.BID]: { check: (g, p, a) => g.#checkBid(p, a), run: (g, p, a) => g.#doBid(p, a) },
    [ACTIONS.PASS]: { check: (g, p) => g.#checkPass(p), run: (g, p) => g.#doPass(p) },
    [ACTIONS.PROPOSE_TRADE]: { check: (g, p, a) => g.#checkProposeTrade(p, a), run: (g, p, a) => g.#doProposeTrade(p, a) },
    [ACTIONS.ACCEPT_TRADE]: { check: (g, p, a) => g.#checkAcceptTrade(p, a), run: (g, p, a) => g.#doAcceptTrade(p, a) },
    [ACTIONS.DECLINE_TRADE]: { check: (g, p, a) => g.#checkRecipient(p, a), run: (g, p, a) => g.#doDeclineTrade(p, a) },
    [ACTIONS.CANCEL_TRADE]: { check: (g, p, a) => g.#checkProposer(p, a), run: (g, p, a) => g.#doCancelTrade(p, a) },
    [ACTIONS.COUNTER_TRADE]: { check: (g, p, a) => g.#checkCounterTrade(p, a), run: (g, p, a) => g.#doCounterTrade(p, a) },
  };

  /** Checks shared by every action, then the action's own check. */
  #checkAction(player, action) {
    if (!player) return 'unknown player';
    if (this.state.phase === PHASE.LOBBY) return 'game has not started';
    if (this.state.phase === PHASE.GAME_OVER) return 'game is over';
    if (player.bankrupt) return 'you are bankrupt';
    if (this.state.phase === PHASE.AUCTION && !AUCTION_ACTIONS.has(action.type)) return 'not while an auction is running';
    return Game.#HANDLERS[action.type].check(this, player, action);
  }

  /** Every syntactically possible action for this player; getLegalActions filters them. */
  #candidateActions(player) {
    const list = SIMPLE_ACTIONS.map((type) => ({ type }));
    for (const tile of OWNABLE_TILES) {
      if (this.state.properties[tile.id].ownerId !== player.id) continue;
      for (const type of TILE_ACTIONS) list.push({ type, tileId: tile.id });
    }
    // Bids carry an amount; the legal one offered is the minimum.
    if (this.state.auction) list.push({ type: ACTIONS.BID, amount: this.#minBid() }, { type: ACTIONS.PASS });
    // proposeTrade needs an offer, so it can't be enumerated; replies to open trades can.
    for (const t of this.state.trades) {
      if (t.toId === player.id) {
        for (const type of [ACTIONS.ACCEPT_TRADE, ACTIONS.DECLINE_TRADE, ACTIONS.COUNTER_TRADE]) list.push({ type, tradeId: t.id });
      }
      if (t.fromId === player.id) list.push({ type: ACTIONS.CANCEL_TRADE, tradeId: t.id });
    }
    return list;
  }

  // =========================================================================
  // Lobby
  // =========================================================================

  #checkAddPlayer(info) {
    if (!isObject(info)) return 'invalid player';
    if (this.state.phase !== PHASE.LOBBY) return 'game already started';
    const { id } = info;
    if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH || id === JACKPOT) return 'invalid player id';
    if (this.#player(id)) return 'player already joined';
    if (this.state.players.length >= this.state.settings.maxPlayers) return 'game is full';
    return null;
  }

  #doAddPlayer({ id, name, color, team }) {
    const players = this.state.players;
    const cleanName = typeof name === 'string' ? name.trim().slice(0, ROOM.nameMaxLength) : '';
    const player = {
      id,
      name: cleanName || `Player ${players.length + 1}`,
      color: this.#pickColor(color),
      team: team === 'A' || team === 'B' ? team : null,
      cash: 0,
      position: 0,
      inJail: false,
      jailTurns: 0,
      jailFreeCards: [], // [{ deck, cardId }] so the card can go back to its own deck
      doublesCount: 0,
      bankrupt: false,
      left: false,
      debt: { amount: 0, creditorId: null, owed: [] },
    };
    players.push(player);
    this.#emit('playerJoined', { playerId: id, name: player.name, color: player.color, team: player.team });
  }

  #pickColor(requested) {
    const taken = new Set(this.state.players.map((p) => p.color));
    if (PLAYER_COLORS.includes(requested) && !taken.has(requested)) return requested;
    return PLAYER_COLORS.find((c) => !taken.has(c));
  }

  #checkStart() {
    if (this.state.phase !== PHASE.LOBBY) return 'game already started';
    if (this.state.players.length < 2) return 'need at least 2 players';
    if (this.state.settings.teams) {
      const n = this.state.players.length;
      if (n !== 4 && n !== 6) return 'team mode needs exactly 4 or 6 players';
      const a = this.state.players.filter((p) => p.team === 'A').length;
      const b = this.state.players.filter((p) => p.team === 'B').length;
      if (a + b !== n) return 'every player needs a team';
      if (a !== b) return 'the teams must be even';
    }
    return null;
  }

  #doStart() {
    const s = this.state;
    shuffle(this.rng, s.players);
    for (const name of Object.keys(DECKS)) s.decks[name] = shuffle(this.rng, DECKS[name].map((c) => c.id));
    s.startedAt = this.now();
    this.#emit('gameStarted', { order: s.players.map((p) => p.id) });
    for (const p of s.players) {
      this.#transfer(BANK, p.id, s.settings.startingCash, 'moneyCollected', { reason: 'startingCash' });
    }
    this.#beginTurn(s.players[0]);
  }

  #doRemovePlayer(player) {
    const s = this.state;
    if (s.phase === PHASE.LOBBY) {
      s.players.splice(s.players.indexOf(player), 1);
      this.#emit('playerLeft', { playerId: player.id });
      return;
    }
    player.left = true;
    this.#emit('playerLeft', { playerId: player.id });
    if (s.phase !== PHASE.GAME_OVER && !player.bankrupt) this.#declareBankruptcy(player, 'left', { toBank: true });
  }

  // =========================================================================
  // Turn flow
  // =========================================================================

  #checkTurn(p, ...phases) {
    if (this.state.currentPlayerId !== p.id) return 'not your turn';
    if (!phases.includes(this.state.phase)) return `not allowed during ${this.state.phase}`;
    return null;
  }

  #checkSolvent(p) {
    return p.cash < 0 ? 'clear your debt first' : null;
  }

  #checkRoll(p) {
    return this.#checkTurn(p, PHASE.AWAITING_ROLL) || this.#checkSolvent(p);
  }

  #checkEndTurn(p) {
    return this.#checkTurn(p, PHASE.AWAITING_END) || this.#checkSolvent(p);
  }

  #doEndTurn(p) {
    this.#emit('turnEnded', { playerId: p.id });
    this.#beginTurn(this.#nextActivePlayer(p.id));
  }

  #beginTurn(player) {
    const s = this.state;
    s.currentPlayerId = player.id;
    s.turnNumber += 1;
    // A turn can pass mid-auction (the turn player went bankrupt); the auction carries on.
    s.phase = s.auction ? PHASE.AUCTION : PHASE.AWAITING_ROLL;
    s.turn = Game.#freshTurn();
    player.doublesCount = 0;
    this.#recordWorth(false);
    this.#emit('turnStarted', { playerId: player.id, turnNumber: s.turnNumber });
    if (s.settings.worldEvents) this.#tickWorldEvents(player);
  }

  // =========================================================================
  // World events (optional mode)
  // =========================================================================

  /**
   * Called at the start of every turn: end the active event once a full round
   * has passed (its anchor player is up again, or has gone), count completed
   * rounds, and draw a fresh event when one is due and none is running.
   */
  #tickWorldEvents(player) {
    const w = this.state.world;
    const idx = this.state.players.indexOf(player);
    if (w.activeEventId) {
      const anchor = this.#player(w.anchorId);
      if (player.id === w.anchorId || !anchor || anchor.bankrupt) {
        this.#emit('worldEventEnded', { eventId: w.activeEventId });
        w.activeEventId = null;
        w.anchorId = null;
      }
    }
    // A round completes whenever turn order wraps back towards the first seat.
    if (w.lastSeatIndex >= 0 && idx <= w.lastSeatIndex) w.roundsElapsed += 1;
    w.lastSeatIndex = idx;
    if (!w.activeEventId && w.roundsElapsed >= w.nextEventAtRound) {
      this.#startWorldEvent(player);
      w.nextEventAtRound = w.roundsElapsed + this.state.settings.worldEventEvery;
    }
  }

  #startWorldEvent(anchor) {
    const w = this.state.world;
    const event = EVENTS[randomInt(this.rng, EVENTS.length)];
    w.activeEventId = event.id;
    w.anchorId = anchor.id;
    this.#emit('worldEventStarted', { eventId: event.id, anchorId: anchor.id });
    if (event.onStart) this.#applyEventOnStart(event.onStart);
  }

  /** A one-off bank payment the moment an event is drawn. Never pushes anyone into debt. */
  #applyEventOnStart(onStart) {
    const meta = { reason: 'worldEvent' };
    for (const p of this.state.players.filter((x) => !x.bankrupt)) {
      if (onStart.kind === 'eachCollect') {
        this.#transfer(BANK, p.id, onStart.amount, 'moneyCollected', meta);
      } else if (onStart.kind === 'eachPayFraction') {
        const amount = Math.min(Math.max(0, p.cash), rules.rupees(Math.max(0, p.cash) * onStart.fraction));
        if (amount > 0) this.#transfer(p.id, BANK, amount, 'moneyPaid', meta);
      } else if (onStart.kind === 'eachPerBuilding') {
        const bill = this.#repairBill(p.id, { perHouse: onStart.perHouse, perHotel: onStart.perHotel });
        const amount = Math.min(Math.max(0, p.cash), bill);
        if (amount > 0) this.#transfer(p.id, BANK, amount, 'moneyPaid', meta);
      }
    }
  }

  /** Modifiers of the event in force right now, or an empty object. */
  #eventModifiers() {
    const id = this.state.settings.worldEvents ? this.state.world.activeEventId : null;
    const event = id ? getEvent(id) : null;
    return (event && event.modifiers) || {};
  }

  /** How much rent is scaled for a given tile by the active event (1 when nothing applies). */
  #rentModifier(tile) {
    const mod = this.#eventModifiers();
    let factor = 1;
    if (mod.rentMultiplier) {
      const m = mod.rentMultiplier;
      if (m.all || (m.groups && m.groups.includes(tile.group))) factor *= m.factor;
    }
    if (tile.type === TILE.AIRPORT && mod.airportRentFactor !== undefined) factor *= mod.airportRentFactor;
    if (tile.type === TILE.UTILITY && mod.utilityRentFactor !== undefined) factor *= mod.utilityRentFactor;
    return factor;
  }

  // =========================================================================
  // Bounties and rivalries (optional mode)
  // =========================================================================

  /** Unordered pair key for the rivalry rent map. */
  static #pairKey(a, b) {
    return [a, b].sort().join('|');
  }

  /** The pair with the most rent paid between them, or null. */
  #topRivalry() {
    let best = null;
    for (const [key, total] of Object.entries(this.state.bounties.rent)) {
      if (!best || total > best.total) {
        const [a, b] = key.split('|');
        best = { a, b, total };
      }
    }
    return best;
  }

  #fullSetCount(playerId) {
    return CITY_GROUPS.filter((g) => this.#ownsGroup(playerId, g)).length;
  }

  /** Remember rent flowing between two players, for the rivalry read-out. */
  #recordRent(payerId, ownerId, amount) {
    if (amount <= 0) return;
    const key = Game.#pairKey(payerId, ownerId);
    this.state.bounties.rent[key] = (this.state.bounties.rent[key] || 0) + amount;
  }

  /** Put (or raise) a bounty on a player who has just become dangerous. */
  #placeBounty(player, reason) {
    const map = this.state.bounties.onPlayer;
    const triggers = (map[player.id] ? map[player.id].triggers : 0) + 1;
    const value = Math.min(BOUNTY.max, BOUNTY.base + BOUNTY.perExtra * (triggers - 1));
    map[player.id] = { value, triggers };
    this.#emit('bountyPlaced', { playerId: player.id, value, triggers, reason });
  }

  /** When a bounty holder pays rent, the bank pays the owner the bounty on top. */
  #claimBountyIfAny(holder, owner, tileId) {
    const bounty = this.state.bounties.onPlayer[holder.id];
    if (!bounty) return;
    delete this.state.bounties.onPlayer[holder.id];
    this.#transfer(BANK, owner.id, bounty.value, 'bountyClaimed', { holderId: holder.id, tileId });
  }

  /** After any ownership change: a bounty on anyone who now holds three colour sets. */
  #checkThirdSets() {
    for (const p of this.state.players) {
      if (p.bankrupt || this.state.bounties.setsAwarded[p.id]) continue;
      if (this.#fullSetCount(p.id) >= BOUNTY.thirdSetTrigger) {
        this.state.bounties.setsAwarded[p.id] = true;
        this.#placeBounty(p, 'thirdSet');
      }
    }
  }

  /** The next non-bankrupt player after `fromId` in seat order (works if `fromId` just went bankrupt). */
  #nextActivePlayer(fromId) {
    const players = this.state.players;
    const start = players.findIndex((p) => p.id === fromId);
    for (let step = 1; step <= players.length; step++) {
      const candidate = players[(start + step) % players.length];
      if (!candidate.bankrupt) return candidate;
    }
    return null;
  }

  /** After a roll, a buy decision or an auction resolves, decide what the current player does next. */
  #settlePhase() {
    const s = this.state;
    if (s.phase === PHASE.GAME_OVER || s.auction) return;
    if (s.turn.pendingTileId) s.phase = PHASE.BUY_DECISION;
    else if (s.turn.canRollAgain || !s.turn.dice) s.phase = PHASE.AWAITING_ROLL; // no dice yet: a fresh turn
    else s.phase = PHASE.AWAITING_END;
  }

  // =========================================================================
  // Rolling and moving
  // =========================================================================

  #rollDice(reason) {
    let dice = null;
    if (typeof this.diceProvider === 'function') {
      try {
        const custom = this.diceProvider(this.state.currentPlayerId, reason, this);
        if (Array.isArray(custom) && custom.length === 2 &&
            Number.isInteger(custom[0]) && custom[0] >= 1 && custom[0] <= DICE.sides &&
            Number.isInteger(custom[1]) && custom[1] >= 1 && custom[1] <= DICE.sides) {
          dice = [custom[0], custom[1]];
        }
      } catch (err) {
        // Fall back to normal roll on error
      }
    }
    if (!dice) {
      dice = [1 + randomInt(this.rng, DICE.sides), 1 + randomInt(this.rng, DICE.sides)];
    }
    const total = dice[0] + dice[1];
    const doubles = dice[0] === dice[1];
    this.#emit('diceRolled', { playerId: this.state.currentPlayerId, dice, total, doubles, reason });
    return { dice, total, doubles };
  }

  #doRoll(p) {
    const roll = this.#rollDice('move');
    this.state.turn.dice = roll.dice;
    if (p.inJail) this.#rollInJail(p, roll);
    else this.#rollNormally(p, roll);
    this.#settlePhase();
  }

  #rollNormally(p, { total, doubles }) {
    this.state.turn.canRollAgain = doubles;
    if (doubles) {
      p.doublesCount += 1;
      if (p.doublesCount >= DICE.maxDoublesBeforeJail) {
        this.#sendToJail(p, 'tripleDoubles');
        return;
      }
    }
    this.#stepForward(p, total, true);
    this.#resolveLanding(p, { diceTotal: total });
  }

  /** Doubles free you (no extra roll). The 3rd miss forces the fine, then you move. */
  #rollInJail(p, { total, doubles }) {
    this.state.turn.canRollAgain = false;
    if (doubles) {
      this.#leaveJail(p, 'doubles');
    } else {
      p.jailTurns += 1;
      if (p.jailTurns < JAIL.maxTurns) {
        this.#emit('jailRollFailed', { playerId: p.id, attempt: p.jailTurns });
        return;
      }
      this.#transfer(p.id, BANK, JAIL.fine, 'moneyPaid', { reason: 'jailFine' });
      this.#leaveJail(p, 'forced');
    }
    this.#stepForward(p, total, true);
    this.#resolveLanding(p, { diceTotal: total });
  }

  /** Move forward `steps` tiles, paying GO salary when passing or landing on GO. */
  #stepForward(p, steps, collectGo) {
    const from = p.position;
    const passedGo = from + steps >= BOARD_SIZE;
    p.position = (from + steps) % BOARD_SIZE;
    this.state.stats.landings[p.position] += 1;
    this.#emit('moved', { playerId: p.id, from, to: p.position, passedGo });
    if (passedGo && collectGo) {
      const salary = rules.rupees(this.state.settings.goSalary * (this.#eventModifiers().goFactor || 1));
      if (salary > 0) this.#transfer(BANK, p.id, salary, 'moneyCollected', { reason: 'goSalary' });
    }
  }

  #advanceTo(p, target, collectGo) {
    this.#stepForward(p, (target - p.position + BOARD_SIZE) % BOARD_SIZE, collectGo);
  }

  /** Move backwards. Never pays GO salary, even if it wraps past GO. */
  #stepBack(p, steps) {
    const from = p.position;
    p.position = (((from - steps) % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
    this.state.stats.landings[p.position] += 1;
    this.#emit('moved', { playerId: p.id, from, to: p.position, passedGo: false });
  }

  /**
   * Apply the effect of the tile the player is standing on.
   * ctx: { diceTotal, airportMultiplier?, utilityMultiplier? } (the last two come from cards).
   */
  #resolveLanding(p, ctx) {
    const tile = BOARD[p.position];
    if (tile.type === TILE.CITY) this.#applyLandBonus(p, tile);
    switch (tile.type) {
      case TILE.CITY:
      case TILE.AIRPORT:
      case TILE.UTILITY:
        return this.#landOnProperty(p, tile, ctx);
      case TILE.TAX: {
        const amount = this.#eventModifiers().taxFree ? 0 : tile.amount;
        return amount > 0 ? this.#payFine(p, amount, 'taxPaid', { tileId: tile.id }) : undefined;
      }
      case TILE.SURPRISE:
        return this.#drawCard(p, 'surprise');
      case TILE.TREASURE:
        return this.#drawCard(p, 'treasure');
      case TILE.GO_TO_JAIL:
        return this.#sendToJail(p, 'goToJail');
      case TILE.VACATION:
        return this.#collectJackpot(p);
      default:
        return undefined; // GO (salary already paid) and Jail (just visiting)
    }
  }

  /** Tourist Season and friends: the bank pays whoever lands on a matching city. */
  #applyLandBonus(p, tile) {
    const bonus = this.#eventModifiers().landBonus;
    if (bonus && bonus.groups.includes(tile.group)) {
      this.#transfer(BANK, p.id, bonus.amount, 'moneyCollected', { reason: 'worldEvent', tileId: tile.id });
    }
  }

  // =========================================================================
  // Properties: buying and rent
  // =========================================================================

  #landOnProperty(p, tile, ctx) {
    const prop = this.state.properties[tile.id];
    if (!prop.ownerId) {
      this.state.turn.pendingTileId = tile.id;
      this.#emit('purchaseOffered', { playerId: p.id, tileId: tile.id, price: tile.price });
      return;
    }
    if (prop.ownerId === p.id) return;
    if (this.#sameTeam(p.id, prop.ownerId)) return; // teammates don't pay each other rent

    const owner = this.#player(prop.ownerId);
    if (prop.mortgaged || (owner.inJail && !this.state.settings.collectRentInJail)) {
      const reason = prop.mortgaged ? 'mortgaged' : 'ownerInJail';
      this.#emit('rentWaived', { playerId: p.id, ownerId: owner.id, tileId: tile.id, reason });
      return;
    }
    // The "nearest utility" card rolls fresh dice for the rent.
    const diceTotal = tile.type === TILE.UTILITY && ctx.utilityMultiplier ? this.#rollDice('utilityCard').total : ctx.diceTotal;
    const amount = this.#rentFor(tile, { ...ctx, diceTotal });
    const best = this.state.stats.biggestRent;
    if (amount > 0 && (!best || amount > best.amount)) {
      this.state.stats.biggestRent = { amount, from: p.id, to: owner.id, tileId: tile.id, turnNumber: this.state.turnNumber };
    }
    this.#transfer(p.id, owner.id, amount, 'rentPaid', { tileId: tile.id });
    if (this.state.settings.bounties && amount > 0) {
      this.#recordRent(p.id, owner.id, amount);
      if (amount >= this.state.settings.bountyRentThreshold) this.#placeBounty(owner, 'rent');
      this.#claimBountyIfAny(p, owner, tile.id);
    }
  }

  /** Rent owed on an owned, unmortgaged tile (owner checks are done by the caller). */
  #rentFor(tile, ctx) {
    const prop = this.state.properties[tile.id];
    const owned = this.#countOwnedInGroup(prop.ownerId, tile.group);
    let base;
    switch (tile.type) {
      case TILE.CITY:
        base = this.#cityRent(tile, prop);
        break;
      case TILE.AIRPORT:
        base = AIRPORT_RENT[owned - 1] * (ctx.airportMultiplier || 1);
        break;
      case TILE.UTILITY:
        base = ctx.diceTotal * (ctx.utilityMultiplier || UTILITY_MULTIPLIER[owned]);
        break;
      default:
        return 0;
    }
    return rules.rupees(base * this.#rentModifier(tile));
  }

  /** Base city rent, before world-event scaling: buildings, landmarks and the full-set double. */
  #cityRent(tile, prop) {
    const ignoreHouses = this.#eventModifiers().rentNoHouses;
    if (prop.landmark) return this.#landmarkRent(tile);
    if (prop.buildings > 0 && !ignoreHouses) return tile.rent[prop.buildings] * this.#setLandmarkBonus(tile, prop);
    const fullSet = this.state.settings.doubleRentOnFullSet && this.#ownsGroup(prop.ownerId, tile.group);
    return tile.rent[0] * (fullSet ? 2 : 1) * this.#setLandmarkBonus(tile, prop);
  }

  /** Landmark rent: 1.5× the hotel rent, rounded to the nearest ₹5. */
  #landmarkRent(tile) {
    return Math.round((tile.rent[MAX_BUILDINGS] * LANDMARK.rentMultiplier) / LANDMARK.rentRounding) * LANDMARK.rentRounding;
  }

  /** +10% rent on the other cities of a set while a landmark stands on one of them. */
  #setLandmarkBonus(tile, prop) {
    if (prop.landmark || tile.type !== TILE.CITY) return 1;
    const hasLandmark = this.#groupProps(tile.group).some((g) => g.landmark);
    return hasLandmark ? LANDMARK.setBonus : 1;
  }

  #checkBuy(p) {
    return this.#checkTurn(p, PHASE.BUY_DECISION)
      || (p.cash < this.#pendingTile().price ? 'not enough cash' : null);
  }

  #doBuy(p) {
    const tile = this.#pendingTile();
    this.#transfer(p.id, BANK, tile.price, 'propertyBought', { tileId: tile.id });
    this.state.properties[tile.id].ownerId = p.id;
    this.state.turn.pendingTileId = null;
    this.#settlePhase();
  }

  #checkDecline(p) {
    return this.#checkTurn(p, PHASE.BUY_DECISION);
  }

  /** Declining puts the tile up for auction when auctions are on; otherwise it stays unowned. */
  #doDecline(p) {
    const tileId = this.state.turn.pendingTileId;
    this.#emit('purchaseDeclined', { playerId: p.id, tileId });
    this.state.turn.pendingTileId = null;
    if (this.state.settings.auctions) this.#startAuction(tileId, p.id);
    this.#settlePhase();
  }

  #pendingTile() {
    return board.getTileById(this.state.turn.pendingTileId);
  }

  // =========================================================================
  // Building, selling and mortgages
  // =========================================================================

  /**
   * Property management happens on your own turn. A player in debt may also
   * sell and mortgage out of turn, since debts can arise on someone else's
   * turn (e.g. a birthday card).
   */
  #checkManageTurn(p, allowedForDebtors) {
    if (allowedForDebtors && p.cash < 0) return null;
    return this.#checkTurn(p, ...ACTIVE_PHASES);
  }

  /** Resolve action.tileId to a tile the player owns, or an error. */
  #ownedTile(p, tileId) {
    if (typeof tileId !== 'string' || !Object.hasOwn(this.state.properties, tileId)) return { error: 'unknown property' };
    const prop = this.state.properties[tileId];
    if (prop.ownerId !== p.id) return { error: 'you do not own that property' };
    return { tile: board.getTileById(tileId), prop };
  }

  #checkBuild(p, action) {
    const turnError = this.#checkManageTurn(p, false);
    if (turnError) return turnError;
    const { error, tile, prop } = this.#ownedTile(p, action.tileId);
    if (error) return error;
    if (tile.type !== TILE.CITY) return 'you can only build on cities';
    if (!this.#ownsGroup(p.id, tile.group)) return 'you need the whole colour set';
    const set = this.#groupProps(tile.group);
    if (set.some((g) => g.mortgaged)) return 'a property in this set is mortgaged';
    if (prop.buildings >= MAX_BUILDINGS) return 'this city already has a hotel';
    if (prop.buildings > Math.min(...set.map((g) => g.buildings))) return 'build evenly across the set';
    if (p.cash < this.#houseCost(tile)) return 'not enough cash';
    return null;
  }

  /** House/hotel cost, scaled by a Housing Slump or Heatwave event. */
  #houseCost(tile) {
    return rules.rupees(tile.houseCost * (this.#eventModifiers().houseCostFactor || 1));
  }

  #doBuild(p, { tileId }) {
    const tile = board.getTileById(tileId);
    const prop = this.state.properties[tileId];
    prop.buildings += 1;
    this.#transfer(p.id, BANK, this.#houseCost(tile), 'built', { tileId, buildings: prop.buildings });
  }

  #checkSellHouse(p, action) {
    const turnError = this.#checkManageTurn(p, true);
    if (turnError) return turnError;
    const { error, tile, prop } = this.#ownedTile(p, action.tileId);
    if (error) return error;
    if (this.state.settings.landmarks && this.#setHasLandmark(tile.group)) return 'sell the landmark first';
    if (prop.buildings === 0) return 'no buildings to sell';
    if (prop.buildings < Math.max(...this.#groupProps(tile.group).map((g) => g.buildings))) return 'sell evenly across the set';
    return null;
  }

  #doSellHouse(p, { tileId }) {
    const tile = board.getTileById(tileId);
    const prop = this.state.properties[tileId];
    prop.buildings -= 1;
    const refund = rules.rupees(tile.houseCost * BUILDING.sellBackRatio);
    this.#transfer(BANK, p.id, refund, 'houseSold', { tileId, buildings: prop.buildings });
  }

  #checkMortgage(p, action) {
    const turnError = this.#checkManageTurn(p, true);
    if (turnError) return turnError;
    const { error, tile, prop } = this.#ownedTile(p, action.tileId);
    if (error) return error;
    if (prop.mortgaged) return 'already mortgaged';
    if (this.#groupProps(tile.group).some((g) => g.buildings > 0)) return 'sell every building in the set first';
    return null;
  }

  #doMortgage(p, { tileId }) {
    this.state.properties[tileId].mortgaged = true;
    this.#transfer(BANK, p.id, board.getTileById(tileId).mortgageValue, 'mortgaged', { tileId });
  }

  #checkUnmortgage(p, action) {
    const turnError = this.#checkManageTurn(p, false);
    if (turnError) return turnError;
    const { error, tile, prop } = this.#ownedTile(p, action.tileId);
    if (error) return error;
    if (!prop.mortgaged) return 'not mortgaged';
    if (p.cash < rules.unmortgageCost(tile.price)) return 'not enough cash';
    return null;
  }

  #doUnmortgage(p, { tileId }) {
    const cost = rules.unmortgageCost(board.getTileById(tileId).price);
    this.#transfer(p.id, BANK, cost, 'unmortgaged', { tileId });
    this.state.properties[tileId].mortgaged = false;
  }

  // =========================================================================
  // Landmarks (optional mode)
  // =========================================================================

  #landmarkCost(tile) {
    return rules.rupees(tile.houseCost * LANDMARK.costMultiplier);
  }

  /** Does the set have a hotel on every city (the prerequisite for a landmark)? */
  #setFullyBuilt(group) {
    return this.#groupProps(group).every((g) => g.buildings === MAX_BUILDINGS);
  }

  #setHasLandmark(group) {
    return this.#groupProps(group).some((g) => g.landmark);
  }

  #checkBuildLandmark(p, action) {
    if (!this.state.settings.landmarks) return 'landmarks are not enabled';
    const turnError = this.#checkManageTurn(p, false);
    if (turnError) return turnError;
    const { error, tile, prop } = this.#ownedTile(p, action.tileId);
    if (error) return error;
    if (tile.type !== TILE.CITY) return 'landmarks are built on cities';
    if (!this.#ownsGroup(p.id, tile.group)) return 'you need the whole colour set';
    if (!this.#setFullyBuilt(tile.group)) return 'every city in the set needs a hotel first';
    if (this.#setHasLandmark(tile.group)) return 'this set already has a landmark';
    if (prop.landmark) return 'this city already has a landmark';
    if (p.cash < this.#landmarkCost(tile)) return 'not enough cash';
    return null;
  }

  #doBuildLandmark(p, { tileId }) {
    const tile = board.getTileById(tileId);
    this.state.properties[tileId].landmark = true;
    this.#transfer(p.id, BANK, this.#landmarkCost(tile), 'landmarkBuilt', { tileId, group: tile.group });
  }

  #checkSellLandmark(p, action) {
    const turnError = this.#checkManageTurn(p, true); // debtors may sell to raise cash
    if (turnError) return turnError;
    const { error, prop } = this.#ownedTile(p, action.tileId);
    if (error) return error;
    if (!prop.landmark) return 'no landmark here';
    return null;
  }

  #doSellLandmark(p, { tileId }) {
    const tile = board.getTileById(tileId);
    this.state.properties[tileId].landmark = false;
    const refund = rules.rupees(this.#landmarkCost(tile) * LANDMARK.sellBackRatio);
    this.#transfer(BANK, p.id, refund, 'landmarkSold', { tileId, group: tile.group });
  }

  // =========================================================================
  // Teams (optional mode)
  // =========================================================================

  /** The team letter ('A' | 'B') a player is on, or null when teams are off. */
  #teamOf(playerId) {
    if (!this.state.settings.teams) return null;
    const p = this.#player(playerId);
    return (p && p.team) || null;
  }

  #sameTeam(a, b) {
    const ta = this.#teamOf(a);
    return ta !== null && ta === this.#teamOf(b);
  }

  /** True when b is a (non-null) owner who is a, or a's teammate. */
  #sameTeamOrSelf(a, b) {
    return b != null && (a === b || this.#sameTeam(a, b));
  }

  /** Living teammates of a player (excluding themselves). */
  #teammates(playerId) {
    return this.state.players.filter((o) => o.id !== playerId && !o.bankrupt && this.#sameTeam(playerId, o.id));
  }

  #checkSendToTeammate(p, action) {
    if (!this.state.settings.teams) return 'teams are not enabled';
    const turnError = this.#checkManageTurn(p, true); // allowed any time it's your management window or you're in debt
    if (turnError) return turnError;
    if (p.cash < 0) return 'clear your debt first';
    const to = this.#player(action.toId);
    if (!to || to.bankrupt) return 'pick a teammate';
    if (!this.#sameTeam(p.id, to.id)) return 'you can only send to a teammate';
    const g = trades.normalizeSide(action.give || {});
    if (g.error) return g.error;
    if (trades.isEmptySide(g.side)) return 'send some cash or a property';
    if (g.side.jailCards.length) return 'jail-free cards cannot be sent this way';
    if (g.side.cash > p.cash) return `you don't have ${formatRupees(g.side.cash)}`;
    for (const tileId of g.side.tileIds) {
      const problem = trades.tileProblem(this.state, p.id, tileId);
      if (problem) return problem;
    }
    return null;
  }

  #doSendToTeammate(p, action) {
    const to = this.#player(action.toId);
    const side = trades.normalizeSide(action.give).side;
    // Re-validate tiles and cash; silently drop anything no longer valid.
    const tiles = side.tileIds.filter((id) => !trades.tileProblem(this.state, p.id, id));
    const cash = Math.min(side.cash, Math.max(0, p.cash));
    if (cash > 0) this.#transfer(p.id, to.id, cash, 'teammateGift', { toId: to.id });
    for (const tileId of tiles) {
      const prop = this.state.properties[tileId];
      prop.ownerId = to.id;
      this.#emit('propertyTransferred', { tileId, from: p.id, to: to.id, mortgaged: prop.mortgaged, reason: 'teammate' });
    }
  }

  #groupProps(group) {
    return board.groupMembers(group).map((i) => this.state.properties[BOARD[i].id]);
  }

  #countOwnedInGroup(ownerId, group) {
    return this.#groupProps(group).filter((g) => g.ownerId === ownerId).length;
  }

  /**
   * Owns the whole colour set. In team mode a teammate's tiles count towards
   * the set (for building, landmarks and the full-set rent bonus); with teams
   * off this is just single-player ownership.
   */
  #ownsGroup(ownerId, group) {
    return board.groupMembers(group).every((i) => this.#sameTeamOrSelf(ownerId, this.state.properties[BOARD[i].id].ownerId));
  }

  /** [tile, prop] pairs for everything a player owns. */
  #holdings(playerId) {
    return OWNABLE_TILES
      .filter((t) => this.state.properties[t.id].ownerId === playerId)
      .map((t) => [t, this.state.properties[t.id]]);
  }

  // =========================================================================
  // Jail
  // =========================================================================

  #sendToJail(p, reason) {
    p.position = JAIL_INDEX;
    this.state.stats.landings[JAIL_INDEX] += 1;
    p.inJail = true;
    p.jailTurns = 0;
    p.doublesCount = 0;
    this.state.turn.canRollAgain = false;
    this.#emit('sentToJail', { playerId: p.id, reason });
  }

  #leaveJail(p, method) {
    p.inJail = false;
    p.jailTurns = 0;
    this.#emit('leftJail', { playerId: p.id, method });
  }

  #checkJailOption(p) {
    return this.#checkTurn(p, PHASE.AWAITING_ROLL) || (p.inJail ? null : 'you are not in jail');
  }

  #checkPayJailFine(p) {
    return this.#checkJailOption(p) || (p.cash < JAIL.fine ? 'not enough cash' : null);
  }

  #doPayJailFine(p) {
    this.#transfer(p.id, BANK, JAIL.fine, 'moneyPaid', { reason: 'jailFine' });
    this.#leaveJail(p, 'fine');
  }

  #checkUseJailCard(p) {
    return this.#checkJailOption(p) || (p.jailFreeCards.length ? null : 'you have no jail-free card');
  }

  #doUseJailCard(p) {
    const card = p.jailFreeCards.shift();
    this.state.decks[card.deck].push(card.cardId);
    this.#leaveJail(p, 'card');
  }

  // =========================================================================
  // Cards
  // =========================================================================

  /** Draw from the top; the card goes to the bottom unless the player keeps it. */
  #drawCard(p, deck) {
    if (typeof this.cardHook === 'function') {
      try {
        this.cardHook(deck, this.state.decks[deck], p, this);
      } catch (err) {
        // Ignore hook error
      }
    }
    const cardId = this.state.decks[deck].shift();
    const card = getCard(deck, cardId);
    if (card.effect.kind === 'jailFree') p.jailFreeCards.push({ deck, cardId });
    else this.state.decks[deck].push(cardId);
    this.state.lastCard = { deck, cardId, playerId: p.id };
    this.#emit('cardDrawn', { playerId: p.id, deck, cardId, text: card.text, kind: card.effect.kind });
    this.#applyCard(p, card);
  }

  #applyCard(p, { id: cardId, effect }) {
    const meta = { reason: 'card', cardId };
    switch (effect.kind) {
      case 'collect':
        return this.#transfer(BANK, p.id, effect.amount, 'moneyCollected', meta);
      case 'pay':
        return this.#payFine(p, effect.amount, 'moneyPaid', meta);
      case 'collectFromEach':
        for (const other of this.#opponents(p)) this.#transfer(other.id, p.id, effect.amount, 'moneyPaid', meta);
        return undefined;
      case 'payEach':
        for (const other of this.#opponents(p)) this.#transfer(p.id, other.id, effect.amount, 'moneyPaid', meta);
        return undefined;
      case 'moveTo':
        this.#advanceTo(p, board.getTileById(effect.tileId).index, effect.collectGo);
        return this.#resolveLanding(p, { diceTotal: this.#lastDiceTotal() });
      case 'moveBy':
        if (effect.steps < 0) this.#stepBack(p, -effect.steps);
        else this.#stepForward(p, effect.steps, true);
        return this.#resolveLanding(p, { diceTotal: this.#lastDiceTotal() });
      case 'nearest':
        return this.#moveToNearest(p, effect);
      case 'goToJail':
        return this.#sendToJail(p, 'card');
      case 'repairs':
        return this.#payFine(p, this.#repairBill(p.id, effect), 'moneyPaid', meta);
      case 'jailFree':
      default:
        return undefined; // jail-free cards were already put in the player's hand
    }
  }

  /** Nearest airport: double rent. Nearest utility: fresh dice × multiplier. */
  #moveToNearest(p, { tileType, rentMultiplier }) {
    this.#advanceTo(p, board.nearestAhead(p.position, tileType), true);
    const ctx = { diceTotal: this.#lastDiceTotal() };
    if (tileType === TILE.AIRPORT) ctx.airportMultiplier = rentMultiplier;
    if (tileType === TILE.UTILITY) ctx.utilityMultiplier = rentMultiplier;
    this.#resolveLanding(p, ctx);
  }

  #repairBill(playerId, { perHouse, perHotel }) {
    let bill = 0;
    for (const [, prop] of this.#holdings(playerId)) {
      bill += prop.buildings === MAX_BUILDINGS ? perHotel : prop.buildings * perHouse;
    }
    return bill;
  }

  #lastDiceTotal() {
    const dice = this.state.turn.dice;
    return dice ? dice[0] + dice[1] : 0;
  }

  #opponents(p) {
    return this.state.players.filter((o) => o !== p && !o.bankrupt);
  }

  // =========================================================================
  // Money
  // =========================================================================

  /**
   * Move money between parties (player id, BANK or JACKPOT) and emit one event.
   * A player who can't cover it pays what they have and owes the rest.
   */
  #transfer(fromId, toId, amount, eventType, extra = {}) {
    if (!(amount > 0)) return;
    this.#emit(eventType, { from: fromId, to: toId, amount, ...extra });
    if (fromId === BANK) {
      this.#receive(toId, amount);
      return;
    }
    if (fromId === JACKPOT) {
      this.state.jackpot -= amount;
      this.#receive(toId, amount);
      return;
    }
    const payer = this.#player(fromId);
    const paid = Math.min(amount, Math.max(0, payer.cash));
    payer.cash -= amount;
    this.#receive(toId, paid);
    if (amount > paid) this.#addDebt(payer, toId, amount - paid);
  }

  #receive(partyId, amount) {
    if (amount <= 0 || partyId === BANK) return;
    if (partyId === JACKPOT) this.state.jackpot += amount;
    else this.#credit(this.#player(partyId), amount);
  }

  /** Give a player money. If they're in debt it goes straight on to their creditors. */
  #credit(p, amount) {
    const wasInDebt = p.debt.owed.length > 0;
    p.cash += amount;
    let remaining = amount;
    while (remaining > 0 && p.debt.owed.length) {
      const entry = p.debt.owed[0];
      const part = Math.min(remaining, entry.amount);
      entry.amount -= part;
      remaining -= part;
      if (entry.amount === 0) p.debt.owed.shift();
      this.#syncDebt(p);
      this.#emit('debtPaid', { from: p.id, to: entry.creditorId, amount: part });
      this.#receive(entry.creditorId, part);
    }
    this.#syncDebt(p);
    if (wasInDebt && !p.debt.owed.length) this.#emit('debtCleared', { playerId: p.id });
  }

  #addDebt(p, creditorId, amount) {
    const last = p.debt.owed[p.debt.owed.length - 1];
    if (last && last.creditorId === creditorId) last.amount += amount;
    else p.debt.owed.push({ creditorId, amount });
    this.#syncDebt(p);
    this.#emit('debtIncurred', { from: p.id, to: creditorId, amount });
  }

  /** Keep the summary fields in step with the queue of owed amounts. */
  #syncDebt(p) {
    p.debt.amount = sum(p.debt.owed.map((e) => e.amount));
    p.debt.creditorId = p.debt.owed.length ? p.debt.owed[0].creditorId : null;
  }

  /** Taxes and card fines: to the bank, or into the jackpot when that setting is on. */
  #payFine(p, amount, eventType, extra) {
    const to = this.state.settings.vacationJackpot ? JACKPOT : BANK;
    this.#transfer(p.id, to, amount, eventType, extra);
  }

  #collectJackpot(p) {
    const amount = this.state.jackpot;
    if (amount > 0) this.#transfer(JACKPOT, p.id, amount, 'jackpotCollected');
  }

  // =========================================================================
  // Bankruptcy and game over
  // =========================================================================

  #checkBankrupt(p) {
    return p.cash < 0 ? null : 'you can only declare bankruptcy while in debt';
  }

  /**
   * Remove a player from play. Their assets go to the creditor of their oldest
   * debt if that's a live player, otherwise back to the bank.
   */
  #declareBankruptcy(p, reason, { toBank = false } = {}) {
    let creditor = toBank ? null : this.#player(p.debt.creditorId);
    let creditorId = creditor && !creditor.bankrupt ? creditor.id : BANK;
    // Team mode: assets that would go to the bank go to a living teammate instead.
    if (creditorId === BANK && this.state.settings.teams) {
      const mate = this.#teammates(p.id)[0];
      if (mate) { creditor = mate; creditorId = mate.id; }
    }
    if (creditorId === BANK) this.#surrenderToBank(p);
    else this.#surrenderToPlayer(p, creditor);

    this.#forgiveDebts(p, () => true);
    for (const other of this.state.players) this.#forgiveDebts(other, (entry) => entry.creditorId === p.id);
    p.bankrupt = true;
    p.inJail = false;
    p.jailTurns = 0;
    p.doublesCount = 0;
    this.#leaveAuction(p);
    if (this.state.settings.bounties) {
      delete this.state.bounties.onPlayer[p.id];
      // A bounty is for bankrupting a rival, not for a teammate inheriting assets.
      if (creditorId !== BANK && !this.#sameTeam(p.id, creditorId)) this.#placeBounty(this.#player(creditorId), 'bankruptcy');
    }
    this.#emit('bankrupt', { playerId: p.id, creditorId, reason });
    // Team mode: a bankruptcy can split a built set across teams; sell back the stranded buildings.
    if (this.state.settings.teams) this.#reconcileStrandedBuildings();

    const survivors = this.state.players.filter((o) => !o.bankrupt);
    if (this.#gameIsWon(survivors)) return this.#endGame(survivors);
    if (this.state.currentPlayerId === p.id) this.#beginTurn(this.#nextActivePlayer(p.id));
    this.#endAuctionIfDecided();
    return undefined;
  }

  /**
   * After a team-mode bankruptcy a built colour set may be split across teams
   * (one teammate's tiles went to an opponent). Such stranded buildings and
   * landmarks are sold back to the bank, their owners refunded, as if the set
   * had been broken up.
   */
  #reconcileStrandedBuildings() {
    for (const group of CITY_GROUPS) {
      const indexes = board.groupMembers(group);
      const props = indexes.map((i) => this.state.properties[BOARD[i].id]);
      if (!props.some((pr) => pr.buildings > 0 || pr.landmark)) continue;
      const anchor = props.map((pr) => pr.ownerId).find(Boolean);
      const whole = props.every((pr) => this.#sameTeamOrSelf(anchor, pr.ownerId));
      const counts = props.map((pr) => pr.buildings);
      const even = Math.max(...counts) - Math.min(...counts) <= 1;
      // A set that is still one team's and evenly built is fine; otherwise clear its buildings.
      if (whole && even) continue;
      indexes.forEach((i, k) => {
        const tile = BOARD[i];
        const prop = props[k];
        if (prop.landmark) {
          prop.landmark = false;
          this.#transfer(BANK, prop.ownerId, rules.rupees(this.#landmarkCost(tile) * LANDMARK.sellBackRatio), 'landmarkSold', { tileId: tile.id, reason: 'setBroken' });
        }
        if (prop.buildings > 0) {
          const refund = rules.rupees(prop.buildings * tile.houseCost * BUILDING.sellBackRatio);
          prop.buildings = 0;
          this.#transfer(BANK, prop.ownerId, refund, 'houseSold', { tileId: tile.id, buildings: 0, reason: 'setBroken' });
        }
      });
    }
  }

  /** Buildings sell back at half value, then cash, property and cards pass to the creditor. */
  #surrenderToPlayer(p, creditor) {
    for (const [tile, prop] of this.#holdings(p.id)) {
      prop.landmark = false; // a landmark cannot stand on a tile about to change hands
      if (prop.buildings === 0) continue;
      const refund = rules.rupees(prop.buildings * tile.houseCost * BUILDING.sellBackRatio);
      prop.buildings = 0;
      this.#transfer(BANK, p.id, refund, 'houseSold', { tileId: tile.id, buildings: 0, reason: 'bankruptcy' });
    }
    if (p.cash > 0) this.#transfer(p.id, creditor.id, p.cash, 'moneyPaid', { reason: 'bankruptcy' });
    for (const [tile, prop] of this.#holdings(p.id)) {
      prop.ownerId = creditor.id;
      this.#emit('propertyTransferred', { tileId: tile.id, from: p.id, to: creditor.id, mortgaged: prop.mortgaged });
    }
    creditor.jailFreeCards.push(...p.jailFreeCards);
    p.jailFreeCards = [];
  }

  /** Buildings vanish, property returns unowned and unmortgaged, cards go back to their decks. */
  #surrenderToBank(p) {
    for (const [tile, prop] of this.#holdings(p.id)) {
      Object.assign(prop, { ownerId: null, buildings: 0, mortgaged: false, landmark: false });
      this.#emit('propertyReturned', { tileId: tile.id, from: p.id });
    }
    for (const card of p.jailFreeCards) this.state.decks[card.deck].push(card.cardId);
    p.jailFreeCards = [];
    if (p.cash > 0) this.#transfer(p.id, BANK, p.cash, 'moneyPaid', { reason: 'bankruptcy' });
  }

  /**
   * Cancel matching debts. Negative cash is an IOU, not money, so cancelling
   * one just raises cash back towards zero; no money is created.
   */
  #forgiveDebts(p, matches) {
    const kept = [];
    for (const entry of p.debt.owed) {
      if (!matches(entry)) {
        kept.push(entry);
        continue;
      }
      p.cash += entry.amount;
      this.#emit('debtForgiven', { from: p.id, to: entry.creditorId, amount: entry.amount });
    }
    p.debt.owed = kept;
    this.#syncDebt(p);
  }

  /** The game is over when one side is left: one player normally, or one team in team mode. */
  #gameIsWon(survivors) {
    if (this.state.settings.teams) return new Set(survivors.map((p) => p.team)).size <= 1;
    return survivors.length <= 1;
  }

  /** `survivors` is the list of players still in; in team mode the winner is a team, not a player. */
  #endGame(survivors) {
    const s = this.state;
    // Any open trades (possible in team mode, between surviving teammates) are closed.
    for (const t of [...s.trades]) this.#closeTrade(t, 'tradeCancelled', { reason: 'game over' });
    s.phase = PHASE.GAME_OVER;
    s.currentPlayerId = null;
    if (s.settings.teams) {
      s.winnerTeam = survivors.length ? survivors[0].team : null;
      // The richest survivor stands in as the named winner (for the token highlight).
      s.winnerId = survivors.reduce((best, p) => (!best || board.netWorth(p, s.properties) > board.netWorth(best, s.properties) ? p : best), null)?.id || null;
    } else {
      s.winnerId = survivors.length ? survivors[0].id : null;
    }
    s.turn = Game.#freshTurn();
    s.auction = null;
    this.#recordWorth(true);
    this.#emit('gameOver', { winnerId: s.winnerId, winnerTeam: s.winnerTeam });
  }

  /** Snapshot everyone's net worth (every `worthEvery` turns, thinned to MAX_WORTH_POINTS). */
  #recordWorth(force) {
    const s = this.state;
    const st = s.stats;
    if (!force && s.turnNumber % st.worthEvery !== 0) return;
    st.worth.push({ turnNumber: s.turnNumber, worth: s.players.map((p) => (p.bankrupt ? 0 : board.netWorth(p, s.properties))) });
    if (st.worth.length > MAX_WORTH_POINTS) {
      st.worth = st.worth.filter((_, i) => i % 2 === 0);
      st.worthEvery *= 2;
    }
  }

  // =========================================================================
  // Auctions
  // =========================================================================

  #startAuction(tileId, startedBy) {
    const s = this.state;
    s.auction = {
      tileId,
      highBid: 0,
      highBidderId: null,
      bidders: s.players.filter((p) => !p.bankrupt).map((p) => p.id), // still in: not passed
      startedBy,
    };
    s.phase = PHASE.AUCTION;
    this.#emit('auctionStarted', { tileId, startedBy });
  }

  #minBid() {
    return this.state.auction.highBid + AUCTION.minIncrement;
  }

  #checkBid(p, { amount }) {
    const a = this.state.auction;
    if (!a) return 'no auction is running';
    if (!a.bidders.includes(p.id)) return 'you have passed on this auction';
    if (p.cash < 0) return 'clear your debt before bidding';
    if (a.highBidderId === p.id) return 'you already hold the high bid';
    if (!Number.isInteger(amount)) return 'a bid must be a whole number of rupees';
    if (amount < this.#minBid()) return `bid at least ${formatRupees(this.#minBid())}`;
    if (amount > p.cash) return "you can't bid more than your cash";
    return null;
  }

  #doBid(p, { amount }) {
    const a = this.state.auction;
    a.highBid = amount;
    a.highBidderId = p.id;
    this.#emit('bidPlaced', { playerId: p.id, tileId: a.tileId, amount });
  }

  #checkPass(p) {
    const a = this.state.auction;
    if (!a) return 'no auction is running';
    if (!a.bidders.includes(p.id)) return 'you have already passed';
    if (a.highBidderId === p.id) return 'you hold the high bid';
    return null;
  }

  #doPass(p) {
    const a = this.state.auction;
    a.bidders = a.bidders.filter((id) => id !== p.id);
    this.#emit('auctionPassed', { playerId: p.id, tileId: a.tileId });
    this.#endAuctionIfDecided();
  }

  /** A bankrupt player drops out; if they held the high bid, the price stays but nobody holds it. */
  #leaveAuction(p) {
    const a = this.state.auction;
    if (!a || !a.bidders.includes(p.id)) return;
    a.bidders = a.bidders.filter((id) => id !== p.id);
    if (a.highBidderId === p.id) a.highBidderId = null;
  }

  /** End early once everyone except the high bidder has passed (or everyone has, with no bids). */
  #endAuctionIfDecided() {
    const a = this.state.auction;
    if (!a) return;
    const challengers = a.bidders.filter((id) => id !== a.highBidderId);
    if (challengers.length === 0 && (a.highBidderId || a.bidders.length === 0)) this.#finishAuction();
  }

  #finishAuction() {
    const s = this.state;
    const a = s.auction;
    s.auction = null;
    if (a.highBidderId) {
      this.#transfer(a.highBidderId, BANK, a.highBid, 'auctionClosed', { tileId: a.tileId, winnerId: a.highBidderId });
      s.properties[a.tileId].ownerId = a.highBidderId;
    } else {
      this.#emit('auctionClosed', { tileId: a.tileId, winnerId: null });
    }
    this.#settlePhase();
  }

  // =========================================================================
  // Trades
  // =========================================================================

  #findTrade(tradeId) {
    return typeof tradeId === 'string' ? this.state.trades.find((t) => t.id === tradeId) : undefined;
  }

  /** Read { toId, give, get } from an action. Returns { trade } or { error }. */
  #readOffer(fromId, { toId, give, get }) {
    const g = trades.normalizeSide(give);
    if (g.error) return g;
    const r = trades.normalizeSide(get);
    if (r.error) return r;
    if (typeof toId !== 'string' || toId === fromId) return { error: 'pick another player to trade with' };
    return { trade: { fromId, toId, give: g.side, get: r.side } };
  }

  #checkNewTrade(trade) {
    const open = this.state.trades.filter((t) => t.fromId === trade.fromId).length;
    if (open >= TRADE.maxOpenPerPlayer) return `you already have ${TRADE.maxOpenPerPlayer} open trade proposals`;
    return trades.tradeProblem(this.state, trade);
  }

  #checkProposeTrade(p, action) {
    if (p.cash < 0) return 'clear your debt before proposing a trade';
    const offer = this.#readOffer(p.id, action);
    return offer.error || this.#checkNewTrade(offer.trade);
  }

  #doProposeTrade(p, action) {
    this.#openTrade(this.#readOffer(p.id, action).trade);
  }

  #openTrade(trade) {
    const s = this.state;
    const open = { id: `t${++s.tradeSeq}`, ...trade, status: 'open', createdAt: this.now() };
    s.trades.push(open);
    this.#emit('tradeProposed', { tradeId: open.id, fromId: open.fromId, toId: open.toId, give: open.give, get: open.get });
  }

  #checkRecipient(p, { tradeId }) {
    const t = this.#findTrade(tradeId);
    if (!t) return 'that trade is no longer open';
    return t.toId === p.id ? null : 'only the player it was offered to can answer it';
  }

  #checkProposer(p, { tradeId }) {
    const t = this.#findTrade(tradeId);
    if (!t) return 'that trade is no longer open';
    return t.fromId === p.id ? null : 'only the player who proposed it can cancel it';
  }

  /**
   * Accepting re-checks the trade (an invalid one is cancelled in #doAcceptTrade)
   * and that both sides can pay the 10% fee on any mortgaged tiles they receive,
   * after the cash in the trade has changed hands. The fee never creates debt.
   */
  #checkAcceptTrade(p, action) {
    const error = this.#checkRecipient(p, action);
    if (error) return error;
    const t = this.#findTrade(action.tradeId);
    if (trades.tradeProblem(this.state, t)) return null;
    const from = this.#player(t.fromId);
    const fromFee = this.#mortgageFeesFor(t.get.tileIds);
    const toFee = this.#mortgageFeesFor(t.give.tileIds);
    if (toFee > 0 && toFee > p.cash + t.give.cash - t.get.cash) return `you can't afford the ${formatRupees(toFee)} fee on mortgaged cities`;
    if (fromFee > 0 && fromFee > from.cash - t.give.cash + t.get.cash) return `${from.name} can't afford the ${formatRupees(fromFee)} fee on mortgaged cities`;
    return null;
  }

  /** Total mortgage transfer fee for receiving these tiles, or 0 under a Trade Fair event. */
  #mortgageFeesFor(tileIds) {
    return this.#eventModifiers().tradeFeeWaived ? 0 : trades.mortgageFees(this.state, tileIds);
  }

  /** The swap is atomic: everything was checked before anything moves. */
  #doAcceptTrade(p, { tradeId }) {
    const t = this.#findTrade(tradeId);
    const problem = trades.tradeProblem(this.state, t);
    if (problem) return this.#closeTrade(t, 'tradeCancelled', { reason: problem });
    this.#closeTrade(t, 'tradeAccepted', { give: t.give, get: t.get });
    if (t.give.cash) this.#transfer(t.fromId, t.toId, t.give.cash, 'tradePayment', { tradeId });
    if (t.get.cash) this.#transfer(t.toId, t.fromId, t.get.cash, 'tradePayment', { tradeId });
    this.#handOver(t.give, t.fromId, t.toId);
    this.#handOver(t.get, t.toId, t.fromId);
    return undefined;
  }

  /** Move tiles and jail-free cards; the receiver pays the fee on mortgaged tiles. */
  #handOver(side, fromId, toId) {
    for (const tileId of side.tileIds) {
      const prop = this.state.properties[tileId];
      prop.ownerId = toId;
      this.#emit('propertyTransferred', { tileId, from: fromId, to: toId, mortgaged: prop.mortgaged, reason: 'trade' });
      const fee = this.#eventModifiers().tradeFeeWaived ? 0 : trades.transferFee(board.getTileById(tileId));
      if (prop.mortgaged && fee > 0) this.#transfer(toId, BANK, fee, 'mortgageFee', { tileId });
    }
    const giver = this.#player(fromId);
    const taker = this.#player(toId);
    for (const cardId of side.jailCards) {
      const card = giver.jailFreeCards.find((c) => c.cardId === cardId);
      giver.jailFreeCards = giver.jailFreeCards.filter((c) => c !== card);
      taker.jailFreeCards.push(card);
    }
  }

  #doDeclineTrade(p, { tradeId }) {
    this.#closeTrade(this.#findTrade(tradeId), 'tradeDeclined');
  }

  #doCancelTrade(p, { tradeId }) {
    this.#closeTrade(this.#findTrade(tradeId), 'tradeCancelled', { reason: 'withdrawn' });
  }

  /** A counter declines the trade and proposes a new one the other way (by default the mirror image). */
  #counterOffer(p, action) {
    const original = this.#findTrade(action.tradeId);
    if (action.give === undefined && action.get === undefined) {
      return { trade: { fromId: p.id, toId: original.fromId, give: original.get, get: original.give } };
    }
    return this.#readOffer(p.id, { toId: original.fromId, give: action.give, get: action.get });
  }

  #checkCounterTrade(p, action) {
    const error = this.#checkRecipient(p, action);
    if (error) return error;
    if (p.cash < 0) return 'clear your debt before proposing a trade';
    const offer = this.#counterOffer(p, action);
    return offer.error || this.#checkNewTrade(offer.trade);
  }

  #doCounterTrade(p, action) {
    const offer = this.#counterOffer(p, action);
    this.#closeTrade(this.#findTrade(action.tradeId), 'tradeDeclined', { countered: true });
    this.#openTrade(offer.trade);
  }

  #closeTrade(trade, eventType, extra = {}) {
    this.state.trades = this.state.trades.filter((t) => t !== trade);
    this.#emit(eventType, { tradeId: trade.id, fromId: trade.fromId, toId: trade.toId, ...extra });
  }

  /** Cancel every open trade that is no longer valid (tile changed hands, player out, buildings, cash…). */
  #sweepTrades() {
    for (const t of [...this.state.trades]) {
      const problem = trades.tradeProblem(this.state, t);
      if (problem) this.#closeTrade(t, 'tradeCancelled', { reason: problem });
    }
  }

  // =========================================================================
  // Lookups
  // =========================================================================

  #player(id) {
    return typeof id === 'string' ? this.state.players.find((p) => p.id === id) : undefined;
  }
}

module.exports = { Game, ACTIONS, PHASE, BANK, JACKPOT };
