'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server/index');
const { Room } = require('../server/rooms/Room');
const { Game } = require('../server/game/Game');
const { DevAuthRateLimiter } = require('../server/dev/rateLimit');
const { BOARD, TILE } = require('../shared/board');
const { fakeClock, fakeTransport, startedRoom } = require('./roomHelpers');

const VALID_DEV_KEY = 'a'.repeat(32); // exactly 32 chars
const SECRET_DEV_PATH = '/x-secret-test-dev-path';
const quietLog = { log() {}, warn() {}, error() {}, info() {} };

test('Developer Panel: access control without DEV_KEY', async () => {
  const oldKey = process.env.DEV_KEY;
  const oldPath = process.env.DEV_PATH;
  delete process.env.DEV_KEY;
  process.env.DEV_PATH = SECRET_DEV_PATH;

  const server = createServer({ log: quietLog });
  const port = await server.listen(0);

  try {
    // 1. HTTP GET dev path returns 404
    const res = await fetch(`http://127.0.0.1:${port}${SECRET_DEV_PATH}`);
    assert.equal(res.status, 404, 'Dev path should 404 when DEV_KEY is not set');

    // 2. Dev namespace rejects connections
    const socket = connect(`http://127.0.0.1:${port}${SECRET_DEV_PATH}`, {
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 1000,
      auth: { token: VALID_DEV_KEY },
    });

    const err = await new Promise((resolve) => {
      socket.on('connect_error', resolve);
      socket.on('connect', () => resolve(null));
    });
    socket.close();
    assert.ok(err !== null, 'Dev namespace connection must fail when DEV_KEY is not set');
  } finally {
    await server.close();
    if (oldKey) process.env.DEV_KEY = oldKey;
    if (oldPath) process.env.DEV_PATH = oldPath;
  }
});

test('Developer Panel: access control with DEV_KEY and rate limiting', async () => {
  const oldKey = process.env.DEV_KEY;
  const oldPath = process.env.DEV_PATH;
  process.env.DEV_KEY = VALID_DEV_KEY;
  process.env.DEV_PATH = SECRET_DEV_PATH;

  const server = createServer({ log: quietLog });
  const port = await server.listen(0);

  try {
    // 1. HTTP GET serves dev HTML
    const res = await fetch(`http://127.0.0.1:${port}${SECRET_DEV_PATH}`);
    assert.equal(res.status, 200, 'Dev path should return 200 when DEV_KEY is set');
    const html = await res.text();
    assert.ok(html.includes('Dev Control'), 'Dev path should serve dev panel HTML');

    // 2. Connecting with valid key succeeds
    const goodSocket = connect(`http://127.0.0.1:${port}${SECRET_DEV_PATH}`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: VALID_DEV_KEY },
    });
    await new Promise((resolve, reject) => {
      goodSocket.once('connect', resolve);
      goodSocket.once('connect_error', reject);
    });
    assert.ok(goodSocket.connected, 'Right key should connect');
    goodSocket.close();

    // 3. Rate limiter unit check: 5 attempts per 10 min -> blocked for 1 hour
    let now = 1000;
    const limiter = new DevAuthRateLimiter({ now: () => now, maxAttempts: 5, windowMs: 600_000, blockDurationMs: 3600_000 });
    const testIp = '1.2.3.4';
    for (let i = 1; i <= 4; i++) {
      const res = limiter.recordFailure(testIp);
      assert.equal(res.blocked, false);
      assert.equal(res.attempts, i);
      assert.equal(limiter.isBlocked(testIp), false);
    }
    // 5th attempt blocks
    const fifth = limiter.recordFailure(testIp);
    assert.equal(fifth.blocked, true);
    assert.equal(limiter.isBlocked(testIp), true);

    // After 30 minutes, still blocked
    now += 1800_000;
    assert.equal(limiter.isBlocked(testIp), true);

    // After 1 hour + 1 second, unblocked
    now += 1800_001;
    assert.equal(limiter.isBlocked(testIp), false);
  } finally {
    await server.close();
    if (oldKey) process.env.DEV_KEY = oldKey;
    else delete process.env.DEV_KEY;
    if (oldPath) process.env.DEV_PATH = oldPath;
    else delete process.env.DEV_PATH;
  }
});

test('Developer Panel: forced rolls and queued rolls in Room', () => {
  const ctx = startedRoom({ players: 2, seed: 123 });
  const { room } = ctx;
  const p1Id = room.game.state.currentPlayerId;
  const p1Socket = ctx.socketOf(p1Id);
  const p2 = room.game.state.players.find((p) => p.id !== p1Id);
  const p2Socket = ctx.socketOf(p2.id);

  // Set next roll for p1
  room.devSetRoll(p1Id, [3, 4]);

  // Action roll
  const res1 = room.action(p1Socket, { type: 'roll' });
  assert.ok(res1.ok);
  const events1 = ctx.transport.last(p1Socket, 'state').events;
  const rollEvent1 = events1.find((e) => e.type === 'diceRolled');
  assert.deepEqual(rollEvent1.dice, [3, 4]);
  assert.equal(rollEvent1.total, 7);

  // Queue rolls for p2
  room.devQueueRolls(p2.id, [[1, 2], [5, 6]]);
  // End p1's turn
  if (room.game.getLegalActions(p1Id).some((a) => a.type === 'decline')) room.action(p1Socket, { type: 'decline' });
  room.action(p1Socket, { type: 'endTurn' });

  assert.equal(room.game.state.currentPlayerId, p2.id);
  const res2 = room.action(p2Socket, { type: 'roll' });
  assert.ok(res2.ok);
  const events2 = ctx.transport.last(p2Socket, 'state').events;
  const rollEvent2 = events2.find((e) => e.type === 'diceRolled');
  assert.deepEqual(rollEvent2.dice, [1, 2]);

  // Queue should still have [5, 6]
  assert.deepEqual(room.devState.queuedRolls.get(p2.id), [[5, 6]]);
});

test('Developer Panel: dice policies and natural 2d6 weighting', () => {
  // 1. "avoid tiles owned by X"
  {
    const ctx = startedRoom({ players: 2, seed: 111 });
    const { room } = ctx;
    const p1Id = room.game.state.currentPlayerId;
    const p1Socket = ctx.socketOf(p1Id);
    const p1 = room.game.state.players.find((p) => p.id === p1Id);
    const p2 = room.game.state.players.find((p) => p.id !== p1Id);

    const tile1 = BOARD[1];
    const tile3 = BOARD[3];
    room.game.state.properties[tile1.id].ownerId = p2.id;
    room.game.state.properties[tile3.id].ownerId = p2.id;

    room.devSetPolicy(p1.id, 'avoidPlayer', p2.id);

    for (let i = 0; i < 30; i++) {
      p1.position = 0;
      p1.doublesCount = 0;
      p1.cash = 1500;
      const res = room.action(p1Socket, { type: 'roll' });
      assert.ok(res.ok);
      const events = ctx.transport.last(p1Socket, 'state').events;
      const moved = events.find((e) => e.type === 'moved');
      if (moved) {
        assert.notEqual(moved.to, 1, 'Should never land on tile 1 owned by p2');
        assert.notEqual(moved.to, 3, 'Should never land on tile 3 owned by p2');
      }
      room.game.state.phase = 'awaitingRoll';
      room.game.state.turn = { dice: null, canRollAgain: false, pendingTileId: null, movesLeft: 0 };
    }
  }

  // 2. "avoid taxes"
  {
    const ctx = startedRoom({ players: 2, seed: 222 });
    const { room } = ctx;
    const p1Id = room.game.state.currentPlayerId;
    const p1Socket = ctx.socketOf(p1Id);
    const p1 = room.game.state.players.find((p) => p.id === p1Id);

    room.devSetPolicy(p1.id, 'avoidTaxes', true);
    for (let i = 0; i < 30; i++) {
      p1.position = 0;
      p1.doublesCount = 0;
      p1.cash = 1500;
      const res = room.action(p1Socket, { type: 'roll' });
      assert.ok(res.ok);
      const events = ctx.transport.last(p1Socket, 'state').events;
      const moved = events.find((e) => e.type === 'moved');
      if (moved) {
        const destTile = BOARD[moved.to];
        assert.notEqual(destTile.type, TILE.TAX, 'Should never land on tax');
      }
      room.game.state.phase = 'awaitingRoll';
      room.game.state.turn = { dice: null, canRollAgain: false, pendingTileId: null, movesLeft: 0 };
    }
  }

  // 3. "avoid Go to Jail"
  {
    const ctx = startedRoom({ players: 2, seed: 333 });
    const { room } = ctx;
    const p1Id = room.game.state.currentPlayerId;
    const p1Socket = ctx.socketOf(p1Id);
    const p1 = room.game.state.players.find((p) => p.id === p1Id);

    room.devSetPolicy(p1.id, 'avoidGoToJail', true);
    for (let i = 0; i < 30; i++) {
      p1.position = 24;
      p1.doublesCount = 0;
      p1.cash = 1500;
      const res = room.action(p1Socket, { type: 'roll' });
      assert.ok(res.ok);
      const events = ctx.transport.last(p1Socket, 'state').events;
      const moved = events.find((e) => e.type === 'moved');
      if (moved) {
        assert.notEqual(moved.to, 30, 'Should avoid Go to Jail');
      }
      assert.equal(p1.inJail, false, 'Should not be in jail');
      room.game.state.phase = 'awaitingRoll';
      room.game.state.turn = { dice: null, canRollAgain: false, pendingTileId: null, movesLeft: 0 };
    }
  }

  // 4. "aim for tile"
  {
    const ctx = startedRoom({ players: 2, seed: 444 });
    const { room } = ctx;
    const p1Id = room.game.state.currentPlayerId;
    const p1Socket = ctx.socketOf(p1Id);
    const p1 = room.game.state.players.find((p) => p.id === p1Id);

    room.devSetPolicy(p1.id, 'aimTile', BOARD[7].id);
    p1.position = 0;
    const aimRes = room.action(p1Socket, { type: 'roll' });
    assert.ok(aimRes.ok);
    const aimEvents = ctx.transport.last(p1Socket, 'state').events;
    const aimMoved = aimEvents.find((e) => e.type === 'moved');
    assert.equal(aimMoved.to, 7, 'Should aim for and hit tile index 7');
  }

  // 5. "force doubles" & "no doubles"
  {
    const ctx = startedRoom({ players: 2, seed: 555 });
    const { room } = ctx;
    const p1Id = room.game.state.currentPlayerId;
    const p1Socket = ctx.socketOf(p1Id);
    const p1 = room.game.state.players.find((p) => p.id === p1Id);

    room.devSetPolicy(p1.id, 'forceDoubles', true);
    p1.position = 0;
    const resDoubles = room.action(p1Socket, { type: 'roll' });
    assert.ok(resDoubles.ok);
    const rollEvent = ctx.transport.last(p1Socket, 'state').events.find((e) => e.type === 'diceRolled');
    assert.equal(rollEvent.doubles, true);

    room.devClearControls(p1.id);
    room.devSetPolicy(p1.id, 'noDoubles', true);
    room.game.state.phase = 'awaitingRoll';
    room.game.state.turn = { dice: null, canRollAgain: false, pendingTileId: null, movesLeft: 0 };
    const resNoDoubles = room.action(p1Socket, { type: 'roll' });
    assert.ok(resNoDoubles.ok);
    const rollNoDoublesEvent = ctx.transport.last(p1Socket, 'state').events.find((e) => e.type === 'diceRolled');
    assert.equal(rollNoDoublesEvent.doubles, false);
  }
});

test('Developer Panel: event stream shape is identical between normal and forced rolls', () => {
  const normalCtx = startedRoom({ players: 2, seed: 100 });
  const forcedCtx = startedRoom({ players: 2, seed: 200 });

  const p1NormalId = normalCtx.room.game.state.currentPlayerId;
  const p1NormalSocket = normalCtx.socketOf(p1NormalId);

  const p1ForcedId = forcedCtx.room.game.state.currentPlayerId;
  const p1ForcedSocket = forcedCtx.socketOf(p1ForcedId);

  // Force exact roll on forcedCtx
  forcedCtx.room.devSetRoll(p1ForcedId, [1, 2]);

  const normalRes = normalCtx.room.action(p1NormalSocket, { type: 'roll' });
  const forcedRes = forcedCtx.room.action(p1ForcedSocket, { type: 'roll' });

  assert.ok(normalRes.ok);
  assert.ok(forcedRes.ok);

  const normalEvents = normalCtx.transport.last(p1NormalSocket, 'state').events;
  const forcedEvents = forcedCtx.transport.last(p1ForcedSocket, 'state').events;

  const normalEvent = normalEvents.find((e) => e.type === 'diceRolled');
  const forcedEvent = forcedEvents.find((e) => e.type === 'diceRolled');

  // Assert keys match exactly
  assert.deepEqual(Object.keys(forcedEvent).sort(), Object.keys(normalEvent).sort());
  assert.equal(typeof forcedEvent.playerId, 'string');
  assert.equal(Array.isArray(forcedEvent.dice), true);
  assert.equal(typeof forcedEvent.total, 'number');
  assert.equal(typeof forcedEvent.doubles, 'boolean');
  assert.equal(typeof forcedEvent.reason, 'string');
});

test('Developer Panel: card manipulation and silent cash adjustment', () => {
  const ctx = startedRoom({ players: 2, seed: 444 });
  const { room } = ctx;
  const p1 = room.game.state.players[0];

  // Card manipulation: pick next surprise card
  room.devSetNextCard('surprise', 's-dividend');
  assert.equal(room.game.state.decks.surprise[0], 's-dividend');

  // Silent cash adjustment
  const initialCash = p1.cash;
  const okAdd = room.devAdjustCash(p1.id, 500);
  assert.equal(okAdd, true);
  assert.equal(p1.cash, initialCash + 500);
  assert.equal(room.game.state.devLedger.bankOut, 500);

  const okDeduct = room.devAdjustCash(p1.id, -200);
  assert.equal(okDeduct, true);
  assert.equal(p1.cash, initialCash + 300);
  assert.equal(room.game.state.devLedger.bankIn, 200);

  // publicState does not leak devLedger
  const pub = room.game.publicState();
  assert.equal(pub.devLedger, undefined, 'devLedger must not leak in publicState');
});

test('Developer Panel: Grep test - no dev UI, path or namespace strings appear in public/', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const devStrings = [
    'DEV_KEY',
    'DEV_PATH',
    'devServer',
    'devState',
    'devAdjustCash',
    'devSetRoll',
    'devQueueRolls',
    'devSetPolicy',
    'devClearControls',
    'watchRoom',
    'unwatchRoom',
    'roomState',
    'Dev Control',
  ];

  function scanDir(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const f of files) {
      const fullPath = path.join(dir, f.name);
      if (f.isDirectory()) {
        scanDir(fullPath);
      } else if (f.isFile()) {
        // Skip binary files (images/fonts)
        if (/\.(png|jpg|jpeg|gif|webp|woff|woff2|ttf|ico|svg)$/i.test(f.name)) continue;
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const str of devStrings) {
          assert.equal(
            content.includes(str),
            false,
            `Dev string "${str}" found in public file: ${path.relative(publicDir, fullPath)}`
          );
        }
      }
    }
  }

  scanDir(publicDir);
});
