'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');
const { createRng, shuffle } = require('../server/game/rng');

/** A started 4-player game advanced `steps` actions by a fixed, simple policy. */
function playedGame(seed, steps) {
  const game = new Game({ seed, now: () => 0 });
  ['a', 'b', 'c', 'd'].forEach((id) => game.addPlayer({ id }));
  game.start();
  advance(game, steps);
  return game;
}

function advance(game, steps) {
  for (let i = 0; i < steps && game.state.phase !== 'gameOver'; i++) {
    if (game.state.phase === 'auction') {
      // The server's timer would close it; bid once first so some auctions sell.
      const bidder = game.state.players.find((p) => game.getLegalActions(p.id).some((a) => a.type === 'bid'));
      if (bidder && i % 2) game.dispatch(bidder.id, game.getLegalActions(bidder.id).find((a) => a.type === 'bid'));
      assert.ok(game.closeAuction().ok);
      continue;
    }
    const id = game.state.currentPlayerId;
    const legal = game.getLegalActions(id);
    const action = legal.find((a) => a.type === 'buy') || legal.find((a) => a.type === 'build') || legal[0];
    assert.ok(game.dispatch(id, action).ok);
  }
}

describe('rng', () => {
  test('is deterministic per seed and stays in [0, 1)', () => {
    const a = createRng(123);
    const b = createRng(123);
    for (let i = 0; i < 1000; i++) {
      const x = a.next();
      assert.equal(x, b.next());
      assert.ok(x >= 0 && x < 1);
    }
    assert.notEqual(createRng(1).next(), createRng(2).next());
  });

  test('getState / setState resumes the sequence', () => {
    const rng = createRng(5);
    rng.next();
    const saved = rng.getState();
    const expected = [rng.next(), rng.next()];
    rng.setState(saved);
    assert.deepEqual([rng.next(), rng.next()], expected);
  });

  test('shuffle is a permutation', () => {
    const out = shuffle(createRng(9), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('save and restore', () => {
  test('toJSON -> fromJSON round-trips to an identical state, through JSON text too', () => {
    const game = playedGame(11, 150);
    const saved = game.toJSON();
    assert.deepEqual(Game.fromJSON(saved).toJSON(), saved);
    const text = JSON.stringify(saved);
    assert.equal(JSON.stringify(Game.fromJSON(JSON.parse(text)).toJSON()), text);
  });

  test('a restored game plays on exactly like the original', () => {
    const original = playedGame(12, 100);
    const copy = Game.fromJSON(JSON.parse(JSON.stringify(original.toJSON())), { now: () => 0 });
    advance(original, 200);
    advance(copy, 200);
    assert.deepEqual(copy.toJSON(), original.toJSON());
  });

  test('the same seed and inputs replay the same game', () => {
    assert.deepEqual(playedGame(13, 300).toJSON(), playedGame(13, 300).toJSON());
  });

  test('toJSON returns a copy, not live state', () => {
    const game = playedGame(14, 10);
    const saved = game.toJSON();
    saved.players[0].cash = -999;
    saved.decks.surprise.length = 0;
    assert.notEqual(game.state.players[0].cash, -999);
    assert.equal(game.state.decks.surprise.length > 0, true);
  });

  test('fromJSON rejects data that is not a saved game', () => {
    for (const bad of [null, 42, 'x', {}, { version: 99, players: [] }, { version: 1 }]) {
      assert.throws(() => Game.fromJSON(bad), /not a saved Rupee Rush game/);
    }
  });
});

describe('publicState', () => {
  test('hides the deck order, seed and rng state but shows deck sizes', () => {
    const game = playedGame(15, 50);
    const pub = game.publicState();
    assert.deepEqual(pub.decks, { surprise: { remaining: game.state.decks.surprise.length }, treasure: { remaining: game.state.decks.treasure.length } });
    assert.equal('seed' in pub, false);
    assert.equal('rngState' in pub, false);
    const text = JSON.stringify(pub);
    assert.ok(!text.includes('s-dividend') || game.state.lastCard?.cardId === 's-dividend');
  });

  test('includes what clients need', () => {
    const pub = playedGame(16, 50).publicState();
    for (const key of ['phase', 'turnNumber', 'currentPlayerId', 'players', 'properties', 'jackpot', 'turn', 'settings', 'lastCard', 'winnerId']) {
      assert.ok(key in pub, key);
    }
  });

  test('is a copy', () => {
    const game = playedGame(17, 10);
    game.publicState().players[0].cash = -1;
    assert.notEqual(game.state.players[0].cash, -1);
  });
});
