'use strict';

/**
 * HTTP + Socket.io entry point.
 *
 *   PORT=3000 node server/index.js
 *
 * createServer() builds everything without listening, so scripts/smoke.js can
 * run the real server in-process on a random port.
 */

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms/RoomManager');
const { attachHandlers, createTransport } = require('./net/handlers');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_PAYLOAD_BYTES = 16 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;

function createServer({ log = console, clock } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: MAX_PAYLOAD_BYTES });

  const manager = new RoomManager({ transport: createTransport(io), log, ...(clock ? { clock } : {}) });
  attachHandlers(io, manager, { log, ...(clock ? { now: clock.now } : {}) });

  app.get('/health', (req, res) => res.json({ ok: true, ...manager.stats() }));
  app.get('/r/:code', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.use(express.static(PUBLIC_DIR));

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
  const server = createServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port).then((p) => console.log(`Rupee Rush listening on http://localhost:${p}`));

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: closing rooms and connections`);
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    server.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createServer };
