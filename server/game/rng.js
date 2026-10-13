'use strict';

/**
 * Small seeded PRNG for the game engine.
 *
 * The engine only ever calls `rng.next()` (a float in [0, 1)), so tests can
 * swap in a stub that returns rigged dice. The real generator is mulberry32:
 * a 32-bit state, fast, and good enough for dice and card shuffles. Its whole
 * state is a single integer, which makes saving and restoring a game trivial.
 */

/** Create a mulberry32 generator. `seed` is coerced to an unsigned 32-bit int. */
function createRng(seed) {
  const initial = seed >>> 0;
  let state = initial;
  return {
    seed: initial,
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    getState() {
      return state;
    },
    setState(s) {
      state = s >>> 0;
    },
  };
}

/** A fresh, non-deterministic seed, for games where the caller doesn't pick one. */
function randomSeed() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/** Integer in [0, n) drawn from any object with a `next()` method. */
function randomInt(rng, n) {
  return Math.floor(rng.next() * n);
}

/** In-place Fisher-Yates shuffle. Returns the same array for convenience. */
function shuffle(rng, array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

module.exports = { createRng, randomSeed, randomInt, shuffle };
