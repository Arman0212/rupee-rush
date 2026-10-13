'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setup, player, prop, own, place, act, findEvent } = require('./helpers');

/** p1 rolls from `from` with `dice`; returns the rentPaid event (if any) and the game. */
function landOn({ from, dice, settings, prepare }) {
  const game = setup({ settings, dice: [dice] });
  place(game, 'p1', from);
  prepare(game);
  const events = act(game, 'p1', 'roll');
  return { game, events, rent: findEvent(events, 'rentPaid') };
}

describe('city rent', () => {
  test('base rent goes from the visitor to the owner', () => {
    const { game, rent } = landOn({ from: 20, dice: [1, 2], prepare: (g) => own(g, 'p2', 'goa') });
    assert.deepEqual(rent, { type: 'rentPaid', from: 'p1', to: 'p2', amount: 18, tileId: 'goa', at: 1000 });
    assert.equal(player(game, 'p1').cash, 1482);
    assert.equal(player(game, 'p2').cash, 1518);
    assert.equal(game.state.phase, 'awaitingEnd');
  });

  test('base rent doubles when the owner holds the whole set', () => {
    const { rent } = landOn({ from: 20, dice: [1, 2], prepare: (g) => own(g, 'p2', 'kolkata', 'goa', 'chennai') });
    assert.equal(rent.amount, 36);
  });

  test('a mortgaged tile elsewhere in the set still counts as owning the set', () => {
    const { rent } = landOn({
      from: 20, dice: [1, 2],
      prepare: (g) => { own(g, 'p2', 'kolkata', 'goa', 'chennai'); prop(g, 'chennai').mortgaged = true; },
    });
    assert.equal(rent.amount, 36);
  });

  test('no doubling when the setting is off', () => {
    const { rent } = landOn({
      from: 20, dice: [1, 2], settings: { doubleRentOnFullSet: false },
      prepare: (g) => own(g, 'p2', 'kolkata', 'goa', 'chennai'),
    });
    assert.equal(rent.amount, 18);
  });

  test('with buildings, rent comes from the table and is not doubled', () => {
    for (const [buildings, expected] of [[1, 90], [2, 250], [3, 700], [4, 875], [5, 1050]]) {
      const { rent } = landOn({
        from: 20, dice: [1, 2],
        prepare: (g) => {
          own(g, 'p2', 'kolkata', 'goa', 'chennai');
          prop(g, 'goa').buildings = buildings;
          player(g, 'p1').cash = 5000;
        },
      });
      assert.equal(rent.amount, expected, `${buildings} buildings`);
    }
  });

  test('a mortgaged tile charges no rent', () => {
    const { game, events, rent } = landOn({
      from: 20, dice: [1, 2],
      prepare: (g) => { own(g, 'p2', 'goa'); prop(g, 'goa').mortgaged = true; },
    });
    assert.equal(rent, undefined);
    assert.equal(findEvent(events, 'rentWaived').reason, 'mortgaged');
    assert.equal(player(game, 'p1').cash, 1500);
  });

  test('landing on your own property costs nothing', () => {
    const { game, events } = landOn({ from: 20, dice: [1, 2], prepare: (g) => own(g, 'p1', 'goa') });
    assert.equal(findEvent(events, 'rentPaid'), undefined);
    assert.equal(player(game, 'p1').cash, 1500);
    assert.equal(game.state.phase, 'awaitingEnd');
  });
});

describe('owner in jail', () => {
  const jailOwner = (g) => { own(g, 'p2', 'goa'); Object.assign(player(g, 'p2'), { inJail: true, position: 10 }); };

  test('rent is still collected when collectRentInJail is on', () => {
    const { rent } = landOn({ from: 20, dice: [1, 2], prepare: jailOwner });
    assert.equal(rent.amount, 18);
  });

  test('rent is waived when collectRentInJail is off', () => {
    const { events, rent } = landOn({ from: 20, dice: [1, 2], settings: { collectRentInJail: false }, prepare: jailOwner });
    assert.equal(rent, undefined);
    assert.equal(findEvent(events, 'rentWaived').reason, 'ownerInJail');
  });
});

describe('airports and utilities', () => {
  const airports = ['bengaluru-airport', 'chennai-airport', 'kolkata-airport', 'delhi-airport'];

  test('airport rent is 25/50/100/200 by the number owned', () => {
    [25, 50, 100, 200].forEach((expected, i) => {
      const { rent } = landOn({ from: 20, dice: [2, 3], prepare: (g) => own(g, 'p2', ...airports.slice(0, i + 1)) });
      assert.equal(rent.tileId, 'bengaluru-airport');
      assert.equal(rent.amount, expected);
    });
  });

  test('a mortgaged airport still counts towards the owner\'s total', () => {
    const { rent } = landOn({
      from: 20, dice: [2, 3],
      prepare: (g) => { own(g, 'p2', ...airports.slice(0, 2)); prop(g, 'chennai-airport').mortgaged = true; },
    });
    assert.equal(rent.amount, 50);
  });

  test('one utility charges 4x the dice', () => {
    const { rent } = landOn({ from: 20, dice: [3, 5], prepare: (g) => own(g, 'p2', 'water-board') });
    assert.equal(rent.amount, 32);
  });

  test('both utilities charge 10x the dice', () => {
    const { rent } = landOn({ from: 20, dice: [3, 5], prepare: (g) => own(g, 'p2', 'water-board', 'electricity-board') });
    assert.equal(rent.amount, 80);
  });
});
