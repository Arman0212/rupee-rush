'use strict';

/**
 * Fakes for the room tests: a manual clock and a transport that records what
 * every socket would have received.
 */

const { Game } = require('../server/game/Game');
const { Room } = require('../server/rooms/Room');

/** A clock whose time only moves when advance() is called; due timers run in order. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

/** Records messages per socket. Room broadcasts are delivered to every attached socket. */
function fakeTransport() {
  const messages = []; // { to, event, payload }
  const channels = new Map(); // socketId -> code
  return {
    messages,
    channels,
    attach(code, socketId) {
      channels.set(socketId, code);
    },
    detach(code, socketId, event, payload) {
      if (event) messages.push({ to: socketId, event, payload });
      if (channels.get(socketId) === code) channels.delete(socketId);
    },
    toRoom(code, event, payload) {
      for (const [socketId, c] of channels) if (c === code) messages.push({ to: socketId, event, payload });
    },
    toSocket(socketId, event, payload) {
      messages.push({ to: socketId, event, payload });
    },
    /** Payloads `socketId` received for `event`, oldest first. */
    received(socketId, event) {
      return messages.filter((m) => m.to === socketId && m.event === event).map((m) => m.payload);
    },
    last(socketId, event) {
      return this.received(socketId, event).at(-1);
    },
  };
}

const quietLog = { log() {}, warn() {}, error() {} };

/** A room with a seeded game and fakes. Returns everything a test needs. */
function makeRoom({ seed = 1 } = {}) {
  const clock = fakeClock();
  const transport = fakeTransport();
  const emptied = [];
  const room = new Room({
    code: 'TESTAB',
    transport,
    clock,
    log: quietLog,
    onEmpty: (r) => emptied.push(r.code),
    makeGame: (settings, now) => new Game({ settings, now, seed }),
  });
  return { room, clock, transport, emptied };
}

/** Seat `names` on sockets s1, s2, …; returns their join results in order. */
function seat(room, ...names) {
  return names.map((name, i) => {
    const result = room.join({ socketId: `s${i + 1}`, name });
    if (!result.ok) throw new Error(`join failed: ${result.error}`);
    return result;
  });
}

/** Seat players and start; returns { players, current } where current is the socket on turn. */
function startedRoom({ players = 2, settings = {}, seed } = {}) {
  const ctx = makeRoom({ seed });
  const joined = seat(ctx.room, ...Array.from({ length: players }, (_, i) => `P${i + 1}`));
  if (Object.keys(settings).length) ctx.room.updateSettings('s1', settings);
  const started = ctx.room.start('s1');
  if (!started.ok) throw new Error(started.error);
  return { ...ctx, joined, socketOf: (playerId) => `s${joined.findIndex((j) => j.playerId === playerId) + 1}` };
}

module.exports = { fakeClock, fakeTransport, quietLog, makeRoom, seat, startedRoom };
