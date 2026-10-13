'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { AWAY_GRACE_MS } = require('../server/rooms/Room');
const { startedRoom } = require('./roomHelpers');

/** Put the current player in debt with nothing to sell, at the end of their turn. */
function strandInDebt(room) {
  const state = room.game.state;
  const p = state.players.find((x) => x.id === state.currentPlayerId);
  p.cash = -100;
  p.debt = { amount: 100, creditorId: null, owed: [{ creditorId: null, amount: 100 }] };
  state.phase = 'awaitingEnd';
  return p.id;
}

describe('turn timer', () => {
  test('is off by default: no deadline while the current player is connected', () => {
    const { room, transport } = startedRoom();
    assert.equal(transport.last('s1', 'state').deadline, null);
    assert.equal(room.turnDeadline, null);
  });

  test('broadcasts the deadline and plays the turn out when it expires', () => {
    const { room, clock, transport } = startedRoom({ settings: { turnTimerSeconds: 30 } });
    const first = room.game.state.currentPlayerId;
    const turn = room.game.state.turnNumber;
    assert.equal(transport.last('s1', 'state').deadline, clock.now() + 30_000);

    clock.advance(29_999);
    assert.equal(room.game.state.currentPlayerId, first);
    clock.advance(1);

    assert.notEqual(room.game.state.currentPlayerId, first);
    assert.equal(room.game.state.turnNumber, turn + 1);
    const state = transport.last('s1', 'state');
    assert.equal(state.events[0].type, 'turnTimedOut');
    assert.equal(state.events[0].playerId, first);
    assert.deepEqual(state.events.filter((e) => e.type === 'diceRolled').length >= 1, true);
    assert.ok(state.events.some((e) => e.type === 'turnEnded'));
    // Auto-play never buys: anything it landed on was declined.
    assert.equal(state.events.some((e) => e.type === 'propertyBought'), false);
    assert.equal(state.deadline, clock.now() + 30_000); // the next player's clock
  });

  test('acting within the turn does not reset the deadline; a new turn does', () => {
    const { room, clock, socketOf } = startedRoom({ settings: { turnTimerSeconds: 30 } });
    const deadline = room.turnDeadline;
    const first = room.game.state.currentPlayerId;
    const socket = socketOf(first);
    clock.advance(10_000);
    while (room.game.state.currentPlayerId === first) {
      const legal = room.game.getLegalActions(first);
      const action = ['roll', 'decline', 'endTurn'].map((t) => legal.find((a) => a.type === t)).find(Boolean);
      const turnEnds = action.type === 'endTurn';
      assert.ok(room.action(socket, action).ok);
      if (!turnEnds) assert.equal(room.turnDeadline, deadline);
    }
    assert.equal(room.turnDeadline, clock.now() + 30_000);
  });

  test('a player stuck in debt is declared bankrupt when time runs out', () => {
    const { room, clock, transport } = startedRoom({ settings: { turnTimerSeconds: 15 } });
    const loser = strandInDebt(room);
    clock.advance(15_000);
    assert.equal(room.game.state.players.find((p) => p.id === loser).bankrupt, true);
    assert.equal(room.status, 'finished');
    assert.ok(transport.last('s1', 'gameOver').winnerId);
    assert.equal(room.turnDeadline, null);
    assert.equal(clock.pending(), 0);
  });

  test('a disconnected current player is played for after 60s even with the timer off', () => {
    const { room, clock, socketOf } = startedRoom();
    const first = room.game.state.currentPlayerId;
    room.disconnect(socketOf(first));
    assert.equal(room.turnDeadline, clock.now() + AWAY_GRACE_MS);
    clock.advance(AWAY_GRACE_MS);
    assert.notEqual(room.game.state.currentPlayerId, first);
    assert.equal(room.turnDeadline, null); // the next player is connected
  });

  test('reconnecting in time cancels the away timer', () => {
    const { room, clock, socketOf, joined } = startedRoom();
    const first = room.game.state.currentPlayerId;
    room.disconnect(socketOf(first));
    clock.advance(30_000);
    room.join({ socketId: 'back', token: joined.find((j) => j.playerId === first).token });
    assert.equal(room.turnDeadline, null);
    clock.advance(AWAY_GRACE_MS);
    assert.equal(room.game.state.currentPlayerId, first);
  });

  test('a game of only disconnected players still runs to the end', () => {
    const { room, clock } = startedRoom({ players: 3, settings: { turnTimerSeconds: 15 } });
    for (const s of ['s1', 's2', 's3']) room.disconnect(s);
    for (let i = 0; i < 5000 && room.status === 'playing'; i++) clock.advance(15_000);
    // It must never stall: either someone won or turns kept ticking over.
    assert.ok(room.status === 'finished' || room.game.state.turnNumber > 1000, `stuck at turn ${room.game.state.turnNumber}`);
  });

  test('disposing the room clears every timer', () => {
    const { room, clock } = startedRoom({ players: 3, settings: { turnTimerSeconds: 15 } });
    room.disconnect('s2');
    assert.ok(clock.pending() >= 2);
    room.dispose();
    assert.equal(clock.pending(), 0);
  });
});
