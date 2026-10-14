'use strict';

/**
 * Tunes the hard bot's params with a (1+λ) evolution strategy.
 *
 *   node scripts/tune.js [--quick] [--generations G] [--children C] [--games N]
 *                        [--seed S] [--workers W] [--from medium|hard]
 *
 * Each generation mutates the current best params C times (every tunable
 * param is scaled by e^N(0, σ), integers rounded, values clamped). Each child
 * plays N games seated with the current best and two medium bots (seats
 * shuffled), on the same fixed seeds for every child, so they're compared on
 * identical dice. The current best plays the same seeds in the child's chair
 * as the baseline (a game that hits the turn cap counts as a win for the
 * richest player). A child that beats the baseline is then checked on a
 * separate, larger set of validation seeds before it replaces the best.
 *
 * Writes server/bots/params/hard.json and server/bots/params/tune-log.json
 * (one entry per generation). --quick finishes in a few minutes.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGames } = require('./tournament');
const { MEDIUM, HARD, HARD_FILE } = require('../server/bots/params');
const { createRng } = require('../server/game/rng');

const LOG_FILE = path.join(path.dirname(HARD_FILE), 'tune-log.json');

/** What the tuner may change, with bounds. Everything else stays as in medium. */
const TUNABLE = {
  minReserve: [0, 500, 'int'],
  reserveK: [0, 3],
  completeReserveRatio: [0, 1],
  setProgress: [0, 2],
  completeSetBonus: [0, 3],
  blockBonus: [0, 2],
  deadSetPenalty: [0, 0.8],
  rentWeight: [0, 1.5],
  airportBonus: [0, 1],
  utilityPenalty: [0, 0.8],
  earlyBonus: [0, 1],
  earlyTurns: [10, 200, 'int'],
  buyThreshold: [0.3, 1.6],
  bidFactor: [0.4, 1.6],
  bidCompleteBoost: [1, 3],
  bidBlockBoost: [1, 2.5],
  thirdHouseBonus: [0, 2],
  hotelFactor: [0.3, 1.5],
  unmortgageSlack: [1, 5],
  setKeepFactor: [1, 6],
  jailLeaveUnowned: [0, 1],
  jailDangerRent: [50, 2000, 'int'],
  acceptMargin: [-50, 300, 'int'],
  tradeSetBonus: [0, 1000, 'int'],
  setRentValue: [0, 1],
  setGiftPremium: [0.2, 3],
  mutualSetWeight: [0, 1.5],
  proposeEveryTurns: [1, 30, 'int'],
  tradeTtlTurns: [2, 20, 'int'],
  offerPremium: [0, 0.8],
  maxMissingForTrade: [1, 2, 'int'],
};

function parseArgs(argv) {
  const opts = { generations: 25, children: 8, games: 600, validate: 2000, seed: 1, workers: os.availableParallelism(), from: 'hard', sigma: 0.25 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--quick') Object.assign(opts, { generations: 6, children: 6, games: 300, validate: 800 });
    else if (arg === '--generations') opts.generations = Number(next());
    else if (arg === '--children') opts.children = Number(next());
    else if (arg === '--games') opts.games = Number(next());
    else if (arg === '--validate') opts.validate = Number(next());
    else if (arg === '--seed') opts.seed = Number(next());
    else if (arg === '--workers') opts.workers = Number(next());
    else if (arg === '--from') opts.from = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

/** A standard normal sample (Box-Muller) from our seeded rng. */
function gaussian(rng) {
  const u = 1 - rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

function mutate(params, rng, sigma) {
  const child = { ...params };
  for (const [key, [lo, hi, kind]] of Object.entries(TUNABLE)) {
    if (rng.next() < 0.5) continue; // change about half the params each time
    const base = child[key];
    // Scale positive values; nudge values near zero additively so they can leave 0.
    let value = Math.abs(base) > (hi - lo) * 0.05 ? base * Math.exp(sigma * gaussian(rng)) : base + (hi - lo) * 0.1 * sigma * gaussian(rng);
    value = Math.min(hi, Math.max(lo, value));
    child[key] = kind === 'int' ? Math.round(value) : Number(value.toFixed(3));
  }
  return child;
}

/** Win rate of `params` (label 'cand') over seeds, seated with the best and two mediums. */
async function score(params, best, seeds, opts) {
  const lineup = [{ type: 'hard', params, label: 'cand' }, { type: 'hard', params: best, label: 'best' }, 'medium', 'medium'];
  const results = await runGames(seeds.map((seed) => ({ seed, lineup, maxTurns: 600 })), opts.workers);
  // A game that hits the turn cap goes to the richest player, so stalling never pays.
  const winner = (r) => (r.winnerSeat >= 0 ? r.winnerSeat : r.worth.indexOf(Math.max(...r.worth)));
  const wins = results.filter((r) => r.labels[winner(r)] === 'cand').length;
  return wins / results.length;
}

const range = (start, n) => Array.from({ length: n }, (_, i) => (start + i) >>> 0);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const rng = createRng(opts.seed * 7919);
  const tunable = (p) => Object.fromEntries(Object.keys(TUNABLE).map((k) => [k, p[k]]));
  let best = { ...MEDIUM, ...(opts.from === 'medium' ? {} : tunable(HARD)) };
  const log = [];
  const validationSeeds = range(900000 + opts.seed, opts.validate);

  console.log(`Tuning: ${opts.generations} generations × ${opts.children} children × ${opts.games} games (validation ${opts.validate}), ${opts.workers} workers`);
  for (let gen = 1; gen <= opts.generations; gen++) {
    // Fixed seeds for this generation: every child and the baseline see the same dice.
    const seeds = range(100000 * gen + opts.seed, opts.games);
    const baseline = await score(best, best, seeds, opts);
    const children = Array.from({ length: opts.children }, () => mutate(best, rng, opts.sigma));
    const scores = [];
    for (const child of children) scores.push(await score(child, best, seeds, opts));
    const top = scores.indexOf(Math.max(...scores));
    let accepted = false;
    let validation = null;
    if (scores[top] > baseline) {
      // Confirm on held-out seeds: the child must beat the best head to head.
      validation = await score(children[top], best, validationSeeds, opts);
      const bestOnValidation = await score(best, best, validationSeeds, opts);
      validation = { child: validation, best: bestOnValidation };
      if (validation.child > validation.best) {
        best = children[top];
        accepted = true;
      }
    }
    const entry = { generation: gen, baseline, bestChild: scores[top], scores, accepted, validation, params: tunable(best) };
    log.push(entry);
    const v = validation ? ` validation ${pct(validation.child)} vs ${pct(validation.best)}` : '';
    console.log(`  gen ${String(gen).padStart(2)}: baseline ${pct(baseline)}, best child ${pct(scores[top])}${v} ${accepted ? '→ accepted' : ''}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }

  const meta = { tunedAt: new Date().toISOString(), generations: opts.generations, children: opts.children, gamesPerChild: opts.games, seed: opts.seed };
  fs.writeFileSync(HARD_FILE, `${JSON.stringify({ meta, params: tunable(best) }, null, 2)}\n`);
  fs.writeFileSync(LOG_FILE, `${JSON.stringify(log, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), HARD_FILE)} and ${path.relative(process.cwd(), LOG_FILE)} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log('Changed from medium:');
  for (const [k, value] of Object.entries(tunable(best))) if (value !== MEDIUM[k]) console.log(`  ${k.padEnd(22)} ${String(MEDIUM[k]).padStart(8)} → ${value}`);
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
