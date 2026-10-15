'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');
const { EVENTS } = require('../shared/events');
const { setup, player, prop, rig, own, place, act, findEvent, totalMoney } = require('./helpers');

/** A started game with world events on but auto-draw pushed far away, and `eventId` forced active. */
function withEvent(eventId, { players = 2, settings = {} } = {}) {
  const game = setup({ players, settings: { worldEvents: true, worldEventEvery: 99, auctions: false, ...settings } });
  game.state.world.activeEventId = eventId;
  return game;
}

/** Land p1 on `tileId` by rigging the exact dice from a chosen start square. */
function landOn(game, tileId, from) {
  const target = require('../shared/board').getTileById(tileId).index;
  place(game, 'p1', from);
  const steps = ((target - from) % 40 + 40) % 40;
  const d1 = Math.min(6, steps - 1);
  rig(game, [d1, steps - d1]);
  return act(game, 'p1', 'roll');
}

describe('world events: rent modifiers', () => {
  test('Tech Boom doubles rent on US and China cities only', () => {
    const game = withEvent('tech-boom');
    own(game, 'p2', 'new-york'); // US (darkBlue)
    const events = landOn(game, 'new-york', 34);
    assert.equal(findEvent(events, 'rentPaid').amount, 100); // base 50 × 2
  });

  test('a city outside the boom is unaffected', () => {
    const game = withEvent('tech-boom');
    own(game, 'p2', 'tel-aviv'); // Israel (lightBlue)
    const events = landOn(game, 'tel-aviv', 0);
    assert.equal(findEvent(events, 'rentPaid').amount, 6);
  });

  test('Airport Strike waives airport rent; Gold Rush doubles it', () => {
    const strike = withEvent('airport-strike');
    own(strike, 'p2', 'tlv-airport');
    assert.equal(findEvent(landOn(strike, 'tlv-airport', 0), 'rentPaid'), undefined);

    const rush = withEvent('gold-rush');
    own(rush, 'p2', 'tlv-airport');
    assert.equal(findEvent(landOn(rush, 'tlv-airport', 0), 'rentPaid').amount, 50); // 25 × 2
  });

  test('Utility Surge doubles utility rent', () => {
    const game = withEvent('utility-surge');
    own(game, 'p2', 'electric-company');
    const events = landOn(game, 'electric-company', 6);
    const total = findEvent(events, 'diceRolled').total;
    // Utility rent is 4 × dice total, doubled by the crisis → 8 × dice total.
    assert.equal(findEvent(events, 'rentPaid').amount, 8 * total);
  });

  test('Bull Market raises all rent by 50%', () => {
    const game = withEvent('bull-market');
    own(game, 'p2', 'tel-aviv');
    assert.equal(findEvent(landOn(game, 'tel-aviv', 0), 'rentPaid').amount, 9); // 6 × 1.5
  });

  test('Rent Freeze charges base rent and ignores houses', () => {
    const game = withEvent('rent-freeze');
    own(game, 'p2', 'tel-aviv', 'haifa', 'jerusalem');
    prop(game, 'tel-aviv').buildings = 3;
    // Base rent only (and the full-set double is a house-independent rule, so it still applies).
    assert.equal(findEvent(landOn(game, 'tel-aviv', 0), 'rentPaid').amount, 12); // 6 × 2 (full set)
  });
});

describe('world events: salary, tax, building, land bonus', () => {
  test('Festival Bonus pays double GO salary', () => {
    const game = withEvent('festival-bonus', { settings: { goSalary: 200 } });
    const events = landOn(game, 'salvador', 39);
    assert.equal(findEvent(events, 'moneyCollected').amount, 400);
  });

  test('Tax Holiday makes tax tiles free', () => {
    const game = withEvent('tax-holiday');
    const before = totalMoney(game);
    const events = landOn(game, 'income-tax', 1);
    assert.equal(findEvent(events, 'taxPaid'), undefined);
    assert.equal(totalMoney(game), before);
  });

  test('Housing Slump halves and Heatwave raises the cost to build', () => {
    const slump = withEvent('housing-slump');
    own(slump, 'p1', 'tel-aviv', 'haifa', 'jerusalem');
    assert.equal(findEvent(act(slump, 'p1', 'build', { tileId: 'tel-aviv' }), 'built').amount, 25); // 50 × 0.5

    const heat = withEvent('heatwave');
    own(heat, 'p1', 'tel-aviv', 'haifa', 'jerusalem');
    assert.equal(findEvent(act(heat, 'p1', 'build', { tileId: 'tel-aviv' }), 'built').amount, 75); // 50 × 1.5
  });

  test('Tourist Season pays ₹50 for landing on a European city', () => {
    const game = withEvent('tourist-season');
    const events = landOn(game, 'venice', 9); // Italy (pink)
    const bonus = findEvent(events, 'moneyCollected');
    assert.equal(bonus.amount, 50);
    assert.equal(bonus.reason, 'worldEvent');
  });

  test('no land bonus outside Europe', () => {
    const game = withEvent('tourist-season');
    const events = landOn(game, 'tel-aviv', 0); // Israel
    assert.equal(findEvent(events, 'moneyCollected'), undefined);
  });
});

describe('world events: trade fee waiver', () => {
  test('Trade Fair waives the mortgage transfer fee', () => {
    const fair = withEvent('trade-fair');
    own(fair, 'p1', 'venice');
    prop(fair, 'venice').mortgaged = true;
    act(fair, 'p1', 'proposeTrade', { toId: 'p2', give: { tileIds: ['venice'] }, get: { cash: 10 } });
    const events = act(fair, 'p2', 'acceptTrade', { tradeId: fair.state.trades[0].id });
    assert.equal(findEvent(events, 'mortgageFee'), undefined);

    const normal = withEvent('tech-boom'); // any event without the waiver
    own(normal, 'p1', 'venice');
    prop(normal, 'venice').mortgaged = true;
    act(normal, 'p1', 'proposeTrade', { toId: 'p2', give: { tileIds: ['venice'] }, get: { cash: 10 } });
    const feeEvents = act(normal, 'p2', 'acceptTrade', { tradeId: normal.state.trades[0].id });
    assert.ok(findEvent(feeEvents, 'mortgageFee'));
  });
});

describe('world events: one-off effects on start', () => {
  /** Force the next drawn event to be `eventId`, then advance one turn to draw it. */
  function drawNext(game, eventId) {
    // The draw pool excludes chaos-only events unless chaosEvents is on.
    const pool = EVENTS.filter((e) => game.state.settings.chaosEvents || !e.chaosOnly);
    const idx = pool.findIndex((e) => e.id === eventId);
    game.rng = { next: () => (idx + 0.5) / pool.length };
    const w = game.state.world;
    w.roundsElapsed = w.nextEventAtRound; // due now
    const id = game.state.currentPlayerId;
    game.state.phase = 'awaitingEnd';
    game.state.turn.dice = [1, 1];
    return act(game, id, 'endTurn');
  }

  test('Market Crash takes 10% of each player\'s cash, never into debt', () => {
    const game = setup({ players: 3, settings: { worldEvents: true, worldEventEvery: 1, auctions: false } });
    for (const p of game.state.players) p.cash = 1000;
    const events = drawNext(game, 'market-crash');
    assert.equal(findEvent(events, 'worldEventStarted').eventId, 'market-crash');
    for (const p of game.state.players) assert.equal(p.cash, 900);
    assert.ok(game.state.players.every((p) => p.cash >= 0));
  });

  test('Stimulus Cheque pays every player ₹100 from the bank', () => {
    const game = setup({ players: 3, settings: { worldEvents: true, worldEventEvery: 1, auctions: false } });
    const cash = game.state.players.map((p) => p.cash);
    drawNext(game, 'stimulus');
    game.state.players.forEach((p, i) => assert.equal(p.cash, cash[i] + 100));
  });

  test('Property Tax charges per building, capped at the player\'s cash', () => {
    const game = setup({ players: 2, settings: { worldEvents: true, worldEventEvery: 1, auctions: false } });
    own(game, 'p2', 'tel-aviv', 'haifa', 'jerusalem');
    prop(game, 'tel-aviv').buildings = 2; // ₹40
    prop(game, 'haifa').buildings = 5; // hotel ₹50
    const before = player(game, 'p2').cash;
    drawNext(game, 'property-tax');
    assert.equal(player(game, 'p2').cash, before - 90);
  });
});

describe('world events: new and chaos-only events', () => {
  /** Force the next drawn event to be `eventId`, then advance one turn to draw it. */
  function drawNext(game, eventId) {
    const pool = EVENTS.filter((e) => game.state.settings.chaosEvents || !e.chaosOnly);
    const idx = pool.findIndex((e) => e.id === eventId);
    game.rng = { next: () => (idx + 0.5) / pool.length };
    game.state.world.roundsElapsed = game.state.world.nextEventAtRound;
    const id = game.state.currentPlayerId;
    game.state.phase = 'awaitingEnd';
    game.state.turn.dice = [1, 1];
    return act(game, id, 'endTurn');
  }

  test('Jailbreak frees everyone in jail', () => {
    const game = setup({ players: 3, settings: { worldEvents: true, worldEventEvery: 1, auctions: false } });
    player(game, 'p2').inJail = true;
    player(game, 'p2').jailTurns = 2;
    drawNext(game, 'jailbreak');
    assert.equal(player(game, 'p2').inJail, false);
  });

  test('Rent Reversal makes the owner pay the lander half the rent', () => {
    const game = withEvent('rent-reversal');
    own(game, 'p2', 'tel-aviv'); // rent 6
    const events = landOn(game, 'tel-aviv', 0); // p1 lands on p2's tile
    assert.equal(findEvent(events, 'rentPaid'), undefined);
    const reversed = findEvent(events, 'rentReversed');
    assert.equal(reversed.from, 'p2');
    assert.equal(reversed.to, 'p1');
    assert.equal(reversed.amount, 3);
  });

  test('Property Shuffle swaps two tiles owned by different players', () => {
    const game = setup({ players: 2, settings: { worldEvents: true, worldEventEvery: 1, chaosEvents: true, auctions: false } });
    own(game, 'p1', 'tel-aviv');
    own(game, 'p2', 'rome');
    drawNext(game, 'property-shuffle');
    assert.equal(prop(game, 'tel-aviv').ownerId, 'p2');
    assert.equal(prop(game, 'rome').ownerId, 'p1');
  });

  test('chaos-only events are not drawn unless chaos events are on', () => {
    const plain = EVENTS.filter((e) => !e.chaosOnly);
    const chaos = EVENTS.filter((e) => e.chaosOnly);
    assert.ok(chaos.length >= 2, 'there are chaos-only events');
    assert.ok(['rent-reversal', 'property-shuffle'].every((id) => chaos.some((e) => e.id === id)));
    assert.ok(['utility-surge', 'jailbreak', 'stimulus'].every((id) => plain.some((e) => e.id === id)));
  });
});

describe('world events: scheduling', () => {
  test('an event starts on schedule, lasts one round, and never overlaps', () => {
    const game = new Game({ seed: 7, now: () => 1, settings: { worldEvents: true, worldEventEvery: 2, auctions: false } });
    for (const id of ['a', 'b', 'c']) game.addPlayer({ id, name: id });
    game.start();
    let active = 0;
    let started = 0;
    let ended = 0;
    const startedIds = [];
    const forceEndTurn = () => {
      const id = game.state.currentPlayerId;
      game.state.phase = 'awaitingEnd';
      game.state.turn.dice = [1, 1];
      const events = game.dispatch(id, { type: 'endTurn' });
      for (const e of events.events) {
        if (e.type === 'worldEventStarted') { started++; active++; startedIds.push(e.eventId); }
        if (e.type === 'worldEventEnded') { ended++; active--; }
      }
      assert.ok(active <= 1, 'two events were active at once');
      assert.equal(Boolean(game.state.world.activeEventId), active === 1);
    };
    for (let i = 0; i < 30; i++) forceEndTurn();
    for (let i = 1; i < startedIds.length; i++) assert.notEqual(startedIds[i], startedIds[i - 1], 'an event repeated back to back');
    assert.ok(started >= 2, `only ${started} events started`);
    assert.ok(ended >= 1, 'no event ever ended');
    assert.ok(game.publicState().world.nextInRounds >= 0);
  });

  test('publicState exposes the active event and rounds until the next, only when the mode is on', () => {
    const on = withEvent('tech-boom');
    assert.equal(on.publicState().world.activeEvent.id, 'tech-boom');
    const off = setup({ settings: { worldEvents: false } });
    assert.equal(off.publicState().world, null);
  });
});
