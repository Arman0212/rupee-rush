'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setup, player, prop, rig, own, place, act, findEvent } = require('./helpers');
const { getTileById } = require('../shared/board');

function started({ players = 3, settings = {} } = {}) {
  return setup({ players, settings: { bounties: true, bountyRentThreshold: 500, auctions: false, ...settings } });
}

/** Land p1 on tileId from a start square, rigging exact dice. */
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

const bountyOn = (game, id) => game.publicState().bounties.onPlayer[id];

describe('bounties: placement triggers', () => {
  test('collecting a single rent at or above the threshold places a bounty on the collector', () => {
    const game = started();
    own(game, 'p2', 'new-york', 'california'); // full US set
    prop(game, 'new-york').buildings = 3; // rent 1400 > 500
    const events = land(game, 'p1', 'new-york', 34);
    assert.ok(findEvent(events, 'rentPaid').amount >= 500);
    assert.equal(findEvent(events, 'bountyPlaced').playerId, 'p2');
    assert.equal(bountyOn(game, 'p2').value, 200);
  });

  test('a rent below the threshold places nothing', () => {
    const game = started();
    own(game, 'p2', 'tel-aviv');
    const events = land(game, 'p1', 'tel-aviv', 0);
    assert.equal(findEvent(events, 'bountyPlaced'), undefined);
    assert.equal(bountyOn(game, 'p2'), undefined);
  });

  test('completing a third colour set places a bounty', () => {
    const game = started();
    own(game, 'p2', 'salvador', 'rio'); // brown (1st set)
    own(game, 'p2', 'tel-aviv', 'haifa', 'jerusalem'); // lightBlue (2nd)
    own(game, 'p2', 'venice', 'milan'); // pink, missing rome
    // Completing the third set via buying rome triggers the bounty.
    place(game, 'p2', 12);
    game.state.currentPlayerId = 'p2';
    rig(game, [1, 1]); // 12 -> rome (14)
    act(game, 'p2', 'roll');
    const events = act(game, 'p2', 'buy');
    assert.equal(findEvent(events, 'bountyPlaced').reason, 'thirdSet');
    assert.equal(bountyOn(game, 'p2').value, 200);
  });

  test('bankrupting a player places a bounty on the creditor', () => {
    const game = started({ players: 2 });
    own(game, 'p2', 'new-york', 'california');
    prop(game, 'new-york').buildings = 5;
    player(game, 'p1').cash = 10;
    land(game, 'p1', 'new-york', 34); // huge rent → p1 in debt
    const events = act(game, 'p1', 'bankrupt');
    assert.ok(findEvent(events, 'bankrupt'));
    const placed = events.filter((e) => e.type === 'bountyPlaced');
    assert.ok(placed.some((e) => e.playerId === 'p2' && e.reason === 'bankruptcy'));
  });

  test('repeated triggers raise the bounty by ₹100 each, capped at ₹1,000', () => {
    const game = started();
    own(game, 'p2', 'new-york', 'california');
    prop(game, 'new-york').buildings = 3;
    for (let i = 0; i < 12; i++) { player(game, 'p1').cash = 100000; land(game, 'p1', 'new-york', 34); }
    assert.equal(bountyOn(game, 'p2').value, 1000);
  });
});

describe('bounties: claiming and clearing', () => {
  test('a bounty holder who pays rent hands the owner the bounty, then it clears', () => {
    const game = started();
    // Put a bounty on p1 directly.
    game.state.bounties.onPlayer.p1 = { value: 300, triggers: 1 };
    own(game, 'p3', 'tel-aviv'); // small rent, so p1 survives
    player(game, 'p1').cash = 1000;
    const events = land(game, 'p1', 'tel-aviv', 0);
    const claim = findEvent(events, 'bountyClaimed');
    assert.equal(claim.holderId, 'p1');
    assert.equal(claim.to, 'p3');
    assert.equal(claim.amount, 300);
    assert.equal(bountyOn(game, 'p1'), undefined);
  });

  test('a bounty clears when its holder goes bankrupt', () => {
    const game = started({ players: 2 });
    game.state.bounties.onPlayer.p1 = { value: 400, triggers: 2 };
    own(game, 'p2', 'new-york', 'california');
    prop(game, 'new-york').buildings = 5;
    player(game, 'p1').cash = 10;
    land(game, 'p1', 'new-york', 34);
    act(game, 'p1', 'bankrupt');
    assert.equal(bountyOn(game, 'p1'), undefined);
  });
});

describe('bounties: rivalries', () => {
  test('the top rivalry is the pair with the most rent paid between them', () => {
    const game = started();
    own(game, 'p2', 'tel-aviv');
    own(game, 'p3', 'haifa');
    land(game, 'p1', 'tel-aviv', 0); // p1 -> p2, 6
    land(game, 'p1', 'haifa', 0); // p1 -> p3, 6
    land(game, 'p3', 'tel-aviv', 0); // p3 -> p2, 6 (now p1|p2 = 6, p1|p3 = 6, p2|p3 = 6)
    land(game, 'p1', 'tel-aviv', 0); // p1 -> p2 again, total p1|p2 = 12
    const rivalry = game.publicState().bounties.rivalry;
    assert.deepEqual([rivalry.a, rivalry.b].sort(), ['p1', 'p2']);
    assert.equal(rivalry.total, 12);
  });

  test('publicState carries bounties only when the mode is on', () => {
    assert.equal(setup({ settings: { bounties: false } }).publicState().bounties, null);
    assert.ok(started().publicState().bounties);
  });
});
