'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ROOM } = require('../shared/rules');
const { RoomManager, randomCode, IDLE_MS, MAX_AGE_MS } = require('../server/rooms/RoomManager');
const { validatePayload, SCHEMAS, normalizeCode, cleanName } = require('../server/net/validate');
const { RateLimiter } = require('../server/net/rateLimit');
const { fakeClock, fakeTransport, quietLog } = require('./roomHelpers');

function makeManager(opts = {}) {
  const clock = fakeClock();
  const transport = fakeTransport();
  const manager = new RoomManager({ transport, clock, log: quietLog, ...opts });
  return { manager, clock, transport };
}

describe('room codes', () => {
  test('are 6 characters from the code alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = randomCode();
      assert.equal(code.length, ROOM.codeLength);
      assert.ok([...code].every((c) => ROOM.codeAlphabet.includes(c)), code);
    }
  });

  test('are unique among live rooms (a collision is retried)', () => {
    const codes = ['AAAAAA', 'AAAAAA', 'AAAAAA', 'BBBBBB'];
    const { manager } = makeManager({ makeCode: () => codes.shift() });
    assert.equal(manager.createRoom({ socketId: 's1', name: 'A' }).code, 'AAAAAA');
    assert.equal(manager.createRoom({ socketId: 's2', name: 'B' }).code, 'BBBBBB');
  });

  test('typed codes are normalised and validated', () => {
    assert.equal(normalizeCode(' abcdef '), 'ABCDEF');
    assert.equal(normalizeCode('ABCDE0'), null); // 0 is not in the alphabet
    assert.equal(normalizeCode('ABC'), null);
  });
});

describe('RoomManager', () => {
  test('the creator becomes host and gets a token', () => {
    const { manager } = makeManager();
    const result = manager.createRoom({ socketId: 's1', name: 'Asha' });
    assert.ok(result.ok);
    const room = manager.get(result.code);
    assert.equal(room.hostId, result.playerId);
    assert.ok(result.token);
    assert.deepEqual(manager.stats(), { rooms: 1, players: 1 });
  });

  test('lists public lobbies only', () => {
    const { manager } = makeManager();
    const open = manager.createRoom({ socketId: 's1', name: 'Open' });
    const hidden = manager.createRoom({ socketId: 's2', name: 'Hidden' });
    manager.get(hidden.code).updateSettings('s2', { isPrivate: true });
    const started = manager.createRoom({ socketId: 's3', name: 'Busy' });
    manager.get(started.code).join({ socketId: 's4', name: 'Two' });
    manager.get(started.code).start('s3');
    assert.deepEqual(manager.listPublic(), [{ code: open.code, hostName: 'Open', players: 1, maxPlayers: 6 }]);
  });

  test('a room is deleted when its last seat leaves', () => {
    const { manager } = makeManager();
    const { code } = manager.createRoom({ socketId: 's1', name: 'A' });
    manager.get(code).leave('s1');
    assert.equal(manager.get(code), null);
  });

  test('sweeps rooms with no connected sockets for 30 minutes', () => {
    const { manager, clock, transport } = makeManager();
    const { code } = manager.createRoom({ socketId: 's1', name: 'A' });
    const room = manager.get(code);
    room.join({ socketId: 's2', name: 'B' });
    room.start('s1');
    room.disconnect('s1');
    room.disconnect('s2');
    clock.advance(IDLE_MS - 1);
    manager.sweep();
    assert.ok(manager.get(code));
    clock.advance(1);
    manager.sweep();
    assert.equal(manager.get(code), null);
    assert.equal(clock.pending(), 0, 'every room timer was cleared');
    assert.equal(transport.messages.filter((m) => m.event === 'roomClosed').length, 0, 'nobody was connected to tell');
  });

  test('a connected socket keeps a room alive until the 6 hour limit', () => {
    const { manager, clock, transport } = makeManager();
    const { code } = manager.createRoom({ socketId: 's1', name: 'A' });
    clock.advance(MAX_AGE_MS - 1);
    manager.sweep();
    assert.ok(manager.get(code));
    clock.advance(1);
    manager.sweep();
    assert.equal(manager.get(code), null);
    assert.deepEqual(transport.last('s1', 'roomClosed'), { code, reason: 'expired' });
  });

  test('periodic sweeping runs on the injected clock and stops on dispose', () => {
    const { manager, clock } = makeManager();
    const { code } = manager.createRoom({ socketId: 's1', name: 'A' });
    manager.get(code).disconnect('s1');
    manager.startSweeping(60_000);
    clock.advance(IDLE_MS + 60_000);
    assert.equal(manager.get(code), null);
    manager.dispose();
    assert.equal(clock.pending(), 0);
  });
});

describe('payload validation', () => {
  test('accepts good payloads and keeps only known fields', () => {
    assert.deepEqual(validatePayload(SCHEMAS.action, { type: 'build', tileId: 'salvador', evil: 1 }), {
      ok: true, value: { type: 'build', tileId: 'salvador' },
    });
    assert.deepEqual(validatePayload(SCHEMAS.startGame, undefined), { ok: true, value: {} });
  });

  test('rejects wrong shapes with a readable error', () => {
    const bad = [
      [SCHEMAS.action, 'roll', 'payload must be an object'],
      [SCHEMAS.action, [], 'payload must be an object'],
      [SCHEMAS.action, {}, 'type must be a string'],
      [SCHEMAS.action, { type: '' }, 'type must not be empty'],
      [SCHEMAS.action, { type: 'bid', amount: 1.5 }, 'amount must be a whole number from 0 to 10000000'],
      [SCHEMAS.joinRoom, { code: 'ABCDEF', token: 5 }, 'token must be a string'],
      [SCHEMAS.chat, { text: 'x'.repeat(2001) }, 'text must be at most 2000 characters'],
      [SCHEMAS.updateSettings, { settings: { a: { nested: 1 } } }, 'settings must only contain strings, numbers and booleans'],
      [SCHEMAS.updateSettings, { settings: null }, 'settings must be an object'],
    ];
    for (const [schema, payload, error] of bad) assert.deepEqual(validatePayload(schema, payload), { ok: false, error });
  });

  test('rejects objects with odd prototypes', () => {
    assert.equal(validatePayload(SCHEMAS.chat, Object.create({ text: 'inherited' })).ok, false);
  });

  test('cleanName strips control characters and trims to the limit', () => {
    assert.equal(cleanName(' a\tb\u0000c '), 'a b c');
    assert.equal(cleanName('x'.repeat(40)).length, ROOM.nameMaxLength);
    assert.equal(cleanName(42), '');
  });
});

describe('RateLimiter', () => {
  test('allows `limit` hits per window per key', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    assert.ok(limiter.take('a'));
    assert.ok(limiter.take('a'));
    assert.equal(limiter.take('a'), false);
    assert.ok(limiter.take('b'));
    now = 1000;
    assert.ok(limiter.take('a'));
  });
});
