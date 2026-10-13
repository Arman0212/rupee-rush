'use strict';

/**
 * Screenshots of a mid-game board in both themes, for reviewing the look.
 *
 *   node scripts/theme-shots.js [prefix=theme]
 *
 * Starts the real server in-process, seats two players (desktop 1440×900 and
 * phone 390×844), seeds some ownership, buildings and a mortgage so the board
 * isn't empty, then saves screenshots/<prefix>-<size>-<theme>.png. A second
 * set (<prefix>-<size>-<theme>-notes.png) shows toasts and a card banner.
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../server/index');
const { BOARD } = require('../shared/board');

const OUT = path.join(__dirname, '..', 'screenshots');
const PREFIX = process.argv[2] || 'theme';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Set the theme both ways: the stored preference (current UI) and the OS scheme (older UI). */
async function setTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => {
    try { localStorage.setItem('rr:theme', t); } catch { /* ignore */ }
    document.documentElement.dataset.theme = t;
  }, theme);
  await sleep(300);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = createServer({ log: { log() {}, info() {}, warn() {}, error: console.error } });
  const port = await server.listen(0);
  const base = `http://localhost:${port}`;
  const browser = await chromium.launch();
  try {
    const mk = async (width, height, mobile) => {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
      return ctx.newPage();
    };
    const desk = await mk(1440, 900, false);
    const phone = await mk(390, 844, true);

    await desk.goto(base);
    await desk.fill('#home-name', 'Asha');
    await desk.click('#home-create');
    await desk.waitForSelector('#screen-lobby:not([hidden])');
    const code = (await desk.textContent('#lobby-code')).trim();
    await phone.goto(`${base}/r/${code}`);
    await phone.fill('#home-name', 'Chitra');
    await phone.click('#home-join-btn');
    await phone.waitForSelector('#screen-lobby:not([hidden])');
    await desk.click('#lobby-start');
    for (const p of [desk, phone]) await p.waitForSelector('#screen-game:not([hidden])');

    // Seed a believable mid-game board.
    const state = server.manager.get(code).game.state;
    const a = state.players.find((p) => p.name === 'Asha');
    const c = state.players.find((p) => p.name === 'Chitra');
    const own = (index, player, extra = {}) => Object.assign(state.properties[BOARD[index].id], { ownerId: player.id, ...extra });
    own(1, a, { buildings: 2 }); own(3, a, { buildings: 3 });
    own(6, c); own(8, c); own(9, c, { buildings: 0 });
    own(5, a); own(15, a); own(12, c);
    own(21, c, { mortgaged: true }); own(26, a); own(31, c); own(39, a, { buildings: 5 }); own(37, a, { buildings: 4 });
    a.cash = 940; c.cash = 610;
    c.position = 24;
    // A real action carries the seeded state to both pages.
    const current = state.currentPlayerId === a.id ? desk : phone;
    if (current === phone && !(await phone.isVisible('#mobile-actions'))) await phone.click('#tab-actions');
    await current.click(`${current === phone ? '#mobile-actions' : '#center-actions'} [data-action="roll"]`);
    await sleep(1500);

    const shots = [[desk, '1440x900'], [phone, '390x844']];
    for (const theme of ['dark', 'light']) {
      for (const [page, label] of shots) {
        await page.evaluate(() => document.querySelectorAll('.toast, dialog.dialog-card').forEach((n) => n.remove()));
        await setTheme(page, theme);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(OUT, `${PREFIX}-${label}-${theme}.png`) });
        await page.evaluate(async () => {
          const mod = await import('/js/ui/toast.js');
          mod.toast('Chitra paid you ₹26 rent for a city.', { kind: 'good', timeout: 60_000 });
          mod.toast('You collected ₹200 salary.', { kind: 'info', timeout: 60_000 });
          const banner = mod.showCardBanner || mod.cardBanner;
          if (banner) banner({ deck: 'surprise', title: 'You drew Surprise', text: 'Wrong turn at the roundabout. Go back 3 spaces.', who: 'Asha' }, 60_000);
        });
        await sleep(400);
        await page.screenshot({ path: path.join(OUT, `${PREFIX}-${label}-${theme}-notes.png`) });
      }
    }
    console.log(`✓ saved ${PREFIX}-*.png to ${path.relative(process.cwd(), OUT)}/`);
  } finally {
    await browser.close();
    await server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
