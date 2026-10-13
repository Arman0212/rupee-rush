'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setup, player, prop, own, place, act, reject, findEvent, eventTypes, totalMoney } = require('./helpers');

/** p1 lands on Tel Aviv (₹100) and declines, starting an auction between `players`. */
function auctionGame({ players = 3, dice = [[2, 4]], settings = {} } = {}) {
  const game = setup({ players, dice, settings: { auctions: true, ...settings } });
  act(game, 'p1', 'roll'); // 0 -> 6 Tel Aviv
  const events = act(game, 'p1', 'decline');
  return { game, events };
}

const bid = (game, id, amount) => game.dispatch(id, { type: 'bid', amount });

describe('starting an auction', () => {
  test('declining with auctions on starts one, open to every player', () => {
    const { game, events } = auctionGame();
    assert.deepEqual(eventTypes(events), ['purchaseDeclined', 'auctionStarted']);
    assert.equal(game.state.phase, 'auction');
    assert.deepEqual(game.state.auction, { tileId: 'tel-aviv', highBid: 0, highBidderId: null, bidders: ['p1', 'p2', 'p3'], startedBy: 'p1' });
    assert.equal(prop(game, 'tel-aviv').ownerId, null);
  });

  test('declining with auctions off leaves the tile unowned', () => {
    const game = setup({ dice: [[2, 4]], settings: { auctions: false } });
    act(game, 'p1', 'roll');
    act(game, 'p1', 'decline');
    assert.equal(game.state.phase, 'awaitingEnd');
    assert.equal(game.state.auction, null);
  });

  test('bankrupt players are not bidders', () => {
    const game = setup({ players: 3, dice: [[2, 4]], settings: { auctions: true } });
    Object.assign(player(game, 'p3'), { bankrupt: true, cash: 0 });
    act(game, 'p1', 'roll');
    act(game, 'p1', 'decline');
    assert.deepEqual(game.state.auction.bidders, ['p1', 'p2']);
  });
});

describe('bidding', () => {
  test('anyone still in can bid, including the player who declined', () => {
    const { game } = auctionGame();
    assert.ok(bid(game, 'p1', 10).ok);
    const { events } = bid(game, 'p2', 11);
    assert.deepEqual(findEvent(events, 'bidPlaced'), { type: 'bidPlaced', playerId: 'p2', tileId: 'tel-aviv', amount: 11, at: 1000 });
    assert.equal(game.state.auction.highBid, 11);
    assert.equal(game.state.auction.highBidderId, 'p2');
  });

  test('a bid must beat the high bid by the minimum increment', () => {
    const { game } = auctionGame();
    assert.equal(bid(game, 'p2', 0).error, 'bid at least ₹1');
    bid(game, 'p2', 50);
    assert.equal(bid(game, 'p3', 50).error, 'bid at least ₹51');
    assert.ok(bid(game, 'p3', 51).ok);
  });

  test('a bid can never exceed your cash, so it never creates debt', () => {
    const { game } = auctionGame();
    player(game, 'p2').cash = 80;
    assert.equal(bid(game, 'p2', 81).error, "you can't bid more than your cash");
    assert.ok(bid(game, 'p2', 80).ok);
  });

  test('bad amounts are refused', () => {
    const { game } = auctionGame();
    for (const amount of [undefined, '50', 12.5, -3, null]) assert.equal(bid(game, 'p2', amount).ok, false);
  });

  test('no bidding while in debt, nor against yourself', () => {
    const { game } = auctionGame();
    Object.assign(player(game, 'p3'), { cash: -10 });
    player(game, 'p3').debt = { amount: 10, creditorId: null, owed: [{ creditorId: null, amount: 10 }] };
    assert.equal(bid(game, 'p3', 5).error, 'clear your debt before bidding');
    bid(game, 'p2', 5);
    assert.equal(bid(game, 'p2', 6).error, 'you already hold the high bid');
  });

  test('legal actions offer the minimum bid and pass to bidders only', () => {
    const { game } = auctionGame();
    bid(game, 'p2', 20);
    assert.deepEqual(game.getLegalActions('p1'), [{ type: 'bid', amount: 21 }, { type: 'pass' }]);
    assert.deepEqual(game.getLegalActions('p2'), []); // the high bidder waits
  });
});

describe('passing and ending', () => {
  test('a pass drops you out; the high bidder cannot pass', () => {
    const { game } = auctionGame();
    bid(game, 'p2', 10);
    assert.equal(game.dispatch('p2', { type: 'pass' }).error, 'you hold the high bid');
    act(game, 'p1', 'pass');
    assert.equal(bid(game, 'p1', 20).error, 'you have passed on this auction');
    assert.equal(game.dispatch('p1', { type: 'pass' }).error, 'you have already passed');
  });

  test('once every other bidder has passed, the auction ends early and the winner pays the bank', () => {
    const { game } = auctionGame();
    const before = totalMoney(game);
    bid(game, 'p3', 75);
    act(game, 'p1', 'pass');
    const events = act(game, 'p2', 'pass');
    assert.deepEqual(findEvent(events, 'auctionClosed'), { type: 'auctionClosed', from: 'p3', to: null, amount: 75, tileId: 'tel-aviv', winnerId: 'p3', at: 1000 });
    assert.equal(prop(game, 'tel-aviv').ownerId, 'p3');
    assert.equal(player(game, 'p3').cash, 1425);
    assert.equal(totalMoney(game), before - 75);
    assert.equal(game.state.auction, null);
    assert.equal(game.state.phase, 'awaitingEnd');
  });

  test('if everyone passes without a bid, the tile stays unowned', () => {
    const { game } = auctionGame();
    act(game, 'p1', 'pass');
    act(game, 'p2', 'pass');
    const events = act(game, 'p3', 'pass');
    assert.deepEqual(findEvent(events, 'auctionClosed'), { type: 'auctionClosed', tileId: 'tel-aviv', winnerId: null, at: 1000 });
    assert.equal(prop(game, 'tel-aviv').ownerId, null);
    assert.equal(game.state.phase, 'awaitingEnd');
  });

  test('closeAuction (the server timer) sells to the high bidder, or to nobody', () => {
    const { game } = auctionGame();
    bid(game, 'p2', 30);
    assert.ok(game.closeAuction().ok);
    assert.equal(prop(game, 'tel-aviv').ownerId, 'p2');
    assert.equal(game.closeAuction().error, 'no auction is running');

    const second = auctionGame().game;
    second.closeAuction();
    assert.equal(prop(second, 'tel-aviv').ownerId, null);
  });

  test('closeAuction is not a client action', () => {
    const { game } = auctionGame();
    assert.equal(game.dispatch('p1', { type: 'closeAuction' }).error, 'unknown action');
  });

  test('after doubles, the turn player rolls again once the auction closes', () => {
    const { game } = auctionGame({ dice: [[3, 3]] });
    game.closeAuction();
    assert.equal(game.state.phase, 'awaitingRoll');
    assert.equal(game.state.currentPlayerId, 'p1');
  });
});

describe('during an auction', () => {
  test('everything except bid and pass is blocked, including ending the turn', () => {
    const { game } = auctionGame();
    own(game, 'p1', 'salvador', 'rio');
    for (const action of [{ type: 'endTurn' }, { type: 'roll' }, { type: 'build', tileId: 'salvador' }, { type: 'mortgage', tileId: 'salvador' },
      { type: 'proposeTrade', toId: 'p2', give: { cash: 10 } }, { type: 'bankrupt' }]) {
      assert.equal(game.dispatch('p1', action).error, 'not while an auction is running', action.type);
    }
  });

  test('if the high bidder goes bankrupt, their bid is void but the price floor stays', () => {
    const { game } = auctionGame();
    bid(game, 'p2', 40);
    game.removePlayer('p2');
    assert.equal(game.state.auction.highBidderId, null);
    assert.deepEqual(game.state.auction.bidders, ['p1', 'p3']);
    assert.equal(bid(game, 'p3', 40).error, 'bid at least ₹41');
  });

  test('if the turn player leaves mid-auction, the next player starts their turn when it closes', () => {
    const { game } = auctionGame();
    bid(game, 'p3', 40);
    game.removePlayer('p1');
    assert.equal(game.state.phase, 'auction');
    assert.equal(game.state.currentPlayerId, 'p2');
    act(game, 'p2', 'pass'); // p3 is the only one left: sold
    assert.equal(prop(game, 'tel-aviv').ownerId, 'p3');
    assert.equal(game.state.phase, 'awaitingRoll');
    assert.equal(game.state.currentPlayerId, 'p2');
  });

  test('the game can end mid-auction', () => {
    const { game } = auctionGame({ players: 2 });
    game.removePlayer('p2');
    assert.equal(game.state.phase, 'gameOver');
    assert.equal(game.state.auction, null);
  });

  test('a mid-board decline also starts an auction (any tile type)', () => {
    const game = setup({ players: 2, dice: [[2, 3]], settings: { auctions: true } });
    place(game, 'p1', 20);
    act(game, 'p1', 'roll'); // 20 -> 25 CDG Airport
    act(game, 'p1', 'decline');
    assert.equal(game.state.auction.tileId, 'cdg-airport');
  });
});
