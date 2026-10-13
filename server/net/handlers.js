'use strict';

/**
 * Socket.io wiring. Each client→server event goes through one wrapper that
 * rate-limits it, validates the payload, runs it inside try/catch, and always
 * acks with { ok: true, ... } or { ok: false, error }. Events nobody listens
 * for are ignored by Socket.io. See docs/protocol.md for the full protocol.
 *
 * A socket is bound to at most one room at a time (socket.data.code). Which
 * seat it holds is decided by the Room, from the socket id alone.
 */

const { SCHEMAS, validatePayload, normalizeCode } = require('./validate');
const { RateLimiter } = require('./rateLimit');

const channel = (code) => `room:${code}`;
const fail = (error) => ({ ok: false, error });

/** Per-socket limits, by event group. */
const LIMITS = {
  action: { limit: 20, windowMs: 1000 },
  listRooms: { limit: 5, windowMs: 5000 },
  join: { limit: 10, windowMs: 10_000 },
  other: { limit: 30, windowMs: 1000 },
};

/** The Room-facing transport, implemented on top of Socket.io. */
function createTransport(io) {
  const socketById = (id) => io.sockets.sockets.get(id);
  return {
    attach(code, socketId) {
      const socket = socketById(socketId);
      if (!socket) return;
      socket.join(channel(code));
      socket.data.code = code;
    },
    detach(code, socketId, event, payload) {
      const socket = socketById(socketId);
      if (!socket) return;
      if (event) socket.emit(event, payload);
      socket.leave(channel(code));
      if (socket.data.code === code) socket.data.code = null;
    },
    toRoom(code, event, payload) {
      io.to(channel(code)).emit(event, payload);
    },
    toSocket(socketId, event, payload) {
      io.to(socketId).emit(event, payload);
    },
  };
}

function attachHandlers(io, manager, { log = console, now = Date.now } = {}) {
  const limiters = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, new RateLimiter({ ...v, now })]));

  io.on('connection', (socket) => {
    socket.data.code = null;
    const currentRoom = () => (socket.data.code ? manager.get(socket.data.code) : null);

    /** Leave whatever seat this socket holds, as if it had disconnected. */
    const unbind = () => {
      const room = currentRoom();
      if (!room) return;
      room.disconnect(socket.id);
      manager.transport.detach(room.code, socket.id);
    };

    /** Register a validated, rate-limited, crash-proof handler. */
    const on = (event, limit, handler) => {
      socket.on(event, (payload, ack) => {
        if (typeof payload === 'function' && ack === undefined) [payload, ack] = [undefined, payload];
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          if (!limiters[limit].take(socket.id)) return reply(fail('rate limited'));
          const checked = validatePayload(SCHEMAS[event], payload);
          if (!checked.ok) return reply(fail(checked.error));
          return reply(handler(checked.value) || { ok: true });
        } catch (err) {
          log.error(`[room ${socket.data.code || '-'}] ${event} from ${socket.id} failed:`, err);
          return reply(fail('server error'));
        }
      });
    };

    /** For events that need the socket to be in a room. */
    const inRoom = (fn) => (value) => {
      const room = currentRoom();
      return room ? fn(room, value) : fail('not in a room');
    };

    on('createRoom', 'join', ({ name }) => {
      unbind();
      return manager.createRoom({ socketId: socket.id, name });
    });

    on('joinRoom', 'join', ({ code, name, token }) => {
      const normalized = normalizeCode(code);
      const room = normalized && manager.get(normalized);
      if (!room) return fail('room not found');
      unbind();
      return room.join({ socketId: socket.id, name, token });
    });

    on('listRooms', 'listRooms', () => ({ ok: true, rooms: manager.listPublic() }));

    on('leaveRoom', 'other', inRoom((room) => room.leave(socket.id)));
    on('pickColor', 'other', inRoom((room, { color }) => room.pickColor(socket.id, color)));
    on('updateSettings', 'other', inRoom((room, { settings }) => room.updateSettings(socket.id, settings)));
    on('kick', 'other', inRoom((room, { playerId }) => room.kick(socket.id, playerId)));
    on('startGame', 'other', inRoom((room) => room.start(socket.id)));
    on('playAgain', 'other', inRoom((room) => room.playAgain(socket.id)));
    on('action', 'action', inRoom((room, action) => room.action(socket.id, action)));
    on('chat', 'other', inRoom((room, { text }) => room.chat(socket.id, text)));

    socket.on('disconnect', () => {
      try {
        const room = currentRoom();
        if (room) room.disconnect(socket.id);
      } catch (err) {
        log.error(`[room ${socket.data.code || '-'}] disconnect failed:`, err);
      }
      for (const limiter of Object.values(limiters)) limiter.forget(socket.id);
    });
  });
}

module.exports = { attachHandlers, createTransport, LIMITS };
