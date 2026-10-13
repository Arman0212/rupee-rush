'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setup, player, prop, own, place, stackDeck, act, findEvent, eventTypes, totalMoney } = require('./helpers');

// Card tiles: Surprise at 7, 22, 36 and Treasure at 2, 17, 33.

/** p1 rolls from `from` onto a card tile with `card` on top of `deck`. */
function draw({ deck, card, from, dice = [[1, 2]], players = 2, settings, prepare = () => {} }) {
  const game = setup({ players, settings, dice });
  place(game, 'p1', from);
  stackDeck(game, deck, card);
  prepare(game);
  const before = totalMoney(game);
  const events = act(game, 'p1', 'roll');
  assert.equal(findEvent(events, 'cardDrawn').cardId, card);
  return { game, events, before };
}

describe('money cards', () => {
  test('collect: the bank pays the player', () => {
    const { game } = draw({ deck: 'treasure', card: 't-bankerror', from: 14 });
    assert.equal(player(game, 'p1').cash, 1700);
  });

  test('pay: the player pays the bank', () => {
    const { game, events } = draw({ deck: 'treasure', card: 't-doctor', from: 14 });
    assert.equal(player(game, 'p1').cash, 1450);
    assert.equal(findEvent(events, 'moneyPaid').to, null);
    assert.equal(game.state.jackpot, 0);
  });

  test('collectFromEach: every other player pays the player', () => {
    const { game, before } = draw({ deck: 'treasure', card: 't-birthday', from: 14, players: 3 });
    assert.deepEqual(game.state.players.map((p) => p.cash), [1520, 1490, 1490]);
    assert.equal(totalMoney(game), before);
  });

  test('payEach: the player pays every other player', () => {
    const { game, before } = draw({ deck: 'surprise', card: 's-chairman', from: 4, players: 4 });
    assert.deepEqual(game.state.players.map((p) => p.cash), [1350, 1550, 1550, 1550]);
    assert.equal(totalMoney(game), before);
  });

  test('payEach and collectFromEach skip bankrupt players', () => {
    const { game } = draw({
      deck: 'surprise', card: 's-chairman', from: 4, players: 3,
      prepare: (g) => { Object.assign(player(g, 'p3'), { bankrupt: true, cash: 0 }); },
    });
    assert.deepEqual(game.state.players.map((p) => p.cash), [1450, 1550, 0]);
  });

  test('repairs: pay per house and per hotel', () => {
    const { game } = draw({
      deck: 'surprise', card: 's-repairs', from: 4,
      prepare: (g) => {
        own(g, 'p1', 'salvador', 'rio');
        prop(g, 'salvador').buildings = 5; // a hotel: ₹100
        prop(g, 'rio').buildings = 4; // four houses: 4 × ₹25
      },
    });
    assert.equal(player(game, 'p1').cash, 1300);
  });
});

describe('movement cards', () => {
  test('moveTo: advance, collecting GO salary when passing it, then resolve the tile', () => {
    const { game, events } = draw({ deck: 'surprise', card: 's-venice', from: 19 }); // 22 -> 11
    assert.equal(player(game, 'p1').position, 11);
    assert.equal(findEvent(events, 'moneyCollected').reason, 'goSalary');
    assert.equal(player(game, 'p1').cash, 1700);
    assert.equal(game.state.phase, 'buyDecision');
    assert.equal(game.state.turn.pendingTileId, 'venice');
  });

  test('moveTo GO pays the salary exactly once', () => {
    const { game, events } = draw({ deck: 'treasure', card: 't-go', from: 14 });
    assert.equal(player(game, 'p1').position, 0);
    assert.equal(events.filter((e) => e.type === 'moneyCollected').length, 1);
    assert.equal(player(game, 'p1').cash, 1700);
  });

  test('moveTo without passing GO pays no salary and charges rent', () => {
    const { game, events } = draw({ deck: 'surprise', card: 's-new-york', from: 32, dice: [[1, 3]], prepare: (g) => own(g, 'p2', 'new-york') });
    assert.equal(findEvent(events, 'moneyCollected'), undefined);
    assert.equal(findEvent(events, 'rentPaid').amount, 50);
  });

  test('moveBy backwards never pays GO and resolves the new tile', () => {
    const { game, events } = draw({ deck: 'surprise', card: 's-back3', from: 4 }); // 7 -> 4 Income Tax
    assert.equal(player(game, 'p1').position, 4);
    assert.equal(findEvent(events, 'taxPaid').amount, 200);
    assert.equal(findEvent(events, 'moneyCollected'), undefined);
    assert.equal(player(game, 'p1').cash, 1300);
  });

  test('moveBy can land on another card tile and draw again', () => {
    const { game, events } = draw({
      deck: 'surprise', card: 's-back3', from: 32, dice: [[1, 3]],
      prepare: (g) => stackDeck(g, 'treasure', 't-refund'),
    }); // 36 -> 33 Treasure
    assert.deepEqual(events.filter((e) => e.type === 'cardDrawn').map((e) => e.cardId), ['s-back3', 't-refund']);
    assert.equal(player(game, 'p1').cash, 1520);
  });

  test('goToJail: straight to jail, no salary, and doubles give no extra roll', () => {
    const { game, events } = draw({ deck: 'surprise', card: 's-jail', from: 3, dice: [[2, 2]] });
    const p1 = player(game, 'p1');
    assert.equal(p1.inJail, true);
    assert.equal(p1.position, 10);
    assert.equal(findEvent(events, 'sentToJail').reason, 'card');
    assert.equal(findEvent(events, 'moneyCollected'), undefined);
    assert.equal(game.state.phase, 'awaitingEnd');
  });

  test('jailFree: the card stays in the player\'s hand, out of the deck', () => {
    const { game } = draw({ deck: 'surprise', card: 's-jailfree', from: 4 });
    assert.deepEqual(player(game, 'p1').jailFreeCards, [{ deck: 'surprise', cardId: 's-jailfree' }]);
    assert.equal(game.state.decks.surprise.length, 15);
    assert.ok(!game.state.decks.surprise.includes('s-jailfree'));
  });

  test('other cards go to the bottom of their deck after use', () => {
    const { game } = draw({ deck: 'treasure', card: 't-fd', from: 14 });
    assert.equal(game.state.decks.treasure.at(-1), 't-fd');
    assert.equal(game.state.decks.treasure.length, 16);
    assert.deepEqual(game.state.lastCard, { deck: 'treasure', cardId: 't-fd', playerId: 'p1' });
  });
});

describe('nearest airport / utility', () => {
  test('nearest airport charges double rent', () => {
    const { events } = draw({ deck: 'surprise', card: 's-airport-1', from: 4, prepare: (g) => own(g, 'p2', 'muc-airport') });
    const rent = findEvent(events, 'rentPaid');
    assert.equal(rent.tileId, 'muc-airport');
    assert.equal(rent.amount, 50); // 25 × 2
  });

  test('nearest airport doubles the rent for several airports too', () => {
    const { events } = draw({
      deck: 'surprise', card: 's-airport-2', from: 4,
      prepare: (g) => own(g, 'p2', 'muc-airport', 'jfk-airport', 'tlv-airport'),
    });
    assert.equal(findEvent(events, 'rentPaid').amount, 200); // 100 × 2
  });

  test('nearest airport wraps past GO and pays the salary', () => {
    const { game, events } = draw({ deck: 'surprise', card: 's-airport-1', from: 32, dice: [[1, 3]] }); // 36 -> 5
    assert.equal(player(game, 'p1').position, 5);
    assert.equal(findEvent(events, 'moneyCollected').reason, 'goSalary');
    assert.equal(game.state.phase, 'buyDecision');
  });

  test('nearest utility rolls fresh dice and charges 10x, even for one utility', () => {
    const { game, events } = draw({
      deck: 'surprise', card: 's-utility', from: 4, dice: [[1, 2], [3, 4]],
      prepare: (g) => own(g, 'p2', 'electric-company'),
    });
    const rolls = events.filter((e) => e.type === 'diceRolled');
    assert.deepEqual(rolls.map((r) => r.reason), ['move', 'utilityCard']);
    assert.equal(findEvent(events, 'rentPaid').amount, 70);
    assert.deepEqual(game.state.turn.dice, [1, 2]); // the fresh roll does not replace the move roll
  });

  test('nearest utility, unowned: offered for sale, no extra dice', () => {
    const { game, events } = draw({ deck: 'surprise', card: 's-utility', from: 4 }); // rigged dice would throw if rolled
    assert.equal(game.state.turn.pendingTileId, 'electric-company');
    assert.deepEqual(eventTypes(events).filter((t) => t === 'diceRolled'), ['diceRolled']);
  });
});

describe('fines and the jackpot', () => {
  test('card fines go to the jackpot when vacationJackpot is on', () => {
    const { game, events } = draw({ deck: 'treasure', card: 't-doctor', from: 14, settings: { vacationJackpot: true } });
    assert.equal(game.state.jackpot, 50);
    assert.equal(findEvent(events, 'moneyPaid').to, 'jackpot');
  });

  test('repairs also feed the jackpot', () => {
    const { game } = draw({
      deck: 'surprise', card: 's-repairs', from: 4, settings: { vacationJackpot: true },
      prepare: (g) => { own(g, 'p1', 'salvador', 'rio'); prop(g, 'salvador').buildings = 1; prop(g, 'rio').buildings = 1; },
    });
    assert.equal(game.state.jackpot, 50);
  });
});
