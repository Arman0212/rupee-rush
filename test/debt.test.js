'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');
const { setup, player, prop, own, place, rig, stackDeck, act, reject, findEvent, eventTypes, totalMoney } = require('./helpers');

const debtOf = (game, id) => {
  const { amount, creditorId } = player(game, id).debt;
  return { amount, creditorId };
};

/** p1 lands on Beijing (p2, two houses: ₹250 rent) holding only `cash`. */
function owesRent({ cash = 10, players = 2, dice = [1, 2] } = {}) {
  const game = setup({ players, dice: [dice] });
  own(game, 'p2', 'shenzhen', 'beijing', 'shanghai');
  prop(game, 'beijing').buildings = 2;
  prop(game, 'shenzhen').buildings = 2;
  prop(game, 'shanghai').buildings = 2;
  place(game, 'p1', 23 - dice[0] - dice[1]);
  player(game, 'p1').cash = cash;
  const before = totalMoney(game);
  const events = act(game, 'p1', 'roll');
  return { game, events, before };
}

describe('debt', () => {
  test('a payment larger than your cash pays what you have and records the rest as debt', () => {
    const { game, events, before } = owesRent();
    assert.equal(player(game, 'p1').cash, -240);
    assert.equal(player(game, 'p2').cash, 1510);
    assert.deepEqual(debtOf(game, 'p1'), { amount: 240, creditorId: 'p2' });
    assert.deepEqual(eventTypes(events).slice(-2), ['rentPaid', 'debtIncurred']);
    assert.equal(totalMoney(game), before);
  });

  test('debt blocks endTurn', () => {
    const { game } = owesRent();
    assert.equal(reject(game, 'p1', 'endTurn'), 'clear your debt first');
    assert.deepEqual(game.getLegalActions('p1'), [{ type: 'bankrupt' }]);
  });

  test('debt blocks the extra roll from doubles', () => {
    const { game } = owesRent({ dice: [1, 1] });
    assert.equal(game.state.phase, 'awaitingRoll');
    assert.equal(reject(game, 'p1', 'roll'), 'clear your debt first');
  });

  test('selling and mortgaging pay the creditor directly', () => {
    const { game, before } = owesRent();
    own(game, 'p1', 'salvador', 'rio', 'new-york');
    prop(game, 'salvador').buildings = 1;
    prop(game, 'rio').buildings = 1;
    act(game, 'p1', 'sellHouse', { tileId: 'salvador' }); // +25
    assert.equal(player(game, 'p2').cash, 1535);
    assert.deepEqual(debtOf(game, 'p1'), { amount: 215, creditorId: 'p2' });
    const events = act(game, 'p1', 'mortgage', { tileId: 'new-york' }); // +200
    assert.deepEqual(eventTypes(events), ['mortgaged', 'debtPaid']);
    assert.equal(player(game, 'p1').cash, -15);
    assert.equal(player(game, 'p2').cash, 1735);
    assert.equal(totalMoney(game), before + 25 + 200);
  });

  test('clearing the debt keeps any surplus and allows endTurn again', () => {
    const { game } = owesRent({ cash: 100 });
    own(game, 'p1', 'new-york');
    const events = act(game, 'p1', 'mortgage', { tileId: 'new-york' }); // +200 against 150 owed
    assert.ok(eventTypes(events).includes('debtCleared'));
    assert.equal(player(game, 'p1').cash, 50);
    assert.equal(player(game, 'p2').cash, 1750);
    assert.deepEqual(debtOf(game, 'p1'), { amount: 0, creditorId: null });
    act(game, 'p1', 'endTurn');
  });

  test('a debt to the bank has a null creditor', () => {
    const game = setup({ dice: [[1, 3]] });
    player(game, 'p1').cash = 50;
    act(game, 'p1', 'roll'); // 0 -> 4 Income Tax, ₹200
    assert.deepEqual(debtOf(game, 'p1'), { amount: 150, creditorId: null });
  });

  test('a debt from someone else\'s turn can be settled out of turn, but not by building', () => {
    const game = setup({ players: 3, dice: [[1, 2]] });
    place(game, 'p1', 14);
    stackDeck(game, 'treasure', 't-birthday');
    player(game, 'p2').cash = 4;
    own(game, 'p2', 'new-york', 'california');
    act(game, 'p1', 'roll');
    assert.deepEqual(debtOf(game, 'p2'), { amount: 6, creditorId: 'p1' });
    const p2Legal = game.getLegalActions('p2').map((a) => a.type);
    assert.deepEqual([...new Set(p2Legal)], ['bankrupt', 'mortgage']);
    assert.equal(reject(game, 'p2', 'build', { tileId: 'new-york' }), 'not your turn');
    act(game, 'p2', 'mortgage', { tileId: 'new-york' });
    assert.equal(player(game, 'p2').cash, 194);
    assert.equal(player(game, 'p1').cash, 1500 + 10 + 10);
  });

  test('money received while in debt goes to the creditor first', () => {
    const game = setup({ dice: [[1, 3]] });
    Object.assign(player(game, 'p2'), { cash: -100 });
    player(game, 'p2').debt = { amount: 100, creditorId: null, owed: [{ creditorId: null, amount: 100 }] };
    own(game, 'p2', 'shenzhen'); // rent 18
    place(game, 'p1', 17);
    act(game, 'p1', 'roll'); // 17 -> 21 Shenzhen
    assert.equal(player(game, 'p2').cash, -82);
    assert.deepEqual(debtOf(game, 'p2'), { amount: 82, creditorId: null });
  });

  test('you can only declare bankruptcy while in debt', () => {
    const game = setup();
    assert.equal(reject(game, 'p1', 'bankrupt'), 'you can only declare bankruptcy while in debt');
  });
});

describe('bankruptcy', () => {
  test('to a player: buildings sell at half value, cash, property and cards pass to the creditor', () => {
    const { game, before } = owesRent({ players: 3 });
    own(game, 'p1', 'salvador', 'rio', 'tel-aviv');
    prop(game, 'salvador').buildings = 2;
    prop(game, 'rio').buildings = 2; // 4 houses × ₹25 back = ₹100
    prop(game, 'tel-aviv').mortgaged = true;
    player(game, 'p1').jailFreeCards.push({ deck: 'surprise', cardId: 's-jailfree' });

    const events = act(game, 'p1', 'bankrupt');
    const [p1, p2] = [player(game, 'p1'), player(game, 'p2')];
    assert.equal(findEvent(events, 'bankrupt').creditorId, 'p2');
    assert.equal(p1.bankrupt, true);
    assert.equal(p1.cash, 0);
    assert.deepEqual(debtOf(game, 'p1'), { amount: 0, creditorId: null });
    assert.equal(p2.cash, 1510 + 100);
    for (const id of ['salvador', 'rio', 'tel-aviv']) assert.equal(prop(game, id).ownerId, 'p2');
    assert.equal(prop(game, 'salvador').buildings, 0);
    assert.equal(prop(game, 'tel-aviv').mortgaged, true);
    assert.deepEqual(p2.jailFreeCards, [{ deck: 'surprise', cardId: 's-jailfree' }]);
    assert.equal(totalMoney(game), before + 100);
    // The turn passes on to the next live player.
    assert.equal(game.state.currentPlayerId, 'p2');
    assert.equal(game.state.phase, 'awaitingRoll');
  });

  test('to a player: leftover cash after selling buildings goes to the creditor', () => {
    const { game } = owesRent({ players: 3, cash: 200 }); // owes 50
    own(game, 'p1', 'salvador', 'rio');
    prop(game, 'salvador').buildings = 4;
    prop(game, 'rio').buildings = 4; // ₹200 back: 50 clears the debt, 150 left over
    act(game, 'p1', 'bankrupt');
    assert.equal(player(game, 'p2').cash, 1500 + 250 + 150);
  });

  test('to the bank: property returns unowned and unmortgaged, buildings vanish, cards go back', () => {
    const game = setup({ players: 3, dice: [[1, 3]] });
    player(game, 'p1').cash = 50;
    own(game, 'p1', 'salvador', 'rio', 'tel-aviv');
    prop(game, 'salvador').buildings = 1;
    prop(game, 'rio').buildings = 1;
    prop(game, 'tel-aviv').mortgaged = true;
    game.state.decks.treasure = game.state.decks.treasure.filter((id) => id !== 't-jailfree');
    player(game, 'p1').jailFreeCards.push({ deck: 'treasure', cardId: 't-jailfree' });
    act(game, 'p1', 'roll'); // Income Tax: owes the bank 150
    const before = totalMoney(game);

    const events = act(game, 'p1', 'bankrupt');
    assert.equal(findEvent(events, 'bankrupt').creditorId, null);
    for (const id of ['salvador', 'rio', 'tel-aviv']) {
      assert.deepEqual(prop(game, id), { ownerId: null, buildings: 0, mortgaged: false });
    }
    assert.equal(game.state.decks.treasure.at(-1), 't-jailfree');
    assert.equal(totalMoney(game), before);
    assert.equal(game.state.currentPlayerId, 'p2');
  });

  test('debts owed to a bankrupt player are forgiven', () => {
    const game = setup({ players: 3 });
    Object.assign(player(game, 'p3'), { cash: -30 });
    player(game, 'p3').debt = { amount: 30, creditorId: 'p2', owed: [{ creditorId: 'p2', amount: 30 }] };
    game.removePlayer('p2');
    assert.equal(player(game, 'p3').cash, 0);
    assert.deepEqual(debtOf(game, 'p3'), { amount: 0, creditorId: null });
  });

  test('the game ends when one player is left', () => {
    const { game } = owesRent();
    const events = act(game, 'p1', 'bankrupt');
    assert.deepEqual(findEvent(events, 'gameOver'), { type: 'gameOver', winnerId: 'p2', at: 1000 });
    assert.equal(game.state.phase, 'gameOver');
    assert.equal(game.state.winnerId, 'p2');
    assert.equal(game.state.currentPlayerId, null);
    assert.equal(reject(game, 'p2', 'roll'), 'game is over');
    assert.deepEqual(game.getLegalActions('p2'), []);
  });

  test('bankrupt players are skipped in turn order and cannot act', () => {
    const { game } = owesRent({ players: 3 });
    act(game, 'p1', 'bankrupt');
    rig(game, [4, 6], [4, 6]);
    place(game, 'p2', 0);
    place(game, 'p3', 0);
    for (const id of ['p2', 'p3']) {
      assert.equal(game.state.currentPlayerId, id);
      act(game, id, 'roll'); // 0 -> 10, just visiting
      act(game, id, 'endTurn');
    }
    assert.equal(game.state.currentPlayerId, 'p2');
    assert.equal(reject(game, 'p1', 'roll'), 'you are bankrupt');
  });
});

describe('removePlayer', () => {
  test('in the lobby it simply removes the player', () => {
    const game = new Game({ seed: 1 });
    game.addPlayer({ id: 'a' });
    game.addPlayer({ id: 'b' });
    assert.ok(game.removePlayer('a').ok);
    assert.deepEqual(game.state.players.map((p) => p.id), ['b']);
    assert.equal(game.removePlayer('zzz').error, 'unknown player');
  });

  test('mid-turn it is bankruptcy to the bank and the turn passes on', () => {
    const game = setup({ players: 3, dice: [[2, 4]] });
    own(game, 'p1', 'salvador');
    act(game, 'p1', 'roll'); // buyDecision on Tel Aviv
    const { ok, events } = game.removePlayer('p1');
    assert.ok(ok);
    assert.deepEqual(eventTypes(events), ['playerLeft', 'propertyReturned', 'moneyPaid', 'bankrupt', 'turnStarted']);
    assert.equal(player(game, 'p1').left, true);
    assert.equal(player(game, 'p1').bankrupt, true);
    assert.equal(prop(game, 'salvador').ownerId, null);
    assert.equal(game.state.currentPlayerId, 'p2');
    assert.equal(game.state.phase, 'awaitingRoll');
    assert.equal(game.state.turn.pendingTileId, null);
  });

  test('always goes to the bank, even when the leaver owes a player', () => {
    const { game } = owesRent({ players: 3 });
    own(game, 'p1', 'salvador');
    game.removePlayer('p1');
    assert.equal(prop(game, 'salvador').ownerId, null);
  });

  test('a player who is not on turn leaving does not disturb the turn', () => {
    const game = setup({ players: 3, dice: [[2, 4]] });
    act(game, 'p1', 'roll');
    game.removePlayer('p2');
    assert.equal(game.state.currentPlayerId, 'p1');
    assert.equal(game.state.phase, 'buyDecision');
    act(game, 'p1', 'decline');
    act(game, 'p1', 'endTurn');
    assert.equal(game.state.currentPlayerId, 'p3');
  });

  test('leaving a two-player game ends it', () => {
    const game = setup();
    game.removePlayer('p2');
    assert.equal(game.state.phase, 'gameOver');
    assert.equal(game.state.winnerId, 'p1');
  });
});

describe('vacation jackpot', () => {
  test('taxes feed the jackpot when the setting is on, and Vacation collects it', () => {
    const game = setup({ settings: { vacationJackpot: true }, dice: [[1, 3]] });
    act(game, 'p1', 'roll'); // Income Tax ₹200
    assert.equal(game.state.jackpot, 200);
    act(game, 'p1', 'endTurn');
    place(game, 'p2', 15);
    rig(game, [2, 3]);
    const events = act(game, 'p2', 'roll'); // 15 -> 20 Vacation
    assert.deepEqual(findEvent(events, 'jackpotCollected'), { type: 'jackpotCollected', from: 'jackpot', to: 'p2', amount: 200, at: 1000 });
    assert.equal(player(game, 'p2').cash, 1700);
    assert.equal(game.state.jackpot, 0);
  });

  test('taxes go to the bank when the setting is off', () => {
    const game = setup({ dice: [[1, 3]] });
    act(game, 'p1', 'roll');
    assert.equal(game.state.jackpot, 0);
    assert.equal(player(game, 'p1').cash, 1300);
  });

  test('an empty jackpot pays nothing', () => {
    const game = setup({ settings: { vacationJackpot: true }, dice: [[5, 5]] });
    place(game, 'p1', 10);
    const events = act(game, 'p1', 'roll');
    assert.equal(findEvent(events, 'jackpotCollected'), undefined);
  });

  test('the jail fine goes to the bank, not the jackpot', () => {
    const game = setup({ settings: { vacationJackpot: true } });
    Object.assign(player(game, 'p1'), { inJail: true, position: 10 });
    act(game, 'p1', 'payJailFine');
    assert.equal(game.state.jackpot, 0);
  });

  test('an unpaid tax owed to the jackpot is paid into the jackpot later', () => {
    const game = setup({ settings: { vacationJackpot: true }, dice: [[1, 3]] });
    player(game, 'p1').cash = 50;
    own(game, 'p1', 'new-york');
    act(game, 'p1', 'roll');
    assert.equal(game.state.jackpot, 50);
    assert.deepEqual(debtOf(game, 'p1'), { amount: 150, creditorId: 'jackpot' });
    act(game, 'p1', 'mortgage', { tileId: 'new-york' });
    assert.equal(game.state.jackpot, 200);
    assert.equal(player(game, 'p1').cash, 50);
  });
});
