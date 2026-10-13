'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setup, player, prop, own, act, reject, findEvent } = require('./helpers');

/** p1 owns the brown set (houses ₹50) and it's their turn. */
function brownSet(buildings = [0, 0]) {
  const game = setup();
  own(game, 'p1', 'salvador', 'rio');
  prop(game, 'salvador').buildings = buildings[0];
  prop(game, 'rio').buildings = buildings[1];
  return game;
}

const build = (game, tileId, who = 'p1') => game.dispatch(who, { type: 'build', tileId });
const sell = (game, tileId, who = 'p1') => game.dispatch(who, { type: 'sellHouse', tileId });
const mortgage = (game, tileId, who = 'p1') => game.dispatch(who, { type: 'mortgage', tileId });

describe('building', () => {
  test('needs the whole colour set', () => {
    const game = setup();
    own(game, 'p1', 'salvador');
    assert.equal(build(game, 'salvador').error, 'you need the whole colour set');
  });

  test('builds a house for the set\'s house cost', () => {
    const game = brownSet();
    const { ok, events } = build(game, 'salvador');
    assert.ok(ok);
    assert.deepEqual(findEvent(events, 'built'), { type: 'built', from: 'p1', to: null, amount: 50, tileId: 'salvador', buildings: 1, at: 1000 });
    assert.equal(prop(game, 'salvador').buildings, 1);
    assert.equal(player(game, 'p1').cash, 1450);
  });

  test('uneven building is rejected', () => {
    const game = brownSet([1, 0]);
    assert.equal(build(game, 'salvador').error, 'build evenly across the set');
    assert.ok(build(game, 'rio').ok);
    assert.ok(build(game, 'salvador').ok);
  });

  test('a hotel (5) is the maximum', () => {
    const game = brownSet([5, 5]);
    assert.equal(build(game, 'salvador').error, 'this city already has a hotel');
    const almost = brownSet([4, 4]);
    assert.ok(build(almost, 'salvador').ok);
    assert.equal(prop(almost, 'salvador').buildings, 5);
  });

  test('a mortgaged tile anywhere in the set blocks building', () => {
    const game = brownSet();
    prop(game, 'rio').mortgaged = true;
    assert.equal(build(game, 'salvador').error, 'a property in this set is mortgaged');
  });

  test('only cities take buildings', () => {
    const game = setup();
    own(game, 'p1', 'water-company', 'electric-company');
    assert.equal(build(game, 'water-company').error, 'you can only build on cities');
  });

  test('needs the cash', () => {
    const game = brownSet();
    player(game, 'p1').cash = 49;
    assert.equal(build(game, 'salvador').error, 'not enough cash');
  });

  test('only on your own turn and your own property', () => {
    const game = brownSet();
    own(game, 'p2', 'tel-aviv', 'haifa', 'jerusalem');
    assert.equal(build(game, 'tel-aviv', 'p2').error, 'not your turn');
    assert.equal(build(game, 'tel-aviv').error, 'you do not own that property');
    assert.equal(build(game, 'nowhere').error, 'unknown property');
  });

  test('allowed in any phase of your own turn', () => {
    const game = brownSet();
    game.state.phase = 'awaitingEnd';
    assert.ok(build(game, 'salvador').ok);
  });

  test('legal actions list exactly the buildable tiles', () => {
    const game = brownSet([1, 0]);
    const builds = game.getLegalActions('p1').filter((a) => a.type === 'build');
    assert.deepEqual(builds, [{ type: 'build', tileId: 'rio' }]);
  });
});

describe('selling', () => {
  test('refunds half the house cost', () => {
    const game = brownSet([1, 1]);
    const { ok, events } = sell(game, 'salvador');
    assert.ok(ok);
    assert.equal(findEvent(events, 'houseSold').amount, 25);
    assert.equal(player(game, 'p1').cash, 1525);
    assert.equal(prop(game, 'salvador').buildings, 0);
  });

  test('uneven selling is rejected', () => {
    const game = brownSet([2, 1]);
    assert.equal(sell(game, 'rio').error, 'sell evenly across the set');
    assert.ok(sell(game, 'salvador').ok);
  });

  test('a hotel sells back one step to four houses', () => {
    const game = brownSet([5, 5]);
    assert.ok(sell(game, 'salvador').ok);
    assert.equal(prop(game, 'salvador').buildings, 4);
  });

  test('nothing to sell', () => {
    const game = brownSet();
    assert.equal(sell(game, 'salvador').error, 'no buildings to sell');
  });
});

describe('mortgages', () => {
  test('mortgaging pays half the price', () => {
    const game = setup();
    own(game, 'p1', 'new-york');
    const { ok, events } = mortgage(game, 'new-york');
    assert.ok(ok);
    assert.equal(findEvent(events, 'mortgaged').amount, 200);
    assert.equal(player(game, 'p1').cash, 1700);
    assert.equal(prop(game, 'new-york').mortgaged, true);
    assert.equal(mortgage(game, 'new-york').error, 'already mortgaged');
  });

  test('mortgaging is rejected while any tile in the set has buildings', () => {
    const game = brownSet([1, 0]);
    assert.equal(mortgage(game, 'rio').error, 'sell every building in the set first');
    assert.equal(mortgage(game, 'salvador').error, 'sell every building in the set first');
    assert.ok(sell(game, 'salvador').ok);
    assert.ok(mortgage(game, 'rio').ok);
  });

  test('airports and utilities can be mortgaged', () => {
    const game = setup();
    own(game, 'p1', 'jfk-airport', 'water-company');
    assert.ok(mortgage(game, 'jfk-airport').ok);
    assert.ok(mortgage(game, 'water-company').ok);
    assert.equal(player(game, 'p1').cash, 1500 + 100 + 75);
  });

  test('unmortgaging costs unmortgageCost(price)', () => {
    const game = setup();
    own(game, 'p1', 'jfk-airport');
    prop(game, 'jfk-airport').mortgaged = true;
    const { ok, events } = game.dispatch('p1', { type: 'unmortgage', tileId: 'jfk-airport' });
    assert.ok(ok);
    assert.equal(findEvent(events, 'unmortgaged').amount, 110);
    assert.equal(player(game, 'p1').cash, 1390);
    assert.equal(prop(game, 'jfk-airport').mortgaged, false);
  });

  test('unmortgaging needs the cash and a mortgage', () => {
    const game = setup();
    own(game, 'p1', 'jfk-airport', 'new-york');
    prop(game, 'jfk-airport').mortgaged = true;
    player(game, 'p1').cash = 109;
    assert.equal(reject(game, 'p1', 'unmortgage', { tileId: 'jfk-airport' }), 'not enough cash');
    assert.equal(reject(game, 'p1', 'unmortgage', { tileId: 'new-york' }), 'not mortgaged');
  });

  test('a full set with a mortgage can be built on again once it is unmortgaged', () => {
    const game = brownSet();
    prop(game, 'rio').mortgaged = true;
    act(game, 'p1', 'unmortgage', { tileId: 'rio' });
    assert.ok(build(game, 'salvador').ok);
  });
});
