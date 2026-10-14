'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');
const { Room, STATUS } = require('../server/rooms/Room');
const { Bot } = require('../server/bots/Bot');
const { fakeClock, fakeTransport, quietLog, seat } = require('./roomHelpers');

/** A room whose bots and delays are seeded, so runs are repeatable. */
function botRoom({ seed = 1, settings } = {}) {
  const clock = fakeClock();
  const transport = fakeTransport();
  const emptied = [];
  let r = 0.5;
  const room = new Room({
    code: 'BOTSAB',
    transport,
    clock,
    log: quietLog,
    onEmpty: (x) => emptied.push(x.code),
    makeGame: (s, now) => new Game({ settings: s, now, seed }),
    random: () => (r = (r * 9301 + 49297) % 233280 / 233280),
    makeBot: ({ id, difficulty }) => new Bot({ id, difficulty, seed: seed + id.length, log: quietLog }),
  });
  seat(room, 'Asha');
  if (settings) room.updateSettings('s1', settings);
  return { room, clock, transport, emptied };
}

const players = (room) => room.publicRoom().players;
const state = (transport) => transport.last('s1', 'state');

describe('room bots: lobby', () => {
  test('the host adds bots with a difficulty; they take free seats and colours and show as bots', () => {
    const { room, transport } = botRoom();
    const a = room.addBot('s1', 'easy');
    const b = room.addBot('s1', 'hard');
    assert.ok(a.ok && b.ok);
    const list = players(room);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((p) => p.bot), [null, 'easy', 'hard']);
    assert.equal(new Set(list.map((p) => p.color)).size, 3);
    assert.equal(new Set(list.map((p) => p.name)).size, 3);
    assert.ok(list.slice(1).every((p) => p.name.startsWith('Bot ') && p.connected && !p.isHost));
    // Nothing secret leaks.
    assert.ok(!JSON.stringify(state(transport)).includes('token'));
  });

  test('only the host can add or remove bots, only in the lobby, and bots count towards maxPlayers', () => {
    const { room } = botRoom({ settings: { maxPlayers: 3 } });
    room.join({ socketId: 's2', name: 'Bilal' });
    assert.equal(room.addBot('s2').error, 'only the host can do that');
    assert.ok(room.addBot('s1').ok);
    assert.equal(room.addBot('s1').error, 'room is full');
    assert.equal(room.addBot('s1', 'genius').error, 'unknown difficulty');
    const botId = players(room)[2].id;
    assert.equal(room.removeBot('s2', botId).error, 'only the host can do that');
    assert.equal(room.removeBot('s1', players(room)[1].id).error, 'no such bot');
    assert.ok(room.removeBot('s1', botId).ok);
    assert.equal(players(room).length, 2);
    room.addBot('s1');
    room.start('s1');
    assert.match(room.addBot('s1').error, /only possible while the room is in lobby/);
    assert.match(room.removeBot('s1', players(room)[2].id).error, /lobby/);
  });

  test('"Allow bots" off refuses new bots and sends the lobby\'s bots home', () => {
    const { room } = botRoom();
    room.addBot('s1');
    room.addBot('s1');
    room.updateSettings('s1', { allowBots: false });
    assert.equal(players(room).length, 1);
    assert.equal(room.addBot('s1').error, 'bots are turned off for this room');
  });

  test('bots never become host, and a room left with only bots is empty', () => {
    const { room, emptied } = botRoom();
    room.addBot('s1');
    room.addBot('s1');
    room.leave('s1');
    assert.deepEqual(emptied, ['BOTSAB']);
  });

  test('bots do not keep an abandoned room alive', () => {
    const { room } = botRoom();
    room.addBot('s1');
    assert.equal(room.connectedCount, 1);
    room.disconnect('s1');
    assert.equal(room.connectedCount, 0);
    assert.notEqual(room.emptySince, null);
  });
});

describe('room bots: playing', () => {
  test('a bot takes its turn after a human-like delay, and any change re-arms the timer', () => {
    const { room, clock, transport } = botRoom({ seed: 3 });
    room.addBot('s1', 'medium');
    room.start('s1');
    const s = room.game.state;
    const botId = players(room)[1].id;
    // Make sure it is the bot's turn.
    if (s.currentPlayerId !== botId) {
      room.action('s1', { type: 'roll' });
      while (room.game.state.currentPlayerId !== botId) {
        const legal = room.game.getLegalActions(players(room)[0].id);
        const next = ['buy', 'endTurn', 'roll'].map((t) => legal.find((a) => a.type === t)).find(Boolean);
        room.action('s1', next);
      }
    }
    const version = state(transport).version;
    clock.advance(500);
    assert.equal(state(transport).version, version, 'nothing before the minimum delay');
    clock.advance(1100);
    assert.ok(state(transport).version > version, 'the bot moved within 1.5s');
  });

  test('bots are never timed out by the turn timer', () => {
    const { room, clock, transport } = botRoom({ settings: { turnTimerSeconds: 15 } });
    room.addBot('s1');
    room.start('s1');
    const botId = players(room)[1].id;
    for (let i = 0; i < 400 && room.status === STATUS.PLAYING; i++) {
      if (room.game.state.currentPlayerId === botId) assert.equal(room.turnDeadline, null);
      clock.advance(16_000); // the human always times out; the bot always acts first
    }
    const timedOut = transport.received('s1', 'state').flatMap((m) => m.events).filter((e) => e.type === 'turnTimedOut');
    assert.ok(timedOut.length > 0);
    assert.ok(timedOut.every((e) => e.playerId !== botId));
  });

  test('1 human and 3 bots play to game over; bots bid in auctions and chat', () => {
    const { room, clock, transport } = botRoom({ seed: 5, settings: { turnTimerSeconds: 15, startingCash: 800 } });
    for (const d of ['easy', 'medium', 'hard']) room.addBot('s1', d);
    room.start('s1');
    for (let i = 0; i < 20000 && room.status === STATUS.PLAYING; i++) clock.advance(16_000);
    assert.equal(room.status, STATUS.FINISHED);
    const events = transport.received('s1', 'state').flatMap((m) => m.events);
    assert.ok(events.some((e) => e.type === 'bidPlaced'), 'a bot bid in an auction');
    assert.ok(events.some((e) => e.type === 'gameOver'));
    const chat = transport.received('s1', 'chat');
    assert.ok(chat.length > 0 && chat.every((m) => m.bot), 'bots said something');
    assert.equal(clock.pending(), 0, 'no timers left behind');
  });

  test('bot chat can be turned off', () => {
    const { room, clock, transport } = botRoom({ seed: 5, settings: { turnTimerSeconds: 15, startingCash: 800, botChat: false } });
    for (const d of ['easy', 'medium', 'hard']) room.addBot('s1', d);
    room.start('s1');
    for (let i = 0; i < 20000 && room.status === STATUS.PLAYING; i++) clock.advance(16_000);
    assert.equal(room.status, STATUS.FINISHED);
    assert.deepEqual(transport.received('s1', 'chat'), []);
  });

  test('bots answer a human\'s trade within a few seconds', () => {
    const { room, clock } = botRoom({ seed: 2 });
    room.addBot('s1', 'medium');
    room.start('s1');
    const [human, bot] = players(room).map((p) => p.id);
    room.game.state.properties.paris.ownerId = bot;
    room.game.state.properties.venice.ownerId = human;
    const r = room.action('s1', { type: 'proposeTrade', toId: bot, give: { cash: 5 }, get: { tileIds: ['paris'] } });
    assert.ok(r.ok, r.error);
    // If it's the bot's turn it may play on first; either way the offer is answered quickly.
    for (let i = 0; i < 10 && room.game.state.trades.length; i++) clock.advance(1500);
    assert.equal(room.game.state.trades.length, 0);
    assert.equal(room.game.state.properties.paris.ownerId, bot, 'declined a lowball offer');
  });

  test('the host can hand a disconnected player\'s seat to a bot, which plays on with their assets', () => {
    const { room, clock } = botRoom({ seed: 4 });
    const { token } = room.join({ socketId: 's2', name: 'Bilal' });
    room.start('s1');
    const bilal = players(room)[1].id;
    room.game.state.properties.rome.ownerId = bilal;
    assert.equal(room.replaceWithBot('s1', bilal).error, 'only a player who has left can be replaced');
    room.disconnect('s2');
    assert.equal(room.replaceWithBot('s2', bilal).error, 'not in this room');
    assert.ok(room.replaceWithBot('s1', bilal, 'hard').ok);
    const row = players(room)[1];
    assert.equal(row.bot, 'hard');
    assert.equal(row.name, 'Bilal');
    assert.ok(row.connected);
    assert.equal(room.game.state.properties.rome.ownerId, bilal);
    // Their old token no longer works.
    assert.equal(room.join({ socketId: 's3', token }).error, 'game already started');
    const turns = room.game.state.turnNumber;
    for (let i = 0; i < 50 && room.game.state.turnNumber < turns + 6; i++) {
      if (room.game.state.currentPlayerId !== bilal) {
        const legal = room.game.getLegalActions(players(room)[0].id);
        const next = ['roll', 'decline', 'endTurn'].map((t) => legal.find((a) => a.type === t)).find(Boolean);
        if (next) room.action('s1', next);
      }
      clock.advance(1500);
    }
    assert.ok(room.game.state.turnNumber >= turns + 6, 'the game keeps going with the bot in the seat');
  });

  test('pending bot moves are cancelled when the room closes or goes back to the lobby', () => {
    const { room, clock } = botRoom();
    room.addBot('s1');
    room.start('s1');
    room.dispose();
    assert.equal(clock.pending(), 0);
  });
});
