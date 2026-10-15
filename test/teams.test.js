'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');
const { player, prop, rig, own, place, act, reject, findEvent } = require('./helpers');
const { getTileById } = require('../shared/board');

/** A started 4-player team game (p1,p2 = A; p3,p4 = B), p1 to move, deterministic order. */
function teamGame({ players = 4, settings = {} } = {}) {
  const game = new Game({ seed: 42, now: () => 1000, settings: { teams: true, auctions: false, ...settings } });
  const teams = players === 6 ? ['A', 'A', 'A', 'B', 'B', 'B'] : ['A', 'A', 'B', 'B'];
  for (let i = 0; i < players; i++) game.addPlayer({ id: `p${i + 1}`, name: `P${i + 1}`, team: teams[i] });
  game.start();
  game.state.players.sort((a, b) => a.id.localeCompare(b.id));
  game.state.currentPlayerId = 'p1';
  return game;
}

function land(game, who, tileId, from) {
  const target = getTileById(tileId).index;
  place(game, who, from);
  game.state.currentPlayerId = who;
  game.state.phase = 'awaitingRoll';
  game.state.turn = { dice: null, canRollAgain: false, pendingTileId: null };
  const steps = ((target - from) % 40 + 40) % 40;
  const d1 = Math.min(6, steps - 1);
  rig(game, [d1, steps - d1]);
  return act(game, who, 'roll');
}

function inDebt(game, id, amount) {
  const p = player(game, id);
  p.cash = -amount;
  p.debt = { amount, creditorId: null, owed: [{ creditorId: null, amount }] };
}

describe('teams: start validation', () => {
  test('team mode needs 4 or 6 players, split evenly, each with a team', () => {
    const three = new Game({ settings: { teams: true } });
    for (const [i, t] of ['A', 'A', 'B'].entries()) three.addPlayer({ id: `p${i}`, name: `p${i}`, team: t });
    assert.equal(three.start().error, 'team mode needs exactly 4 or 6 players');

    const lopsided = new Game({ settings: { teams: true } });
    for (const [i, t] of ['A', 'A', 'A', 'B'].entries()) lopsided.addPlayer({ id: `p${i}`, name: `p${i}`, team: t });
    assert.equal(lopsided.start().error, 'the teams must be even');

    assert.ok(teamGame());
  });
});

describe('teams: rent', () => {
  test('teammates pay no rent to each other; opponents still do', () => {
    const game = teamGame();
    own(game, 'p1', 'tel-aviv');
    assert.equal(findEvent(land(game, 'p2', 'tel-aviv', 0), 'rentPaid'), undefined); // teammate
    assert.ok(findEvent(land(game, 'p3', 'tel-aviv', 0), 'rentPaid')); // opponent
  });

  test('a set completed across a team doubles base rent for opponents', () => {
    const game = teamGame();
    own(game, 'p1', 'tel-aviv', 'haifa');
    own(game, 'p2', 'jerusalem'); // team A holds the full light-blue set
    assert.equal(findEvent(land(game, 'p3', 'tel-aviv', 0), 'rentPaid').amount, 12); // 6 × 2
  });
});

describe('teams: building', () => {
  test('a team set lets each owner build on their own tiles, but not a teammate\'s', () => {
    const game = teamGame();
    own(game, 'p1', 'tel-aviv', 'haifa');
    own(game, 'p2', 'jerusalem');
    player(game, 'p1').cash = 1000;
    player(game, 'p2').cash = 1000;
    game.state.currentPlayerId = 'p1';
    act(game, 'p1', 'build', { tileId: 'tel-aviv' }); // team owns the set, p1 owns the tile
    assert.equal(reject(game, 'p1', 'build', { tileId: 'jerusalem' }), 'you do not own that property');
    game.state.currentPlayerId = 'p2';
    act(game, 'p2', 'build', { tileId: 'jerusalem' });
  });
});

describe('teams: send to teammate', () => {
  test('cash and a property can be sent to a teammate with no fee', () => {
    const game = teamGame();
    own(game, 'p1', 'rome');
    player(game, 'p1').cash = 500;
    const beforeTo = player(game, 'p2').cash;
    const events = act(game, 'p1', 'sendToTeammate', { toId: 'p2', give: { tileIds: ['rome'], cash: 100 } });
    assert.equal(prop(game, 'rome').ownerId, 'p2');
    assert.equal(player(game, 'p1').cash, 400);
    assert.equal(player(game, 'p2').cash, beforeTo + 100);
    assert.equal(findEvent(events, 'mortgageFee'), undefined);
    assert.ok(findEvent(events, 'teammateGift') || findEvent(events, 'propertyTransferred'));
  });

  test('you cannot send to an opponent', () => {
    const game = teamGame();
    own(game, 'p1', 'rome');
    assert.equal(reject(game, 'p1', 'sendToTeammate', { toId: 'p3', give: { tileIds: ['rome'] } }), 'you can only send to a teammate');
  });

  test('sending is refused when the mode is off', () => {
    const game = new Game({ settings: { teams: false, auctions: false }, seed: 1, now: () => 1 });
    for (const id of ['p1', 'p2']) game.addPlayer({ id, name: id });
    game.start();
    own(game, 'p1', 'rome');
    assert.equal(reject(game, 'p1', 'sendToTeammate', { toId: 'p2', give: { cash: 10 } }), 'teams are not enabled');
  });
});

describe('teams: bankruptcy and winning', () => {
  test('assets that would go to the bank go to a living teammate', () => {
    const game = teamGame();
    own(game, 'p1', 'venice');
    player(game, 'p1').cash = 50;
    land(game, 'p1', 'income-tax', 1); // tax 200 → debt to the bank
    const events = act(game, 'p1', 'bankrupt');
    assert.equal(findEvent(events, 'bankrupt').creditorId, 'p2'); // teammate, not the bank
    assert.equal(prop(game, 'venice').ownerId, 'p2');
  });

  test('a debt to an opponent still goes to that opponent', () => {
    const game = teamGame();
    own(game, 'p3', 'new-york', 'california');
    prop(game, 'new-york').buildings = 5;
    own(game, 'p1', 'venice');
    player(game, 'p1').cash = 10;
    land(game, 'p1', 'new-york', 34); // owes p3
    const events = act(game, 'p1', 'bankrupt');
    assert.equal(findEvent(events, 'bankrupt').creditorId, 'p3');
    assert.equal(prop(game, 'venice').ownerId, 'p3');
  });

  test('the game ends when one team is left, even with two survivors', () => {
    const game = teamGame();
    inDebt(game, 'p3', 10);
    act(game, 'p3', 'bankrupt');
    assert.equal(game.state.phase, 'awaitingRoll'); // team B still has p4
    inDebt(game, 'p4', 10);
    const events = act(game, 'p4', 'bankrupt');
    assert.equal(game.state.phase, 'gameOver');
    assert.equal(game.state.winnerTeam, 'A');
    assert.equal(findEvent(events, 'gameOver').winnerTeam, 'A');
    assert.ok(['p1', 'p2'].includes(game.state.winnerId));
  });
});
