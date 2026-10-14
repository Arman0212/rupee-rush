'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { DevAuthRateLimiter } = require('./rateLimit');

const MIN_KEY_LENGTH = 32;

function verifyKey(inputKey, expectedKey) {
  if (typeof inputKey !== 'string' || typeof expectedKey !== 'string') return false;
  const a = crypto.createHash('sha256').update(inputKey).digest();
  const b = crypto.createHash('sha256').update(expectedKey).digest();
  return crypto.timingSafeEqual(a, b);
}

function normalizeDevPath(p) {
  if (!p || typeof p !== 'string') return '/x-monopoly-dev';
  let clean = p.trim();
  if (!clean.startsWith('/')) clean = '/' + clean;
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean;
}

function setupDevServer({ app, io, manager, log = console, clock }) {
  const devKey = process.env.DEV_KEY;
  if (!devKey || typeof devKey !== 'string' || devKey.length < MIN_KEY_LENGTH) {
    return null;
  }

  const devPath = normalizeDevPath(process.env.DEV_PATH);
  const now = clock && typeof clock.now === 'function' ? clock.now : Date.now;
  const rateLimiter = new DevAuthRateLimiter({ now });

  // 1. Serve static panel assets strictly from devPath
  const devDir = __dirname;
  app.get(devPath, (req, res) => {
    if (rateLimiter.isBlocked(req.ip)) {
      log.warn(`[dev] Blocked IP ${req.ip} tried to access ${devPath}`);
      return res.status(403).send('Forbidden');
    }
    res.sendFile(path.join(devDir, 'index.html'));
  });
  app.use(devPath, (req, res, next) => {
    if (rateLimiter.isBlocked(req.ip)) {
      log.warn(`[dev] Blocked IP ${req.ip} tried to access static dev asset ${req.url}`);
      return res.status(403).send('Forbidden');
    }
    next();
  }, express.static(devDir));

  // 2. Setup Socket.io dev namespace
  const devIo = io.of(devPath);

  devIo.use((socket, next) => {
    const ip = socket.handshake.address || socket.conn.remoteAddress || 'unknown';
    if (rateLimiter.isBlocked(ip)) {
      log.warn(`[dev] Blocked IP ${ip} tried to connect to dev namespace ${devPath}`);
      return next(new Error('unauthorized'));
    }

    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (verifyKey(token, devKey)) {
      rateLimiter.recordSuccess(ip);
      return next();
    }

    const result = rateLimiter.recordFailure(ip);
    if (result.blocked) {
      log.warn(`[dev] IP ${ip} blocked for 1 hour after 5 failed dev auth attempts`);
    } else {
      log.warn(`[dev] Failed dev auth attempt from IP ${ip} (${result.attempts}/5)`);
    }
    return next(new Error('unauthorized'));
  });

  function broadcastRooms() {
    const rooms = manager.allRooms().map((r) => r.devSummary());
    devIo.emit('rooms', rooms);
  }

  manager.onRoomChange = () => broadcastRooms();
  manager.onDevUpdate = (code) => {
    const room = manager.get(code);
    if (room) {
      devIo.to(`room:${code}`).emit('roomState', room.getDevState());
    }
    broadcastRooms();
  };

  devIo.on('connection', (socket) => {
    socket.emit('rooms', manager.allRooms().map((r) => r.devSummary()));

    socket.on('getRooms', (ack = () => {}) => {
      const rooms = manager.allRooms().map((r) => r.devSummary());
      ack({ ok: true, rooms });
    });

    socket.on('watchRoom', ({ code }, ack = () => {}) => {
      for (const roomName of socket.rooms) {
        if (roomName.startsWith('room:')) socket.leave(roomName);
      }
      const room = manager.get(code);
      if (!room) return ack({ ok: false, error: 'room not found' });
      socket.join(`room:${code}`);
      ack({ ok: true, state: room.getDevState() });
    });

    socket.on('unwatchRoom', ({ code }) => {
      socket.leave(`room:${code}`);
    });

    socket.on('setRoll', ({ code, playerId, dice }, ack = () => {}) => {
      const room = manager.get(code);
      if (!room) return ack({ ok: false, error: 'room not found' });
      const ok = room.devSetRoll(playerId, dice);
      if (ok) {
        devIo.to(`room:${code}`).emit('roomState', room.getDevState());
        ack({ ok: true });
      } else {
        ack({ ok: false, error: 'invalid dice' });
      }
    });

    socket.on('queueRolls', ({ code, playerId, rolls }, ack = () => {}) => {
      const room = manager.get(code);
      if (!room) return ack({ ok: false, error: 'room not found' });
      const ok = room.devQueueRolls(playerId, rolls);
      if (ok) {
        devIo.to(`room:${code}`).emit('roomState', room.getDevState());
        ack({ ok: true });
      } else {
        ack({ ok: false, error: 'invalid rolls' });
      }
    });

    socket.on('setPolicy', ({ code, playerId, policy, value }, ack = () => {}) => {
      const room = manager.get(code);
      if (!room) return ack({ ok: false, error: 'room not found' });
      const ok = room.devSetPolicy(playerId, policy, value);
      if (ok) {
        devIo.to(`room:${code}`).emit('roomState', room.getDevState());
        ack({ ok: true });
      } else {
        ack({ ok: false, error: 'could not set policy' });
      }
    });

    socket.on('clearControls', ({ code, playerId }, ack = () => {}) => {
      const room = manager.get(code);
      if (!room) return ack({ ok: false, error: 'room not found' });
      room.devClearControls(playerId);
      devIo.to(`room:${code}`).emit('roomState', room.getDevState());
      ack({ ok: true });
    });

    socket.on('setNextCard', ({ code, deck, cardId }, ack = () => {}) => {
      const room = manager.get(code);
      if (!room) return ack({ ok: false, error: 'room not found' });
      const ok = room.devSetNextCard(deck, cardId);
      if (ok) {
        devIo.to(`room:${code}`).emit('roomState', room.getDevState());
        ack({ ok: true });
      } else {
        ack({ ok: false, error: 'could not set card' });
      }
    });

    socket.on('adjustCash', ({ code, playerId, amount }, ack = () => {}) => {
      const room = manager.get(code);
      if (!room) return ack({ ok: false, error: 'room not found' });
      const ok = room.devAdjustCash(playerId, Number(amount));
      if (ok) {
        devIo.to(`room:${code}`).emit('roomState', room.getDevState());
        ack({ ok: true });
      } else {
        ack({ ok: false, error: 'could not adjust cash' });
      }
    });

    socket.on('extendAuction', ({ code, seconds }, ack = () => {}) => {
      const room = manager.get(code);
      if (!room) return ack({ ok: false, error: 'room not found' });
      const ok = room.devExtendAuction(seconds);
      if (ok) {
        devIo.to(`room:${code}`).emit('roomState', room.getDevState());
        ack({ ok: true });
      } else {
        ack({ ok: false, error: 'auction not active' });
      }
    });

    socket.on('endAuction', ({ code }, ack = () => {}) => {
      const room = manager.get(code);
      if (!room) return ack({ ok: false, error: 'room not found' });
      const ok = room.devEndAuction();
      if (ok) {
        devIo.to(`room:${code}`).emit('roomState', room.getDevState());
        ack({ ok: true });
      } else {
        ack({ ok: false, error: 'auction not active' });
      }
    });
  });

  return { devPath, rateLimiter };
}

module.exports = { setupDevServer, verifyKey, normalizeDevPath };
