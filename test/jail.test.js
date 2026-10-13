'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setup, player, place, act, reject, findEvent, eventTypes } = require('./helpers');

/** p1 starts their turn in jail. */
function jailed(dice, { jailTurns = 0, cash } = {}) {
  const game = setup({ dice });
  const p1 = player(game, 'p1');
  Object.assign(p1, { position: 10, inJail: true, jailTurns });
  if (cash !== undefined) p1.cash = cash;
  return game;
}

describe('going to jail', () => {
  test('the Go to Jail tile sends you to jail without GO salary and ends doubles', () => {
    const game = setup({ dice: [[2, 2]] });
    place(game, 'p1', 26);
    const events = act(game, 'p1', 'roll'); // 26 -> 30 Go to Jail
    const p1 = player(game, 'p1');
    assert.equal(p1.position, 10);
    assert.equal(p1.inJail, true);
    assert.equal(findEvent(events, 'sentToJail').reason, 'goToJail');
    assert.equal(findEvent(events, 'moneyCollected'), undefined);
    assert.equal(game.state.phase, 'awaitingEnd'); // the double gives no extra roll
  });

  test('landing on the Jail tile is just visiting', () => {
    const game = setup({ dice: [[3, 3]] });
    place(game, 'p1', 4);
    act(game, 'p1', 'roll');
    assert.equal(player(game, 'p1').inJail, false);
    assert.equal(game.state.phase, 'awaitingRoll');
  });
});

describe('getting out', () => {
  test('jail options are offered only in jail and before rolling', () => {
    const game = jailed([[1, 2]]);
    player(game, 'p1').jailFreeCards.push({ deck: 'surprise', cardId: 's-jailfree' });
    assert.deepEqual(game.getLegalActions('p1').map((a) => a.type), ['roll', 'payJailFine', 'useJailCard']);
    act(game, 'p1', 'roll'); // fails
    assert.equal(reject(game, 'p1', 'payJailFine'), 'not allowed during awaitingEnd');
    const free = setup();
    assert.equal(reject(free, 'p1', 'payJailFine'), 'you are not in jail');
    assert.equal(reject(free, 'p1', 'useJailCard'), 'you are not in jail');
  });

  test('paying the fine releases you and you then roll normally (doubles included)', () => {
    const game = jailed([[3, 3]]);
    const events = act(game, 'p1', 'payJailFine');
    assert.deepEqual(eventTypes(events), ['moneyPaid', 'leftJail']);
    assert.equal(player(game, 'p1').cash, 1450);
    assert.equal(player(game, 'p1').inJail, false);
    assert.equal(game.state.phase, 'awaitingRoll');
    act(game, 'p1', 'roll'); // 10 -> 16 Surat, and a double earns another roll
    assert.equal(player(game, 'p1').position, 16);
    act(game, 'p1', 'decline');
    assert.equal(game.state.phase, 'awaitingRoll');
  });

  test('you cannot pay the fine without the cash', () => {
    const game = jailed([], { cash: 49 });
    assert.equal(reject(game, 'p1', 'payJailFine'), 'not enough cash');
  });

  test('a jail-free card releases you and goes back to the bottom of its deck', () => {
    const game = jailed([]);
    game.state.decks.treasure = game.state.decks.treasure.filter((id) => id !== 't-jailfree');
    player(game, 'p1').jailFreeCards.push({ deck: 'treasure', cardId: 't-jailfree' });
    assert.equal(reject(game, 'p2', 'useJailCard'), 'not your turn');
    act(game, 'p1', 'useJailCard');
    assert.equal(player(game, 'p1').inJail, false);
    assert.deepEqual(player(game, 'p1').jailFreeCards, []);
    assert.equal(game.state.decks.treasure.at(-1), 't-jailfree');
    assert.equal(game.state.decks.treasure.length, 16);
  });

  test('you need a card to use one', () => {
    const game = jailed([]);
    assert.equal(reject(game, 'p1', 'useJailCard'), 'you have no jail-free card');
  });

  test('rolling doubles releases you and moves you, with no extra roll', () => {
    const game = jailed([[2, 2]]);
    const events = act(game, 'p1', 'roll');
    assert.equal(findEvent(events, 'leftJail').method, 'doubles');
    assert.equal(player(game, 'p1').position, 14); // Chandigarh
    act(game, 'p1', 'decline');
    assert.equal(game.state.phase, 'awaitingEnd');
    assert.equal(player(game, 'p1').cash, 1500);
  });

  test('a failed roll keeps you in jail and counts the attempt', () => {
    const game = jailed([[1, 2]]);
    const events = act(game, 'p1', 'roll');
    assert.deepEqual(eventTypes(events), ['diceRolled', 'jailRollFailed']);
    assert.equal(player(game, 'p1').jailTurns, 1);
    assert.equal(player(game, 'p1').position, 10);
    assert.equal(game.state.phase, 'awaitingEnd');
  });

  test('the third failed roll forces the fine and moves you by that roll', () => {
    const game = jailed([[1, 2]], { jailTurns: 2 });
    const events = act(game, 'p1', 'roll');
    assert.equal(findEvent(events, 'moneyPaid').reason, 'jailFine');
    assert.equal(findEvent(events, 'leftJail').method, 'forced');
    assert.equal(player(game, 'p1').cash, 1450);
    assert.equal(player(game, 'p1').position, 13); // Kochi
    assert.equal(game.state.phase, 'buyDecision');
  });

  test('the forced fine can push you into debt to the bank', () => {
    const game = jailed([[1, 3]], { jailTurns: 2, cash: 20 });
    act(game, 'p1', 'roll'); // 10 -> 14 Chandigarh
    const p1 = player(game, 'p1');
    assert.equal(p1.cash, -30);
    assert.deepEqual({ amount: p1.debt.amount, creditorId: p1.debt.creditorId }, { amount: 30, creditorId: null });
    assert.equal(p1.position, 14);
    act(game, 'p1', 'decline');
    assert.equal(reject(game, 'p1', 'endTurn'), 'clear your debt first');
  });

  test('jail attempts reset once you are out', () => {
    const game = jailed([[1, 2]], { jailTurns: 2 });
    act(game, 'p1', 'roll');
    assert.equal(player(game, 'p1').jailTurns, 0);
    assert.equal(player(game, 'p1').inJail, false);
  });
});
