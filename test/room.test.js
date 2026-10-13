'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PLAYER_COLORS, ROOM } = require('../shared/rules');
const { AWAY_GRACE_MS } = require('../server/rooms/Room');
const { makeRoom, seat, startedRoom } = require('./roomHelpers');

const names = (room) => room.publicRoom().players.map((p) => p.name);

describe('joining and names', () => {
  test('the first player becomes host and every join gets its own token', () => {
    const { room } = makeRoom();
    const [a, b] = seat(room, 'Asha', 'Bilal');
    assert.equal(room.hostId, a.playerId);
    assert.match(a.token, /^[A-Za-z0-9_-]{32}$/); // 24 random bytes, base64url
    assert.notEqual(a.token, b.token);
    assert.equal(room.publicRoom().players[0].isHost, true);
  });

  test('names are cleaned and de-duplicated', () => {
    const { room } = makeRoom();
    seat(room, '  Asha  ', 'asha', 'ASHA', 'Bi\u0000l‮al\n', '');
    assert.deepEqual(names(room), ['Asha', 'asha 2', 'ASHA 3', 'Bi l al', 'Player']);
  });

  test('a de-duplicated name stays within the length limit', () => {
    const { room } = makeRoom();
    const long = 'Abcdefghijklmnopqrst';
    seat(room, long, long);
    const [first, second] = names(room);
    assert.equal(first, long.slice(0, ROOM.nameMaxLength));
    assert.equal(second.length <= ROOM.nameMaxLength, true);
    assert.match(second, / 2$/);
  });

  test('joining is refused when the room is full', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B');
    room.updateSettings('s1', { maxPlayers: 2 });
    assert.deepEqual(room.join({ socketId: 's3', name: 'C' }), { ok: false, error: 'room is full' });
  });

  test('joining is refused once the game has started, without a valid token', () => {
    const { room } = startedRoom();
    assert.equal(room.join({ socketId: 's9', name: 'Late' }).error, 'game already started');
    assert.equal(room.join({ socketId: 's9', name: 'Late', token: 'x'.repeat(32) }).error, 'game already started');
  });

  test('joiners get the chat history', () => {
    const { room, transport } = makeRoom();
    seat(room, 'A');
    room.chat('s1', 'hello');
    room.join({ socketId: 's2', name: 'B' });
    assert.deepEqual(transport.last('s2', 'chatHistory').messages.map((m) => m.text), ['hello']);
  });
});

describe('colours', () => {
  test('each joiner gets a different free colour', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B', 'C');
    assert.deepEqual(room.publicRoom().players.map((p) => p.color), PLAYER_COLORS.slice(0, 3));
  });

  test('picking a free colour works; a taken or unknown one is refused', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B');
    assert.equal(room.pickColor('s2', PLAYER_COLORS[0]).error, 'colour already taken');
    assert.equal(room.pickColor('s2', '#000000').error, 'unknown colour');
    assert.ok(room.pickColor('s2', PLAYER_COLORS[5]).ok);
    assert.ok(room.pickColor('s1', PLAYER_COLORS[1]).ok); // B's old colour is free now
    assert.equal(room.join({ socketId: 's3', name: 'C' }).ok, true);
    assert.equal(room.publicRoom().players[2].color, PLAYER_COLORS[0]);
  });

  test('colours are fixed once the game starts', () => {
    const { room } = startedRoom();
    assert.equal(room.pickColor('s1', PLAYER_COLORS[6]).error, 'colours are fixed once the game starts');
  });
});

describe('host powers', () => {
  test('only the host edits settings, which are sanitised', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B', 'C');
    assert.equal(room.updateSettings('s2', { startingCash: 2000 }).error, 'only the host can do that');
    const { settings } = room.updateSettings('s1', { startingCash: 99999, goSalary: 260, nonsense: 1, maxPlayers: 2 });
    assert.equal(settings.startingCash, 5000);
    assert.equal(settings.goSalary, 250);
    assert.equal('nonsense' in settings, false);
    assert.equal(settings.maxPlayers, 3); // never below the players already seated
  });

  test('only the host can start, and only with 2+ players', () => {
    const { room } = makeRoom();
    seat(room, 'A');
    assert.equal(room.start('s1').error, 'need at least 2 players');
    assert.equal(room.join({ socketId: 's1', name: 'Again' }).error, 'already in this room');
    room.join({ socketId: 's2', name: 'B' });
    assert.equal(room.start('s2').error, 'only the host can do that');
    assert.ok(room.start('s1').ok);
    assert.equal(room.status, 'playing');
    assert.equal(room.start('s1').error, 'only possible while the room is in lobby');
  });

  test('the game uses the seats, names, colours and settings from the lobby', () => {
    const { room } = makeRoom();
    const [a, b] = seat(room, 'Asha', 'Bilal');
    room.pickColor('s2', PLAYER_COLORS[4]);
    room.updateSettings('s1', { startingCash: 2000 });
    room.start('s1');
    const players = room.game.state.players;
    assert.deepEqual(new Set(players.map((p) => p.id)), new Set([a.playerId, b.playerId]));
    assert.equal(players.find((p) => p.id === b.playerId).color, PLAYER_COLORS[4]);
    assert.ok(players.every((p) => p.cash === 2000));
  });

  test('the host can kick anyone in the lobby; the kicked socket is told', () => {
    const { room, transport } = makeRoom();
    const [, b] = seat(room, 'A', 'B', 'C');
    assert.equal(room.kick('s2', b.playerId).error, 'only the host can do that');
    assert.ok(room.kick('s1', b.playerId).ok);
    assert.deepEqual(names(room), ['A', 'C']);
    assert.deepEqual(transport.last('s2', 'kicked'), { code: 'TESTAB' });
    assert.equal(transport.channels.has('s2'), false);
    assert.equal(room.action('s2', { type: 'roll' }).error, 'not in this room');
    assert.equal(room.kick('s1', room.hostId).error, 'you cannot kick yourself');
  });

  test('if the host leaves, the next player becomes host', () => {
    const { room } = makeRoom();
    const [, b] = seat(room, 'A', 'B', 'C');
    room.leave('s1');
    assert.equal(room.hostId, b.playerId);
    assert.equal(room.publicRoom().players.find((p) => p.isHost).name, 'B');
  });

  test('host transfer prefers a connected player', () => {
    const { room } = makeRoom();
    const [, , c] = seat(room, 'A', 'B', 'C');
    room.disconnect('s2');
    room.leave('s1');
    assert.equal(room.hostId, c.playerId);
  });

  test('the room reports empty when the last seat leaves', () => {
    const { room, emptied } = makeRoom();
    seat(room, 'A');
    room.leave('s1');
    assert.deepEqual(emptied, ['TESTAB']);
  });
});

describe('disconnects and reconnection', () => {
  test('a lobby seat survives a short disconnect and is freed after 60s', () => {
    const { room, clock, transport } = makeRoom();
    const [, b] = seat(room, 'A', 'B', 'C');
    room.disconnect('s2');
    assert.equal(room.publicRoom().players[1].connected, false);
    assert.equal(transport.last('s1', 'state').events[0].type, 'seatDisconnected');
    clock.advance(AWAY_GRACE_MS - 1);
    assert.ok(room.join({ socketId: 's2b', token: b.token }).reconnected);
    clock.advance(AWAY_GRACE_MS);
    assert.deepEqual(names(room), ['A', 'B', 'C']);
    room.disconnect('s3');
    clock.advance(AWAY_GRACE_MS);
    assert.deepEqual(names(room), ['A', 'B']);
    assert.equal(transport.last('s1', 'state').events[0].reason, 'timeout');
  });

  test('a valid token rebinds the seat mid-game and sends the full state', () => {
    const { room, transport, joined } = startedRoom();
    room.disconnect('s2');
    const result = room.join({ socketId: 's2-new', name: 'ignored', token: joined[1].token });
    assert.deepEqual(result, { ok: true, code: 'TESTAB', playerId: joined[1].playerId, token: joined[1].token, reconnected: true });
    const state = transport.last('s2-new', 'state');
    assert.ok(state.publicState.players.length === 2);
    assert.equal(transport.last('s2-new', 'you').playerId, joined[1].playerId);
    assert.ok(transport.last('s2-new', 'chatHistory'));
    assert.equal(room.publicRoom().players[1].name, 'P2');
  });

  test('the same token from a second tab replaces the first socket', () => {
    const { room, transport, joined } = startedRoom();
    room.join({ socketId: 's1-tab2', token: joined[0].token });
    assert.deepEqual(transport.last('s1', 'replaced'), { code: 'TESTAB' });
    assert.equal(transport.channels.has('s1'), false);
    assert.equal(room.action('s1', { type: 'roll' }).error, 'not in this room');
    assert.equal(room.publicRoom().players[0].connected, true);
  });

  test('mid-game a disconnected player can be kicked only after 60s, which bankrupts them to the bank', () => {
    const { room, clock, joined } = startedRoom({ players: 3 });
    const target = joined[2];
    assert.match(room.kick('s1', target.playerId).error, /disconnected for 60 seconds/);
    room.disconnect('s3');
    clock.advance(30_000);
    assert.match(room.kick('s1', target.playerId).error, /disconnected for 60 seconds/);
    clock.advance(30_000);
    assert.ok(room.kick('s1', target.playerId).ok);
    const enginePlayer = room.game.state.players.find((p) => p.id === target.playerId);
    assert.equal(enginePlayer.bankrupt, true);
    assert.equal(enginePlayer.left, true);
    assert.equal(room.publicRoom().players.length, 2);
  });

  test('a host disconnected for 60s mid-game hands hosting to someone present', () => {
    const { room, clock, joined } = startedRoom({ players: 3 });
    room.disconnect('s1');
    clock.advance(AWAY_GRACE_MS);
    assert.equal(room.hostId, joined[1].playerId);
    room.join({ socketId: 's1b', token: joined[0].token });
    assert.equal(room.hostId, joined[1].playerId); // hosting does not bounce back
  });

  test('leaving mid-game is bankruptcy to the bank; the last one standing wins', () => {
    const { room, transport, joined } = startedRoom();
    assert.ok(room.leave('s2').ok);
    assert.equal(room.status, 'finished');
    assert.deepEqual(transport.last('s1', 'gameOver'), { winnerId: joined[0].playerId, name: 'P1' });
  });
});

describe('actions and broadcasts', () => {
  test('actions are dispatched for the socket\'s own seat; acting out of turn fails', () => {
    const { room, socketOf } = startedRoom();
    const current = socketOf(room.game.state.currentPlayerId);
    const other = current === 's1' ? 's2' : 's1';
    assert.deepEqual(room.action(other, { type: 'roll' }), { ok: false, error: 'not your turn' });
    const result = room.action(current, { type: 'roll' });
    assert.equal(result.ok, true);
    assert.equal(result.version, room.version);
    assert.equal(room.action('stranger', { type: 'roll' }).error, 'not in this room');
  });

  test('actions before the game starts are refused', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B');
    assert.equal(room.action('s1', { type: 'roll' }).error, 'no game in progress');
  });

  test('every state has a new version, and each seat gets its legal actions', () => {
    const { room, transport, socketOf } = startedRoom();
    const current = socketOf(room.game.state.currentPlayerId);
    room.action(current, { type: 'roll' });
    for (const socket of ['s1', 's2']) {
      const versions = transport.received(socket, 'state').map((s) => s.version);
      assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
      assert.equal(new Set(versions).size, versions.length);
      const you = transport.last(socket, 'you');
      assert.equal(you.version, room.version);
      assert.deepEqual(you.legalActions, room.game.getLegalActions(you.playerId));
    }
  });

  test('no token ever appears in anything sent to any socket', () => {
    const { room, transport, joined, clock } = startedRoom({ players: 3 });
    room.chat('s1', 'hi');
    room.disconnect('s3');
    clock.advance(AWAY_GRACE_MS);
    room.join({ socketId: 's3b', token: joined[2].token });
    const everything = JSON.stringify(transport.messages);
    for (const { token } of joined) assert.equal(everything.includes(token), false);
  });

  test('play again returns everyone to the lobby with the same settings', () => {
    const { room } = startedRoom({ players: 3, settings: { startingCash: 3000, vacationJackpot: true } });
    room.leave('s3');
    room.leave('s2');
    assert.equal(room.status, 'finished');
    assert.ok(room.playAgain('s1').ok);
    assert.equal(room.status, 'lobby');
    assert.equal(room.game, null);
    assert.equal(room.settings.startingCash, 3000);
    assert.equal(room.settings.vacationJackpot, true);
    assert.equal(room.join({ socketId: 's4', name: 'New' }).ok, true);
  });

  test('play again is host-only and only after game over', () => {
    const { room } = startedRoom();
    assert.match(room.playAgain('s1').error, /finished/);
  });
});

describe('chat', () => {
  test('messages are cleaned, trimmed to the limit and broadcast', () => {
    const { room, transport } = makeRoom();
    const [a] = seat(room, 'A', 'B');
    assert.ok(room.chat('s1', '  <b>hi</b>\u0007 there  ').ok);
    const msg = transport.last('s2', 'chat');
    assert.deepEqual(msg, { id: 1, playerId: a.playerId, name: 'A', text: '<b>hi</b> there', ts: 1_000_000 });
    room.chat('s1', 'x'.repeat(5000));
    assert.equal(transport.last('s2', 'chat').text.length, ROOM.chatMaxLength);
  });

  test('empty messages are ignored', () => {
    const { room, transport } = makeRoom();
    seat(room, 'A');
    assert.equal(room.chat('s1', ' \n\t ').error, 'empty message');
    assert.equal(transport.received('s1', 'chat').length, 0);
  });

  test('at most 5 messages per 5 seconds per player', () => {
    const { room, clock } = makeRoom();
    seat(room, 'A', 'B');
    for (let i = 0; i < 5; i++) assert.ok(room.chat('s1', `m${i}`).ok);
    assert.match(room.chat('s1', 'too many').error, /slow down/);
    assert.ok(room.chat('s2', 'other players are separate').ok);
    clock.advance(5000);
    assert.ok(room.chat('s1', 'ok again').ok);
  });

  test('the room keeps the last 100 messages', () => {
    const { room, clock } = makeRoom();
    seat(room, 'A');
    for (let i = 0; i < 120; i++) {
      room.chat('s1', `m${i}`);
      clock.advance(1000);
    }
    const history = room.chatLog;
    assert.equal(history.length, 100);
    assert.equal(history[0].text, 'm20');
  });

  test('chat works during the game too', () => {
    const { room } = startedRoom();
    assert.ok(room.chat('s2', 'gl hf').ok);
  });
});
