'use strict';

/**
 * One multiplayer room: the lobby, the seats (players and their secret tokens),
 * the Game once started, chat, and every timer the room owns.
 *
 * Room never touches Socket.io. It talks to an injected `transport`:
 *   attach(code, socketId)                  put a socket in the room's channel
 *   detach(code, socketId, event?, payload?) optionally tell it why, then remove it
 *   toRoom(code, event, payload)            broadcast to the channel
 *   toSocket(socketId, event, payload)      send to one socket
 * and an injected `clock` { now, setTimeout, clearTimeout }, so every timer can
 * be driven by a fake clock in tests.
 *
 * Every public method takes the caller's socketId and resolves the seat from
 * it, so a socket can only ever act for the seat it is bound to. Methods return
 * { ok: true, ... } or { ok: false, error } and never throw on bad input.
 *
 * The engine stays authoritative: the room only decides who may call
 * game.dispatch, and when the turn timer plays on a player's behalf.
 *
 * Bots are seats with no socket that always count as connected. After every
 * change the room arms one bot timer (a human-like 0.6-1.5s, shorter in
 * auctions); any newer change cancels and re-arms it. When it fires, the first
 * bot that wants to act (bidders, then debtors and trade recipients, then the
 * player whose turn it is) decides on the current public state. Bots are
 * never timed out and never kicked for being away. With no human connected
 * they wait, so an abandoned room doesn't play on by itself.
 */

const crypto = require('node:crypto');
const { Game, PHASE } = require('../game/Game');
const { ROOM, PLAYER_COLORS, sanitizeSettings, modeSettings } = require('../../shared/rules');
const { BOARD, TILE, getTileById } = require('../../shared/board');
const { DECKS, getCard } = require('../../shared/cards');
const { RateLimiter } = require('../net/rateLimit');
const { cleanName, cleanText } = require('../net/validate');
const { Bot, DIFFICULTIES } = require('../bots/Bot');
const { fullSets } = require('../bots/valuation');
const { pickBotName, pickLine } = require('../bots/persona');

const STATUS = Object.freeze({ LOBBY: 'lobby', PLAYING: 'playing', FINISHED: 'finished' });

/** How long a disconnected player keeps their lobby seat, and how long before they can be kicked mid-game. */
const AWAY_GRACE_MS = 60_000;
const CHAT_HISTORY = 100;
const CHAT_RATE = { limit: 5, windowMs: 5000 };
/** When the turn timer expires (and the player is solvent), the first of these that is legal gets played. */
const AUTOPLAY_ORDER = ['roll', 'decline', 'endTurn'];
/** Enough for a full liquidation (22 cities × 5 buildings + 28 mortgages) plus the rest of the turn. */
const MAX_AUTOPLAY_STEPS = 300;
/** After an auction, a paused turn timer resumes with at least this much time left. */
const RESUME_MIN_MS = 5000;
const ACTIVE_PHASES = new Set([PHASE.AWAITING_ROLL, PHASE.BUY_DECISION, PHASE.AWAITING_END]);
/** How long a bot "thinks" before acting, in ms: [min, max] normally and during auctions. */
const BOT_DELAY = Object.freeze({ normal: [600, 1500], auction: [300, 700] });

const REAL_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
});

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });
const newToken = () => crypto.randomBytes(24).toString('base64url');
const newPlayerId = () => crypto.randomBytes(8).toString('hex');

class Room {
  /** Seats in join order: id -> { id, name, color, token, socketId, connected, disconnectedAt, bot }. bot is a Bot or null. */
  #seats = new Map();
  #awayTimers = new Map(); // seat id -> timer handle
  #turnTimer = null; // { key, mode, deadline, handle }
  #pausedTurn = null; // { key, mode, remaining } while an auction runs
  #resumeAutoplay = null; // turn key whose timed-out auto-play an auction interrupted
  #auctionTimer = null; // { auction, endsAt, handle }
  #botTimer = null; // handle of the pending bot move
  #botSets = new Map(); // bot seat id -> colour sets it owned at the last change, for chat lines
  #chatLimiter;

  /**
   * @param {object}   opts
   * @param {string}   opts.code
   * @param {object}   opts.transport
   * @param {object}   [opts.clock]    { now, setTimeout, clearTimeout }
   * @param {object}   [opts.log]      console-like
   * @param {Function} [opts.onEmpty]  called once the last seat is gone
   * @param {Function} [opts.makeGame] (settings, now) => Game, so tests can seed or rig it
   * @param {Function} [opts.random]   () => [0, 1) for bot delays, names and chat lines
   * @param {Function} [opts.makeBot]  ({ id, difficulty }) => Bot, so tests can seed bots
   * @param {object}   [opts.botDelay] { normal: [min, max], auction: [min, max] } in ms
   */
  constructor({ code, transport, clock = REAL_CLOCK, log = console, onEmpty = () => {}, makeGame, random = Math.random, makeBot, botDelay = BOT_DELAY }) {
    this.code = code;
    this.transport = transport;
    this.clock = clock;
    this.log = log;
    this.onEmpty = onEmpty;
    this.makeGame = makeGame || ((settings, now) => new Game({ settings, now }));
    this.random = random;
    this.botDelay = botDelay;
    this.makeBot = makeBot || (({ id, difficulty }) => new Bot({ id, difficulty, log }));
    this.settings = sanitizeSettings({});
    this.status = STATUS.LOBBY;
    this.hostId = null;
    this.game = null;
    this.version = 0;
    this.chatLog = []; // last CHAT_HISTORY messages
    this.chatSeq = 0;
    this.createdAt = clock.now();
    this.emptySince = null; // when the last socket left, for idle cleanup
    this.closed = false;
    this.#chatLimiter = new RateLimiter({ ...CHAT_RATE, now: clock.now });
    this.devState = {
      queuedRolls: new Map(),
      policies: new Map(),
      nextCards: { surprise: null, treasure: null },
    };
  }

  // =========================================================================
  // Joining and leaving
  // =========================================================================

  /**
   * Join with a name, or reclaim a seat with a token. A valid token always
   * wins, even mid-game; otherwise joining needs an open lobby with room.
   */
  join({ socketId, name, token }) {
    const seat = typeof token === 'string' ? this.#seatByToken(token) : null;
    if (seat) return this.#reconnect(seat, socketId);
    if (this.#seatBySocket(socketId)) return fail('already in this room');
    if (this.status !== STATUS.LOBBY) return fail('game already started');
    if (this.#seats.size >= this.settings.maxPlayers) return fail('room is full');

    const newSeat = {
      id: newPlayerId(),
      name: this.#uniqueName(cleanName(name) || 'Player'),
      color: this.#freeColor(),
      token: newToken(),
      socketId,
      connected: true,
      disconnectedAt: null,
      bot: null,
      team: null,
    };
    this.#seats.set(newSeat.id, newSeat);
    if (!this.hostId) this.hostId = newSeat.id;
    this.transport.attach(this.code, socketId);
    this.#sendChatHistory(socketId);
    this.#syncModeTeams();
    this.#broadcast([this.#roomEvent('seatJoined', { playerId: newSeat.id, name: newSeat.name })]);
    return ok({ code: this.code, playerId: newSeat.id, token: newSeat.token, reconnected: false });
  }

  #reconnect(seat, socketId) {
    if (seat.socketId && seat.socketId !== socketId) {
      // Newest socket wins; the old tab is told why it went quiet.
      this.transport.detach(this.code, seat.socketId, 'replaced', { code: this.code });
    }
    seat.socketId = socketId;
    seat.connected = true;
    seat.disconnectedAt = null;
    this.#clearAwayTimer(seat.id);
    this.transport.attach(this.code, socketId);
    this.#sendChatHistory(socketId);
    this.#afterChange([this.#roomEvent('seatReconnected', { playerId: seat.id })]);
    return ok({ code: this.code, playerId: seat.id, token: seat.token, reconnected: true });
  }

  /** The socket went away. The seat is kept; the lobby frees it after AWAY_GRACE_MS. */
  disconnect(socketId) {
    const seat = this.#seatBySocket(socketId);
    if (!seat) return;
    seat.socketId = null;
    seat.connected = false;
    seat.disconnectedAt = this.clock.now();
    this.#startAwayTimer(seat);
    this.#afterChange([this.#roomEvent('seatDisconnected', { playerId: seat.id })]);
  }

  /** Leave on purpose. Mid-game this is bankruptcy to the bank. */
  leave(socketId) {
    const seat = this.#seatBySocket(socketId);
    if (!seat) return fail('not in this room');
    const events = this.status === STATUS.PLAYING ? this.game.removePlayer(seat.id).events : [];
    this.#removeSeat(seat, 'left');
    this.#syncModeTeams();
    this.#afterChange([...events, this.#roomEvent('seatLeft', { playerId: seat.id, reason: 'left' })]);
    return ok();
  }

  // =========================================================================
  // Lobby
  // =========================================================================

  pickColor(socketId, color) {
    const seat = this.#seatBySocket(socketId);
    if (!seat) return fail('not in this room');
    if (this.status !== STATUS.LOBBY) return fail('colours are fixed once the game starts');
    if (!PLAYER_COLORS.includes(color)) return fail('unknown colour');
    if ([...this.#seats.values()].some((s) => s !== seat && s.color === color)) return fail('colour already taken');
    seat.color = color;
    this.#broadcast();
    return ok();
  }

  /** Host only. Partial settings are merged into the current ones and sanitised. */
  updateSettings(socketId, partial) {
    const error = this.#requireHost(socketId, STATUS.LOBBY);
    if (error) return fail(error);
    let next = sanitizeSettings({ ...this.settings, ...partial });
    // The mode picks the feature flags; general settings (players, privacy, timer…) stay.
    if ('mode' in partial) next = sanitizeSettings({ ...next, ...modeSettings(next.mode) });
    // Never drop the limit below the players already seated.
    next.maxPlayers = Math.max(next.maxPlayers, this.#seats.size);
    const teamsJustOn = next.teams && !this.settings.teams;
    this.settings = next;
    const events = [this.#roomEvent('settingsChanged', { settings: next })];
    // Turning bots off sends the lobby's bots home.
    if (!next.allowBots) {
      for (const seat of this.#botSeats()) {
        this.#removeSeat(seat, 'removed');
        events.push(this.#roomEvent('seatLeft', { playerId: seat.id, reason: 'removed' }));
      }
    }
    // Keep teams sensible. In Chaos they follow the player count; otherwise they
    // follow the (test-only) teams flag directly.
    if (next.mode === 'chaos') this.#syncModeTeams();
    else if (teamsJustOn) this.#assignTeams();
    else if (!next.teams) for (const seat of this.#seats.values()) seat.team = null;
    this.#broadcast(events);
    return ok({ settings: this.settings });
  }

  /**
   * In Chaos, teams are on with exactly 4 or 6 players and off otherwise. New
   * (unassigned) seats trigger a fresh even deal; a host's own even split is
   * left alone. No effect outside Chaos or outside the lobby.
   */
  #syncModeTeams() {
    if (this.status !== STATUS.LOBBY || this.settings.mode !== 'chaos') return;
    const want = this.#seats.size === 4 || this.#seats.size === 6;
    this.settings.teams = want;
    if (want) {
      if ([...this.#seats.values()].some((s) => !s.team)) this.#assignTeams();
    } else {
      for (const s of this.#seats.values()) s.team = null;
    }
  }

  /** Host only, in the lobby, teams on: put a player on team 'A', 'B' or neither (null). */
  setTeam(socketId, playerId, team) {
    const error = this.#requireHost(socketId, STATUS.LOBBY);
    if (error) return fail(error);
    if (!this.settings.teams) return fail('team mode is off');
    const seat = this.#seats.get(playerId);
    if (!seat) return fail('no such player');
    if (team !== 'A' && team !== 'B' && team !== null) return fail('unknown team');
    seat.team = team;
    this.#broadcast([this.#roomEvent('teamsChanged', {})]);
    return ok();
  }

  /** Host only, in the lobby, teams on: deal everyone out into two even teams at random. */
  shuffleTeams(socketId) {
    const error = this.#requireHost(socketId, STATUS.LOBBY);
    if (error) return fail(error);
    if (!this.settings.teams) return fail('team mode is off');
    this.#assignTeams();
    this.#broadcast([this.#roomEvent('teamsChanged', {})]);
    return ok();
  }

  /** Split the current seats into two even teams (odd seat out gets no team). */
  #assignTeams() {
    const ids = [...this.#seats.keys()];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const half = Math.floor(ids.length / 2);
    ids.forEach((id, i) => {
      const seat = this.#seats.get(id);
      seat.team = ids.length % 2 === 1 && i === ids.length - 1 ? null : (i < half ? 'A' : 'B');
    });
  }

  /** Host only. In the lobby anyone can be kicked; mid-game only players gone for AWAY_GRACE_MS. */
  kick(socketId, playerId) {
    const error = this.#requireHost(socketId);
    if (error) return fail(error);
    const target = this.#seats.get(playerId);
    if (!target) return fail('no such player');
    if (target.id === this.hostId) return fail('you cannot kick yourself');

    let events = [];
    if (this.status === STATUS.PLAYING) {
      const awayFor = target.connected ? 0 : this.clock.now() - target.disconnectedAt;
      if (awayFor < AWAY_GRACE_MS) return fail('only players disconnected for 60 seconds can be kicked mid-game');
      events = this.game.removePlayer(target.id).events;
    }
    this.#removeSeat(target, 'kicked');
    this.#syncModeTeams();
    this.#afterChange([...events, this.#roomEvent('seatLeft', { playerId: target.id, reason: 'kicked' })]);
    return ok();
  }

  // =========================================================================
  // Bots
  // =========================================================================

  /** Host only, in the lobby: seat a computer player in the next free colour. */
  addBot(socketId, difficulty = 'medium') {
    const error = this.#requireHost(socketId, STATUS.LOBBY);
    if (error) return fail(error);
    if (!this.settings.allowBots) return fail('bots are turned off for this room');
    if (!DIFFICULTIES.includes(difficulty)) return fail('unknown difficulty');
    if (this.#seats.size >= this.settings.maxPlayers) return fail('room is full');
    const taken = new Set([...this.#seats.values()].map((s) => s.name.toLowerCase()));
    const id = newPlayerId();
    const seat = {
      id,
      name: this.#uniqueName(pickBotName(taken, this.random)),
      color: this.#freeColor(),
      token: newToken(), // never sent anywhere; no socket can claim a bot's seat
      socketId: null,
      connected: true,
      disconnectedAt: null,
      bot: this.makeBot({ id, difficulty }),
      team: null,
    };
    this.#seats.set(id, seat);
    this.#syncModeTeams();
    this.#broadcast([this.#roomEvent('seatJoined', { playerId: id, name: seat.name, bot: difficulty })]);
    return ok({ playerId: id });
  }

  /** Host only, in the lobby. */
  removeBot(socketId, playerId) {
    const error = this.#requireHost(socketId, STATUS.LOBBY);
    if (error) return fail(error);
    const seat = this.#seats.get(playerId);
    if (!seat || !seat.bot) return fail('no such bot');
    this.#removeSeat(seat, 'removed');
    this.#syncModeTeams();
    this.#broadcast([this.#roomEvent('seatLeft', { playerId, reason: 'removed' })]);
    return ok();
  }

  /**
   * Host only, mid-game: a bot takes over the seat (cash, cities, position) of
   * a player who has disconnected. Their token stops working, so they can't
   * come back to that seat.
   */
  replaceWithBot(socketId, playerId, difficulty = 'medium') {
    const error = this.#requireHost(socketId, STATUS.PLAYING);
    if (error) return fail(error);
    if (!this.settings.allowBots) return fail('bots are turned off for this room');
    if (!DIFFICULTIES.includes(difficulty)) return fail('unknown difficulty');
    const seat = this.#seats.get(playerId);
    if (!seat) return fail('no such player');
    if (seat.bot) return fail('that player is already a bot');
    if (seat.connected) return fail('only a player who has left can be replaced');
    const player = this.game.state.players.find((p) => p.id === playerId);
    if (!player || player.bankrupt) return fail('that player is out of the game');
    this.#clearAwayTimer(seat.id);
    seat.bot = this.makeBot({ id: seat.id, difficulty });
    seat.token = newToken();
    seat.connected = true;
    seat.disconnectedAt = null;
    this.#afterChange([this.#roomEvent('seatReplacedByBot', { playerId, difficulty })]);
    return ok();
  }

  start(socketId) {
    const error = this.#requireHost(socketId, STATUS.LOBBY);
    if (error) return fail(error);
    if (this.#seats.size < 2) return fail('need at least 2 players');

    const game = this.makeGame(this.settings, this.clock.now);
    this.#attachDevHooks(game);
    // Each game starts with fresh bot memories (when they last traded and so on).
    for (const seat of this.#botSeats()) seat.bot = this.makeBot({ id: seat.id, difficulty: seat.bot.difficulty });
    for (const seat of this.#seats.values()) {
      const added = game.addPlayer({ id: seat.id, name: seat.name, color: seat.color, team: this.settings.teams ? seat.team : undefined });
      if (!added.ok) return fail(`could not seat ${seat.name}: ${added.error}`);
    }
    const started = game.start();
    if (!started.ok) return fail(started.error);
    this.game = game;
    this.status = STATUS.PLAYING;
    this.#afterChange(started.events);
    return ok();
  }

  /** Host only, after game over: everyone still seated goes back to the lobby with the same settings. */
  playAgain(socketId) {
    const error = this.#requireHost(socketId, STATUS.FINISHED);
    if (error) return fail(error);
    this.game = null;
    this.status = STATUS.LOBBY;
    this.#clearTurnTimer();
    this.#clearAuctionTimer();
    this.#clearBotTimer();
    this.#botSets.clear();
    // Seats that went quiet long ago would have been dropped by a lobby; do it now.
    const now = this.clock.now();
    for (const seat of [...this.#seats.values()]) {
      if (!seat.connected && now - seat.disconnectedAt >= AWAY_GRACE_MS) this.#removeSeat(seat, 'timeout');
    }
    this.#broadcast([this.#roomEvent('backToLobby')]);
    return ok();
  }

  // =========================================================================
  // Game
  // =========================================================================

  /** Forward a player action to the engine. The ack carries the resulting state version. */
  action(socketId, action) {
    const seat = this.#seatBySocket(socketId);
    if (!seat) return fail('not in this room');
    if (this.status !== STATUS.PLAYING) return fail('no game in progress');
    const result = this.game.dispatch(seat.id, action);
    if (!result.ok) return result;
    this.#afterChange(result.events);
    return ok({ version: this.version });
  }

  /** After anything changed: auto-pass absent bidders, settle status and timers, then tell everyone. */
  #afterChange(events) {
    const all = [...events, ...this.#autoPassAbsent()];
    const gameOver = this.status === STATUS.PLAYING && this.game.state.phase === PHASE.GAME_OVER;
    if (gameOver) this.status = STATUS.FINISHED;
    this.#syncAuctionTimer(all);
    this.#syncTurnTimer();
    this.#broadcast(all);
    if (gameOver) {
      const winner = this.game.state.players.find((p) => p.id === this.game.state.winnerId);
      this.transport.toRoom(this.code, 'gameOver', { winnerId: winner ? winner.id : null, name: winner ? winner.name : null });
    }
    if (this.status !== STATUS.LOBBY) this.#botChatter(all);
    if (this.#humanSeats().length === 0) {
      this.#clearBotTimer();
      if (!this.closed) this.onEmpty(this);
      return;
    }
    this.#scheduleBots();
  }

  // =========================================================================
  // Bot moves
  // =========================================================================

  /** Re-arm the single bot timer: any change cancels the move a bot was about to make. */
  #scheduleBots() {
    this.#clearBotTimer();
    if (this.closed || this.status !== STATUS.PLAYING || !this.#botSeats().length) return;
    if (this.connectedCount === 0) return; // nobody watching: wait for a human to come back
    const [lo, hi] = this.game.state.phase === PHASE.AUCTION ? this.botDelay.auction : this.botDelay.normal;
    const ms = Math.round(lo + this.random() * (hi - lo));
    this.#botTimer = this.clock.setTimeout(() => this.#runBots(), ms);
  }

  #clearBotTimer() {
    if (this.#botTimer) this.clock.clearTimeout(this.#botTimer);
    this.#botTimer = null;
  }

  /**
   * Bots that may want to act, most urgent first: auction bidders, then
   * anyone off-turn (debts, trade replies), then the player whose turn it is.
   */
  #botQueue() {
    const { currentPlayerId } = this.game.state;
    const bots = this.#botSeats().filter((s) => {
      const p = this.game.state.players.find((x) => x.id === s.id);
      return p && !p.bankrupt;
    });
    return [...bots.filter((s) => s.id !== currentPlayerId), ...bots.filter((s) => s.id === currentPlayerId)];
  }

  /** The bot timer fired: let the first bot that wants to act make one move. */
  #runBots() {
    this.#botTimer = null;
    if (this.closed || this.status !== STATUS.PLAYING) return;
    const state = this.game.publicState();
    const humans = new Set(this.#humanSeats().map((s) => s.id));
    for (const seat of this.#botQueue()) {
      const legalActions = this.game.getLegalActions(seat.id);
      if (!legalActions.length) continue;
      // The game waits on the current player (outside auctions), so it must always do something.
      const mustAct = state.currentPlayerId === seat.id && state.phase !== PHASE.AUCTION;
      const action = seat.bot.act({ state, legalActions, humans, mustAct });
      if (!action) continue;
      let result = this.game.dispatch(seat.id, action);
      if (!result.ok) {
        this.log.warn(`[room ${this.code}] bot ${seat.name}: ${action.type} rejected: ${result.error}`);
        const fallback = mustAct ? this.#autoAction(seat.id) : null;
        if (!fallback) continue;
        result = this.game.dispatch(seat.id, fallback);
        if (!result.ok) continue;
      }
      this.#afterChange(result.events);
      return;
    }
  }

  /** A short line from a bot when it completes a set, goes bankrupt or wins (if the room allows it). */
  #botChatter(events) {
    if (!this.game) return;
    const state = this.game.state;
    for (const seat of this.#botSeats()) {
      const sets = fullSets(state, seat.id);
      const before = this.#botSets.get(seat.id) || [];
      this.#botSets.set(seat.id, sets);
      if (!this.settings.botChat) continue;
      let kind = null;
      if (events.some((e) => e.type === 'gameOver' && e.winnerId === seat.id)) kind = 'won';
      else if (events.some((e) => e.type === 'bankrupt' && e.playerId === seat.id)) kind = 'bankrupt';
      else if (sets.some((g) => !before.includes(g))) kind = 'completedSet';
      if (kind) this.#say(seat, pickLine(kind, this.random));
    }
  }

  #say(seat, text) {
    const message = { id: ++this.chatSeq, playerId: seat.id, name: seat.name, text, ts: this.clock.now(), bot: true };
    this.chatLog.push(message);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    this.transport.toRoom(this.code, 'chat', message);
  }

  // =========================================================================
  // Turn timer
  // =========================================================================

  /**
   * Keep the turn timer matching the game. One timer per turn: it is (re)armed
   * when the turn changes, and cleared when no timer is wanted. With the
   * setting off, a disconnected current player still gets AWAY_GRACE_MS so
   * the game can't stall on them.
   */
  #syncTurnTimer() {
    // An auction pauses the turn timer; it resumes for the same turn afterwards.
    if (this.status === STATUS.PLAYING && this.game.state.phase === PHASE.AUCTION) {
      if (this.#turnTimer) {
        const { key, mode, deadline } = this.#turnTimer;
        this.#pausedTurn = { key, mode, remaining: Math.max(0, deadline - this.clock.now()) };
        this.#clearTurnTimer();
      }
      return;
    }
    const want = this.#wantedTurnTimer();
    const current = this.#turnTimer;
    if (current && want && current.key === want.key && current.mode === want.mode) return;
    this.#clearTurnTimer();
    let ms = want ? want.ms : 0;
    if (want && this.#resumeAutoplay === want.key) ms = 0; // finish the timed-out turn straight away
    else if (want && this.#pausedTurn && this.#pausedTurn.key === want.key && this.#pausedTurn.mode === want.mode) {
      ms = Math.max(this.#pausedTurn.remaining, RESUME_MIN_MS);
    }
    this.#pausedTurn = null;
    this.#resumeAutoplay = null;
    if (!want) return;
    const handle = this.clock.setTimeout(() => this.#onTurnTimeout(), ms);
    this.#turnTimer = { ...want, deadline: this.clock.now() + ms, handle };
  }

  #wantedTurnTimer() {
    if (this.status !== STATUS.PLAYING || !ACTIVE_PHASES.has(this.game.state.phase)) return null;
    const { currentPlayerId, turnNumber } = this.game.state;
    const key = `${turnNumber}:${currentPlayerId}`;
    const seat = this.#seats.get(currentPlayerId);
    if (seat && seat.bot) return null; // bots move on their own and are never timed out
    const seconds = this.settings.turnTimerSeconds;
    if (seconds > 0) return { key, mode: 'turn', ms: seconds * 1000 };
    if (!seat || !seat.connected) return { key, mode: 'away', ms: AWAY_GRACE_MS };
    return null;
  }

  #clearTurnTimer() {
    if (this.#turnTimer) this.clock.clearTimeout(this.#turnTimer.handle);
    this.#turnTimer = null;
  }

  /** Time's up: play the rest of the turn for the current player, safest action first. */
  #onTurnTimeout() {
    this.#turnTimer = null;
    if (this.closed || this.status !== STATUS.PLAYING) return;
    const state = this.game.state;
    const { currentPlayerId: playerId, turnNumber } = state;
    const events = [this.#roomEvent('turnTimedOut', { playerId })];
    const sameTurn = () => ![PHASE.GAME_OVER, PHASE.AUCTION].includes(this.game.state.phase)
      && this.game.state.currentPlayerId === playerId && this.game.state.turnNumber === turnNumber;

    for (let step = 0; step < MAX_AUTOPLAY_STEPS && sameTurn(); step++) {
      const action = this.#autoAction(playerId);
      if (!action) {
        this.log.warn(`[room ${this.code}] turn timer: no automatic action for ${playerId}`);
        break;
      }
      const result = this.game.dispatch(playerId, action);
      if (!result.ok) {
        this.log.error(`[room ${this.code}] turn timer: ${action.type} rejected: ${result.error}`);
        break;
      }
      events.push(...result.events);
    }
    // Declining may have started an auction: carry on with this turn once it closes.
    if (this.game.state.phase === PHASE.AUCTION) this.#resumeAutoplay = `${turnNumber}:${playerId}`;
    this.#afterChange(events);
  }

  /**
   * The next action to play for a player whose time ran out. A player in debt
   * first raises cash (see #liquidationAction) and is declared bankrupt only
   * if that can't clear the debt. A solvent player rolls, then declines, then
   * ends the turn. The server never buys on a player's behalf.
   */
  #autoAction(playerId) {
    const legal = this.game.getLegalActions(playerId);
    const player = this.game.state.players.find((p) => p.id === playerId);
    if (player && player.cash < 0) {
      return Room.#liquidationAction(legal) || legal.find((a) => a.type === 'bankrupt') || null;
    }
    for (const type of AUTOPLAY_ORDER) {
      const action = legal.find((a) => a.type === type);
      if (action) return action;
    }
    return null;
  }

  /**
   * One step of raising cash, using only legal actions. Mortgaging loses less
   * than selling buildings at half price, so: mortgage the cheapest tile that
   * can be mortgaged (its set has no buildings); otherwise sell a building
   * from the cheapest set (the engine only allows even selling). Clearing a
   * set makes its tiles mortgageable, so they go next. Ties go to the earlier
   * board position. Called one step at a time, so it stops as soon as the
   * debt is cleared.
   */
  static #liquidationAction(legal) {
    const cheapestBy = (cost) => (a, b) => {
      const [ta, tb] = [getTileById(a.tileId), getTileById(b.tileId)];
      return cost(ta) - cost(tb) || ta.index - tb.index;
    };
    const mortgages = legal.filter((a) => a.type === 'mortgage').sort(cheapestBy((t) => t.price));
    if (mortgages.length) return mortgages[0];
    const sells = legal.filter((a) => a.type === 'sellHouse').sort(cheapestBy((t) => t.houseCost));
    return sells[0] || null;
  }

  // =========================================================================
  // Auctions
  // =========================================================================

  /**
   * One timer per auction, settings.auctionSeconds long, restarted by every
   * valid bid. When it fires the server closes the auction.
   */
  #syncAuctionTimer(events) {
    const auction = this.status === STATUS.PLAYING ? this.game.state.auction : null;
    if (!auction) {
      this.#clearAuctionTimer();
      return;
    }
    const bid = events.some((e) => e.type === 'bidPlaced');
    if (this.#auctionTimer && this.#auctionTimer.auction === auction && !bid) return;
    this.#clearAuctionTimer();
    const ms = this.settings.auctionSeconds * 1000;
    const handle = this.clock.setTimeout(() => this.#onAuctionTimeout(), ms);
    this.#auctionTimer = { auction, endsAt: this.clock.now() + ms, handle };
  }

  #clearAuctionTimer() {
    if (this.#auctionTimer) this.clock.clearTimeout(this.#auctionTimer.handle);
    this.#auctionTimer = null;
  }

  #onAuctionTimeout() {
    this.#auctionTimer = null;
    if (this.closed || this.status !== STATUS.PLAYING || !this.game.state.auction) return;
    const result = this.game.closeAuction();
    if (result.ok) this.#afterChange(result.events);
  }

  /** Disconnected players count as having passed (the high bidder keeps their bid). */
  #autoPassAbsent() {
    const events = [];
    while (this.status === STATUS.PLAYING && this.game.state.auction) {
      const { bidders, highBidderId } = this.game.state.auction;
      const absent = bidders.find((id) => id !== highBidderId && !(this.#seats.get(id) && this.#seats.get(id).connected));
      if (!absent) break;
      const result = this.game.dispatch(absent, { type: 'pass' });
      if (!result.ok) break;
      events.push(...result.events);
    }
    return events;
  }

  // =========================================================================
  // Chat
  // =========================================================================

  chat(socketId, raw, teamOnly = false) {
    const seat = this.#seatBySocket(socketId);
    if (!seat) return fail('not in this room');
    const text = cleanText(raw, ROOM.chatMaxLength);
    if (!text) return fail('empty message');
    if (!this.#chatLimiter.take(seat.id)) return fail('slow down: at most 5 messages every 5 seconds');
    // Team-only chat (team mode) reaches the sender and their teammates, nobody else.
    const team = teamOnly && this.settings.teams ? seat.team : null;
    const message = { id: ++this.chatSeq, playerId: seat.id, name: seat.name, text, ts: this.clock.now(), ...(team ? { team } : {}) };
    if (team) {
      for (const s of this.#seats.values()) {
        if (s.socketId && s.team === team) this.transport.toSocket(s.socketId, 'chat', message);
      }
    } else {
      this.chatLog.push(message);
      if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
      this.transport.toRoom(this.code, 'chat', message);
    }
    return ok();
  }

  #sendChatHistory(socketId) {
    this.transport.toSocket(socketId, 'chatHistory', { messages: this.chatLog });
  }

  // =========================================================================
  // State broadcast
  // =========================================================================

  /** Everything about the room that clients may see. Never includes tokens or socket ids. */
  publicRoom() {
    return {
      code: this.code,
      status: this.status,
      hostId: this.hostId,
      settings: { ...this.settings },
      colors: PLAYER_COLORS,
      players: [...this.#seats.values()].map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        connected: s.connected,
        disconnectedAt: s.disconnectedAt,
        isHost: s.id === this.hostId,
        bot: s.bot ? s.bot.difficulty : null,
        team: s.team,
      })),
    };
  }

  /** Summary for the public room list. */
  listing() {
    const host = this.#seats.get(this.hostId);
    return { code: this.code, hostName: host ? host.name : null, players: this.#seats.size, maxPlayers: this.settings.maxPlayers, mode: this.settings.mode };
  }

  get isPublicLobby() {
    return this.status === STATUS.LOBBY && !this.settings.isPrivate;
  }

  get seatCount() {
    return this.#seats.size;
  }

  /** Connected humans (bots don't count: a room of only bots is empty). */
  get connectedCount() {
    return this.#humanSeats().filter((s) => s.connected).length;
  }

  get turnDeadline() {
    return this.#turnTimer ? this.#turnTimer.deadline : null;
  }

  /** One 'state' to the room with a new version, then each seat's private 'you'. */
  #broadcast(events = []) {
    if (this.closed) return;
    this.version += 1;
    const publicState = this.game ? this.game.publicState() : null;
    if (publicState && publicState.auction) publicState.auction.endsAt = this.#auctionTimer ? this.#auctionTimer.endsAt : null;
    this.transport.toRoom(this.code, 'state', {
      version: this.version,
      serverNow: this.clock.now(), // clients correct their clock with this for countdowns
      room: this.publicRoom(),
      publicState,
      events,
      deadline: this.turnDeadline,
    });
    for (const seat of this.#seats.values()) {
      if (seat.socketId) this.transport.toSocket(seat.socketId, 'you', this.#privateView(seat));
    }
    this.emptySince = this.connectedCount === 0 ? (this.emptySince ?? this.clock.now()) : null;
    this.onDevUpdate?.();
  }

  #privateView(seat) {
    const playing = this.status === STATUS.PLAYING;
    return {
      version: this.version,
      playerId: seat.id,
      isHost: seat.id === this.hostId,
      legalActions: playing ? this.game.getLegalActions(seat.id) : [],
    };
  }

  #roomEvent(type, fields = {}) {
    return { type, ...fields, at: this.clock.now() };
  }

  // =========================================================================
  // Seats, names, colours, host
  // =========================================================================

  #humanSeats() {
    return [...this.#seats.values()].filter((s) => !s.bot);
  }

  #botSeats() {
    return [...this.#seats.values()].filter((s) => s.bot);
  }

  #seatBySocket(socketId) {
    if (!socketId) return null;
    for (const seat of this.#seats.values()) if (seat.socketId === socketId) return seat;
    return null;
  }

  #seatByToken(token) {
    for (const seat of this.#seats.values()) {
      if (seat.token.length === token.length && crypto.timingSafeEqual(Buffer.from(seat.token), Buffer.from(token))) return seat;
    }
    return null;
  }

  #requireHost(socketId, status) {
    const seat = this.#seatBySocket(socketId);
    if (!seat) return 'not in this room';
    if (seat.id !== this.hostId) return 'only the host can do that';
    if (status && this.status !== status) return `only possible while the room is in ${status}`;
    return null;
  }

  /** "Asha", "Asha 2", "Asha 3"… compared case-insensitively, always within the length limit. */
  #uniqueName(base) {
    const taken = new Set([...this.#seats.values()].map((s) => s.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const name = `${[...base].slice(0, ROOM.nameMaxLength - suffix.length).join('').trimEnd()}${suffix}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  #freeColor() {
    const taken = new Set([...this.#seats.values()].map((s) => s.color));
    return PLAYER_COLORS.find((c) => !taken.has(c));
  }

  #removeSeat(seat, reason) {
    this.#seats.delete(seat.id);
    this.#clearAwayTimer(seat.id);
    this.#chatLimiter.forget(seat.id);
    if (seat.socketId) this.transport.detach(this.code, seat.socketId, reason === 'kicked' ? 'kicked' : null, { code: this.code });
    if (this.hostId === seat.id) this.#transferHost(seat.id);
  }

  /** The next human seat in join order becomes host, preferring someone who is connected. Bots never host. */
  #transferHost(fromId) {
    const others = this.#humanSeats().filter((s) => s.id !== fromId);
    const next = others.find((s) => s.connected) || others[0] || null;
    this.hostId = next ? next.id : null;
  }

  // =========================================================================
  // Away timers
  // =========================================================================

  /**
   * After AWAY_GRACE_MS a disconnected player loses their lobby seat. Mid-game
   * they keep it, but a disconnected host hands hosting to someone present.
   */
  #startAwayTimer(seat) {
    this.#clearAwayTimer(seat.id);
    const handle = this.clock.setTimeout(() => this.#onAwayTimeout(seat.id), AWAY_GRACE_MS);
    this.#awayTimers.set(seat.id, handle);
  }

  #clearAwayTimer(seatId) {
    if (!this.#awayTimers.has(seatId)) return;
    this.clock.clearTimeout(this.#awayTimers.get(seatId));
    this.#awayTimers.delete(seatId);
  }

  #onAwayTimeout(seatId) {
    this.#awayTimers.delete(seatId);
    const seat = this.#seats.get(seatId);
    if (this.closed || !seat || seat.connected) return;
    if (this.status === STATUS.LOBBY) {
      this.#removeSeat(seat, 'timeout');
      this.#afterChange([this.#roomEvent('seatLeft', { playerId: seat.id, reason: 'timeout' })]);
    } else if (seat.id === this.hostId) {
      this.#transferHost(seat.id);
      if (this.hostId !== seat.id) this.#broadcast([this.#roomEvent('hostChanged', { playerId: this.hostId })]);
    } else {
      this.#broadcast(); // clients can now offer the host a kick button
    }
  }

  // =========================================================================
  // Teardown
  // =========================================================================

  // =========================================================================
  // Developer Control Panel Hooks & Methods
  // =========================================================================

  #attachDevHooks(game) {
    if (!game) return;
    game.diceProvider = (playerId, reason, g) => this.#devDiceProvider(playerId, reason, g);
    game.cardHook = (deck, deckArray, p, g) => this.#devCardHook(deck, deckArray, p, g);
  }

  #devCardHook(deck, deckArray, p, g) {
    const nextCardId = this.devState.nextCards[deck];
    if (nextCardId) {
      const idx = deckArray.indexOf(nextCardId);
      if (idx > -1) {
        deckArray.splice(idx, 1);
        deckArray.unshift(nextCardId);
      }
      this.devState.nextCards[deck] = null;
    }
  }

  #devDiceProvider(playerId, reason, game) {
    // 1. Check queued rolls
    const queue = this.devState.queuedRolls.get(playerId);
    if (queue && queue.length > 0) {
      const roll = queue.shift();
      if (Array.isArray(roll) && roll.length === 2 &&
          Number.isInteger(roll[0]) && roll[0] >= 1 && roll[0] <= 6 &&
          Number.isInteger(roll[1]) && roll[1] >= 1 && roll[1] <= 6) {
        this.onDevUpdate?.();
        return roll;
      }
    }

    // 2. Check active policies
    const policies = this.devState.policies.get(playerId);
    if (policies && Object.keys(policies).length > 0) {
      const p = game.state.players.find((x) => x.id === playerId);
      if (p) {
        const valid = this.#findValidDiceCombinations(p, policies, reason, game);
        if (valid.length > 0) {
          // Weighted by normal 2d6 odds: choosing uniformly among valid (d1, d2) pairs
          // preserves the natural 2d6 triangular distribution.
          const idx = Math.floor(this.random() * valid.length);
          return valid[idx];
        }
      }
    }

    return null;
  }

  #findValidDiceCombinations(p, policies, reason, game) {
    const valid = [];
    for (let d1 = 1; d1 <= 6; d1++) {
      for (let d2 = 1; d2 <= 6; d2++) {
        const isDouble = d1 === d2;

        if (policies.noDoubles && isDouble) continue;
        if (policies.forceDoubles && !isDouble) continue;

        if (reason === 'move') {
          let destIndex;
          if (p.inJail) {
            if (isDouble || p.jailTurns + 1 >= 3) {
              destIndex = (10 + d1 + d2) % 40;
            } else {
              destIndex = 10;
            }
          } else {
            if (isDouble && p.doublesCount === 2) {
              destIndex = 10; // Triple doubles send to jail
            } else {
              destIndex = (p.position + d1 + d2) % 40;
            }
          }

          if (policies.avoidGoToJail) {
            if (!p.inJail && isDouble && p.doublesCount === 2) continue;
            if (destIndex === 30) continue;
          }

          const destTile = BOARD[destIndex];

          if (policies.avoidTaxes && destTile.type === TILE.TAX) continue;

          if (policies.aimTile !== undefined && policies.aimTile !== null && policies.aimTile !== '') {
            const target = String(policies.aimTile);
            if (destTile.id !== target && String(destIndex) !== target) continue;
          }

          if (policies.avoidPlayer) {
            const prop = game.state.properties[destTile.id];
            if (prop && prop.ownerId === policies.avoidPlayer) continue;
          }

          if (policies.avoidBuilt) {
            const prop = game.state.properties[destTile.id];
            if (prop && prop.ownerId && prop.ownerId !== p.id && prop.buildings > 0) continue;
          }
        }

        valid.push([d1, d2]);
      }
    }
    return valid;
  }

  devSetRoll(playerId, dice) {
    if (!Array.isArray(dice) || dice.length !== 2 ||
        !Number.isInteger(dice[0]) || dice[0] < 1 || dice[0] > 6 ||
        !Number.isInteger(dice[1]) || dice[1] < 1 || dice[1] > 6) {
      return false;
    }
    this.devState.queuedRolls.set(playerId, [[dice[0], dice[1]]]);
    this.onDevUpdate?.();
    return true;
  }

  devQueueRolls(playerId, rolls) {
    if (!Array.isArray(rolls)) return false;
    const valid = [];
    for (const r of rolls) {
      if (Array.isArray(r) && r.length === 2 &&
          Number.isInteger(r[0]) && r[0] >= 1 && r[0] <= 6 &&
          Number.isInteger(r[1]) && r[1] >= 1 && r[1] <= 6) {
        valid.push([r[0], r[1]]);
      }
    }
    this.devState.queuedRolls.set(playerId, valid);
    this.onDevUpdate?.();
    return true;
  }

  devSetPolicy(playerId, policy, value) {
    let pMap = this.devState.policies.get(playerId);
    if (!pMap) {
      pMap = {};
      this.devState.policies.set(playerId, pMap);
    }
    if (value === null || value === undefined || value === false || value === '') {
      delete pMap[policy];
    } else {
      pMap[policy] = value;
    }
    this.onDevUpdate?.();
    return true;
  }

  devClearControls(playerId) {
    if (playerId && playerId !== 'all') {
      this.devState.queuedRolls.delete(playerId);
      this.devState.policies.delete(playerId);
    } else {
      this.devState.queuedRolls.clear();
      this.devState.policies.clear();
    }
    this.onDevUpdate?.();
    return true;
  }

  devSetNextCard(deck, cardId) {
    if (!['surprise', 'treasure'].includes(deck)) return false;
    this.devState.nextCards[deck] = cardId;
    if (this.game?.state?.decks?.[deck]) {
      const d = this.game.state.decks[deck];
      const idx = d.indexOf(cardId);
      if (idx > -1) {
        d.splice(idx, 1);
        d.unshift(cardId);
      }
    }
    this.onDevUpdate?.();
    return true;
  }

  devAdjustCash(playerId, amount) {
    if (!this.game) return false;
    const ok = this.game.devAdjustCash(playerId, amount);
    if (ok) this.onDevUpdate?.();
    return ok;
  }

  devExtendAuction(seconds = 10) {
    if (this.closed || this.status !== STATUS.PLAYING || !this.game?.state?.auction) return false;
    const addMs = Math.max(1, Number(seconds) || 10) * 1000;
    const currentRemaining = this.#auctionTimer ? Math.max(0, this.#auctionTimer.endsAt - this.clock.now()) : 0;
    const newRemaining = currentRemaining + addMs;
    this.#clearAuctionTimer();
    const auction = this.game.state.auction;
    const handle = this.clock.setTimeout(() => this.#onAuctionTimeout(), newRemaining);
    this.#auctionTimer = { auction, endsAt: this.clock.now() + newRemaining, handle };
    this.#broadcast();
    this.onDevUpdate?.();
    return true;
  }

  devEndAuction() {
    if (this.closed || this.status !== STATUS.PLAYING || !this.game?.state?.auction) return false;
    this.#clearAuctionTimer();
    const result = this.game.closeAuction();
    if (result.ok) this.#afterChange(result.events);
    this.onDevUpdate?.();
    return true;
  }

  devSummary() {
    return {
      code: this.code,
      status: this.status,
      turnNumber: this.game ? this.game.state.turnNumber : 0,
      createdAt: this.createdAt,
      seatCount: this.seatCount,
      players: [...this.#seats.values()].map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        connected: s.connected,
        isBot: Boolean(s.bot),
      })),
    };
  }

  getDevState() {
    const isPlaying = this.status === STATUS.PLAYING && Boolean(this.game);
    const gState = isPlaying ? this.game.state : null;
    return {
      code: this.code,
      status: this.status,
      version: this.version,
      turnNumber: gState ? gState.turnNumber : 0,
      currentPlayerId: gState ? gState.currentPlayerId : null,
      phase: gState ? gState.phase : null,
      players: [...this.#seats.values()].map((s) => {
        const p = gState ? gState.players.find((x) => x.id === s.id) : null;
        return {
          id: s.id,
          name: s.name,
          color: s.color,
          connected: s.connected,
          isBot: Boolean(s.bot),
          cash: p ? p.cash : 0,
          position: p ? p.position : 0,
          inJail: p ? p.inJail : false,
          jailTurns: p ? p.jailTurns : 0,
          bankrupt: p ? p.bankrupt : false,
          doublesCount: p ? p.doublesCount : 0,
          debt: p ? p.debt : { total: 0, owed: [] },
          properties: p
            ? Object.entries(gState.properties)
                .filter(([_, prop]) => prop.ownerId === s.id)
                .map(([tileId, prop]) => ({
                  tileId,
                  buildings: prop.buildings,
                  mortgaged: prop.mortgaged,
                }))
            : [],
          queuedRolls: this.devState.queuedRolls.get(s.id) || [],
          policies: this.devState.policies.get(s.id) || {},
        };
      }),
      board: BOARD.map((tile) => {
        const prop = gState ? gState.properties[tile.id] : null;
        return {
          index: tile.index,
          id: tile.id,
          name: tile.name,
          type: tile.type,
          group: tile.group || null,
          price: tile.price || 0,
          ownerId: prop ? prop.ownerId : null,
          buildings: prop ? prop.buildings : 0,
          mortgaged: prop ? prop.mortgaged : false,
        };
      }),
      cards: isPlaying && gState.decks ? {
        surprise: (gState.decks.surprise || []).slice(0, 5).map((id) => {
          const c = getCard('surprise', id);
          return { id, text: c ? c.text : id, kind: c?.effect?.kind };
        }),
        treasure: (gState.decks.treasure || []).slice(0, 5).map((id) => {
          const c = getCard('treasure', id);
          return { id, text: c ? c.text : id, kind: c?.effect?.kind };
        }),
        allSurprise: Object.values(DECKS.surprise).map((c) => ({ id: c.id, text: c.text, kind: c.effect.kind })),
        allTreasure: Object.values(DECKS.treasure).map((c) => ({ id: c.id, text: c.text, kind: c.effect.kind })),
      } : null,
      auction: isPlaying && gState.auction ? {
        tileId: gState.auction.tileId,
        highBid: gState.auction.highBid,
        highBidderId: gState.auction.highBidderId,
        bidders: gState.auction.bidders,
        endsAt: this.#auctionTimer ? this.#auctionTimer.endsAt : null,
      } : null,
    };
  }

  /** Clear every timer and send every socket away. The room is unusable afterwards. */
  dispose(reason = 'closed') {
    if (this.closed) return;
    this.#clearTurnTimer();
    this.#clearAuctionTimer();
    this.#clearBotTimer();
    for (const id of [...this.#awayTimers.keys()]) this.#clearAwayTimer(id);
    for (const seat of this.#seats.values()) {
      if (seat.socketId) this.transport.detach(this.code, seat.socketId, 'roomClosed', { code: this.code, reason });
    }
    this.closed = true;
  }
}

module.exports = { Room, STATUS, AWAY_GRACE_MS, REAL_CLOCK, BOT_DELAY };
