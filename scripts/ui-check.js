'use strict';

/**
 * Headless UI check: the real server in-process, three browser pages at
 * desktop, laptop and phone sizes, playing through the real UI by clicking
 * only the buttons the client generates.
 *
 *   node scripts/ui-check.js [turns=30]
 *
 * Saves screenshots to screenshots/, checks for horizontal scrolling and
 * XSS in chat, and fails on any console error, page error or failed request.
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../server/index');

const OUT = path.join(__dirname, '..', 'screenshots');
const TURNS = Number(process.argv[2]) || 30;
const STALL_MS = 20_000;
const VIEWPORTS = [
  { label: '1440x900', width: 1440, height: 900, name: 'Asha' },
  { label: '1024x768', width: 1024, height: 768, name: 'Bilal' },
  { label: '390x844', width: 390, height: 844, name: 'Chitra', mobile: true },
];
const PREFERENCE = ['buy', 'roll', 'useJailCard', 'payJailFine', 'endTurn', 'decline'];
/** Shared between the pages: the first purchase offer is declined to start an auction. */
const scenario = { auctionStarted: false, auctionShots: false, tradeDone: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const say = (msg) => console.log(`  ✓ ${msg}`);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = createServer({ log: { log() {}, warn() {}, error: (...a) => errors.push(`[server] ${a.join(' ')}`) } });
  const port = await server.listen(0);
  const base = `http://localhost:${port}`;
  const browser = await chromium.launch();

  try {
    const players = [];
    for (const [i, vp] of VIEWPORTS.entries()) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: Boolean(vp.mobile),
        hasTouch: Boolean(vp.mobile),
        // The first page animates; the others prove reduced motion works (and keep the run quick).
        reducedMotion: i === 0 ? 'no-preference' : 'reduce',
        // The laptop page runs in dark mode to cover the dark theme.
        colorScheme: i === 1 ? 'dark' : 'light',
      });
      const page = await context.newPage();
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[${vp.label}] console: ${msg.text()}`); });
      page.on('pageerror', (err) => errors.push(`[${vp.label}] page error: ${err.message}`));
      page.on('requestfailed', (req) => errors.push(`[${vp.label}] request failed: ${req.url()} ${req.failure() && req.failure().errorText}`));
      players.push({ ...vp, page });
    }
    const [host, ...guests] = players;
    const shot = (p, name, opts = {}) => p.page.screenshot({ path: path.join(OUT, `${p.label}-${name}.png`), ...opts });
    const noSideScroll = async (p, where) => {
      const extra = await p.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (extra > 0) errors.push(`[${p.label}] ${where}: page scrolls sideways by ${extra}px`);
    };

    // --- Home ---------------------------------------------------------------
    for (const p of players) {
      await p.page.goto(base);
      await p.page.waitForSelector('#screen-home:not([hidden])');
      await p.page.waitForFunction(() => document.fonts.status === 'loaded');
      await shot(p, 'home', { fullPage: true });
      await noSideScroll(p, 'home');
    }
    say('home screen at all three sizes');
    for (const p of [players[0], players[2]]) {
      await p.page.click('#home-help');
      await p.page.waitForSelector('dialog.dialog-help[open]');
      await shot(p, 'how-to-play');
      await p.page.keyboard.press('Escape');
    }
    say('"How to play" opens from home'); 

    // --- Create and join ----------------------------------------------------------
    await host.page.fill('#home-name', host.name);
    await host.page.click('#home-create');
    await host.page.waitForSelector('#screen-lobby:not([hidden])');
    const code = (await host.page.textContent('#lobby-code')).trim();
    for (const p of guests) {
      await p.page.goto(`${base}/r/${code}`);
      await p.page.waitForFunction((c) => document.querySelector('#home-hint').textContent.includes(c), code);
      await p.page.fill('#home-name', p.name);
      await p.page.click('#home-join-btn');
      await p.page.waitForSelector('#screen-lobby:not([hidden])');
    }
    await host.page.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 3);
    say(`room ${code}: created on desktop, joined from /r/${code} on laptop and phone`);

    // --- Lobby: settings, colour, chat -------------------------------------------------
    await host.page.fill('#set-startingCash', '1000');
    await host.page.press('#set-startingCash', 'Tab');
    await host.page.fill('#set-auctionSeconds', '5');
    await host.page.press('#set-auctionSeconds', 'Tab');
    await guests[0].page.waitForFunction(() => document.querySelector('#set-startingCash').value === '1000');
    if (!(await guests[0].page.isDisabled('#set-startingCash'))) errors.push('guest can edit settings');
    await guests[1].page.click('.colour-swatch:not(:disabled):not(.is-mine)');
    await guests[1].page.waitForSelector('.colour-swatch.is-mine');
    const evil = '<b>hi</b><img src=x onerror="window.__xss=1">';
    await guests[0].page.fill('#lobby-chat input', evil);
    await guests[0].page.press('#lobby-chat input', 'Enter');
    await host.page.waitForFunction((t) => [...document.querySelectorAll('.chat-text')].some((n) => n.textContent === t), evil);
    const injected = await host.page.evaluate(() => document.querySelectorAll('.chat-list img, .chat-list b').length + (window.__xss ? 1 : 0));
    if (injected) errors.push('chat HTML was rendered as markup');
    for (const p of players) {
      await shot(p, 'lobby', { fullPage: true });
      await noSideScroll(p, 'lobby');
    }
    say('lobby: host-only settings, colour pick, chat rendered as text');

    // --- Start ------------------------------------------------------------------------
    await host.page.click('#lobby-start');
    for (const p of players) await p.page.waitForSelector('#screen-game:not([hidden])');
    await sleep(500);
    for (const p of players) {
      await shot(p, 'game-start');
      await noSideScroll(p, 'game');
    }
    say('game started on every page');

    // --- Verify no toast or card banner overlaps the board at any viewport size ---
    for (const p of players) {
      await p.page.evaluate(async () => {
        const { toast, showCardBanner } = await import('/js/ui/toast.js');
        toast('Passed GO: collected ₹200 salary', { kind: 'good' });
        toast('Rent payment: ₹150 to New York');
        showCardBanner({ deck: 'surprise', text: 'Advance to New York. If you pass GO, collect ₹200.', who: 'Test' });
      });
      await sleep(250);
      await assertNoBoardOverlap(p, 'explicit toast + card stack');
      await p.page.evaluate(() => {
        document.querySelectorAll('.toasts .toast, .toasts .card-banner').forEach((el) => el.click());
      });
      await sleep(200);
    }
    say('no toast or card banner overlaps the board at any of the three viewport sizes');

    // --- Keyboard: open a tile popup with Enter, close with Escape --------------------------
    await host.page.focus('[data-tile-id="jerusalem"]');
    await host.page.keyboard.press('Enter');
    await host.page.waitForSelector('dialog.dialog-tile[open]');
    await shot(host, 'tile-popup');
    await host.page.keyboard.press('Escape');
    await host.page.waitForSelector('dialog.dialog-tile', { state: 'detached' });
    say('tile popup opens from the keyboard and closes with Escape');

    // --- Play ------------------------------------------------------------------------------
    let lastProgress = Date.now();
    let clicks = 0;
    let midShots = false;
    for (;;) {
      const turn = await host.page.evaluate(() => Number(document.body.dataset.turn || 0));
      const over = await host.page.$('dialog.dialog-gameover[open]');
      if (over || turn > TURNS) break;
      if (scenario.auctionStarted && !scenario.auctionShots) {
        scenario.auctionShots = true;
        await auctionShots(players, shot);
      }
      if (!scenario.tradeDone && turn >= 6 && (await host.page.evaluate(() => document.body.dataset.phase)) !== 'auction') {
        scenario.tradeDone = true;
        await tradeScenario(players, shot);
      }
      if (!midShots && turn >= Math.ceil(TURNS / 2)) {
        midShots = true;
        await midGameShots(players, shot, noSideScroll);
      }
      let acted = false;
      for (const p of players) {
        if (await takeTurnStep(p)) {
          acted = true;
          clicks++;
        }
      }
      if (acted) lastProgress = Date.now();
      else if (Date.now() - lastProgress > STALL_MS) throw new Error(`no player had anything to click for ${STALL_MS / 1000}s at turn ${turn}`);
      else await sleep(120);
    }
    const finalTurn = await host.page.evaluate(() => Number(document.body.dataset.turn || 0));
    say(`played to turn ${finalTurn} with ${clicks} clicks on generated buttons`);

    // Once play stops, the animated page must show exactly what the others show.
    for (const p of players) {
      await p.page.waitForFunction(() => !document.body.dataset.animating, null, { timeout: 10_000 }).catch(() => {});
    }
    await sleep(1500);
    const tokenMap = (p) => p.page.$$eval('.token', (ts) => ts.map((t) => `${t.dataset.player}@${t.dataset.position}${t.dataset.jail === 'true' ? 'J' : ''}`).sort().join(' '));
    const reference = await tokenMap(players[1]);
    for (const p of players) {
      const mine = await tokenMap(p);
      if (mine !== reference) errors.push(`[${p.label}] tokens ${mine} differ from ${reference}`);
    }
    say(`tokens agree on every page after animations: ${reference.replace(/[0-9a-f]{16}/g, (id) => id.slice(0, 4))}`);
    for (const p of players) {
      await closeCards(p.page);
      await shot(p, 'game');
      await noSideScroll(p, 'game (late)');
    }
    if (!(await host.page.$('dialog.dialog-gameover[open]'))) await endgameScenario(server, code, players, shot);

    const p3 = players[2];
    for (const tab of ['players', 'cities', 'chat']) {
      await p3.page.click(`#tab-${tab}`);
      await p3.page.waitForFunction((t) => document.querySelector(`#tab-${t}`).getAttribute('aria-selected') === 'true', tab);
      await sleep(300); // let the fixed tab bar repaint before capturing
      await shot(p3, `game-tab-${tab}`);
    }
    say(`screenshots saved to ${path.relative(process.cwd(), OUT)}/`);
  } finally {
    await browser.close();
    await server.close();
  }

  if (errors.length) {
    console.error(`\n✗ ${errors.length} problem(s):`);
    for (const e of [...new Set(errors)].slice(0, 30)) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('\n✓ UI check passed: no console errors, no sideways scrolling');
}

/** Check that no toast or card banner intersects the board bounding box. */
async function assertNoBoardOverlap(p, contextDesc = '') {
  const overlap = await p.page.evaluate(() => {
    const board = document.querySelector('#board');
    if (!board) return null;
    const bRect = board.getBoundingClientRect();
    if (bRect.width === 0 || bRect.height === 0) return null;

    const items = [...document.querySelectorAll('.toasts .toast, .toasts .card-banner, .card-banner')];
    for (const item of items) {
      const iRect = item.getBoundingClientRect();
      if (iRect.width === 0 || iRect.height === 0) continue;
      const intersects = !(
        iRect.right <= bRect.left ||
        iRect.left >= bRect.right ||
        iRect.bottom <= bRect.top ||
        iRect.top >= bRect.bottom
      );
      if (intersects) {
        return {
          itemText: item.textContent.trim().slice(0, 40),
          itemRect: { left: iRect.left, right: iRect.right, top: iRect.top, bottom: iRect.bottom },
          boardRect: { left: bRect.left, right: bRect.right, top: bRect.top, bottom: bRect.bottom }
        };
      }
    }
    return null;
  });

  if (overlap) {
    errors.push(`[${p.label}] ${contextDesc} toast/card overlaps board: "${overlap.itemText}"`);
  }
}

/** Close drawn-card popups, as a player would after reading them. */
async function closeCards(page) {
  await page.evaluate(() => document.querySelectorAll('dialog.dialog-card[open]').forEach((d) => d.close()));
}

async function waitIdle(page) {
  await page.waitForFunction(() => !document.body.classList.contains('is-busy'), null, { timeout: 10_000 });
}

/** Click one generated button for this player if there is something to do. */
async function takeTurnStep(p) {
  const { page } = p;
  await assertNoBoardOverlap(p, 'during play');
  await closeCards(page);
  const container = p.mobile ? '#mobile-actions' : '#center-actions';
  if (p.mobile && !(await page.isVisible(container))) await page.click('#tab-actions');

  // Auction: sometimes a quick bid (if affordable), otherwise pass.
  const auctionHost = p.mobile ? '#mobile-auction' : '#center-auction';
  if (await page.$(`${auctionHost} .auction`)) {
    if (!scenario.auctionShots) return false; // hold still until the auction screenshots are taken
    const quick = await page.$(`${auctionHost} .quick-bid:enabled`);
    const pass = await page.$(`${auctionHost} [data-action="pass"]:enabled`);
    if (quick && Math.random() < 0.3) await quick.click();
    else if (pass) await pass.click();
    else return false;
    await waitIdle(page);
    return true;
  }

  // In debt: raise cash from the Cities tab, or give up via the banner.
  if (await page.$('#game-banners .banner-danger')) {
    await page.click('#tab-cities');
    const raise = await page.$('#panel-cities button[data-action="sellHouse"]:enabled, #panel-cities button[data-action="mortgage"]:enabled');
    if (raise) await raise.click();
    else {
      await page.click('#game-banners [data-action="bankrupt"]');
      await page.click('dialog [data-confirm]');
    }
    await waitIdle(page);
    if (p.mobile) await page.click('#tab-actions');
    return true;
  }

  // Sometimes build when the Cities tab offers it.
  if (Math.random() < 0.5) {
    const tab = await page.$('#tab-cities');
    if (tab && (await tab.isVisible())) {
      await tab.click();
      const build = await page.$('#panel-cities button[data-action="build"]:enabled');
      if (build) {
        await build.click();
        await waitIdle(page);
        if (p.mobile) await page.click('#tab-actions');
        return true;
      }
      if (p.mobile) await page.click('#tab-actions');
    }
  }

  const available = await page.$$eval(`${container} button[data-action]:enabled`, (bs) => bs.map((b) => b.dataset.action));
  // The first time anyone may buy, decline instead so an auction starts.
  if (!scenario.auctionStarted && available.includes('decline')) {
    scenario.auctionStarted = true;
    await page.click(`${container} button[data-action="decline"]`);
    await waitIdle(page);
    return true;
  }
  const pick = PREFERENCE.find((a) => available.includes(a));
  if (!pick) return false;
  await page.click(`${container} button[data-action="${pick}"]:enabled`);
  await waitIdle(page);
  return true;
}

/**
 * Screens that random play rarely reaches, driven through the UI after one
 * seeded change on the in-process server: Bilal (laptop) gets a debt he can't
 * repay → debt banner → bankruptcy (with confirm) → spectating; Chitra (phone)
 * resigns via Leave → Asha wins → game-over overlay → Play again.
 */
async function endgameScenario(server, code, players, shot) {
  const [host, bilal, chitra] = players;
  const room = server.manager.get(code);
  const state = room.game.state;
  const victim = state.players.find((p) => p.name === bilal.name);
  if (victim.bankrupt) return;
  const currentPage = () => players.find((p) => p.name === state.players.find((x) => x.id === state.currentPlayerId).name);
  // Let Bilal finish his own turn, so someone else's action carries the seeded state to him.
  for (let i = 0; i < 30 && currentPage() === bilal; i++) await takeTurnStep(bilal);
  // Seed: a ₹5,000 debt to the bank, too big to mortgage away.
  victim.cash = -5000;
  victim.debt = { amount: 5000, creditorId: null, owed: [{ creditorId: null, amount: 5000 }] };
  await takeTurnStep(currentPage());
  await bilal.page.waitForSelector('#game-banners .banner-danger');
  await closeCards(bilal.page);
  await shot(bilal, 'debt-banner');
  await bilal.page.click('#game-banners [data-action="bankrupt"]');
  await bilal.page.waitForSelector('dialog.dialog-confirm[open]');
  await shot(bilal, 'confirm-bankrupt');
  await bilal.page.click('dialog [data-confirm]');
  await bilal.page.waitForSelector('#game-banners .banner-muted');
  await shot(bilal, 'spectating');
  say('debt banner → bankruptcy (confirmed) → spectating banner');

  await chitra.page.click('#leave-btn');
  await chitra.page.waitForSelector('dialog.dialog-confirm[open]');
  await chitra.page.click('dialog [data-confirm]');
  await chitra.page.waitForSelector('#screen-home:not([hidden])');
  await host.page.waitForSelector('dialog.dialog-gameover[open]');
  await sleep(400);
  await shot(host, 'game-over');
  await bilal.page.waitForSelector('dialog.dialog-gameover[open]');
  await shot(bilal, 'game-over');
  say('resign with confirm → back home; winner overlay with standings');

  await host.page.click('dialog.dialog-gameover button:has-text("Play again")');
  await host.page.waitForSelector('#screen-lobby:not([hidden])');
  await bilal.page.waitForSelector('#screen-lobby:not([hidden])');
  await host.page.waitForSelector('#screen-game', { state: 'hidden' });
  say('play again: host and spectator back in the lobby');
  // Start a fresh game so the remaining tab screenshots show a board.
  await chitra.page.goto(`${(new URL(host.page.url())).origin}/r/${code}`);
  await chitra.page.waitForSelector('#screen-lobby:not([hidden])');
  await host.page.click('#lobby-start');
  for (const p of players) await p.page.waitForSelector('#screen-game:not([hidden])');
}

/** Every page shows the auction panel; capture it on desktop and phone (and a bid resetting the clock). */
async function auctionShots(players, shot) {
  const [host, laptop, phone] = players;
  await phone.page.click('#tab-actions');
  for (const p of players) await p.page.waitForSelector(`${p.mobile ? '#mobile-auction' : '#center-auction'} .auction`);
  await shot(host, 'auction');
  await shot(phone, 'auction');
  // A bid from the laptop: the countdown bar jumps back to full on every page.
  const quick = await laptop.page.$('#center-auction .quick-bid:enabled');
  if (quick) {
    await quick.click();
    await waitIdle(laptop.page);
    await host.page.waitForSelector('#center-auction .auction-leader');
    await shot(host, 'auction-bid');
  }
  say('auction panel: tile, high bid, countdown, quick bids, custom amount and pass');
}

/** Desktop proposes in the builder, the laptop accepts from its Trades tab; the phone opens a builder. */
async function tradeScenario(players, shot) {
  const [host, laptop, phone] = players;
  for (const p of players) await closeCards(p.page);
  await openTab(host.page, 'trades');
  await host.page.click('[data-action="newTrade"]');
  await host.page.click(`.partner-btn:has-text("${laptop.name}")`);
  const theirs = await host.page.$('.builder-col:nth-child(2) input[type="checkbox"]:enabled');
  if (theirs) await theirs.check();
  await host.page.fill('.builder-col:nth-child(1) .input-num', '25');
  await host.page.press('.builder-col:nth-child(1) .input-num', 'Tab');
  await shot(host, 'trade-builder');
  await host.page.click('[data-action="proposeTrade"]');
  await host.page.waitForSelector('dialog.dialog-trade', { state: 'detached' });
  await host.page.waitForSelector('.trade-outgoing');

  await openTab(laptop.page, 'trades');
  await laptop.page.waitForSelector('.trade-incoming [data-action="acceptTrade"]');
  await shot(laptop, 'trade-incoming');
  await laptop.page.click('.trade-incoming [data-action="acceptTrade"]');
  await waitIdle(laptop.page);
  await host.page.waitForSelector('.trade-outgoing', { state: 'detached' });
  say(`trade: ${host.name} proposed in the builder, ${laptop.name} accepted from the Trades tab`);

  await openTab(phone.page, 'trades');
  await phone.page.click('[data-action="newTrade"]');
  await phone.page.click(`.partner-btn:has-text("${host.name}")`);
  await phone.page.waitForSelector('.builder-cols');
  await shot(phone, 'trade-builder');
  await phone.page.keyboard.press('Escape');
  await phone.page.click('#tab-actions');
  for (const p of [host, laptop]) await p.page.click('#tab-players');
}

/** Click a sidebar tab and let it repaint before any screenshot. */
async function openTab(page, tab) {
  await page.click(`#tab-${tab}`);
  await page.waitForFunction((t) => document.querySelector(`#tab-${t}`).getAttribute('aria-selected') === 'true', tab);
  await sleep(250);
}

async function midGameShots(players, shot, noSideScroll) {
  for (const p of players) {
    await closeCards(p.page);
    await shot(p, 'game-mid');
    await noSideScroll(p, 'game (mid)');
  }
  // Tile popup on the phone, for an owned city if there is one.
  const p3 = players[2];
  const owned = await p3.page.$('.tile.owned');
  await (owned || (await p3.page.$('[data-tile-id="new-york"]'))).click();
  await p3.page.waitForSelector('dialog.dialog-tile[open]');
  await shot(p3, 'tile-popup');
  await p3.page.keyboard.press('Escape');
}

main().catch(async (err) => {
  console.error(`\n✗ UI check failed: ${err.stack || err}`);
  if (errors.length) for (const e of errors.slice(0, 20)) console.error(`  - ${e}`);
  process.exit(1);
});
