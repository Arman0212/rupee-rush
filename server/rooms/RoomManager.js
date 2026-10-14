'use strict';

/**
 * Owns every live room: creates them with unique codes, finds them, lists the
 * public lobbies and sweeps away idle or old rooms. Rooms live in memory only,
 * so a server restart ends every game.
 */

const crypto = require('node:crypto');
const { ROOM } = require('../../shared/rules');
const { Room, REAL_CLOCK } = require('./Room');

const IDLE_MS = 30 * 60 * 1000; // no connected sockets for this long
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // hard lifetime of any room
const SWEEP_EVERY_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 1000;

/** A random room code drawn from ROOM.codeAlphabet. */
function randomCode(randomInt = crypto.randomInt) {
  let code = '';
  for (let i = 0; i < ROOM.codeLength; i++) code += ROOM.codeAlphabet[randomInt(ROOM.codeAlphabet.length)];
  return code;
}

class RoomManager {
  #rooms = new Map(); // code -> Room
  #sweepHandle = null;

  /**
   * @param {object}   opts
   * @param {object}   opts.transport see Room
   * @param {object}   [opts.clock]
   * @param {object}   [opts.log]
   * @param {Function} [opts.makeCode] () => string, for tests
   * @param {Function} [opts.makeGame] passed through to every Room
   * @param {object}   [opts.botDelay] passed through to every Room
   */
  constructor({ transport, clock = REAL_CLOCK, log = console, makeCode = randomCode, makeGame, idleMs = IDLE_MS, maxAgeMs = MAX_AGE_MS, botDelay }) {
    Object.assign(this, { transport, clock, log, makeCode, makeGame, idleMs, maxAgeMs, botDelay });
  }

  /** Create a room and seat its creator, who becomes host. */
  createRoom({ socketId, name }) {
    const code = this.#uniqueCode();
    if (!code) return { ok: false, error: 'could not allocate a room code, try again' };
    const room = new Room({
      code,
      transport: this.transport,
      clock: this.clock,
      log: this.log,
      makeGame: this.makeGame,
      ...(this.botDelay ? { botDelay: this.botDelay } : {}),
      onEmpty: (r) => this.deleteRoom(r.code, 'empty'),
    });
    room.onDevUpdate = () => this.onDevUpdate?.(code);
    this.#rooms.set(code, room);
    const result = room.join({ socketId, name });
    if (!result.ok) {
      this.deleteRoom(code, 'failed');
    } else {
      this.onRoomChange?.();
    }
    return result;
  }

  get(code) {
    return this.#rooms.get(code) || null;
  }

  allRooms() {
    return [...this.#rooms.values()];
  }

  /** Public lobbies only: not private, not started. */
  listPublic() {
    return [...this.#rooms.values()].filter((r) => r.isPublicLobby).map((r) => r.listing());
  }

  stats() {
    let players = 0;
    for (const room of this.#rooms.values()) players += room.seatCount;
    return { rooms: this.#rooms.size, players };
  }

  deleteRoom(code, reason) {
    const room = this.#rooms.get(code);
    if (!room) return;
    this.#rooms.delete(code);
    room.dispose(reason);
    this.onRoomChange?.();
  }

  /** Delete rooms nobody has been connected to for idleMs, and any room older than maxAgeMs. */
  sweep() {
    const now = this.clock.now();
    for (const room of [...this.#rooms.values()]) {
      if (now - room.createdAt >= this.maxAgeMs) this.deleteRoom(room.code, 'expired');
      else if (room.emptySince !== null && now - room.emptySince >= this.idleMs) this.deleteRoom(room.code, 'idle');
    }
  }

  /** Sweep every minute until stop() (a chain of timeouts, so a fake clock can drive it). */
  startSweeping(everyMs = SWEEP_EVERY_MS) {
    const tick = () => {
      this.sweep();
      this.#sweepHandle = this.clock.setTimeout(tick, everyMs);
    };
    this.#sweepHandle = this.clock.setTimeout(tick, everyMs);
  }

  /** Stop sweeping and close every room (graceful shutdown). */
  dispose(reason = 'server shutting down') {
    if (this.#sweepHandle) this.clock.clearTimeout(this.#sweepHandle);
    this.#sweepHandle = null;
    for (const code of [...this.#rooms.keys()]) this.deleteRoom(code, reason);
  }

  #uniqueCode() {
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const code = this.makeCode();
      if (!this.#rooms.has(code)) return code;
    }
    return null;
  }
}

module.exports = { RoomManager, randomCode, IDLE_MS, MAX_AGE_MS };
