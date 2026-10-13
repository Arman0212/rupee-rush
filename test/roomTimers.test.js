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

/**
 * Give the current player `holdings` ({ tileId: buildings }) and a debt to the
 * bank that leaves them at `cash`, at the end of their turn.
 */
function inDebtWith(room, cash, holdings) {
  const state = room.game.state;
  const p = state.players.find((x) => x.id === state.currentPlayerId);
  for (const [tileId, buildings] of Object.entries(holdings)) Object.assign(state.properties[tileId], { ownerId: p.id, buildings });
  p.cash = cash;
  p.debt = { amount: -cash, creditorId: null, owed: [{ creditorId: null, amount: -cash }] };
  state.phase = 'awaitingEnd';
  return p;
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

  test('a player in debt mortgages first: unbuilt tiles in sets without buildings, cheapest first', () => {
    const { room, clock, transport } = startedRoom({ settings: { turnTimerSeconds: 15 } });
    const debtor = inDebtWith(room, -100, { patna: 1, bhopal: 1, 'new-delhi': 0, mumbai: 0, 'delhi-airport': 0 });
    clock.advance(15_000);
    const events = transport.last('s1', 'state').events;
    // Delhi Airport (₹200, mortgage ₹100) is the cheapest mortgageable tile and clears the debt alone.
    assert.deepEqual(events.filter((e) => e.type === 'mortgaged').map((e) => e.tileId), ['delhi-airport']);
    assert.equal(events.some((e) => e.type === 'houseSold'), false);
    assert.equal(debtor.cash, 0);
    assert.equal(room.game.state.properties.mumbai.mortgaged, false);
    assert.equal(debtor.bankrupt, false);
  });

  test('then buildings are sold evenly from the cheapest set, and the cleared set is mortgaged next', () => {
    const { room, clock, transport } = startedRoom({ settings: { turnTimerSeconds: 15 } });
    const debtor = inDebtWith(room, -60, { patna: 1, bhopal: 1, indore: 1, kochi: 1, chandigarh: 1 });
    clock.advance(15_000);
    const events = transport.last('s1', 'state').events;
    const steps = events.filter((e) => e.type === 'houseSold' || e.type === 'mortgaged').map((e) => `${e.type}:${e.tileId}`);
    // Every set has buildings, so sell brown (₹50 houses) first: -60 + 25 + 25 = -10;
    // brown is now bare, so mortgage Patna (+₹30) rather than sell a pink house.
    assert.deepEqual(steps, ['houseSold:patna', 'houseSold:bhopal', 'mortgaged:patna']);
    assert.equal(debtor.cash, 20);
    const props = room.game.state.properties;
    assert.deepEqual(['indore', 'kochi', 'chandigarh'].map((id) => props[id].buildings), [1, 1, 1]);
    // Then the normal timeout order carries on and the turn passes.
    assert.ok(events.some((e) => e.type === 'turnEnded' && e.playerId === debtor.id));
    assert.notEqual(room.game.state.currentPlayerId, debtor.id);
  });

  test('bankruptcy only if mortgaging and selling everything cannot clear the debt', () => {
    const { room, clock, transport } = startedRoom({ players: 3, settings: { turnTimerSeconds: 15 } });
    const debtor = inDebtWith(room, -1000, { patna: 1, bhopal: 1, 'new-delhi': 0, mumbai: 0 });
    clock.advance(15_000);
    const events = transport.last('s1', 'state').events;
    const steps = events.filter((e) => e.type === 'houseSold' || e.type === 'mortgaged').map((e) => `${e.type}:${e.tileId}`);
    assert.deepEqual(steps, [
      'mortgaged:new-delhi', 'mortgaged:mumbai', // unbuilt set first, cheapest first
      'houseSold:patna', 'houseSold:bhopal', // then the buildings
      'mortgaged:patna', 'mortgaged:bhopal', // then the tiles they stood on
    ]);
    const types = events.map((e) => e.type);
    assert.ok(types.lastIndexOf('mortgaged') < types.indexOf('bankrupt'));
    assert.equal(debtor.bankrupt, true);
    assert.equal(room.status, 'playing');
    assert.notEqual(room.game.state.currentPlayerId, debtor.id);
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
