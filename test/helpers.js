'use strict';

/**
 * Shared fixtures for the engine tests. Tests reach into `game.state` to set
 * up positions and ownership directly, then drive the game only through the
 * public API with rigged dice.
 */

const assert = require('node:assert/strict');
const { Game } = require('../server/game/Game');

/** An rng stub that yields the given dice, e.g. riggedDice([3, 4], [6, 6]). Throws when it runs out. */
function riggedDice(...rolls) {
  const faces = rolls.flat();
  return {
    next() {
      if (!faces.length) throw new Error('rigged dice exhausted');
      return (faces.shift() - 0.5) / 6; // maps face f back to 1 + floor(next() * 6) === f
    },
  };
}

/**
 * A started game with players p1..pN seated in order, p1 to move, all on GO
 * with the starting cash. `dice` is a list of [d1, d2] pairs. Auctions are off
 * unless a test turns them on, so "decline" leaves a tile unowned.
 */
function setup({ players = 2, settings = {}, dice = [] } = {}) {
  const game = new Game({ settings: { auctions: false, ...settings }, seed: 42, now: () => 1000 });
  for (let i = 1; i <= players; i++) game.addPlayer({ id: `p${i}`, name: `P${i}` });
  game.start();
  game.state.players.sort((a, b) => a.id.localeCompare(b.id));
  game.state.currentPlayerId = 'p1';
  game.rng = riggedDice(...dice);
  return game;
}

const player = (game, id) => game.state.players.find((p) => p.id === id);
const prop = (game, tileId) => game.state.properties[tileId];

function rig(game, ...rolls) {
  game.rng = riggedDice(...rolls);
}

function own(game, playerId, ...tileIds) {
  for (const id of tileIds) prop(game, id).ownerId = playerId;
}

function place(game, playerId, position) {
  player(game, playerId).position = position;
}

/** Put the given cards on top of a deck, in order, keeping the rest below. */
function stackDeck(game, deck, ...cardIds) {
  const rest = game.state.decks[deck].filter((id) => !cardIds.includes(id));
  game.state.decks[deck] = [...cardIds, ...rest];
}

/** Dispatch and assert success; returns the events. */
function act(game, playerId, type, extra = {}) {
  const result = game.dispatch(playerId, { type, ...extra });
  assert.ok(result.ok, `${playerId} ${type} failed: ${result.error}`);
  return result.events;
}

/** Dispatch and assert failure; returns the error. */
function reject(game, playerId, type, extra = {}) {
  const result = game.dispatch(playerId, { type, ...extra });
  assert.equal(result.ok, false, `${playerId} ${type} should have been rejected`);
  return result.error;
}

const findEvent = (events, type) => events.find((e) => e.type === type);
const eventTypes = (events) => events.map((e) => e.type);

/** Money in play: negative cash is an IOU, not money. */
function totalMoney(game) {
  return game.state.players.reduce((t, p) => t + Math.max(0, p.cash), 0) + game.state.jackpot;
}

module.exports = {
  riggedDice, setup, player, prop, rig, own, place, stackDeck, act, reject, findEvent, eventTypes, totalMoney,
};
