'use strict';

/**
 * Random-bot simulator for the game engine.
 *
 *   node scripts/simulate.js [games] [--games N] [--seed S] [--players K]
 *                            [--max-turns T] [--workers W] [--no-trades] [--no-auctions]
 *
 * Plays N games (default 2000) between 2-6 bots that pick from
 * getLegalActions(), biased towards buying and building so games end. Bots
 * also bid in auctions (up to a private cap) and propose and answer trades,
 * mostly to complete colour sets. The server's auction timer is emulated by
 * calling game.closeAuction() when bidding stalls. Every
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
const { tradeProblem, tileProblem, mortgageFees } = require('../server/game/trades');
const { AUCTION, TRADE } = require('../shared/rules');
const { createRng, randomInt } = require('../server/game/rng');
const { BOARD, MAX_BUILDINGS, TILE, JAIL_INDEX, groupMembers, getTileById } = require('../shared/board');
const { DECKS } = require('../shared/cards');

const ACTIVE = new Set([PHASE.AWAITING_ROLL, PHASE.BUY_DECISION, PHASE.AWAITING_END, PHASE.AUCTION]);
const MAX_ACTIONS_PER_GAME = 200000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { games: 2000, seed: 1, players: null, maxTurns: 2000, workers: os.availableParallelism(), trades: true, auctions: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => Number(argv[++i]);
    if (arg === '--games') opts.games = next();
    else if (arg === '--seed') opts.seed = next();
    else if (arg === '--players') opts.players = next();
    else if (arg === '--max-turns') opts.maxTurns = next();
    else if (arg === '--workers') opts.workers = next();
    else if (arg === '--no-trades') opts.trades = false;
    else if (arg === '--no-auctions') opts.auctions = false;
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

/** Pick from weighted options with the bot rng. */
function weighted(rng, options) {
  const total = options.reduce((t, [, w]) => t + w, 0);
  let pick = rng.next() * total;
  for (const [value, w] of options) if ((pick -= w) < 0) return value;
  return options[options.length - 1][0];
}

// --- Auctions -----------------------------------------------------------------

/**
 * Each bot privately values the tile at a random 40-130% of its price (more
 * if it completes or extends a set it is collecting) and bids the minimum
 * plus a quick-bid step while that stays under its cap and its cash.
 */
function auctionChoice(state, player, legal, caps, rng) {
  const bid = legal.find((a) => a.type === 'bid');
  if (!bid) return legal.find((a) => a.type === 'pass') || null;
  const tile = getTileById(state.auction.tileId);
  const key = `${state.turnNumber}:${tile.id}:${player.id}`;
  if (!caps.has(key)) {
    const mine = tile.group ? groupMembers(tile.group).filter((i) => state.properties[BOARD[i].id].ownerId === player.id).length : 0;
    caps.set(key, Math.round(tile.price * (0.4 + rng.next() * 0.9) * (1 + 0.3 * mine)));
  }
  const cap = Math.min(caps.get(key), player.cash);
  if (bid.amount > cap) return { type: 'pass' };
  const step = rng.next() < 0.5 ? 0 : AUCTION.quickBids[randomInt(rng, AUCTION.quickBids.length)];
  return { type: 'bid', amount: Math.min(cap, bid.amount + step) };
}

// --- Trades -------------------------------------------------------------------

const tileValue = (state, id) => {
  const tile = getTileById(id);
  return state.properties[id].mortgaged ? tile.price / 2 : tile.price;
};
const sideValue = (state, side) => side.cash + side.jailCards.length * 50 + side.tileIds.reduce((t, id) => t + tileValue(state, id), 0);

/** Would owning these extra tiles complete a set for `playerId`? */
function completesSet(state, playerId, tileIds) {
  return tileIds.some((id) => {
    const tile = getTileById(id);
    return tile.group && groupMembers(tile.group).every((i) => {
      const other = BOARD[i].id;
      return state.properties[other].ownerId === playerId || tileIds.includes(other);
    });
  });
}

/**
 * Propose a fair-ish trade, preferring a tile that would complete (or move
 * towards) one of the bot's sets, paid for with cash and sometimes a spare tile.
 */
function proposeTrade(state, bot, rng) {
  const tradeable = (ownerId) => Object.keys(state.properties).filter((id) => state.properties[id].ownerId === ownerId && !tileProblem(state, ownerId, id));
  const others = state.players.filter((p) => p.id !== bot.id && !p.bankrupt);
  const wanted = [];
  for (const other of others) {
    for (const id of tradeable(other.id)) {
      const tile = getTileById(id);
      const mine = groupMembers(tile.group).filter((i) => state.properties[BOARD[i].id].ownerId === bot.id).length;
      wanted.push([{ other, id }, 1 + mine * 6 + (completesSet(state, bot.id, [id]) ? 20 : 0)]);
    }
  }
  if (!wanted.length) return null;
  const { other, id } = weighted(rng, wanted);
  const price = tileValue(state, id) * (0.9 + rng.next() * 0.7);
  const give = { tileIds: [], cash: 0, jailCards: [] };
  // Sometimes offer a spare tile from a set the bot isn't collecting.
  const spare = tradeable(bot.id).filter((t) => groupMembers(getTileById(t).group).filter((i) => state.properties[BOARD[i].id].ownerId === bot.id).length === 1);
  if (spare.length && rng.next() < 0.4) give.tileIds.push(spare[randomInt(rng, spare.length)]);
  give.cash = Math.max(0, Math.min(Math.floor(bot.cash * 0.7), Math.round(price - sideValue(state, give))));
  if (!give.cash && !give.tileIds.length) return null;
  return { type: 'proposeTrade', toId: other.id, give, get: { tileIds: [id], cash: 0, jailCards: [] } };
}

/** Accept roughly fair trades; demand a premium for handing over a set-completing tile. */
function answerTrade(state, bot, trade, legal, rng) {
  const can = (type) => legal.some((a) => a.type === type && a.tradeId === trade.id);
  let receive = sideValue(state, trade.give);
  const giveUp = sideValue(state, trade.get);
  if (completesSet(state, bot.id, trade.give.tileIds)) receive *= 1.5;
  const premium = completesSet(state, trade.fromId, trade.get.tileIds) ? 1.3 : 1;
  const fees = mortgageFees(state, trade.give.tileIds);
  if (can('acceptTrade') && receive - fees >= giveUp * premium * (0.85 + rng.next() * 0.3)) return { type: 'acceptTrade', tradeId: trade.id };
  if (can('counterTrade') && rng.next() < 0.1) return { type: 'counterTrade', tradeId: trade.id };
  return { type: 'declineTrade', tradeId: trade.id };
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

/** Auction state exists exactly in the auction phase and is self-consistent. */
function checkAuction(state) {
  const a = state.auction;
  assert((state.phase === PHASE.AUCTION) === Boolean(a), `phase ${state.phase} with auction ${JSON.stringify(a)}`);
  if (!a) return;
  const live = new Set(state.players.filter((p) => !p.bankrupt).map((p) => p.id));
  assert(a.bidders.every((id) => live.has(id)), 'a bankrupt player is still bidding');
  assert(state.properties[a.tileId].ownerId === null, 'auctioning an owned tile');
  if (a.highBidderId) {
    const leader = state.players.find((p) => p.id === a.highBidderId);
    assert(a.bidders.includes(leader.id), 'high bidder has passed');
    assert(a.highBid > 0 && a.highBid <= leader.cash, `high bid ${a.highBid} above the leader's cash ${leader.cash}`);
  }
}

/** Every open trade is valid right now (invalid ones must already be cancelled). */
function checkTrades(state) {
  const perProposer = new Map();
  for (const t of state.trades) {
    assert(t.status === 'open', `trade ${t.id} has status ${t.status}`);
    const problem = tradeProblem(state, t);
    assert(!problem, `open trade ${t.id} is invalid: ${problem}`);
    perProposer.set(t.fromId, (perProposer.get(t.fromId) || 0) + 1);
  }
  for (const [id, n] of perProposer) assert(n <= TRADE.maxOpenPerPlayer, `${id} has ${n} open proposals`);
  assert(new Set(state.trades.map((t) => t.id)).size === state.trades.length, 'duplicate trade ids');
}

/** Each tile has exactly one entry and at most one owner; every holding adds up. */
function checkUniqueOwnership(state) {
  const owners = Object.entries(state.properties).map(([, p]) => p.ownerId).filter(Boolean);
  const perPlayer = state.players.reduce((t, p) => t + Object.values(state.properties).filter((x) => x.ownerId === p.id).length, 0);
  assert(owners.length === perPlayer, 'a tile is owned by someone who is not a player');
  assert(Object.keys(state.properties).length === BOARD.filter((t) => t.price).length, 'property map has the wrong tiles');
}

function checkTurn(state, game) {
  const live = state.players.filter((p) => !p.bankrupt);
  if (state.phase === PHASE.GAME_OVER) {
    assert(live.length === 1 && state.winnerId === live[0].id, 'game over without exactly one survivor as winner');
    assert(state.trades.length === 0, 'open trades after game over');
    return;
  }
  if (state.phase === PHASE.AUCTION) return; // the turn player waits; bidders act
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
  checkAuction(state);
  checkTrades(state);
  checkUniqueOwnership(state);
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
  let game = new Game({ seed, now: () => ++clock, settings: { auctions: opts.auctions } });
  const ledger = { bankOut: 0, bankIn: 0 };
  const caps = new Map(); // auction caps per bot
  const tally = { auctions: 0, auctionsSold: 0, tradesProposed: 0, tradesAccepted: 0 };
  const history = [];
  const landings = new Map();

  const record = (who, action, result) => {
    history.push({ turn: game.state.turnNumber, who, action, ok: result.ok, error: result.error });
    if (!result.ok) throw new InvariantError(`legal action rejected: ${result.error}`);
    for (const e of result.events) {
      applyToLedger(ledger, e);
      if (e.type === 'auctionStarted') tally.auctions++;
      if (e.type === 'auctionClosed' && e.winnerId) tally.auctionsSold++;
      if (e.type === 'tradeProposed') tally.tradesProposed++;
      if (e.type === 'tradeAccepted') tally.tradesAccepted++;
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

    const serverClose = () => {
      record('server', { type: 'closeAuction' }, game.closeAuction());
      game = checkAll(game, ledger);
    };
    const live = () => game.state.players.filter((p) => !p.bankrupt);

    let actions = 0;
    while (game.state.phase !== PHASE.GAME_OVER && game.state.turnNumber <= opts.maxTurns) {
      assert(++actions < MAX_ACTIONS_PER_GAME, 'too many actions: the game is stuck');

      // Auction: one bidder acts at a time; the "timer" closes it when bidding stalls.
      if (game.state.phase === PHASE.AUCTION) {
        const able = live().filter((p) => game.getLegalActions(p.id).length);
        if (!able.length || botRng.next() < 0.08) {
          serverClose();
          continue;
        }
        const bidder = able[randomInt(botRng, able.length)];
        act(bidder.id, auctionChoice(game.state, bidder, game.getLegalActions(bidder.id), caps, botRng));
        continue;
      }

      if (opts.trades) {
        // Answer open trades (sometimes later rather than now), and occasionally cancel one.
        for (const t of [...game.state.trades]) {
          if (!game.state.trades.includes(t) || game.state.phase === PHASE.AUCTION) continue;
          const roll = botRng.next();
          if (roll < 0.5) {
            const to = game.state.players.find((p) => p.id === t.toId);
            act(to.id, answerTrade(game.state, to, t, game.getLegalActions(to.id), botRng));
          } else if (roll < 0.55) {
            act(t.fromId, { type: 'cancelTrade', tradeId: t.id });
          }
        }
        // Occasionally someone proposes a trade.
        if (game.state.phase !== PHASE.GAME_OVER && game.state.phase !== PHASE.AUCTION && botRng.next() < 0.06) {
          const proposers = live().filter((p) => p.cash >= 0 && game.state.trades.filter((t) => t.fromId === p.id).length < TRADE.maxOpenPerPlayer);
          if (proposers.length) {
            const bot = proposers[randomInt(botRng, proposers.length)];
            const offer = proposeTrade(game.state, bot, botRng);
            if (offer) act(bot.id, offer);
          }
        }
      }
      if (game.state.phase === PHASE.GAME_OVER || game.state.phase === PHASE.AUCTION) continue;
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
      tally,
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
  console.log(`  finished: ${finished.length} (${(100 * finished.length / results.length).toFixed(1)}%)   capped: ${capped}`);
  const total = (k) => results.reduce((t, r) => t + r.tally[k], 0);
  console.log(`  auctions: ${total('auctions')} (${total('auctions') ? (100 * total('auctionsSold') / total('auctions')).toFixed(0) : 0}% sold)   trades: ${total('tradesAccepted')} accepted of ${total('tradesProposed')} proposed`);
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
