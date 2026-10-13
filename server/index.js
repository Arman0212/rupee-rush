'use strict';

/**
 * HTTP + Socket.io entry point.
 *
 *   PORT=3000 node server/index.js
 *
 * createServer() builds everything without listening, so scripts/smoke.js can
 * run the real server in-process on a random port.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms/RoomManager');
const { attachHandlers, createTransport } = require('./net/handlers');
const { normalizeCode } = require('./net/validate');
const { createLogger } = require('./log');
const rules = require('../shared/rules');
const { GAME_NAME, GAME_TAGLINE } = rules;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', 'shared'); // UMD files, loaded by the browser as window.RR
const MAX_PAYLOAD_BYTES = 16 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * index.html with its link-preview tags filled in. Previews need absolute
 * URLs, and the public host is only known per request (behind Render's or
 * Railway's proxy, thanks to 'trust proxy'). Cached in production.
 */
function indexRenderer() {
  let cached = null;
  const template = () => {
    if (cached) return cached;
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    if (process.env.NODE_ENV === 'production') cached = html;
    return html;
  };
  return (req, code) => {
    const origin = `${req.protocol}://${req.host}`;
    const fields = code
      ? { TITLE: `Join my ${GAME_NAME} game · room ${code}`, DESCRIPTION: 'Tap to join the room, pick a colour and start trading cities across the world.' }
      : { TITLE: `${GAME_NAME} · ${GAME_TAGLINE}`, DESCRIPTION: 'A multiplayer property-trading game for friends. Buy cities, build, bid, trade and outlast everyone.' };
    fields.ORIGIN = origin;
    fields.URL = `${origin}${code ? `/r/${code}` : '/'}`;
    return template().replace(/%(TITLE|DESCRIPTION|ORIGIN|URL)%/g, (_, key) => escapeHtml(fields[key]));
  };
}

function createServer({ log = createLogger(), clock } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // one proxy hop (Render, Railway): real protocol, host and client IP
  const httpServer = http.createServer(app);
  // Both transports: websocket where possible, long-polling through proxies that block it.
  const io = new Server(httpServer, { maxHttpBufferSize: MAX_PAYLOAD_BYTES, transports: ['websocket', 'polling'] });

  const manager = new RoomManager({ transport: createTransport(io), log, ...(clock ? { clock } : {}) });
  attachHandlers(io, manager, { log, ...(clock ? { now: clock.now } : {}) });

  const renderIndex = indexRenderer();
  app.get('/health', (req, res) => res.json({ ok: true, ...manager.stats() }));
  app.get('/', (req, res) => res.type('html').send(renderIndex(req, null)));
  app.get('/r/:code', (req, res) => res.type('html').send(renderIndex(req, normalizeCode(req.params.code))));
  app.use('/shared', express.static(SHARED_DIR));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  return {
    app,
    io,
    manager,
    httpServer,
    /** Resolves with the bound port (pass 0 for a random one). */
    listen(port) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => {
          manager.startSweeping();
          resolve(httpServer.address().port);
        });
      });
    },
    /** Close every room (sockets get 'roomClosed'), then the sockets and the HTTP server. */
    close() {
      manager.dispose();
      return new Promise((resolve) => io.close(() => resolve()));
    },
  };
}

if (require.main === module) {
  const log = createLogger();
  const server = createServer({ log });
  const port = Number(process.env.PORT) || 3000;
  server.listen(port).then((p) => log.info(`${GAME_NAME} listening on port ${p}`));

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: closing rooms and connections`);
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    server.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createServer };
