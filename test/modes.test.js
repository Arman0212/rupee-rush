'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');
const { modeSettings, sanitizeSettings, MODES } = require('../shared/rules');
const { TILE } = require('../shared/board');

describe('mode mapping', () => {
  test('MODES are classic and chaos, and the default is classic', () => {
    assert.deepEqual([...MODES].sort(), ['chaos', 'classic']);
    assert.equal(sanitizeSettings({}).mode, 'classic');
    assert.equal(sanitizeSettings({ mode: 'nonsense' }).mode, 'classic');
    assert.equal(sanitizeSettings({ mode: 'chaos' }).mode, 'chaos');
  });

  test('classic turns every mode feature off', () => {
    const s = modeSettings('classic');
    assert.equal(s.worldEvents, false);
    assert.equal(s.bounties, false);
    assert.equal(s.landmarks, false);
    assert.equal(s.teams, false);
    assert.equal(s.startingCities, 0);
  });

  test('chaos turns the features on with the chaos tuning', () => {
    const s = modeSettings('chaos');
    assert.equal(s.worldEvents, true);
    assert.equal(s.worldEventEvery, 2);
    assert.equal(s.chaosEvents, true);
    assert.equal(s.bounties, true);
    assert.equal(s.bountyRentThreshold, 300);
    assert.equal(s.landmarks, true);
    assert.equal(s.auctions, true);
    assert.equal(s.auctionSeconds, 8);
    assert.equal(s.vacationJackpot, true);
    assert.equal(s.startingCash, 2000);
    assert.equal(s.startingCities, 2);
    // Teams are decided by the lobby from the player count, not the mapping.
    assert.equal('teams' in s, false);
  });

  test('the engine reads the feature flags, not the mode, so features switch on alone', () => {
    const game = new Game({ settings: { mode: 'classic', worldEvents: true }, seed: 1, now: () => 1 });
    // mode stays classic, but the explicit feature flag is honoured.
    assert.equal(game.state.settings.mode, 'classic');
    assert.equal(game.state.settings.worldEvents, true);
  });
});

describe('chaos opening: starting cities', () => {
  test('each player is dealt the configured number of unowned cities for free', () => {
    const game = new Game({ settings: { startingCities: 2, auctions: false }, seed: 5, now: () => 1 });
    for (const id of ['a', 'b', 'c']) game.addPlayer({ id, name: id });
    const before = game.state.players.map((p) => p.cash);
    game.start();
    // No money changed hands for the deal (cash is only the starting cash).
    game.state.players.forEach((p) => assert.equal(p.cash, 1500));
    void before;
    const owned = {};
    for (const [tileId, prop] of Object.entries(game.state.properties)) {
      if (prop.ownerId) owned[prop.ownerId] = (owned[prop.ownerId] || 0) + 1;
    }
    for (const p of game.state.players) assert.equal(owned[p.id], 2);
    // Only cities are dealt.
    for (const [tileId, prop] of Object.entries(game.state.properties)) {
      if (prop.ownerId) assert.equal(require('../shared/board').getTileById(tileId).type, TILE.CITY);
    }
  });

  test('with startingCities 0 (classic) nobody owns anything at the start', () => {
    const game = new Game({ settings: { startingCities: 0 }, seed: 1, now: () => 1 });
    for (const id of ['a', 'b']) game.addPlayer({ id, name: id });
    game.start();
    assert.ok(Object.values(game.state.properties).every((p) => !p.ownerId));
  });
});
