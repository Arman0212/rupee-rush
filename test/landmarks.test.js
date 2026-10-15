'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setup, player, prop, own, act, reject, findEvent } = require('./helpers');
const { MAX_BUILDINGS } = require('../shared/board');

function withHotels(game, playerId, ...tileIds) {
  own(game, playerId, ...tileIds);
  for (const id of tileIds) prop(game, id).buildings = MAX_BUILDINGS;
}

/** A started game with landmarks on, p1 to move, owning a fully built light-blue set. */
function ready({ settings = {} } = {}) {
  const game = setup({ players: 2, settings: { landmarks: true, auctions: false, ...settings } });
  withHotels(game, 'p1', 'tel-aviv', 'haifa', 'jerusalem');
  player(game, 'p1').cash = 1000;
  return game;
}

describe('landmarks: building', () => {
  test('a landmark needs the whole set hotelled, costs 3× the house cost, and sets the flag', () => {
    const game = ready();
    const events = act(game, 'p1', 'buildLandmark', { tileId: 'tel-aviv' });
    assert.equal(findEvent(events, 'landmarkBuilt').amount, 150); // 3 × 50
    assert.equal(prop(game, 'tel-aviv').landmark, true);
    assert.equal(prop(game, 'tel-aviv').buildings, MAX_BUILDINGS); // hotel stays underneath
  });

  test('a landmark is refused without a full hotel set, and only one per set', () => {
    const game = ready();
    prop(game, 'haifa').buildings = 4;
    assert.equal(reject(game, 'p1', 'buildLandmark', { tileId: 'tel-aviv' }), 'every city in the set needs a hotel first');
    prop(game, 'haifa').buildings = MAX_BUILDINGS;
    act(game, 'p1', 'buildLandmark', { tileId: 'tel-aviv' });
    assert.equal(reject(game, 'p1', 'buildLandmark', { tileId: 'haifa' }), 'this set already has a landmark');
  });

  test('a landmark is refused unless the mode is on', () => {
    const game = setup({ players: 2, settings: { landmarks: false, auctions: false } });
    withHotels(game, 'p1', 'tel-aviv', 'haifa', 'jerusalem');
    assert.equal(reject(game, 'p1', 'buildLandmark', { tileId: 'tel-aviv' }), 'landmarks are not enabled');
    assert.ok(!game.getLegalActions('p1').some((a) => a.type === 'buildLandmark'));
  });

  test('getLegalActions offers the landmark once the set qualifies', () => {
    const game = ready();
    assert.ok(game.getLegalActions('p1').some((a) => a.type === 'buildLandmark' && a.tileId === 'tel-aviv'));
  });
});

describe('landmarks: rent', () => {
  test('landmark rent is 1.5× the hotel rent (to ₹5) and the rest of the set gets +10%', () => {
    const game = ready();
    act(game, 'p1', 'buildLandmark', { tileId: 'tel-aviv' });
    // tel-aviv is the landmark (hotel rent 550 → 1.5× = 825); the rest of the set gets +10%.
    const land = (tileId, from) => {
      const target = require('../shared/board').getTileById(tileId).index;
      player(game, 'p2').position = from;
      game.state.currentPlayerId = 'p2';
      game.state.phase = 'awaitingRoll';
      game.state.turn = { dice: null, canRollAgain: false, pendingTileId: null };
      const steps = ((target - from) % 40 + 40) % 40;
      const d1 = Math.min(6, steps - 1);
      require('./helpers').rig(game, [d1, steps - d1]);
      return act(game, 'p2', 'roll');
    };
    assert.equal(findEvent(land('tel-aviv', 0), 'rentPaid').amount, 825);
    assert.equal(findEvent(land('haifa', 0), 'rentPaid').amount, 605); // 550 × 1.1
    assert.equal(findEvent(land('jerusalem', 0), 'rentPaid').amount, 660); // 600 × 1.1
  });
});

describe('landmarks: selling and protection', () => {
  test('selling a landmark returns half its cost and restores the hotel', () => {
    const game = ready();
    act(game, 'p1', 'buildLandmark', { tileId: 'tel-aviv' });
    const events = act(game, 'p1', 'sellLandmark', { tileId: 'tel-aviv' });
    assert.equal(findEvent(events, 'landmarkSold').amount, 75); // 150 × 0.5
    assert.equal(prop(game, 'tel-aviv').landmark, false);
    assert.equal(prop(game, 'tel-aviv').buildings, MAX_BUILDINGS);
  });

  test('houses cannot be sold while a landmark stands; sell the landmark first', () => {
    const game = ready();
    act(game, 'p1', 'buildLandmark', { tileId: 'tel-aviv' });
    assert.equal(reject(game, 'p1', 'sellHouse', { tileId: 'haifa' }), 'sell the landmark first');
    act(game, 'p1', 'sellLandmark', { tileId: 'tel-aviv' });
    act(game, 'p1', 'sellHouse', { tileId: 'haifa' }); // now allowed
  });

  test('a landmarked set cannot be mortgaged or traded (it counts as built)', () => {
    const game = ready();
    act(game, 'p1', 'buildLandmark', { tileId: 'tel-aviv' });
    assert.equal(reject(game, 'p1', 'mortgage', { tileId: 'jerusalem' }), 'sell every building in the set first');
    assert.equal(reject(game, 'p1', 'proposeTrade', { toId: 'p2', give: { tileIds: ['jerusalem'] }, get: { cash: 10 } }),
      "sell the buildings in Jerusalem's set first");
  });

  test('a player in debt may sell a landmark to raise cash out of turn', () => {
    const game = ready();
    act(game, 'p1', 'buildLandmark', { tileId: 'tel-aviv' });
    game.state.currentPlayerId = 'p2'; // not p1's turn
    player(game, 'p1').cash = -50;
    player(game, 'p1').debt = { amount: 50, creditorId: null, owed: [{ creditorId: null, amount: 50 }] };
    act(game, 'p1', 'sellLandmark', { tileId: 'tel-aviv' });
    assert.equal(prop(game, 'tel-aviv').landmark, false);
  });
});
