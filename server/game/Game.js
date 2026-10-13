'use strict';

/**
 * Rupee Rush game engine.
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
 *   bankrupt, gameOver.
 */

const board = require('../../shared/board');
const { DECKS, getCard } = require('../../shared/cards');
const rules = require('../../shared/rules');
const { createRng, randomSeed, randomInt, shuffle } = require('./rng');
const { ACTIONS, NOT_IMPLEMENTED, TILE_ACTIONS, PHASE, BANK, JACKPOT } = require('./actions');

const { BOARD, BOARD_SIZE, TILE, AIRPORT_RENT, UTILITY_MULTIPLIER, MAX_BUILDINGS, JAIL_INDEX } = board;
const { JAIL, DICE, BUILDING, ROOM, PLAYER_COLORS } = rules;

const STATE_VERSION = 1;
const MAX_ID_LENGTH = 64;
const ACTIVE_PHASES = [PHASE.AWAITING_ROLL, PHASE.BUY_DECISION, PHASE.AWAITING_END];
const OWNABLE_TILES = BOARD.filter(board.isOwnable);

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
   * @param {number}   [opts.seed]     used to build a mulberry32 rng when `rng` is omitted
   * @param {Function} [opts.now]      clock returning ms since epoch
   */
  constructor({ settings, rng, seed, now } = {}) {
    this.now = typeof now === 'function' ? now : Date.now;
    this.rng = rng || createRng(seed ?? randomSeed());
    const clean = rules.sanitizeSettings(isObject(settings) ? settings : {});
    this.state = Game.#initialState(clean, this.rng.seed ?? null, this.now());
  }

  static #initialState(settings, seed, createdAt) {
    const properties = {};
    for (const tile of OWNABLE_TILES) properties[tile.id] = { ownerId: null, buildings: 0, mortgaged: false };
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
      players: [],
      properties,
      decks: { surprise: [], treasure: [] },
      jackpot: 0,
      turn: Game.#freshTurn(),
      lastCard: null,
    };
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

  /** Full state for saving, including the hidden deck order and the rng state. */
  toJSON() {
    const rngState = typeof this.rng.getState === 'function' ? this.rng.getState() : null;
    return { ...cloneData(this.state), rngState };
  }

  /** Restore a game saved with toJSON(). Throws on data that isn't a saved game. */
  static fromJSON(data, { rng, now } = {}) {
    if (!isObject(data) || data.version !== STATE_VERSION || !Array.isArray(data.players)) {
      throw new Error('Game.fromJSON: not a saved Rupee Rush game');
    }
    const { rngState, ...state } = cloneData(data);
    let restoredRng = rng;
    if (!restoredRng) {
      restoredRng = createRng(state.seed ?? 0);
      if (rngState != null) restoredRng.setState(rngState);
    }
    const game = new Game({ settings: state.settings, rng: restoredRng, now });
    game.state = state;
    return game;
  }

  /**
   * What clients may see: everything except the remaining deck order and the
   * seed / rng state, either of which would let a client predict dice and cards.
   */
  publicState() {
    const { seed, decks, ...visible } = cloneData(this.state);
    return {
      ...visible,
      decks: { surprise: { remaining: decks.surprise.length }, treasure: { remaining: decks.treasure.length } },
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
    [ACTIONS.PAY_JAIL_FINE]: { check: (g, p) => g.#checkPayJailFine(p), run: (g, p) => g.#doPayJailFine(p) },
    [ACTIONS.USE_JAIL_CARD]: { check: (g, p) => g.#checkUseJailCard(p), run: (g, p) => g.#doUseJailCard(p) },
    [ACTIONS.BANKRUPT]: { check: (g, p) => g.#checkBankrupt(p), run: (g, p) => g.#declareBankruptcy(p, 'debt') },
  };

  /** Checks shared by every action, then the action's own check. */
  #checkAction(player, action) {
    if (!player) return 'unknown player';
    if (this.state.phase === PHASE.LOBBY) return 'game has not started';
    if (this.state.phase === PHASE.GAME_OVER) return 'game is over';
    if (player.bankrupt) return 'you are bankrupt';
    return Game.#HANDLERS[action.type].check(this, player, action);
  }

  /** Every syntactically possible action for this player; getLegalActions filters them. */
  #candidateActions(player) {
    const list = SIMPLE_ACTIONS.map((type) => ({ type }));
    for (const tile of OWNABLE_TILES) {
      if (this.state.properties[tile.id].ownerId !== player.id) continue;
      for (const type of TILE_ACTIONS) list.push({ type, tileId: tile.id });
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

  #doAddPlayer({ id, name, color }) {
    const players = this.state.players;
    const cleanName = typeof name === 'string' ? name.trim().slice(0, ROOM.nameMaxLength) : '';
    const player = {
      id,
      name: cleanName || `Player ${players.length + 1}`,
      color: this.#pickColor(color),
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
    this.#emit('playerJoined', { playerId: id, name: player.name, color: player.color });
  }

  #pickColor(requested) {
    const taken = new Set(this.state.players.map((p) => p.color));
    if (PLAYER_COLORS.includes(requested) && !taken.has(requested)) return requested;
    return PLAYER_COLORS.find((c) => !taken.has(c));
  }

  #checkStart() {
    if (this.state.phase !== PHASE.LOBBY) return 'game already started';
    if (this.state.players.length < 2) return 'need at least 2 players';
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
    s.phase = PHASE.AWAITING_ROLL;
    s.turn = Game.#freshTurn();
    player.doublesCount = 0;
    this.#emit('turnStarted', { playerId: player.id, turnNumber: s.turnNumber });
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

  /** After a roll or a buy decision resolves, decide what the current player does next. */
  #settlePhase() {
    const s = this.state;
    if (s.phase === PHASE.GAME_OVER) return;
    if (s.turn.pendingTileId) s.phase = PHASE.BUY_DECISION;
    else if (s.turn.canRollAgain) s.phase = PHASE.AWAITING_ROLL;
    else s.phase = PHASE.AWAITING_END;
  }

  // =========================================================================
  // Rolling and moving
  // =========================================================================

  #rollDice(reason) {
    const dice = [1 + randomInt(this.rng, DICE.sides), 1 + randomInt(this.rng, DICE.sides)];
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
    this.#emit('moved', { playerId: p.id, from, to: p.position, passedGo });
    if (passedGo && collectGo) {
      this.#transfer(BANK, p.id, this.state.settings.goSalary, 'moneyCollected', { reason: 'goSalary' });
    }
  }

  #advanceTo(p, target, collectGo) {
    this.#stepForward(p, (target - p.position + BOARD_SIZE) % BOARD_SIZE, collectGo);
  }

  /** Move backwards. Never pays GO salary, even if it wraps past GO. */
  #stepBack(p, steps) {
    const from = p.position;
    p.position = (((from - steps) % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
    this.#emit('moved', { playerId: p.id, from, to: p.position, passedGo: false });
  }

  /**
   * Apply the effect of the tile the player is standing on.
   * ctx: { diceTotal, airportMultiplier?, utilityMultiplier? } (the last two come from cards).
   */
  #resolveLanding(p, ctx) {
    const tile = BOARD[p.position];
    switch (tile.type) {
      case TILE.CITY:
      case TILE.AIRPORT:
      case TILE.UTILITY:
        return this.#landOnProperty(p, tile, ctx);
      case TILE.TAX:
        return this.#payFine(p, tile.amount, 'taxPaid', { tileId: tile.id });
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

    const owner = this.#player(prop.ownerId);
    if (prop.mortgaged || (owner.inJail && !this.state.settings.collectRentInJail)) {
      const reason = prop.mortgaged ? 'mortgaged' : 'ownerInJail';
      this.#emit('rentWaived', { playerId: p.id, ownerId: owner.id, tileId: tile.id, reason });
      return;
    }
    // The "nearest utility" card rolls fresh dice for the rent.
    const diceTotal = tile.type === TILE.UTILITY && ctx.utilityMultiplier ? this.#rollDice('utilityCard').total : ctx.diceTotal;
    const amount = this.#rentFor(tile, { ...ctx, diceTotal });
    this.#transfer(p.id, owner.id, amount, 'rentPaid', { tileId: tile.id });
  }

  /** Rent owed on an owned, unmortgaged tile (owner checks are done by the caller). */
  #rentFor(tile, ctx) {
    const prop = this.state.properties[tile.id];
    const owned = this.#countOwnedInGroup(prop.ownerId, tile.group);
    switch (tile.type) {
      case TILE.CITY: {
        if (prop.buildings > 0) return tile.rent[prop.buildings];
        const fullSet = this.state.settings.doubleRentOnFullSet && this.#ownsGroup(prop.ownerId, tile.group);
        return tile.rent[0] * (fullSet ? 2 : 1);
      }
      case TILE.AIRPORT:
        return AIRPORT_RENT[owned - 1] * (ctx.airportMultiplier || 1);
      case TILE.UTILITY:
        return ctx.diceTotal * (ctx.utilityMultiplier || UTILITY_MULTIPLIER[owned]);
      default:
        return 0;
    }
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

  /** Without auctions (a later phase) a declined tile simply stays unowned. */
  #doDecline(p) {
    this.#emit('purchaseDeclined', { playerId: p.id, tileId: this.state.turn.pendingTileId });
    this.state.turn.pendingTileId = null;
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
    if (p.cash < tile.houseCost) return 'not enough cash';
    return null;
  }

  #doBuild(p, { tileId }) {
    const tile = board.getTileById(tileId);
    const prop = this.state.properties[tileId];
    prop.buildings += 1;
    this.#transfer(p.id, BANK, tile.houseCost, 'built', { tileId, buildings: prop.buildings });
  }

  #checkSellHouse(p, action) {
    const turnError = this.#checkManageTurn(p, true);
    if (turnError) return turnError;
    const { error, tile, prop } = this.#ownedTile(p, action.tileId);
    if (error) return error;
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

  #groupProps(group) {
    return board.groupMembers(group).map((i) => this.state.properties[BOARD[i].id]);
  }

  #countOwnedInGroup(ownerId, group) {
    return this.#groupProps(group).filter((g) => g.ownerId === ownerId).length;
  }

  #ownsGroup(ownerId, group) {
    return this.#countOwnedInGroup(ownerId, group) === board.groupMembers(group).length;
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
    const creditor = toBank ? null : this.#player(p.debt.creditorId);
    const creditorId = creditor && !creditor.bankrupt ? creditor.id : BANK;
    if (creditorId === BANK) this.#surrenderToBank(p);
    else this.#surrenderToPlayer(p, creditor);

    this.#forgiveDebts(p, () => true);
    for (const other of this.state.players) this.#forgiveDebts(other, (entry) => entry.creditorId === p.id);
    p.bankrupt = true;
    p.inJail = false;
    p.jailTurns = 0;
    p.doublesCount = 0;
    this.#emit('bankrupt', { playerId: p.id, creditorId, reason });

    const survivors = this.state.players.filter((o) => !o.bankrupt);
    if (survivors.length <= 1) this.#endGame(survivors[0]);
    else if (this.state.currentPlayerId === p.id) this.#beginTurn(this.#nextActivePlayer(p.id));
  }

  /** Buildings sell back at half value, then cash, property and cards pass to the creditor. */
  #surrenderToPlayer(p, creditor) {
    for (const [tile, prop] of this.#holdings(p.id)) {
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
      Object.assign(prop, { ownerId: null, buildings: 0, mortgaged: false });
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

  #endGame(winner) {
    const s = this.state;
    s.phase = PHASE.GAME_OVER;
    s.currentPlayerId = null;
    s.winnerId = winner ? winner.id : null;
    s.turn = Game.#freshTurn();
    this.#emit('gameOver', { winnerId: s.winnerId });
  }

  // =========================================================================
  // Lookups
  // =========================================================================

  #player(id) {
    return typeof id === 'string' ? this.state.players.find((p) => p.id === id) : undefined;
  }
}

module.exports = { Game, ACTIONS, PHASE, BANK, JACKPOT };
