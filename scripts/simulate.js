'use strict';

/**
 * Random-bot simulator for the game engine.
 *
 *   node scripts/simulate.js [games] [--games N] [--seed S] [--players K]
 *                            [--max-turns T] [--workers W]
 *
 * Plays N games (default 2000) between 2-6 bots that pick from
 * getLegalActions(), biased towards buying and building so games end. Every
 * game has its own seed, which drives both the engine and the bots, so any
 * failure can be replayed exactly with `--seed <seed> --games 1`. Games are
 * spread over worker threads (one per core by default; `--workers 1` runs
 * everything in-process, which is easier to debug).
 *
 * After every action it checks the invariants below and stops at the first
 * failure, printing the seed, the action history and the broken invariant.
 */

const os = require('node:os');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { Game, PHASE, BANK } = require('../server/game/Game');
const { createRng, randomInt } = require('../server/game/rng');
const { BOARD, MAX_BUILDINGS, TILE, JAIL_INDEX, groupMembers, getTileById } = require('../shared/board');
const { DECKS } = require('../shared/cards');

const ACTIVE = new Set([PHASE.AWAITING_ROLL, PHASE.BUY_DECISION, PHASE.AWAITING_END]);
const MAX_ACTIONS_PER_GAME = 200000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { games: 2000, seed: 1, players: null, maxTurns: 2000, workers: os.availableParallelism() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => Number(argv[++i]);
    if (arg === '--games') opts.games = next();
    else if (arg === '--seed') opts.seed = next();
    else if (arg === '--players') opts.players = next();
    else if (arg === '--max-turns') opts.maxTurns = next();
    else if (arg === '--workers') opts.workers = next();
    else if (/^\d+$/.test(arg)) opts.games = Number(arg);
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/** Relative weights for a solvent player. Buying and building keep games short. */
const WEIGHTS = {
  roll: 10, endTurn: 10, buy: 40, decline: 1, build: 40, unmortgage: 2,
  payJailFine: 3, useJailCard: 4, mortgage: 0.05, sellHouse: 0.05, bankrupt: 0,
};

/** A player in debt raises money; they only give up when nothing else is left (or rarely, by choice). */
const DEBT_WEIGHTS = { sellHouse: 5, mortgage: 5, bankrupt: 0.1 };

/**
 * Trading isn't built yet, so random buying almost never completes a colour
 * set and games stall with nobody able to build. Bots therefore skip a city
 * when an opponent already holds part of its set, leaving it for the player
 * who is collecting that set.
 */
function wantsPendingCity(state, player) {
  const tile = getTileById(state.turn.pendingTileId);
  if (tile.type !== TILE.CITY) return true;
  return groupMembers(tile.group).every((i) => {
    const owner = state.properties[BOARD[i].id].ownerId;
    return !owner || owner === player.id;
  });
}

function weightFor(action, state, player) {
  if (player.cash < 0) return DEBT_WEIGHTS[action.type] || 0;
  if (action.type === 'buy' && !wantsPendingCity(state, player)) return 0.5;
  return WEIGHTS[action.type] || 0;
}

function chooseAction(actions, player, rng, state) {
  const weighted = actions.map((a) => [a, weightFor(a, state, player)]);
  const total = weighted.reduce((t, [, w]) => t + w, 0);
  if (total === 0) return actions[randomInt(rng, actions.length)];
  let pick = rng.next() * total;
  for (const [a, w] of weighted) {
    pick -= w;
    if (pick < 0) return a;
  }
  return weighted[weighted.length - 1][0];
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

class InvariantError extends Error {}
const assert = (cond, msg) => {
  if (!cond) throw new InvariantError(msg);
};

/**
 * Independent money ledger built from events. Money only enters or leaves
 * play through the bank; a debt owed to the bank is money the bank has not
 * received yet, so it is backed out until a debtPaid event arrives.
 */
function applyToLedger(ledger, event) {
  if (event.type === 'debtIncurred') {
    if (event.to === BANK) ledger.bankIn -= event.amount;
    return;
  }
  if (event.type === 'debtForgiven' || typeof event.amount !== 'number' || !('from' in event)) return;
  if (event.from === BANK) ledger.bankOut += event.amount;
  if (event.to === BANK) ledger.bankIn += event.amount;
}

function checkMoney(state, ledger) {
  let total = state.jackpot;
  for (const p of state.players) {
    assert(Number.isInteger(p.cash), `${p.id} has non-integer cash ${p.cash}`);
    assert(p.debt.amount === Math.max(0, -p.cash), `${p.id} debt ${p.debt.amount} does not match cash ${p.cash}`);
    assert(p.cash >= 0 || p.debt.owed.length > 0, `${p.id} has negative cash but no debt`);
    total += p.cash + p.debt.amount;
  }
  assert(state.jackpot >= 0, `jackpot is negative (${state.jackpot})`);
  const expected = ledger.bankOut - ledger.bankIn;
  assert(total === expected, `money in play ${total} != bank out ${ledger.bankOut} - bank in ${ledger.bankIn} = ${expected}`);
}

function checkBuildings(state) {
  for (const tile of BOARD) {
    const prop = state.properties[tile.id];
    if (!prop) continue;
    assert(prop.buildings >= 0 && prop.buildings <= MAX_BUILDINGS, `${tile.id} has ${prop.buildings} buildings`);
    if (tile.type !== TILE.CITY) assert(prop.buildings === 0, `${tile.id} is not a city but has buildings`);
  }
  const groups = new Set(BOARD.filter((t) => t.type === TILE.CITY).map((t) => t.group));
  for (const group of groups) {
    const props = groupMembers(group).map((i) => state.properties[BOARD[i].id]);
    const counts = props.map((p) => p.buildings);
    if (Math.max(...counts) === 0) continue;
    const owner = props[0].ownerId;
    assert(owner && props.every((p) => p.ownerId === owner), `${group} has buildings but is not one owner's full set`);
    assert(props.every((p) => !p.mortgaged), `${group} has buildings and a mortgaged tile`);
    assert(Math.max(...counts) - Math.min(...counts) <= 1, `${group} is built unevenly: ${counts}`);
  }
}

function checkOwnership(state) {
  const byId = new Map(state.players.map((p) => [p.id, p]));
  assert(byId.size === state.players.length, 'duplicate player ids');
  for (const [tileId, prop] of Object.entries(state.properties)) {
    if (!prop.ownerId) {
      assert(prop.buildings === 0 && !prop.mortgaged, `unowned ${tileId} has buildings or a mortgage`);
      continue;
    }
    const owner = byId.get(prop.ownerId);
    assert(owner, `${tileId} owned by unknown player ${prop.ownerId}`);
    assert(!owner.bankrupt, `${tileId} owned by bankrupt ${owner.id}`);
  }
  for (const p of state.players.filter((x) => x.bankrupt)) {
    assert(p.cash === 0 && p.debt.owed.length === 0 && p.jailFreeCards.length === 0, `bankrupt ${p.id} still holds assets`);
  }
}

function checkTurn(state, game) {
  const live = state.players.filter((p) => !p.bankrupt);
  if (state.phase === PHASE.GAME_OVER) {
    assert(live.length === 1 && state.winnerId === live[0].id, 'game over without exactly one survivor as winner');
    return;
  }
  assert(ACTIVE.has(state.phase), `unexpected phase ${state.phase}`);
  const current = state.players.filter((p) => p.id === state.currentPlayerId);
  assert(current.length === 1, `expected one current player, found ${current.length}`);
  assert(!current[0].bankrupt, `current player ${current[0].id} is bankrupt`);
  assert(live.length >= 2, 'game still running with fewer than 2 players');
  assert(game.getLegalActions(current[0].id).length > 0, 'current player has no legal actions');
}

/** Each jail-free card is in exactly one place: its deck or one player's hand. */
function checkCards(state) {
  for (const [name, cards] of Object.entries(DECKS)) {
    const held = state.players.flatMap((p) => p.jailFreeCards.filter((c) => c.deck === name).map((c) => c.cardId));
    const all = [...state.decks[name], ...held].sort();
    const expected = cards.map((c) => c.id).sort();
    assert(JSON.stringify(all) === JSON.stringify(expected), `${name} cards lost or duplicated`);
  }
}

/** Saves, restores and returns the restored game, so play continues on the copy. */
function roundTrip(game) {
  const saved = JSON.stringify(game.toJSON());
  const restored = Game.fromJSON(JSON.parse(saved), { now: game.now });
  assert(JSON.stringify(restored.toJSON()) === saved, 'toJSON -> fromJSON does not round-trip');
  return restored;
}

function checkAll(game, ledger) {
  const state = game.state;
  checkMoney(state, ledger);
  checkBuildings(state);
  checkOwnership(state);
  checkTurn(state, game);
  checkCards(state);
  return roundTrip(game);
}

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------

function playGame(seed, opts) {
  const botRng = createRng(seed ^ 0x9e3779b9);
  const drawn = 2 + randomInt(botRng, 5); // always drawn, so --players doesn't shift the bot rng
  const playerCount = opts.players || drawn;
  let clock = 0;
  let game = new Game({ seed, now: () => ++clock });
  const ledger = { bankOut: 0, bankIn: 0 };
  const history = [];
  const landings = new Map();

  const record = (who, action, result) => {
    history.push({ turn: game.state.turnNumber, who, action, ok: result.ok, error: result.error });
    if (!result.ok) throw new InvariantError(`legal action rejected: ${result.error}`);
    for (const e of result.events) {
      applyToLedger(ledger, e);
      const landed = e.type === 'moved' ? e.to : e.type === 'sentToJail' ? JAIL_INDEX : null;
      if (landed !== null) landings.set(landed, (landings.get(landed) || 0) + 1);
    }
  };
  const act = (playerId, action) => {
    record(playerId, action, game.dispatch(playerId, action));
    game = checkAll(game, ledger);
  };

  try {
    for (let i = 0; i < playerCount; i++) record('-', { type: 'addPlayer' }, game.addPlayer({ id: `bot${i}`, name: `Bot ${i}` }));
    record('-', { type: 'start' }, game.start());
    const seats = game.state.players.map((p) => p.id);
    game = checkAll(game, ledger);

    let actions = 0;
    while (game.state.phase !== PHASE.GAME_OVER && game.state.turnNumber <= opts.maxTurns) {
      assert(++actions < MAX_ACTIONS_PER_GAME, 'too many actions: the game is stuck');
      // Players in debt sometimes sort it out on someone else's turn.
      for (const p of game.state.players) {
        if (p.id !== game.state.currentPlayerId && p.cash < 0 && !p.bankrupt && botRng.next() < 0.5) {
          act(p.id, chooseAction(game.getLegalActions(p.id), p, botRng, game.state));
        }
      }
      if (game.state.phase === PHASE.GAME_OVER) break;
      const current = game.state.players.find((p) => p.id === game.state.currentPlayerId);
      act(current.id, chooseAction(game.getLegalActions(current.id), current, botRng, game.state));
    }

    const finished = game.state.phase === PHASE.GAME_OVER;
    return {
      ok: true,
      finished,
      turns: game.state.turnNumber,
      winnerSeat: finished ? seats.indexOf(game.state.winnerId) : -1,
      playerCount,
      landings,
    };
  } catch (err) {
    // Plain data, so it survives the trip back from a worker thread.
    const error = { message: err.message, stack: err.stack, invariant: err instanceof InvariantError };
    return { ok: false, seed, playerCount, error, history };
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportFailure(f, opts) {
  const kind = f.error.invariant ? 'Invariant failed' : 'Engine threw';
  console.error(`\n✗ ${kind} in game with seed ${f.seed} (${f.playerCount} players)`);
  console.error(`  ${f.error.message}`);
  if (!f.error.invariant) console.error(f.error.stack);
  const tail = f.history.slice(-40);
  console.error(`\n  Last ${tail.length} of ${f.history.length} actions:`);
  for (const h of tail) {
    const extra = h.action.tileId ? ` ${h.action.tileId}` : '';
    console.error(`    turn ${String(h.turn).padStart(4)}  ${h.who.padEnd(5)} ${h.action.type}${extra}${h.ok ? '' : `  -> ${h.error}`}`);
  }
  console.error(`\n  Reproduce: node scripts/simulate.js --seed ${f.seed} --games 1${opts.players ? ` --players ${opts.players}` : ''}`);
}

function reportSummary(results, ms) {
  const finished = results.filter((r) => r.finished);
  const capped = results.length - finished.length;
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  console.log(`✓ ${results.length} games, every invariant held after every action (${(ms / 1000).toFixed(1)}s)`);
  console.log(`  finished: ${finished.length}   capped: ${capped}`);
  console.log(`  average turns: ${avg(finished.map((r) => r.turns)).toFixed(1)} (finished games), ${avg(results.map((r) => r.turns)).toFixed(1)} (all)`);

  console.log('\n  Win rate by seat (finished games):');
  for (let seat = 0; seat < 6; seat++) {
    const games = finished.filter((r) => r.playerCount > seat);
    if (!games.length) continue;
    const wins = games.filter((r) => r.winnerSeat === seat).length;
    const fair = avg(games.map((r) => 1 / r.playerCount));
    console.log(`    seat ${seat + 1}: ${(100 * wins / games.length).toFixed(1).padStart(5)}%  (${wins}/${games.length}, fair share ${(100 * fair).toFixed(1)}%)`);
  }

  const totals = new Map();
  for (const r of results) for (const [i, n] of r.landings) totals.set(i, (totals.get(i) || 0) + n);
  const all = [...totals.values()].reduce((a, b) => a + b, 0);
  console.log('\n  Most-landed tiles:');
  for (const [i, n] of [...totals].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${BOARD[i].name.padEnd(20)} ${(100 * n / all).toFixed(2)}%`);
  }
}

// ---------------------------------------------------------------------------
// Running games, in-process or on worker threads
// ---------------------------------------------------------------------------

/** Play the given seeds in order, stopping at the first failure. */
function runSeeds(seeds, opts) {
  const results = [];
  for (const seed of seeds) {
    const result = playGame(seed, opts);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

/**
 * Hand seeds to `count` workers one at a time from a shared queue, so a few
 * long capped games don't leave the other workers idle. Stops dealing new
 * seeds after the first failure.
 */
function runInWorkers(seeds, opts, count) {
  const queue = [...seeds];
  const results = [];
  const runWorker = () => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { opts } });
    const next = () => {
      const failed = results.some((r) => !r.ok);
      if (!queue.length || failed) {
        worker.terminate().then(resolve, reject);
        return;
      }
      worker.postMessage(queue.shift());
    };
    worker.on('message', (result) => {
      results.push(result);
      next();
    });
    worker.once('error', reject);
    next();
  });
  return Promise.all(Array.from({ length: count }, runWorker)).then(() => results);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const seeds = Array.from({ length: opts.games }, (_, i) => (opts.seed + i) >>> 0);
  const workers = Math.max(1, Math.min(opts.workers || 1, seeds.length));
  const results = workers === 1 ? runSeeds(seeds, opts) : await runInWorkers(seeds, opts, workers);

  const failures = results.filter((r) => !r.ok).sort((a, b) => a.seed - b.seed);
  if (failures.length) {
    reportFailure(failures[0], opts);
    process.exit(1);
  }
  reportSummary(results, Date.now() - started);
}

if (isMainThread) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  parentPort.on('message', (seed) => parentPort.postMessage(playGame(seed, workerData.opts)));
}
