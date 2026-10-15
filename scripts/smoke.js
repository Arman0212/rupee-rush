'use strict';

/**
 * End-to-end smoke test: the real server in-process on a random port, driven by
 * four socket.io clients.
 *
 *   node scripts/smoke.js
 *
 * Covers: create/join by code, room list, settings, colours, chat, starting,
 * random play from legalActions until game over (or a turn cap), a mid-game
 * disconnect + token reconnect, a second-tab takeover, out-of-turn and garbage
 * actions, and play-again. Then one human plays a whole game against three
 * bots (easy, medium, hard): adding and removing bots, at least one auction
 * and a trade the bots must answer. Throughout it asserts that no token ever appears in
 * a server→client event and that state versions strictly increase per socket.
 * Exits 0 on success, 1 on failure.
 */

const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server/index');
const { PLAYER_COLORS, GAME_NAME } = require('../shared/rules');

const TURN_CAP = 400;
const WAIT_MS = 5000;
const WATCHDOG_MS = 360_000;
/** Bots normally think for 0.6-1.5s; here they're quick so a whole game fits in the run. */
const BOT_DELAY = { normal: [5, 15], auction: [3, 8] };

const quietLog = { log() {}, warn() {}, error: (...args) => console.error('[server]', ...args) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One socket.io client that records everything the server sends it. */
class Client {
  constructor(url, label) {
    this.label = label;
    this.inbox = []; // every server->client event: { event, payload }
    this.state = null;
    this.you = null;
    this.lastVersion = 0;
    this.waiters = [];
    this.socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    this.socket.onAny((event, payload) => {
      this.inbox.push({ event, payload });
      if (event === 'state') {
        assert.ok(payload.version > this.lastVersion, `${label}: state version ${payload.version} after ${this.lastVersion}`);
        this.lastVersion = payload.version;
        this.state = payload;
      }
      if (event === 'you') this.you = payload;
      this.waiters = this.waiters.filter((w) => !w());
    });
  }

  connected() {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('connect_error', reject);
    });
  }

  /** Emit with an ack. */
  call(event, payload) {
    return this.socket.timeout(WAIT_MS).emitWithAck(event, payload);
  }

  /** Resolve once `predicate()` is true (checked after every incoming event). */
  until(predicate, what, ms = WAIT_MS) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: timed out waiting for ${what}`)), ms);
      this.waiters.push(() => {
        if (!predicate()) return false;
        clearTimeout(timer);
        resolve();
        return true;
      });
    });
  }

  received(event) {
    return this.inbox.filter((m) => m.event === event).map((m) => m.payload);
  }
}

// ---------------------------------------------------------------------------
// Bot policy: random from legalActions, biased like the simulator
// ---------------------------------------------------------------------------

const WEIGHTS = { roll: 10, endTurn: 10, buy: 40, decline: 1, build: 30, unmortgage: 1, payJailFine: 3, useJailCard: 4 };
const DEBT_WEIGHTS = { sellHouse: 5, mortgage: 5, bankrupt: 0.2 };

function chooseAction(legal, inDebt) {
  const table = inDebt ? DEBT_WEIGHTS : WEIGHTS;
  const weighted = legal.map((a) => [a, table[a.type] || 0]);
  const total = weighted.reduce((t, [, w]) => t + w, 0);
  if (!total) return legal[Math.floor(Math.random() * legal.length)];
  let pick = Math.random() * total;
  for (const [a, w] of weighted) if ((pick -= w) < 0) return a;
  return legal[legal.length - 1];
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

async function run() {
  const server = createServer({ log: quietLog, botDelay: BOT_DELAY });
  const port = await server.listen(0);
  const url = `http://localhost:${port}`;
  const tokens = new Set();
  const allClients = [];
  let clients = []; // the four seated bots (replaced in place when one reconnects)
  const newClient = async (label) => {
    const c = new Client(url, label);
    allClients.push(c);
    await c.connected();
    return c;
  };
  const step = (msg) => console.log(`  ✓ ${msg}`);

  try {
    // --- HTTP ---------------------------------------------------------------
    const health = await (await fetch(`${url}/health`)).json();
    assert.deepEqual(health, { ok: true, rooms: 0, players: 0 });
    const invitePage = await fetch(`${url}/r/ABCDEF`);
    assert.equal(invitePage.status, 200);
    assert.match(await invitePage.text(), /\/js\/main\.js/);
    step('HTTP: /health and /r/:code');

    // --- Create, list, join ---------------------------------------------------
    clients = [await newClient('host'), await newClient('c2'), await newClient('c3'), await newClient('c4')];
    const [host] = clients;
    const created = await host.call('createRoom', { name: 'Host' });
    assert.ok(created.ok, created.error);
    const { code } = created;
    tokens.add(created.token);
    host.token = created.token;
    host.playerId = created.playerId;

    const listed = await clients[1].call('listRooms');
    assert.ok(listed.rooms.some((r) => r.code === code && r.hostName === 'Host'));

    for (const [i, c] of clients.slice(1).entries()) {
      const r = await c.call('joinRoom', { code: code.toLowerCase(), name: i === 0 ? 'Host' : `Player ${i + 2}` });
      assert.ok(r.ok, r.error);
      tokens.add(r.token);
      c.token = r.token;
      c.playerId = r.playerId;
    }
    await host.until(() => host.state && host.state.room.players.length === 4, '4 players');
    assert.equal(host.state.room.players[1].name, 'Host 2', 'duplicate name was de-duplicated');
    step(`room ${code}: created, listed, joined by 3 more (names de-duplicated)`);

    // --- Lobby: settings, colours, chat ---------------------------------------
    assert.equal((await clients[1].call('updateSettings', { settings: { goSalary: 0 } })).error, 'only the host can do that');
    const settings = await host.call('updateSettings', { settings: { startingCash: 500, goSalary: 0, auctionSeconds: 5 } });
    assert.ok(settings.ok);
    for (const [i, c] of clients.entries()) assert.ok((await c.call('pickColor', { color: PLAYER_COLORS[7 - i] })).ok);
    assert.equal((await clients[1].call('pickColor', { color: PLAYER_COLORS[7] })).error, 'colour already taken');
    assert.ok((await clients[2].call('chat', { text: '  <img src=x onerror=alert(1)> hello  ' })).ok);
    await host.until(() => host.received('chat').length === 1, 'chat');
    assert.equal(host.received('chat')[0].text, '<img src=x onerror=alert(1)> hello');
    await host.until(() => host.state.room.players.every((p, i) => p.color === PLAYER_COLORS[7 - i]), 'colours');
    assert.equal(host.state.room.settings.startingCash, 500);
    step('lobby: host-only settings, colour picks (duplicate refused), chat');

    // --- Start ---------------------------------------------------------------------
    assert.equal((await clients[1].call('startGame')).error, 'only the host can do that');
    assert.ok((await host.call('startGame')).ok);
    await Promise.all(clients.map((c) => c.until(() => c.state && c.state.publicState, 'game state')));
    const late = await newClient('late');
    assert.equal((await late.call('joinRoom', { code, name: 'Late' })).error, 'game already started');
    late.socket.disconnect();
    step('game started; late joiner refused');

    // --- Robustness ------------------------------------------------------------------
    assert.equal((await host.call('action', 'roll')).ok, false);
    assert.equal((await host.call('action', { type: 42 })).ok, false);
    assert.equal((await host.call('action', { type: 'chat' })).error, 'not implemented');
    assert.equal((await host.call('action', { type: 'proposeTrade', give: { evil: 1 } })).ok, false);
    host.socket.emit('noSuchEvent', { x: 1 }); // ignored
    host.socket.emit('action', { type: 'roll' }); // no ack callback: must not crash
    await sleep(50);
    step('garbage payloads, unknown events and missing acks are handled');

    // --- Play ------------------------------------------------------------------------
    let outOfTurnChecked = false;
    let reconnectDone = false;
    let actions = 0;
    let rateLimited = 0;
    const live = () => clients.filter((c) => c.socket.connected);

    // Wait for everyone to be in step before the first move.
    await settle(Math.max(...clients.map((c) => c.lastVersion)));
    await auctionAndTradeScenario();

    while (host.state.room.status === 'playing' && host.state.publicState.turnNumber <= TURN_CAP) {
      const ps = host.state.publicState;
      const byId = (id) => clients.find((c) => c.playerId === id);
      const current = byId(ps.currentPlayerId);

      if (!outOfTurnChecked) {
        const idle = clients.find((c) => c !== current && c.you.legalActions.length === 0);
        const r = await idle.call('action', { type: 'roll' });
        assert.deepEqual(r, { ok: false, error: 'not your turn' });
        outOfTurnChecked = true;
        step('acting out of turn is refused');
      }

      if (!reconnectDone && ps.turnNumber >= 20) {
        await reconnectScenario();
        reconnectDone = true;
        continue;
      }

      const actor = [current, ...clients].find((c) => c && c.you && c.you.legalActions.length);
      if (!actor) {
        // Nobody can act: only the server's auction timer can move things on.
        assert.equal(ps.phase, 'auction', `nobody can act in phase ${ps.phase}`);
        const seen = host.lastVersion;
        await host.until(() => host.lastVersion > seen, 'the auction timer', 8000);
        await settle(host.lastVersion);
        continue;
      }
      const enginePlayer = ps.players.find((p) => p.id === actor.playerId);
      const action = chooseAction(actor.you.legalActions, enginePlayer.cash < 0);
      let r = await actor.call('action', action);
      while (!r.ok && r.error === 'rate limited') {
        // Bots are far faster than people; back off like a real client would.
        rateLimited++;
        await sleep(100);
        r = await actor.call('action', action);
      }
      assert.ok(r.ok, `${actor.label} ${action.type} refused: ${r.error}`);
      actions++;
      await settle(r.version);
    }

    const ps = host.state.publicState;
    if (host.state.room.status === 'finished') {
      await Promise.all(live().map((c) => c.until(() => c.received('gameOver').length === 1, 'gameOver')));
      const over = host.received('gameOver')[0];
      assert.equal(over.winnerId, ps.winnerId);
      step(`game over after ${ps.turnNumber} turns / ${actions} actions (${rateLimited} rate-limit back-offs): ${over.name} wins`);
      assert.equal((await clients[1].call('playAgain')).error, 'only the host can do that');
      assert.ok((await host.call('playAgain')).ok);
      await host.until(() => host.state.room.status === 'lobby' && host.state.publicState === null, 'lobby');
      assert.equal(host.state.room.settings.startingCash, 500);
      step('play again: back to the lobby with the same settings');
    } else {
      step(`turn cap reached at turn ${ps.turnNumber} (${actions} actions, ${rateLimited} rate-limit back-offs) without a winner`);
    }
    assert.ok(reconnectDone, 'reconnect scenario ran');

    await botScenario();

    // --- Global assertions -----------------------------------------------------------
    for (const c of allClients) {
      const everything = JSON.stringify(c.inbox);
      for (const token of tokens) assert.equal(everything.includes(token), false, `${c.label} received a token`);
    }
    step(`no token in any of ${allClients.reduce((n, c) => n + c.inbox.length, 0)} server→client events; versions strictly increased on every socket`);
    console.log('\n✓ smoke test passed');
  } finally {
    for (const c of allClients) c.socket.disconnect();
    await server.close();
  }

  /**
   * One auction and one accepted trade, all over the sockets. The only staged
   * step: the server-side game is put at "current player may buy Tel Aviv".
   */
  async function auctionAndTradeScenario() {
    const host = clients[0];
    const room = server.manager.get(host.state.room.code);
    const s = room.game.state;
    Object.assign(s.turn, { pendingTileId: 'tel-aviv', dice: [2, 4], canRollAgain: false });
    s.phase = 'buyDecision';
    const byId = (id) => clients.find((c) => c.playerId === id);
    const seller = byId(s.currentPlayerId);
    const [bidder, other] = clients.filter((c) => c !== seller);

    // Decline → auction for everyone, with a server deadline.
    let r = await seller.call('action', { type: 'decline' });
    assert.ok(r.ok, r.error);
    await settle(r.version);
    assert.equal(bidder.state.publicState.auction.tileId, 'tel-aviv');
    assert.ok(bidder.state.publicState.auction.endsAt > bidder.state.serverNow);
    r = await bidder.call('action', { type: 'bid', amount: 60 });
    assert.ok(r.ok, r.error);
    assert.equal((await other.call('action', { type: 'bid', amount: 60 })).error, 'bid at least ₹61');
    for (const c of clients.filter((x) => x !== bidder)) {
      r = await c.call('action', { type: 'pass' });
      assert.ok(r.ok, `${c.label} pass: ${r.error}`);
    }
    await settle(r.version);
    assert.equal(host.state.publicState.auction, null);
    assert.equal(host.state.publicState.properties['tel-aviv'].ownerId, bidder.playerId);
    assert.ok(host.received('state').some((st) => st.events.some((e) => e.type === 'auctionClosed' && e.amount === 60)));
    step(`auction over sockets: ${bidder.label} won Tel Aviv for ₹60 after the others passed`);

    // A trade: `other` offers ₹90 for Tel Aviv, `bidder` accepts.
    r = await other.call('action', { type: 'proposeTrade', toId: bidder.playerId, give: { cash: 90 }, get: { tileIds: ['tel-aviv'] } });
    assert.ok(r.ok, r.error);
    await settle(r.version);
    const trade = bidder.state.publicState.trades[0];
    assert.ok(bidder.you.legalActions.some((a) => a.type === 'acceptTrade' && a.tradeId === trade.id));
    assert.equal((await other.call('action', { type: 'acceptTrade', tradeId: trade.id })).ok, false, 'the proposer cannot accept');
    r = await bidder.call('action', { type: 'acceptTrade', tradeId: trade.id });
    assert.ok(r.ok, r.error);
    await settle(r.version);
    assert.equal(host.state.publicState.properties['tel-aviv'].ownerId, other.playerId);
    assert.deepEqual(host.state.publicState.trades, []);
    step(`trade over sockets: ${other.label} bought Tel Aviv from ${bidder.label} for ₹90`);
  }

  /** One human against three bots, to game over. */
  async function botScenario() {
    const human = await newClient('Hema');
    let r = await human.call('createRoom', { name: 'Hema' });
    assert.ok(r.ok, r.error);
    tokens.add(r.token);
    const me = r.playerId;
    await human.until(() => human.state && human.state.room, 'lobby state');
    assert.ok((await human.call('updateSettings', { settings: { startingCash: 500, goSalary: 0, auctionSeconds: 5 } })).ok);
    for (const difficulty of ['easy', 'medium', 'hard', 'medium']) {
      r = await human.call('addBot', { difficulty });
      assert.ok(r.ok, r.error);
    }
    await human.until(() => human.state.room.players.length === 5, 'four bots seated');
    const extra = human.state.room.players.at(-1);
    assert.ok((await human.call('removeBot', { playerId: extra.id })).ok);
    assert.equal((await human.call('removeBot', { playerId: me })).error, 'no such bot');
    await human.until(() => human.state.room.players.length === 4, 'bot removed');
    const bots = human.state.room.players.filter((p) => p.bot);
    assert.deepEqual(bots.map((b) => b.bot), ['easy', 'medium', 'hard']);
    assert.ok(bots.every((b) => b.name.startsWith('Bot ') && b.connected && !b.isHost));
    step(`lobby: added ${bots.map((b) => `${b.name} (${b.bot})`).join(', ')}; removed one`);

    assert.ok((await human.call('startGame')).ok);
    const botIds = new Set(bots.map((b) => b.id));
    let proposed = false;
    let moves = 0;
    const started = Date.now();
    const actionable = (legal) => legal.filter((a) => a.type !== 'cancelTrade');
    const finished = () => human.state.room.status === 'finished';
    while (!finished()) {
      await human.until(() => finished() || (human.you && human.you.version === human.state.version && actionable(human.you.legalActions).length), 'a move for the human or game over', 60_000);
      if (finished()) break;
      const ps = human.state.publicState;
      const legal = actionable(human.you.legalActions);
      const mine = ps.players.find((p) => p.id === me);
      const botTile = Object.keys(ps.properties).find((id) => botIds.has(ps.properties[id].ownerId) && !ps.properties[id].mortgaged);
      let action;
      if (legal.some((a) => a.type === 'declineTrade')) action = legal.find((a) => a.type === 'declineTrade');
      else if (legal.some((a) => a.type === 'pass')) action = { type: 'pass' };
      else if (legal.some((a) => a.type === 'decline')) action = { type: 'decline' }; // every purchase goes to auction
      else if (!proposed && botTile && mine.cash > 0 && legal.some((a) => a.type === 'roll' || a.type === 'endTurn')) {
        // A lowball offer the bot has to answer.
        action = { type: 'proposeTrade', toId: ps.properties[botTile].ownerId, give: { cash: 1 }, get: { tileIds: [botTile] } };
        proposed = true;
      } else action = chooseAction(legal, mine.cash < 0);
      r = await human.call('action', action);
      moves++;
      if (!r.ok && /rate limited/.test(r.error)) await sleep(1000);
      // Anything else (say, the state moved on under us) just means: look again.
    }
    const events = human.received('state').flatMap((st) => st.events);
    const ps = human.state.publicState;
    assert.ok(events.some((e) => e.type === 'auctionStarted'), 'at least one auction');
    assert.ok(events.some((e) => e.type === 'bidPlaced' && botIds.has(e.playerId)), 'a bot bid');
    const answered = events.find((e) => (e.type === 'tradeDeclined' || e.type === 'tradeAccepted') && botIds.has(e.toId));
    assert.ok(answered, 'a bot answered a trade');
    assert.ok(events.some((e) => e.type === 'turnTimedOut') === false, 'nobody was timed out');
    const lines = human.received('chat').filter((m) => m.bot);
    assert.ok(lines.length > 0, 'bots said something');
    const winner = ps.players.find((p) => p.id === ps.winnerId);
    const botTrades = events.filter((e) => e.type === 'tradeProposed' && botIds.has(e.fromId)).length;
    step(`1 human + 3 bots: game over after ${ps.turnNumber} turns in ${((Date.now() - started) / 1000).toFixed(1)}s, ${winner.name} wins`);
    step(`  ${events.filter((e) => e.type === 'auctionStarted').length} auctions, a bot ${answered.type === 'tradeAccepted' ? 'accepted' : 'declined'} the human's offer, bots proposed ${botTrades} trades, ${lines.length} bot chat lines, ${moves} human moves`);
    human.socket.disconnect();
  }

  // Disconnect a non-host mid-game, reconnect with its token, then take over from a second tab.
  async function reconnectScenario() {
    const index = 2;
    const old = clients[index];
    const watcher = clients[0];
    old.socket.disconnect();
    await watcher.until(() => watcher.state.room.players.find((p) => p.id === old.playerId).connected === false, 'disconnect broadcast');

    const back = await newClient(`${old.label}-reconnected`);
    const r = await back.call('joinRoom', { code: watcher.state.room.code, token: old.token });
    assert.ok(r.ok, r.error);
    assert.equal(r.playerId, old.playerId);
    assert.equal(r.reconnected, true);
    await back.until(() => back.state && back.state.publicState && back.you, 'state after reconnect');
    assert.equal(back.you.playerId, old.playerId);
    assert.ok(back.state.publicState.players.some((p) => p.id === old.playerId));
    assert.ok(back.received('chatHistory')[0].messages.length >= 1, 'chat history resent');
    await watcher.until(() => watcher.state.room.players.find((p) => p.id === old.playerId).connected, 'reconnect broadcast');
    Object.assign(back, { token: old.token, playerId: old.playerId });
    clients[index] = back;
    step('disconnect mid-game, reconnect with token: same seat, full state and chat history');

    const tab2 = await newClient(`${old.label}-tab2`);
    const r2 = await tab2.call('joinRoom', { code: watcher.state.room.code, token: old.token });
    assert.equal(r2.playerId, old.playerId);
    await back.until(() => back.received('replaced').length === 1, 'replaced');
    await tab2.until(() => tab2.you, 'you on tab2');
    assert.equal((await back.call('action', { type: 'roll' })).error, 'not in a room');
    Object.assign(tab2, { token: old.token, playerId: old.playerId });
    back.socket.disconnect();
    clients[index] = tab2;
    step('same token in a second tab: newest socket wins, old one gets "replaced"');
    await settle(Math.max(...clients.map((c) => c.lastVersion)));
  }

  function settle(version) {
    return Promise.all(clients.filter((c) => c.socket.connected).map((c) => c.until(() => c.you && c.you.version >= version, `version ${version}`)));
  }
}

const watchdog = setTimeout(() => {
  console.error('✗ smoke test timed out');
  process.exit(1);
}, WATCHDOG_MS);

console.log(`${GAME_NAME} smoke test`);
run().then(
  () => {
    clearTimeout(watchdog);
    process.exit(0);
  },
  (err) => {
    console.error(`\n✗ smoke test failed: ${err.stack || err}`);
    process.exit(1);
  },
);
