'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');
const { PLAYER_COLORS } = require('../shared/rules');
const { setup, player, prop, place, act, reject, findEvent, eventTypes, own } = require('./helpers');

describe('lobby', () => {
  test('addPlayer validates ids, duplicates, capacity and phase', () => {
    const game = new Game({ settings: { maxPlayers: 2 }, seed: 1 });
    assert.equal(game.addPlayer({ id: '' }).error, 'invalid player id');
    assert.equal(game.addPlayer({ id: 'jackpot' }).error, 'invalid player id');
    assert.equal(game.addPlayer(null).error, 'invalid player');
    assert.equal(game.addPlayer().error, 'invalid player');
    assert.ok(game.addPlayer({ id: 'a', name: '  Asha  ' }).ok);
    assert.equal(game.addPlayer({ id: 'a' }).error, 'player already joined');
    assert.ok(game.addPlayer({ id: 'b' }).ok);
    assert.equal(game.addPlayer({ id: 'c' }).error, 'game is full');
    assert.equal(game.state.players[0].name, 'Asha');
    assert.equal(game.state.players[1].name, 'Player 2');
  });

  test('colours fall back to the first free one', () => {
    const game = new Game({ seed: 1 });
    game.addPlayer({ id: 'a', color: PLAYER_COLORS[3] });
    game.addPlayer({ id: 'b', color: PLAYER_COLORS[3] });
    game.addPlayer({ id: 'c', color: 'hotpink' });
    assert.deepEqual(game.state.players.map((p) => p.color), [PLAYER_COLORS[3], PLAYER_COLORS[0], PLAYER_COLORS[1]]);
  });

  test('start needs two players, hands out cash and cannot run twice', () => {
    const game = new Game({ settings: { startingCash: 2000 }, seed: 1 });
    game.addPlayer({ id: 'a' });
    assert.equal(game.start().error, 'need at least 2 players');
    game.addPlayer({ id: 'b' });
    const { ok, events } = game.start();
    assert.ok(ok);
    assert.equal(game.state.phase, 'awaitingRoll');
    assert.equal(game.state.turnNumber, 1);
    assert.ok(game.state.players.every((p) => p.cash === 2000));
    assert.equal(findEvent(events, 'turnStarted').playerId, game.state.players[0].id);
    assert.equal(game.start().error, 'game already started');
    assert.equal(game.addPlayer({ id: 'c' }).error, 'game already started');
  });

  test('the same seed shuffles turn order and decks the same way', () => {
    const make = (seed) => {
      const g = new Game({ seed });
      ['a', 'b', 'c', 'd', 'e', 'f'].forEach((id) => g.addPlayer({ id }));
      g.start();
      return [g.state.players.map((p) => p.id), g.state.decks];
    };
    assert.deepEqual(make(7), make(7));
    assert.notDeepEqual(make(7), make(8));
  });

  test('actions before start are rejected', () => {
    const game = new Game({ seed: 1 });
    game.addPlayer({ id: 'a' });
    assert.equal(game.dispatch('a', { type: 'roll' }).error, 'game has not started');
    assert.deepEqual(game.getLegalActions('a'), []);
  });
});

describe('rolling and moving', () => {
  test('a plain roll moves by the dice total and waits for endTurn', () => {
    const game = setup({ dice: [[4, 6]] });
    const events = act(game, 'p1', 'roll'); // 0 -> 10 Jail, just visiting
    assert.equal(player(game, 'p1').position, 10);
    assert.equal(player(game, 'p1').inJail, false);
    assert.deepEqual(eventTypes(events), ['diceRolled', 'moved']);
    assert.deepEqual(findEvent(events, 'diceRolled').dice, [4, 6]);
    assert.equal(game.state.phase, 'awaitingEnd');
    assert.deepEqual(game.getLegalActions('p1'), [{ type: 'endTurn' }]);
  });

  test('landing on an unowned property offers it; buying deducts the price', () => {
    const game = setup({ dice: [[2, 4]] });
    act(game, 'p1', 'roll'); // 0 -> 6 Tel Aviv (₹100)
    assert.equal(game.state.phase, 'buyDecision');
    assert.equal(game.state.turn.pendingTileId, 'tel-aviv');
    reject(game, 'p1', 'endTurn');
    const events = act(game, 'p1', 'buy');
    assert.deepEqual(findEvent(events, 'propertyBought'), { type: 'propertyBought', from: 'p1', to: null, amount: 100, tileId: 'tel-aviv', at: 1000 });
    assert.equal(player(game, 'p1').cash, 1400);
    assert.equal(prop(game, 'tel-aviv').ownerId, 'p1');
    assert.equal(game.state.phase, 'awaitingEnd');
  });

  test('declining leaves the property unowned', () => {
    const game = setup({ dice: [[2, 4]] });
    act(game, 'p1', 'roll');
    act(game, 'p1', 'decline');
    assert.equal(prop(game, 'tel-aviv').ownerId, null);
    assert.equal(player(game, 'p1').cash, 1500);
    assert.equal(game.state.phase, 'awaitingEnd');
  });

  test('you cannot buy without the cash', () => {
    const game = setup({ dice: [[2, 4]] });
    player(game, 'p1').cash = 99;
    act(game, 'p1', 'roll');
    assert.equal(reject(game, 'p1', 'buy'), 'not enough cash');
    assert.deepEqual(game.getLegalActions('p1'), [{ type: 'decline' }]);
  });

  test('endTurn passes to the next player and bumps the turn number', () => {
    const game = setup({ players: 3, dice: [[2, 4]] });
    act(game, 'p1', 'roll');
    act(game, 'p1', 'decline');
    const events = act(game, 'p1', 'endTurn');
    assert.deepEqual(eventTypes(events), ['turnEnded', 'turnStarted']);
    assert.equal(game.state.currentPlayerId, 'p2');
    assert.equal(game.state.turnNumber, 2);
    assert.equal(game.state.phase, 'awaitingRoll');
  });

  test('passing GO pays the salary', () => {
    const game = setup({ dice: [[1, 2]] });
    place(game, 'p1', 38);
    const events = act(game, 'p1', 'roll'); // 38 -> 1 Salvador
    assert.equal(findEvent(events, 'moved').passedGo, true);
    assert.equal(findEvent(events, 'moneyCollected').reason, 'goSalary');
    assert.equal(player(game, 'p1').cash, 1700);
  });

  test('landing exactly on GO pays the salary once, using the configured amount', () => {
    const game = setup({ settings: { goSalary: 300 }, dice: [[1, 2]] });
    place(game, 'p1', 37);
    const events = act(game, 'p1', 'roll');
    assert.equal(player(game, 'p1').position, 0);
    assert.equal(events.filter((e) => e.type === 'moneyCollected').length, 1);
    assert.equal(player(game, 'p1').cash, 1800);
  });

  test('doubles give another roll', () => {
    const game = setup({ dice: [[5, 5], [1, 3]] });
    place(game, 'p1', 10);
    act(game, 'p1', 'roll'); // 10 -> 20 Vacation
    assert.equal(game.state.phase, 'awaitingRoll');
    reject(game, 'p1', 'endTurn');
    act(game, 'p1', 'roll'); // 20 -> 24 Shanghai
    assert.equal(game.state.phase, 'buyDecision');
    act(game, 'p1', 'decline');
    assert.equal(game.state.phase, 'awaitingEnd'); // 1+3 was not a double
  });

  test('doubles then a buy decision returns to awaitingRoll', () => {
    const game = setup({ dice: [[3, 3]] });
    act(game, 'p1', 'roll'); // 0 -> 6 Tel Aviv
    act(game, 'p1', 'buy');
    assert.equal(game.state.phase, 'awaitingRoll');
  });

  test('a third double in one turn goes straight to jail without moving', () => {
    const game = setup({ dice: [[5, 5], [2, 2], [3, 3]] });
    place(game, 'p1', 10);
    act(game, 'p1', 'roll'); // -> 20 Vacation
    act(game, 'p1', 'roll'); // -> 24 Shanghai
    act(game, 'p1', 'decline');
    const events = act(game, 'p1', 'roll');
    const p1 = player(game, 'p1');
    assert.deepEqual(eventTypes(events), ['diceRolled', 'sentToJail']);
    assert.equal(findEvent(events, 'sentToJail').reason, 'tripleDoubles');
    assert.equal(p1.position, 10);
    assert.equal(p1.inJail, true);
    assert.equal(p1.doublesCount, 0);
    assert.equal(game.state.phase, 'awaitingEnd');
    act(game, 'p1', 'endTurn');
  });

  test('doubles from an earlier turn do not count towards jail', () => {
    const game = setup({ dice: [[5, 5], [2, 2], [1, 2], [4, 6], [1, 1]] });
    place(game, 'p1', 10);
    act(game, 'p1', 'roll'); // double: 10 -> 20
    act(game, 'p1', 'roll'); // double: 20 -> 24 Shanghai
    act(game, 'p1', 'decline');
    act(game, 'p1', 'roll'); // 24 -> 27 Toulouse
    act(game, 'p1', 'decline');
    act(game, 'p1', 'endTurn');
    act(game, 'p2', 'roll'); // 0 -> 10, just visiting
    act(game, 'p2', 'endTurn');
    act(game, 'p1', 'roll'); // a double again, but only the first this turn: 27 -> 29 Paris
    assert.equal(player(game, 'p1').inJail, false);
    assert.equal(player(game, 'p1').position, 29);
  });
});

describe('validation', () => {
  test('acting out of turn or in the wrong phase is rejected', () => {
    const game = setup({ dice: [[2, 4]] });
    assert.equal(reject(game, 'p2', 'roll'), 'not your turn');
    assert.equal(reject(game, 'p1', 'endTurn'), 'not allowed during awaitingRoll');
    assert.equal(reject(game, 'p1', 'buy'), 'not allowed during awaitingRoll');
    assert.equal(reject(game, 'nobody', 'roll'), 'unknown player');
  });

  test('chat is not an engine action; old placeholder types are unknown', () => {
    const game = setup();
    assert.deepEqual(game.dispatch('p1', { type: 'chat' }), { ok: false, error: 'not implemented' });
    assert.deepEqual(game.dispatch('p1', { type: 'trade' }), { ok: false, error: 'unknown action' });
  });

  test('dispatch never throws on garbage input', () => {
    const game = setup();
    own(game, 'p1', 'salvador');
    const junk = [
      undefined, null, 0, 'roll', [], {}, { type: 5 }, { type: 'nope' }, { type: '__proto__' }, { type: 'constructor' },
      { type: 'build' }, { type: 'build', tileId: 3 }, { type: 'build', tileId: {} }, { type: 'mortgage', tileId: '__proto__' },
      { type: 'sellHouse', tileId: 'constructor' }, { type: 'unmortgage', tileId: 'go' }, { type: 'build', tileId: 'jail' },
      { type: 'toString' }, { type: 'hasOwnProperty' },
    ];
    for (const action of junk) {
      for (const id of ['p1', 'p2', undefined, null, {}, 42, '__proto__']) {
        const result = game.dispatch(id, action);
        assert.equal(result.ok, false, `accepted ${JSON.stringify(action)} from ${String(id)}`);
        assert.equal(typeof result.error, 'string');
      }
    }
    assert.deepEqual(game.getLegalActions(undefined), []);
    assert.deepEqual(game.getLegalActions({}), []);
  });

  test('getLegalActions agrees exactly with dispatch across a long random game', () => {
    const game = new Game({ seed: 99, now: () => 0 });
    ['a', 'b', 'c'].forEach((id) => game.addPlayer({ id }));
    game.start();
    const ids = ['a', 'b', 'c'];
    const tiles = Object.keys(game.state.properties);
    const allCandidates = [
      ...['roll', 'buy', 'decline', 'endTurn', 'payJailFine', 'useJailCard', 'bankrupt'].map((type) => ({ type })),
      ...['build', 'sellHouse', 'mortgage', 'unmortgage'].flatMap((type) => tiles.map((tileId) => ({ type, tileId }))),
    ];
    const key = (a) => `${a.type}:${a.tileId || ''}`;
    for (let step = 0; step < 400 && game.state.phase !== 'gameOver'; step++) {
      for (const id of ids) {
        const legal = new Set(game.getLegalActions(id).map(key));
        const before = JSON.stringify(game.toJSON());
        for (const action of allCandidates) {
          // Legal actions run on a copy; illegal ones must fail on the real game without touching it.
          const isLegal = legal.has(key(action));
          const result = (isLegal ? Game.fromJSON(game.toJSON()) : game).dispatch(id, action);
          assert.equal(result.ok, isLegal, `${id} ${key(action)}: legal=${isLegal} dispatch=${result.ok} ${result.error || ''}`);
        }
        assert.equal(JSON.stringify(game.toJSON()), before, 'a rejected action changed the state');
      }
      const current = game.state.currentPlayerId;
      const options = game.getLegalActions(current);
      const preferred = options.filter((a) => ['buy', 'build', 'roll', 'endTurn'].includes(a.type));
      const choice = (preferred.length ? preferred : options)[step % (preferred.length || options.length)];
      act(game, current, choice.type, choice);
    }
  });
});
