'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');
const { Bot, isAllowed, safestAction } = require('../server/bots/Bot');
const { playBotGame } = require('../server/bots/arena');
const v = require('../server/bots/valuation');
const { getTileById } = require('../shared/board');
const { setup, player } = require('./helpers');

/** A started 3-player game with auctions on, p1 to move, and a bot for any seat. */
function scene({ settings = {} } = {}) {
  const game = setup({ players: 3, settings: { auctions: true, ...settings } });
  const own = (playerId, ...tileIds) => tileIds.forEach((id) => { game.state.properties[id].ownerId = playerId; });
  const bot = (id, difficulty = 'medium') => new Bot({ id, difficulty, seed: 7 });
  const ask = (b, opts = {}) => b.act({ state: game.publicState(), legalActions: game.getLegalActions(b.id), ...opts });
  return { game, own, bot, ask };
}

/** Put a player into debt to the bank. */
function inDebt(game, id, amount) {
  const p = player(game, id);
  p.cash = -amount;
  p.debt = { amount, creditorId: null, owed: [{ creditorId: null, amount }] };
}

describe('bots: legality', () => {
  test('every decision across thousands of states is legal, for every difficulty', () => {
    const warnings = [];
    const log = { warn: (m) => warnings.push(m) };
    let decisions = 0;
    const lineups = [
      ['easy', 'medium', 'hard', 'random'],
      ['medium', 'medium', 'hard'],
      ['easy', 'easy', 'hard', 'medium', 'medium', 'random'],
    ];
    for (let seed = 1; seed <= 12; seed++) {
      const seats = lineups[seed % lineups.length].map((type) => ({ type }));
      playBotGame({
        seed,
        seats,
        log,
        maxTurns: 400,
        onStep: ({ action, state, legal, playerId }) => {
          decisions++;
          assert.ok(isAllowed(action, legal, state, playerId), `illegal ${JSON.stringify(action)}`);
        },
      });
    }
    // playBotGame throws if the engine ever rejects a bot's action.
    assert.ok(decisions > 5000, `only ${decisions} decisions`);
    assert.deepEqual(warnings, [], 'no strategy returned an illegal action');
  });

  test('a strategy that returns something illegal is replaced by the safest legal action', () => {
    const { game, bot } = scene();
    const b = bot('p1');
    const warnings = [];
    b.log = { warn: (m) => warnings.push(m) };
    b.decide = () => ({ type: 'buy' }); // nothing pending to buy
    const action = b.act({ state: game.publicState(), legalActions: game.getLegalActions('p1'), mustAct: true });
    assert.deepEqual(action, { type: 'roll' });
    assert.equal(warnings.length, 1);
  });

  test('safestAction prefers passing, declining and raising cash; bankruptcy last', () => {
    assert.deepEqual(safestAction([{ type: 'bid', amount: 5 }, { type: 'pass' }], null, 'x'), { type: 'pass' });
    const { game } = scene();
    inDebt(game, 'p1', 50);
    game.state.properties.salvador.ownerId = 'p1';
    const legal = game.getLegalActions('p1');
    assert.equal(safestAction(legal, game.state, 'p1').type, 'mortgage');
  });

  test('bids above the listed minimum are allowed, up to the bot\'s cash', () => {
    const state = { players: [{ id: 'a', cash: 100 }] };
    const legal = [{ type: 'bid', amount: 11 }, { type: 'pass' }];
    assert.ok(isAllowed({ type: 'bid', amount: 50 }, legal, state, 'a'));
    assert.ok(!isAllowed({ type: 'bid', amount: 10 }, legal, state, 'a'));
    assert.ok(!isAllowed({ type: 'bid', amount: 101 }, legal, state, 'a'));
  });
});

describe('bots: cash reserve', () => {
  test('medium and hard never buy, bid or build below their reserve unless it completes a set', () => {
    let checked = 0;
    for (let seed = 100; seed < 112; seed++) {
      playBotGame({
        seed,
        seats: ['medium', 'hard', 'medium', 'easy'].map((type) => ({ type })),
        maxTurns: 500,
        onStep: ({ action, state, playerId, bot }) => {
          if (bot.difficulty === 'easy' || bot.difficulty === 'random') return;
          const me = state.players.find((p) => p.id === playerId);
          const reserve = v.reserveFor(state, playerId, bot.params);
          let tileId = null;
          let cost = 0;
          if (action.type === 'buy') [tileId, cost] = [state.turn.pendingTileId, getTileById(state.turn.pendingTileId).price];
          else if (action.type === 'bid') [tileId, cost] = [state.auction.tileId, action.amount];
          else if (action.type === 'build') [tileId, cost] = [action.tileId, getTileById(action.tileId).houseCost];
          else return;
          if (action.type !== 'build' && v.setsCompletedBy(state, playerId, [tileId]).length) return;
          checked++;
          assert.ok(me.cash - cost >= reserve, `${action.type} ${tileId} for ${cost} leaves ${me.cash - cost} < reserve ${reserve}`);
        },
      });
    }
    assert.ok(checked > 300, `only ${checked} purchases checked`);
  });

  test('the reserve grows with the rent the bot could land on next', () => {
    const { game, own } = scene();
    const params = new Bot({ id: 'p1' }).params;
    const calm = v.reserveFor(game.publicState(), 'p1', params);
    own('p2', 'tel-aviv', 'haifa', 'jerusalem');
    for (const id of ['tel-aviv', 'haifa', 'jerusalem']) game.state.properties[id].buildings = 4;
    player(game, 'p1').position = 0; // tel-aviv is 6 ahead
    const scary = v.reserveFor(game.publicState(), 'p1', params);
    assert.equal(calm, params.minReserve);
    assert.ok(scary > calm && scary >= getTileById('jerusalem').rent[4] * params.reserveK);
  });

  test('declines a city it can afford only by dipping into the reserve', () => {
    const { game, bot } = scene();
    const b = bot('p1');
    player(game, 'p1').cash = 200;
    game.state.phase = 'buyDecision';
    game.state.turn = { dice: [1, 2], canRollAgain: false, pendingTileId: 'shenzhen' };
    const action = b.act({ state: game.publicState(), legalActions: game.getLegalActions('p1'), mustAct: true });
    assert.equal(action.type, 'decline');
  });

  test('buys a city that completes its set even when that leaves little cash', () => {
    const { game, own, bot } = scene();
    own('p1', 'tel-aviv', 'haifa');
    player(game, 'p1').cash = 130;
    game.state.phase = 'buyDecision';
    game.state.turn = { dice: [1, 2], canRollAgain: false, pendingTileId: 'jerusalem' };
    const action = bot('p1').act({ state: game.publicState(), legalActions: game.getLegalActions('p1'), mustAct: true });
    assert.equal(action.type, 'buy');
  });
});

describe('bots: trades', () => {
  const propose = (game, fromId, toId, give, get) => {
    const r = game.dispatch(fromId, { type: 'proposeTrade', toId, give, get });
    assert.ok(r.ok, r.error);
    return game.state.trades.at(-1);
  };

  test('never hands over a set-completing tile for nothing (any difficulty)', () => {
    for (const difficulty of ['easy', 'medium', 'hard']) {
      const { game, own, bot, ask } = scene();
      own('p1', 'tel-aviv', 'haifa');
      own('p2', 'jerusalem');
      const t = propose(game, 'p1', 'p2', { cash: 10 }, { tileIds: ['jerusalem'] });
      for (let i = 0; i < 20; i++) {
        const b = bot('p2', difficulty);
        b.rng = { next: () => i / 20 };
        assert.deepEqual(ask(b), { type: 'declineTrade', tradeId: t.id }, difficulty);
      }
    }
  });

  test('gives up a set-completing tile for a large premium, or for a set of its own', () => {
    const premium = scene();
    premium.own('p1', 'tel-aviv', 'haifa');
    premium.own('p2', 'jerusalem');
    player(premium.game, 'p1').cash = 5000;
    const t1 = propose(premium.game, 'p1', 'p2', { cash: 2500 }, { tileIds: ['jerusalem'] });
    assert.deepEqual(premium.ask(premium.bot('p2')), { type: 'acceptTrade', tradeId: t1.id });

    // A swap where each side completes a set, and the bot's new set is the better one.
    const swap = scene();
    swap.own('p1', 'tel-aviv', 'haifa', 'new-york');
    swap.own('p2', 'jerusalem', 'california');
    const t2 = propose(swap.game, 'p1', 'p2', { tileIds: ['new-york'] }, { tileIds: ['jerusalem'] });
    assert.deepEqual(swap.ask(swap.bot('p2')), { type: 'acceptTrade', tradeId: t2.id });
  });

  test('never breaks up a full set it owns for a fair price', () => {
    const { game, own, bot, ask } = scene();
    own('p2', 'tel-aviv', 'haifa', 'jerusalem');
    own('p1', 'rome');
    propose(game, 'p1', 'p2', { cash: 120 }, { tileIds: ['haifa'] });
    assert.equal(ask(bot('p2')).type, 'declineTrade');
  });

  test('accepts a clearly good offer and declines a bad one', () => {
    const good = scene();
    good.own('p1', 'venice');
    const t1 = good.game.dispatch('p1', { type: 'proposeTrade', toId: 'p2', give: { tileIds: ['venice'], cash: 100 } });
    assert.ok(t1.ok);
    assert.equal(good.ask(good.bot('p2')).type, 'acceptTrade');

    const bad = scene();
    bad.own('p2', 'paris');
    bad.game.dispatch('p1', { type: 'proposeTrade', toId: 'p2', give: { cash: 20 }, get: { tileIds: ['paris'] } });
    assert.equal(bad.ask(bad.bot('p2')).type, 'declineTrade');
  });

  test('proposes a fair swap that completes its set, at most one open proposal at a time', () => {
    const { game, own, bot } = scene();
    own('p1', 'tel-aviv', 'haifa', 'rio');
    own('p2', 'jerusalem', 'salvador');
    const b = bot('p1');
    game.state.phase = 'awaitingEnd';
    game.state.turn = { dice: [1, 2], canRollAgain: false, pendingTileId: null };
    const action = b.act({ state: game.publicState(), legalActions: game.getLegalActions('p1'), mustAct: true });
    assert.equal(action.type, 'proposeTrade');
    assert.equal(action.toId, 'p2');
    assert.deepEqual(action.get.tileIds, ['jerusalem']);
    assert.ok(game.dispatch('p1', action).ok);
    // The other side, by the same valuation, would take it.
    assert.equal(bot('p2').act({ state: game.publicState(), legalActions: game.getLegalActions('p2') }).type, 'acceptTrade');
    // With that proposal open, the bot just ends its turn.
    assert.deepEqual(b.act({ state: game.publicState(), legalActions: game.getLegalActions('p1'), mustAct: true }), { type: 'endTurn' });
  });

  test('waits longer between proposals to humans', () => {
    const { game, own, bot } = scene();
    own('p2', 'jerusalem');
    const offer = { type: 'proposeTrade', toId: 'p2', give: { tileIds: [], cash: 10, jailCards: [] }, get: { tileIds: ['jerusalem'], cash: 0, jailCards: [] } };
    game.state.phase = 'awaitingEnd';
    game.state.turn = { dice: [1, 2], canRollAgain: false, pendingTileId: null };
    const run = (humans) => {
      const b = bot('p1');
      b.planTrade = () => ({ ...offer });
      const ask = () => b.act({ state: game.publicState(), legalActions: game.getLegalActions('p1'), mustAct: true, humans });
      const turn = game.state.turnNumber;
      assert.equal(ask().type, 'proposeTrade');
      game.state.turnNumber += b.params.proposeEveryTurns; // enough for a bot target, not a human one
      const second = ask().type;
      game.state.turnNumber = turn;
      return second;
    };
    assert.equal(run(new Set()), 'proposeTrade');
    assert.equal(run(new Set(['p2'])), 'endTurn');
  });

  test('easy bots never propose trades', () => {
    const { game, own, bot } = scene();
    own('p1', 'tel-aviv', 'haifa');
    own('p2', 'jerusalem');
    game.state.phase = 'awaitingEnd';
    game.state.turn = { dice: [1, 2], canRollAgain: false, pendingTileId: null };
    const action = bot('p1', 'easy').act({ state: game.publicState(), legalActions: game.getLegalActions('p1'), mustAct: true });
    assert.deepEqual(action, { type: 'endTurn' });
  });
});

describe('bots: debt', () => {
  test('mortgages the least valuable tile first, keeping full sets', () => {
    const { game, own, bot, ask } = scene();
    own('p2', 'salvador', 'rio', 'electric-company', 'paris');
    inDebt(game, 'p2', 40);
    const action = ask(bot('p2'));
    assert.equal(action.type, 'mortgage');
    assert.equal(action.tileId, 'electric-company');
  });

  test('sells houses only when nothing is left to mortgage, from the least valuable set', () => {
    const { game, own, bot, ask } = scene();
    own('p2', 'salvador', 'rio', 'california', 'new-york');
    for (const id of ['salvador', 'rio', 'california', 'new-york']) game.state.properties[id].buildings = 1;
    inDebt(game, 'p2', 30);
    const action = ask(bot('p2'));
    assert.equal(action.type, 'sellHouse');
    assert.ok(['salvador', 'rio'].includes(action.tileId));
  });

  test('declares bankruptcy only when there is nothing left to raise cash with', () => {
    const { game, own, bot, ask } = scene();
    own('p2', 'salvador');
    game.state.properties.salvador.mortgaged = true;
    inDebt(game, 'p2', 500);
    assert.deepEqual(ask(bot('p2')), { type: 'bankrupt' });
  });

  test('a bot in debt keeps raising cash until it is clear', () => {
    const { game, own, bot } = scene();
    own('p2', 'salvador', 'rio', 'tel-aviv', 'haifa');
    inDebt(game, 'p2', 100);
    const b = bot('p2');
    for (let i = 0; i < 10 && player(game, 'p2').cash < 0; i++) {
      const action = b.act({ state: game.publicState(), legalActions: game.getLegalActions('p2') });
      assert.equal(action.type, 'mortgage');
      assert.ok(game.dispatch('p2', action).ok);
    }
    assert.ok(player(game, 'p2').cash >= 0);
    assert.ok(!player(game, 'p2').bankrupt);
  });
});

describe('bots: auctions and jail', () => {
  const auction = (game, tileId, highBid = 0, highBidderId = null) => {
    game.state.phase = 'auction';
    game.state.auction = { tileId, highBid, highBidderId, bidders: ['p1', 'p2', 'p3'], startedBy: 'p1' };
  };

  test('bids on a cheap city and passes once the price is too high', () => {
    const { game, bot, ask } = scene();
    auction(game, 'shenzhen', 20, 'p1');
    const first = ask(bot('p2'));
    assert.equal(first.type, 'bid');
    assert.ok(first.amount >= 21 && first.amount < 220 * 2);
    game.state.auction.highBid = 2000;
    assert.deepEqual(ask(bot('p2')), { type: 'pass' });
  });

  test('bids more for a city that completes its set', () => {
    const { game, own, bot } = scene();
    own('p2', 'tel-aviv', 'haifa');
    auction(game, 'jerusalem');
    const b = bot('p2');
    const ctx = { state: game.publicState(), me: 'p2', player: player(game, 'p2'), p: b.params };
    const completing = b.auctionCap(ctx);
    own('p2'); // nothing changed for an outsider:
    const outsider = bot('p3').auctionCap({ ...ctx, me: 'p3', player: player(game, 'p3') });
    assert.ok(completing > outsider * 1.5, `${completing} vs ${outsider}`);
  });

  test('a bot holding the high bid has nothing to do', () => {
    const { game, bot, ask } = scene();
    auction(game, 'shenzhen', 50, 'p2');
    assert.equal(ask(bot('p2')), null);
  });

  test('pays its way out of jail early on, and stays in once the board is built up', () => {
    const { game, own, bot } = scene();
    const p1 = player(game, 'p1');
    p1.inJail = true;
    p1.position = 10;
    const b = bot('p1');
    const ask = () => b.act({ state: game.publicState(), legalActions: game.getLegalActions('p1'), mustAct: true });
    assert.equal(ask().type, 'payJailFine');
    // Late game: everything owned and an opponent with hotels.
    for (const id of Object.keys(game.state.properties)) game.state.properties[id].ownerId = 'p3';
    own('p2', 'california', 'new-york');
    game.state.properties.california.buildings = 5;
    game.state.properties['new-york'].buildings = 5;
    assert.equal(ask().type, 'roll');
  });

  test('builds on a full set, preferring the best rent per rupee, and keeps the reserve', () => {
    const { game, own, bot } = scene();
    own('p1', 'tel-aviv', 'haifa', 'jerusalem');
    player(game, 'p1').cash = 400;
    const b = bot('p1');
    const builds = [];
    for (let i = 0; i < 20; i++) {
      const action = b.act({ state: game.publicState(), legalActions: game.getLegalActions('p1'), mustAct: true });
      if (action.type !== 'build') break;
      builds.push(action.tileId);
      assert.ok(game.dispatch('p1', action).ok);
    }
    assert.ok(builds.length >= 2, `built ${builds.length}`);
    assert.ok(player(game, 'p1').cash >= v.reserveFor(game.publicState(), 'p1', b.params));
  });
});

describe('bots: only public information', () => {
  test('decisions are the same whatever the hidden deck order and rng state', () => {
    const run = (seed) => {
      const game = new Game({ seed, now: () => 1 });
      for (const id of ['a', 'b']) game.addPlayer({ id, name: id });
      game.start();
      return game;
    };
    const g1 = run(1);
    const g2 = run(2);
    // Same visible position, different decks and rng.
    g2.state.players = JSON.parse(JSON.stringify(g1.state.players));
    g2.state.currentPlayerId = g1.state.currentPlayerId;
    const id = g1.state.currentPlayerId;
    const s1 = g1.publicState();
    const s2 = g2.publicState();
    assert.ok(!('seed' in s1) && !('rngState' in s1) && typeof s1.decks.surprise.remaining === 'number');
    const a = new Bot({ id, seed: 3 }).act({ state: s1, legalActions: g1.getLegalActions(id), mustAct: true });
    const b = new Bot({ id, seed: 3 }).act({ state: s2, legalActions: g2.getLegalActions(id), mustAct: true });
    assert.deepEqual(a, b);
  });
});
