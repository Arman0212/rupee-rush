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
 */

const crypto = require('node:crypto');
const { Game, PHASE } = require('../game/Game');
const { ROOM, PLAYER_COLORS, sanitizeSettings } = require('../../shared/rules');
const { RateLimiter } = require('../net/rateLimit');
const { cleanName, cleanText } = require('../net/validate');

const STATUS = Object.freeze({ LOBBY: 'lobby', PLAYING: 'playing', FINISHED: 'finished' });

/** How long a disconnected player keeps their lobby seat, and how long before they can be kicked mid-game. */
const AWAY_GRACE_MS = 60_000;
const CHAT_HISTORY = 100;
const CHAT_RATE = { limit: 5, windowMs: 5000 };
/** When the turn timer expires, the first of these that is legal gets played. */
const AUTOPLAY_ORDER = ['roll', 'decline', 'endTurn'];
const MAX_AUTOPLAY_STEPS = 50;
const ACTIVE_PHASES = new Set([PHASE.AWAITING_ROLL, PHASE.BUY_DECISION, PHASE.AWAITING_END]);

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
  /** Seats in join order: id -> { id, name, color, token, socketId, connected, disconnectedAt }. */
  #seats = new Map();
  #awayTimers = new Map(); // seat id -> timer handle
  #turnTimer = null; // { key, mode, deadline, handle }
  #chatLimiter;

  /**
   * @param {object}   opts
   * @param {string}   opts.code
   * @param {object}   opts.transport
   * @param {object}   [opts.clock]    { now, setTimeout, clearTimeout }
   * @param {object}   [opts.log]      console-like
   * @param {Function} [opts.onEmpty]  called once the last seat is gone
   * @param {Function} [opts.makeGame] (settings, now) => Game, so tests can seed or rig it
   */
  constructor({ code, transport, clock = REAL_CLOCK, log = console, onEmpty = () => {}, makeGame }) {
    this.code = code;
    this.transport = transport;
    this.clock = clock;
    this.log = log;
    this.onEmpty = onEmpty;
    this.makeGame = makeGame || ((settings, now) => new Game({ settings, now }));
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
    };
    this.#seats.set(newSeat.id, newSeat);
    if (!this.hostId) this.hostId = newSeat.id;
    this.transport.attach(this.code, socketId);
    this.#sendChatHistory(socketId);
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
    this.#syncTurnTimer();
    this.#broadcast([this.#roomEvent('seatReconnected', { playerId: seat.id })]);
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
    this.#syncTurnTimer();
    this.#broadcast([this.#roomEvent('seatDisconnected', { playerId: seat.id })]);
  }

  /** Leave on purpose. Mid-game this is bankruptcy to the bank. */
  leave(socketId) {
    const seat = this.#seatBySocket(socketId);
    if (!seat) return fail('not in this room');
    const events = this.status === STATUS.PLAYING ? this.game.removePlayer(seat.id).events : [];
    this.#removeSeat(seat, 'left');
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
    const next = sanitizeSettings({ ...this.settings, ...partial });
    // Never drop the limit below the players already seated.
    next.maxPlayers = Math.max(next.maxPlayers, this.#seats.size);
    this.settings = next;
    this.#broadcast([this.#roomEvent('settingsChanged', { settings: next })]);
    return ok({ settings: next });
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
    this.#afterChange([...events, this.#roomEvent('seatLeft', { playerId: target.id, reason: 'kicked' })]);
    return ok();
  }

  start(socketId) {
    const error = this.#requireHost(socketId, STATUS.LOBBY);
    if (error) return fail(error);
    if (this.#seats.size < 2) return fail('need at least 2 players');

    const game = this.makeGame(this.settings, this.clock.now);
    for (const seat of this.#seats.values()) {
      const added = game.addPlayer({ id: seat.id, name: seat.name, color: seat.color });
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

  /** After the game changed: settle the room status and timers, then tell everyone. */
  #afterChange(events) {
    const gameOver = this.status === STATUS.PLAYING && this.game.state.phase === PHASE.GAME_OVER;
    if (gameOver) this.status = STATUS.FINISHED;
    this.#syncTurnTimer();
    this.#broadcast(events);
    if (gameOver) {
      const winner = this.game.state.players.find((p) => p.id === this.game.state.winnerId);
      this.transport.toRoom(this.code, 'gameOver', { winnerId: winner ? winner.id : null, name: winner ? winner.name : null });
    }
    if (this.#seats.size === 0) this.onEmpty(this);
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
    const want = this.#wantedTurnTimer();
    const current = this.#turnTimer;
    if (current && want && current.key === want.key && current.mode === want.mode) return;
    this.#clearTurnTimer();
    if (!want) return;
    const handle = this.clock.setTimeout(() => this.#onTurnTimeout(), want.ms);
    this.#turnTimer = { ...want, deadline: this.clock.now() + want.ms, handle };
  }

  #wantedTurnTimer() {
    if (this.status !== STATUS.PLAYING || !ACTIVE_PHASES.has(this.game.state.phase)) return null;
    const { currentPlayerId, turnNumber } = this.game.state;
    const key = `${turnNumber}:${currentPlayerId}`;
    const seconds = this.settings.turnTimerSeconds;
    if (seconds > 0) return { key, mode: 'turn', ms: seconds * 1000 };
    const seat = this.#seats.get(currentPlayerId);
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
    const sameTurn = () => state.phase !== PHASE.GAME_OVER && this.game.state.currentPlayerId === playerId
      && this.game.state.turnNumber === turnNumber;

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
    this.#afterChange(events);
  }

  /**
   * Roll, then decline, then end the turn. Selling and mortgaging are never
   * done on a player's behalf, so a player in debt (who can't roll or end the
   * turn) is declared bankrupt.
   */
  #autoAction(playerId) {
    const legal = this.game.getLegalActions(playerId);
    for (const type of AUTOPLAY_ORDER) {
      const action = legal.find((a) => a.type === type);
      if (action) return action;
    }
    return legal.find((a) => a.type === 'bankrupt') || null;
  }

  // =========================================================================
  // Chat
  // =========================================================================

  chat(socketId, raw) {
    const seat = this.#seatBySocket(socketId);
    if (!seat) return fail('not in this room');
    const text = cleanText(raw, ROOM.chatMaxLength);
    if (!text) return fail('empty message');
    if (!this.#chatLimiter.take(seat.id)) return fail('slow down: at most 5 messages every 5 seconds');
    const message = { id: ++this.chatSeq, playerId: seat.id, name: seat.name, text, ts: this.clock.now() };
    this.chatLog.push(message);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    this.transport.toRoom(this.code, 'chat', message);
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
      })),
    };
  }

  /** Summary for the public room list. */
  listing() {
    const host = this.#seats.get(this.hostId);
    return { code: this.code, hostName: host ? host.name : null, players: this.#seats.size, maxPlayers: this.settings.maxPlayers };
  }

  get isPublicLobby() {
    return this.status === STATUS.LOBBY && !this.settings.isPrivate;
  }

  get seatCount() {
    return this.#seats.size;
  }

  get connectedCount() {
    return [...this.#seats.values()].filter((s) => s.connected).length;
  }

  get turnDeadline() {
    return this.#turnTimer ? this.#turnTimer.deadline : null;
  }

  /** One 'state' to the room with a new version, then each seat's private 'you'. */
  #broadcast(events = []) {
    if (this.closed) return;
    this.version += 1;
    this.transport.toRoom(this.code, 'state', {
      version: this.version,
      room: this.publicRoom(),
      publicState: this.game ? this.game.publicState() : null,
      events,
      deadline: this.turnDeadline,
    });
    for (const seat of this.#seats.values()) {
      if (seat.socketId) this.transport.toSocket(seat.socketId, 'you', this.#privateView(seat));
    }
    this.emptySince = this.connectedCount === 0 ? (this.emptySince ?? this.clock.now()) : null;
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

  /** The next seat in join order becomes host, preferring someone who is connected. */
  #transferHost(fromId) {
    const others = [...this.#seats.values()].filter((s) => s.id !== fromId);
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

  /** Clear every timer and send every socket away. The room is unusable afterwards. */
  dispose(reason = 'closed') {
    if (this.closed) return;
    this.#clearTurnTimer();
    for (const id of [...this.#awayTimers.keys()]) this.#clearAwayTimer(id);
    for (const seat of this.#seats.values()) {
      if (seat.socketId) this.transport.detach(this.code, seat.socketId, 'roomClosed', { code: this.code, reason });
    }
    this.closed = true;
  }
}

module.exports = { Room, STATUS, AWAY_GRACE_MS, REAL_CLOCK };
