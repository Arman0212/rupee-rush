'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');
const { setup, player, prop, own, act, findEvent, eventTypes, totalMoney } = require('./helpers');

const propose = (game, from, to, give = {}, get = {}) => game.dispatch(from, { type: 'proposeTrade', toId: to, give, get });

/** p1 owns Patna, p2 owns Bhopal and Mumbai; nobody has rolled. */
function tradeGame(players = 3) {
  const game = setup({ players });
  own(game, 'p1', 'patna');
  own(game, 'p2', 'bhopal', 'mumbai');
  return game;
}

describe('proposing', () => {
  test('a valid proposal is open and visible to everyone', () => {
    const game = tradeGame();
    const { ok, events } = propose(game, 'p1', 'p2', { tileIds: ['patna'], cash: 100 }, { tileIds: ['bhopal'] });
    assert.ok(ok);
    const trade = game.state.trades[0];
    assert.deepEqual(trade, {
      id: 't1', fromId: 'p1', toId: 'p2',
      give: { tileIds: ['patna'], cash: 100, jailCards: [] },
      get: { tileIds: ['bhopal'], cash: 0, jailCards: [] },
      status: 'open', createdAt: 1000,
    });
    assert.equal(findEvent(events, 'tradeProposed').tradeId, 't1');
    assert.deepEqual(game.publicState().trades, game.state.trades);
  });

  test('works on anyone\'s turn and in any normal phase', () => {
    const game = tradeGame();
    assert.ok(propose(game, 'p3', 'p2', { cash: 10 }).ok);
  });

  test('refuses empty, impossible and invalid offers', () => {
    const game = tradeGame();
    game.state.properties.patna.buildings = 0;
    own(game, 'p1', 'bhopal'); // p1 now has the brown set
    game.state.properties.bhopal.buildings = 1;
    const cases = [
      [{}, {}, 'a trade must include something'],
      [{ tileIds: ['mumbai'] }, {}, 'Mumbai has changed hands'],
      [{ tileIds: ['patna'] }, {}, "sell the buildings in Patna's set first"],
      [{ cash: 1501 }, {}, "P1 doesn't have ₹1,501"],
      [{ jailCards: ['s-jailfree'] }, {}, 'P1 no longer holds that jail-free card'],
      [{ tileIds: ['nowhere'] }, {}, 'unknown property'],
      [{ cash: -5 }, {}, 'trade cash must be a whole, non-negative number of rupees'],
      [{ tileIds: 'patna' }, {}, 'invalid tiles in trade'],
      ['junk', {}, 'invalid trade offer'],
    ];
    for (const [give, get, error] of cases) assert.equal(propose(game, 'p1', 'p2', give, get).error, error, JSON.stringify(give));
    assert.equal(propose(game, 'p1', 'p1', { cash: 5 }).error, 'pick another player to trade with');
    assert.equal(propose(game, 'p1', 'ghost', { cash: 5 }).error, 'pick another player to trade with');
  });

  test('bankrupt or in-debt players cannot propose, and nobody can trade with the bankrupt', () => {
    const game = tradeGame();
    Object.assign(player(game, 'p3'), { bankrupt: true, cash: 0 });
    assert.equal(propose(game, 'p3', 'p2', { cash: 0 }, { cash: 1 }).error, 'you are bankrupt');
    assert.equal(propose(game, 'p1', 'p3', { cash: 1 }).error, 'P3 is out of the game');
    Object.assign(player(game, 'p1'), { cash: -20 });
    player(game, 'p1').debt = { amount: 20, creditorId: null, owed: [{ creditorId: null, amount: 20 }] };
    assert.equal(propose(game, 'p1', 'p2', { tileIds: ['patna'] }).error, 'clear your debt before proposing a trade');
  });

  test('at most 3 open proposals per player', () => {
    const game = tradeGame();
    for (let i = 1; i <= 3; i++) assert.ok(propose(game, 'p1', 'p2', { cash: i }).ok);
    assert.equal(propose(game, 'p1', 'p3', { cash: 9 }).error, 'you already have 3 open trade proposals');
    assert.ok(propose(game, 'p2', 'p1', { cash: 9 }).ok); // other players are unaffected
  });
});

describe('accepting', () => {
  test('only the recipient can accept; the swap moves tiles, cash and cards at once', () => {
    const game = tradeGame();
    player(game, 'p1').jailFreeCards.push({ deck: 'surprise', cardId: 's-jailfree' });
    game.state.decks.surprise = game.state.decks.surprise.filter((c) => c !== 's-jailfree');
    propose(game, 'p1', 'p2', { tileIds: ['patna'], cash: 100, jailCards: ['s-jailfree'] }, { tileIds: ['bhopal', 'mumbai'], cash: 30 });
    const before = totalMoney(game);
    assert.equal(game.dispatch('p1', { type: 'acceptTrade', tradeId: 't1' }).error, 'only the player it was offered to can answer it');
    assert.equal(game.dispatch('p3', { type: 'acceptTrade', tradeId: 't1' }).error, 'only the player it was offered to can answer it');
    const events = act(game, 'p2', 'acceptTrade', { tradeId: 't1' });
    assert.equal(findEvent(events, 'tradeAccepted').tradeId, 't1');
    assert.equal(prop(game, 'patna').ownerId, 'p2');
    assert.equal(prop(game, 'bhopal').ownerId, 'p1');
    assert.equal(prop(game, 'mumbai').ownerId, 'p1');
    assert.equal(player(game, 'p1').cash, 1500 - 100 + 30);
    assert.equal(player(game, 'p2').cash, 1500 + 100 - 30);
    assert.deepEqual(player(game, 'p2').jailFreeCards, [{ deck: 'surprise', cardId: 's-jailfree' }]);
    assert.deepEqual(player(game, 'p1').jailFreeCards, []);
    assert.equal(totalMoney(game), before);
    assert.deepEqual(game.state.trades, []);
  });

  test('mortgaged tiles stay mortgaged and the receiver pays a 10% fee to the bank', () => {
    const game = tradeGame();
    prop(game, 'mumbai').mortgaged = true; // mortgage value ₹200 -> fee ₹20
    propose(game, 'p1', 'p2', { cash: 50 }, { tileIds: ['mumbai'] });
    const before = totalMoney(game);
    const events = act(game, 'p2', 'acceptTrade', { tradeId: 't1' });
    assert.equal(prop(game, 'mumbai').mortgaged, true);
    assert.deepEqual(findEvent(events, 'mortgageFee'), { type: 'mortgageFee', from: 'p1', to: null, amount: 20, tileId: 'mumbai', at: 1000 });
    assert.equal(player(game, 'p1').cash, 1500 - 50 - 20);
    assert.equal(totalMoney(game), before - 20);
  });

  test('an accept is refused if the receiver cannot afford the fee, and nothing changes', () => {
    const game = tradeGame();
    prop(game, 'patna').mortgaged = true; // fee ₹3
    propose(game, 'p1', 'p2', { tileIds: ['patna'] }, { cash: 0 });
    player(game, 'p2').cash = 2;
    const snapshot = JSON.stringify(game.state);
    assert.equal(game.dispatch('p2', { type: 'acceptTrade', tradeId: 't1' }).error, "you can't afford the ₹3 fee on mortgaged cities");
    assert.equal(JSON.stringify(game.state), snapshot);
    player(game, 'p2').cash = 3;
    assert.ok(game.dispatch('p2', { type: 'acceptTrade', tradeId: 't1' }).ok);
    assert.equal(player(game, 'p2').cash, 0);
  });

  test('cash received in the trade counts towards the fee', () => {
    const game = tradeGame();
    prop(game, 'patna').mortgaged = true;
    propose(game, 'p1', 'p2', { tileIds: ['patna'], cash: 10 }, {});
    player(game, 'p2').cash = 0;
    assert.ok(game.dispatch('p2', { type: 'acceptTrade', tradeId: 't1' }).ok);
    assert.equal(player(game, 'p2').cash, 7);
  });

  test('acceptance re-checks everything and cancels a trade that went stale', () => {
    const game = tradeGame();
    propose(game, 'p1', 'p2', { tileIds: ['patna'] }, { cash: 10 });
    own(game, 'p3', 'patna'); // changed behind the engine's back
    const { ok, events } = game.dispatch('p2', { type: 'acceptTrade', tradeId: 't1' });
    assert.ok(ok);
    assert.deepEqual(eventTypes(events), ['tradeCancelled']);
    assert.equal(findEvent(events, 'tradeCancelled').reason, 'Patna has changed hands');
    assert.equal(prop(game, 'patna').ownerId, 'p3');
  });
});

describe('declining, cancelling, countering', () => {
  test('the recipient declines; the proposer cancels', () => {
    const game = tradeGame();
    propose(game, 'p1', 'p2', { cash: 10 });
    propose(game, 'p1', 'p2', { cash: 20 });
    assert.equal(game.dispatch('p1', { type: 'declineTrade', tradeId: 't1' }).error, 'only the player it was offered to can answer it');
    assert.equal(findEvent(act(game, 'p2', 'declineTrade', { tradeId: 't1' }), 'tradeDeclined').tradeId, 't1');
    assert.equal(game.dispatch('p2', { type: 'cancelTrade', tradeId: 't2' }).error, 'only the player who proposed it can cancel it');
    assert.equal(findEvent(act(game, 'p1', 'cancelTrade', { tradeId: 't2' }), 'tradeCancelled').reason, 'withdrawn');
    assert.deepEqual(game.state.trades, []);
    assert.equal(game.dispatch('p2', { type: 'acceptTrade', tradeId: 't1' }).error, 'that trade is no longer open');
  });

  test('a counter declines and proposes the mirror image by default', () => {
    const game = tradeGame();
    propose(game, 'p1', 'p2', { tileIds: ['patna'] }, { tileIds: ['bhopal'], cash: 40 });
    const events = act(game, 'p2', 'counterTrade', { tradeId: 't1' });
    assert.deepEqual(eventTypes(events), ['tradeDeclined', 'tradeProposed']);
    assert.equal(findEvent(events, 'tradeDeclined').countered, true);
    const counter = game.state.trades[0];
    assert.equal(counter.fromId, 'p2');
    assert.equal(counter.toId, 'p1');
    assert.deepEqual(counter.give, { tileIds: ['bhopal'], cash: 40, jailCards: [] });
    assert.deepEqual(counter.get, { tileIds: ['patna'], cash: 0, jailCards: [] });
  });

  test('a counter can carry a different offer', () => {
    const game = tradeGame();
    propose(game, 'p1', 'p2', { tileIds: ['patna'] }, { tileIds: ['mumbai'] });
    act(game, 'p2', 'counterTrade', { tradeId: 't1', give: { tileIds: ['bhopal'] }, get: { tileIds: ['patna'], cash: 50 } });
    assert.deepEqual(game.state.trades[0].get, { tileIds: ['patna'], cash: 50, jailCards: [] });
    assert.equal(game.dispatch('p2', { type: 'counterTrade', tradeId: 't2' }).error, 'only the player it was offered to can answer it');
  });

  test('legal actions list the replies to open trades', () => {
    const game = tradeGame();
    propose(game, 'p1', 'p2', { cash: 10 });
    const replies = (id) => game.getLegalActions(id).filter((a) => a.tradeId).map((a) => a.type);
    assert.deepEqual(replies('p2'), ['acceptTrade', 'declineTrade', 'counterTrade']);
    assert.deepEqual(replies('p1'), ['cancelTrade']);
    assert.deepEqual(replies('p3'), []);
  });
});

describe('automatic cancellation', () => {
  test('accepting one trade cancels another that needed the same tile', () => {
    const game = tradeGame();
    propose(game, 'p1', 'p2', { cash: 100 }, { tileIds: ['bhopal'] });
    propose(game, 'p3', 'p2', { cash: 120 }, { tileIds: ['bhopal'] });
    const events = act(game, 'p2', 'acceptTrade', { tradeId: 't2' });
    const cancelled = findEvent(events, 'tradeCancelled');
    assert.equal(cancelled.tradeId, 't1');
    assert.equal(cancelled.reason, 'Bhopal has changed hands');
    assert.deepEqual(game.state.trades, []);
  });

  test('building in the set cancels trades that include its tiles', () => {
    const game = setup({ players: 2 });
    own(game, 'p1', 'patna', 'bhopal');
    propose(game, 'p1', 'p2', { tileIds: ['patna'] }, { cash: 80 });
    const events = act(game, 'p1', 'build', { tileId: 'bhopal' });
    assert.match(findEvent(events, 'tradeCancelled').reason, /sell the buildings/);
  });

  test('a trade whose cash is no longer there is cancelled', () => {
    const game = setup({ players: 2, dice: [[1, 2]] });
    own(game, 'p2', 'patna');
    game.state.properties.patna.ownerId = 'p2';
    player(game, 'p1').cash = 102;
    propose(game, 'p1', 'p2', { cash: 100 }, { tileIds: ['patna'] });
    // p1 lands on Income Tax (₹200) and can no longer pay the ₹100.
    game.state.players[0].position = 1;
    const events = act(game, 'p1', 'roll'); // 1 -> 4 Income Tax
    assert.equal(findEvent(events, 'tradeCancelled').reason, "P1 doesn't have ₹100");
  });

  test('bankruptcy or leaving cancels that player\'s trades', () => {
    const game = tradeGame();
    propose(game, 'p1', 'p2', { cash: 10 });
    propose(game, 'p2', 'p3', { cash: 10 });
    const events = game.removePlayer('p2').events;
    const cancelled = events.filter((e) => e.type === 'tradeCancelled').map((e) => [e.tradeId, e.reason]);
    assert.deepEqual(cancelled, [['t1', 'P2 is out of the game'], ['t2', 'P2 is out of the game']]);
  });

  test('saves and restores open trades', () => {
    const game = tradeGame();
    propose(game, 'p1', 'p2', { tileIds: ['patna'] }, { cash: 30 });
    const copy = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON())));
    assert.deepEqual(copy.state.trades, game.state.trades);
    assert.ok(copy.dispatch('p2', { type: 'acceptTrade', tradeId: 't1' }).ok);
  });
});
