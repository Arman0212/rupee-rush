'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startedRoom } = require('./roomHelpers');

/** Put the current player in front of an unowned Tel Aviv, as if they had just rolled. */
function offerTelAviv(room) {
  const s = room.game.state;
  Object.assign(s.turn, { pendingTileId: 'tel-aviv', dice: [2, 4], canRollAgain: false });
  s.phase = 'buyDecision';
  return s.currentPlayerId;
}

function auctionRoom({ players = 3, settings = {} } = {}) {
  const ctx = startedRoom({ players, settings: { auctionSeconds: 10, ...settings } });
  const turnPlayer = offerTelAviv(ctx.room);
  const others = ctx.joined.map((j) => j.playerId).filter((id) => id !== turnPlayer);
  ctx.room.action(ctx.socketOf(turnPlayer), { type: 'decline' });
  return { ...ctx, turnPlayer, others };
}

const lastState = (transport) => transport.last('s1', 'state');

describe('auction timer', () => {
  test('starts with the auction and is broadcast as auction.endsAt, with serverNow', () => {
    const { room, clock, transport } = auctionRoom();
    assert.equal(room.game.state.phase, 'auction');
    const state = lastState(transport);
    assert.equal(state.publicState.auction.endsAt, clock.now() + 10_000);
    assert.equal(state.serverNow, clock.now());
  });

  test('every valid bid restarts it; an invalid one does not', () => {
    const { room, clock, transport, others, socketOf } = auctionRoom();
    clock.advance(6000);
    assert.ok(room.action(socketOf(others[0]), { type: 'bid', amount: 20 }).ok);
    assert.equal(lastState(transport).publicState.auction.endsAt, clock.now() + 10_000);
    clock.advance(6000);
    const endsAt = lastState(transport).publicState.auction.endsAt;
    assert.equal(room.action(socketOf(others[1]), { type: 'bid', amount: 5 }).ok, false);
    assert.equal(room.game.state.auction.highBid, 20);
    clock.advance(3999);
    assert.equal(room.game.state.phase, 'auction');
    assert.equal(endsAt, clock.now() + 1);
  });

  test('when it fires, the server closes the auction and the high bidder gets the tile', () => {
    const { room, clock, others, socketOf } = auctionRoom();
    room.action(socketOf(others[0]), { type: 'bid', amount: 55 });
    clock.advance(10_000);
    assert.equal(room.game.state.auction, null);
    assert.equal(room.game.state.properties['tel-aviv'].ownerId, others[0]);
    assert.equal(room.game.state.phase, 'awaitingEnd');
  });

  test('with no bids the tile stays unowned', () => {
    const { room, clock } = auctionRoom();
    clock.advance(10_000);
    assert.equal(room.game.state.properties['tel-aviv'].ownerId, null);
  });

  test('everyone else passing ends it early, and the timer is cleared', () => {
    const { room, clock, turnPlayer, others, socketOf } = auctionRoom();
    room.action(socketOf(others[0]), { type: 'bid', amount: 30 });
    room.action(socketOf(turnPlayer), { type: 'pass' });
    room.action(socketOf(others[1]), { type: 'pass' });
    assert.equal(room.game.state.properties['tel-aviv'].ownerId, others[0]);
    assert.equal(clock.pending(), 0);
  });
});

describe('absent bidders', () => {
  test('disconnected players are treated as having passed', () => {
    const ctx = startedRoom({ players: 3 });
    const turnPlayer = offerTelAviv(ctx.room);
    const absent = ctx.joined.map((j) => j.playerId).find((id) => id !== turnPlayer);
    ctx.room.disconnect(ctx.socketOf(absent));
    ctx.room.action(ctx.socketOf(turnPlayer), { type: 'decline' });
    assert.equal(ctx.room.game.state.auction.bidders.includes(absent), false);
    assert.ok(ctx.transport.last('s1', 'state') && ctx.room.game.state.auction);
  });

  test('a bidder who disconnects mid-auction passes, which can end it', () => {
    const { room, others, turnPlayer, socketOf } = auctionRoom();
    room.action(socketOf(others[0]), { type: 'bid', amount: 30 });
    room.action(socketOf(turnPlayer), { type: 'pass' });
    room.disconnect(socketOf(others[1]));
    assert.equal(room.game.state.auction, null);
    assert.equal(room.game.state.properties['tel-aviv'].ownerId, others[0]);
  });
});

describe('turn timer during an auction', () => {
  test('is paused, then resumes with the time that was left (at least 5s)', () => {
    const ctx = startedRoom({ players: 3, settings: { turnTimerSeconds: 30, auctionSeconds: 10 } });
    ctx.clock.advance(12_000); // 18s of the turn left
    const turnPlayer = offerTelAviv(ctx.room);
    ctx.room.action(ctx.socketOf(turnPlayer), { type: 'decline' });
    assert.equal(ctx.room.turnDeadline, null);
    assert.equal(ctx.transport.last('s1', 'state').deadline, null);
    ctx.clock.advance(10_000); // auction closes
    assert.equal(ctx.room.game.state.phase, 'awaitingEnd');
    assert.equal(ctx.room.turnDeadline, ctx.clock.now() + 18_000);
  });

  test('a timed-out turn that declined into an auction is finished once the auction closes', () => {
    const ctx = startedRoom({ players: 3, settings: { turnTimerSeconds: 15, auctionSeconds: 10 } });
    const turnPlayer = offerTelAviv(ctx.room);
    ctx.clock.advance(15_000); // the turn times out: auto-decline starts an auction
    assert.equal(ctx.room.game.state.phase, 'auction');
    assert.equal(ctx.room.game.state.currentPlayerId, turnPlayer);
    ctx.clock.advance(10_000); // auction closes; the auto-play finishes the turn
    assert.notEqual(ctx.room.game.state.currentPlayerId, turnPlayer);
  });
});
