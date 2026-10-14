'use strict';

/**
 * Bot tournament.
 *
 *   node scripts/tournament.js [--games N] [--seed S] [--lineup random,easy,medium,hard]
 *                              [--max-turns T] [--workers W]
 *
 * Plays N games (default 1000). Every game seats the lineup (default one bot
 * of each type) in a random order, so no type gets the first-move advantage.
 * Reports, per bot type: win rate with a 95% confidence interval, average
 * final net worth and how often it completed a colour set; and overall: the
 * share of games that finished before the turn cap and their average length.
 *
 * Also exports runGames() for scripts/tune.js.
 */

const os = require('node:os');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const { playBotGame } = require('../server/bots/arena');
const { createRng, randomInt } = require('../server/game/rng');

function parseArgs(argv) {
  const opts = { games: 1000, seed: 1, lineup: ['random', 'easy', 'medium', 'hard'], maxTurns: 1000, workers: os.availableParallelism() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--games') opts.games = Number(next());
    else if (arg === '--seed') opts.seed = Number(next());
    else if (arg === '--lineup') opts.lineup = next().split(',');
    else if (arg === '--max-turns') opts.maxTurns = Number(next());
    else if (arg === '--workers') opts.workers = Number(next());
    else if (/^\d+$/.test(arg)) opts.games = Number(arg);
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

/** Seat the lineup in a random order decided by the game's seed. */
function seatsFor(seed, lineup) {
  const rng = createRng((seed ^ 0x2545f491) >>> 0);
  const seats = lineup.map((s) => (typeof s === 'string' ? { type: s } : s));
  for (let i = seats.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    [seats[i], seats[j]] = [seats[j], seats[i]];
  }
  return seats;
}

function playJob(job) {
  const seats = seatsFor(job.seed, job.lineup);
  try {
    const result = playBotGame({ seed: job.seed, seats, maxTurns: job.maxTurns, settings: job.settings });
    return { ok: true, seed: job.seed, labels: seats.map((s) => s.label || s.type), ...result };
  } catch (err) {
    return { ok: false, seed: job.seed, error: err.stack || err.message };
  }
}

/**
 * Play jobs ({ seed, lineup, maxTurns, settings? }; lineup entries are type
 * names or { type, params, label }) on `workers` threads. Resolves to results
 * in job order. Throws on the first failed game.
 */
function runGames(jobs, workers = os.availableParallelism()) {
  const count = Math.max(1, Math.min(workers, jobs.length));
  if (count === 1) return Promise.resolve(jobs.map(playJob)).then(checkResults);
  const results = new Array(jobs.length);
  let nextJob = 0;
  const runWorker = () => new Promise((resolve, reject) => {
    const worker = new Worker(__filename);
    const feed = () => {
      if (nextJob >= jobs.length) {
        worker.terminate().then(resolve, reject);
        return;
      }
      const index = nextJob++;
      worker.postMessage({ index, job: jobs[index] });
    };
    worker.on('message', ({ index, result }) => {
      results[index] = result;
      feed();
    });
    worker.once('error', reject);
    feed();
  });
  return Promise.all(Array.from({ length: count }, runWorker)).then(() => checkResults(results));
}

function checkResults(results) {
  const failed = results.find((r) => !r.ok);
  if (failed) throw new Error(`game with seed ${failed.seed} failed:\n${failed.error}`);
  return results;
}

/** Wilson score interval for a proportion, 95%. */
function wilson(wins, n) {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Per-label stats from results. Win rate counts every game (unfinished games have no winner). */
function summarise(results) {
  const rows = new Map();
  for (const r of results) {
    r.labels.forEach((label, seat) => {
      if (!rows.has(label)) rows.set(label, { label, seats: 0, wins: 0, worth: 0, sets: 0 });
      const row = rows.get(label);
      row.seats++;
      if (r.winnerSeat === seat) row.wins++;
      row.worth += r.worth[seat];
      if (r.setsCompleted[seat]) row.sets++;
    });
  }
  const finished = results.filter((r) => r.finished);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    rows: [...rows.values()].map((row) => {
      const [lo, hi] = wilson(row.wins, row.seats);
      return { ...row, rate: row.wins / row.seats, lo, hi, avgWorth: row.worth / row.seats, setRate: row.sets / row.seats };
    }).sort((a, b) => b.rate - a.rate),
    games: results.length,
    finished: finished.length,
    avgTurns: avg(finished.map((r) => r.turns)),
    auctions: results.reduce((t, r) => t + r.tally.auctions, 0),
    trades: results.reduce((t, r) => t + r.tally.tradesAccepted, 0),
    proposed: results.reduce((t, r) => t + r.tally.tradesProposed, 0),
  };
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;

function printTable(summary) {
  const header = ['bot', 'seats', 'wins', 'win rate', '95% CI', 'avg net worth', 'completed a set'];
  const lines = summary.rows.map((r) => [
    r.label, String(r.seats), String(r.wins), pct(r.rate), `${pct(r.lo)} – ${pct(r.hi)}`,
    `₹${Math.round(r.avgWorth).toLocaleString('en-IN')}`, pct(r.setRate),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => `  ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('   ')}`;
  console.log(fmt(header));
  console.log(`  ${widths.map((w) => '─'.repeat(w)).join('   ')}`);
  for (const l of lines) console.log(fmt(l));
  console.log(`\n  games: ${summary.games}   finished: ${summary.finished} (${pct(summary.finished / summary.games)})   avg length: ${summary.avgTurns.toFixed(1)} turns (finished games)`);
  console.log(`  auctions: ${summary.auctions}   trades: ${summary.trades} accepted of ${summary.proposed} proposed`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const jobs = Array.from({ length: opts.games }, (_, i) => ({ seed: (opts.seed + i) >>> 0, lineup: opts.lineup, maxTurns: opts.maxTurns }));
  const results = await runGames(jobs, opts.workers);
  console.log(`Tournament: ${opts.games} games, lineup ${opts.lineup.join(', ')} (seats shuffled), cap ${opts.maxTurns} turns, ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  printTable(summarise(results));
}

if (!isMainThread) {
  parentPort.on('message', ({ index, job }) => parentPort.postMessage({ index, result: playJob(job) }));
} else if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runGames, summarise, printTable, wilson, seatsFor };
