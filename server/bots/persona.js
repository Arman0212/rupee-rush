'use strict';

/** Names and the occasional chat line for computer players. */

const BOT_NAMES = ['Aria', 'Kabir', 'Meera', 'Ravi', 'Zoya', 'Tara', 'Dev', 'Ishan', 'Noor', 'Arjun', 'Leela', 'Vikram'];

const LINES = {
  completedSet: ['That set is mine now.', 'Full set! Time to build.', 'Collected the whole set. Watch your step.', 'All three. Lovely.'],
  bankrupt: ['I’m out. Good game, everyone!', 'Bankrupt. Well played.', 'That’s me done. GG!'],
  won: ['GG! That was fun.', 'Victory! Thanks for the game.', 'Well played, all. Rematch?'],
};

/** A bot name (without the "Bot " prefix) not already in `taken` (lower-case full names), chosen with `random`. */
function pickBotName(taken, random = Math.random) {
  const free = BOT_NAMES.filter((n) => !taken.has(`bot ${n}`.toLowerCase()));
  const pool = free.length ? free : BOT_NAMES;
  return `Bot ${pool[Math.floor(random() * pool.length)]}`;
}

function pickLine(kind, random = Math.random) {
  const lines = LINES[kind];
  return lines[Math.floor(random() * lines.length)];
}

module.exports = { BOT_NAMES, LINES, pickBotName, pickLine };
