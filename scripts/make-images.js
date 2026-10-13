'use strict';

/**
 * Renders the link-preview image and PNG icons into public/ with headless
 * Chromium (dev only; the results are committed, so production never needs
 * Playwright).
 *
 *   node scripts/make-images.js
 */

const path = require('node:path');
const { chromium } = require('playwright');

const fs = require('node:fs');

const PUBLIC = path.join(__dirname, '..', 'public');
// Inlined: a page set with setContent may not load file:// fonts.
const font = (file) => `data:font/woff2;base64,${fs.readFileSync(path.join(PUBLIC, 'fonts', file)).toString('base64')}`;
const FONTS = `
  @font-face { font-family: 'Baloo 2'; font-weight: 500 800; src: url('${font('baloo2.woff2')}') format('woff2'); }
  @font-face { font-family: 'Inter'; font-weight: 400 700; src: url('${font('inter.woff2')}') format('woff2'); }`;

const coin = (size) => `
  <div style="width:${size}px;height:${size}px;border-radius:50%;display:grid;place-items:center;
    background:radial-gradient(circle at 35% 30%,#f7c548,#f2952c 60%,#c96a12);box-shadow:0 0 0 ${size * 0.04}px #fffaf0,0 0 0 ${size * 0.07}px #0f7c74">
    <div style="width:${size * 0.72}px;height:${size * 0.72}px;border-radius:50%;background:#2f3a8f;color:#fff;display:grid;place-items:center;
      font:800 ${size * 0.5}px/1 'Baloo 2'">₹</div>
  </div>`;

const OG = `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
  body { margin:0; width:1200px; height:630px; overflow:hidden; font-family:Inter; color:#2b2118;
    background:
      radial-gradient(circle at 1px 1px, #ecdcbc 1.5px, transparent 2px) 0 0/22px 22px,
      linear-gradient(135deg,#fbf3e2,#f2e2c2); }
  .wrap { position:absolute; inset:0; display:flex; align-items:center; gap:56px; padding:0 90px; }
  .rangoli { position:absolute; right:-140px; top:-90px; width:640px; height:640px; border-radius:50%; opacity:.55;
    background:
      radial-gradient(circle, transparent 0 14%, #f2952c 14.5% 15.5%, transparent 16% 27%, #0f7c74 27.5% 28.2%, transparent 28.7% 47%, #f2952c 47.5% 48.2%, transparent 48.7%),
      repeating-conic-gradient(rgb(242 149 44 / .3) 0 6deg, transparent 6deg 15deg),
      radial-gradient(circle, rgb(247 197 72 / .4) 0 13%, transparent 13.5%); }
  h1 { font:800 120px/0.95 'Baloo 2'; color:#2f3a8f; margin:0; }
  p { font:500 34px/1.3 Inter; color:#6a5b49; margin:18px 0 0; max-width:620px; }
  .tiles { display:flex; gap:10px; margin-top:34px; }
  .tile { width:78px; height:110px; border-radius:10px; background:#fdf8ec; border:2px solid #e3d2ae; overflow:hidden;
    font:700 15px/1.1 Inter; text-align:center; display:flex; flex-direction:column; }
  .tile span { flex:1; display:grid; place-items:center; padding:0 4px; }
  .band { height:26px; }
</style></head><body><div class="rangoli"></div><div class="wrap">${coin(260)}<div>
  <h1>Rupee Rush</h1><p>Buy, build, bid and trade your way across India's cities.</p>
  <div class="tiles">${[['#d93a3a', 'Goa'], ['#f2c94c', 'Pune'], ['#2e9e5b', 'Thane'], ['#2f4aa8', 'Mumbai'], ['#d9529b', 'Kochi']]
    .map(([c, n]) => `<div class="tile"><div class="band" style="background:${c}"></div><span>${n}</span></div>`).join('')}</div>
</div></div></body></html>`;

const ICON = (size) => `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
  body { margin:0; width:${size}px; height:${size}px; display:grid; place-items:center; background:transparent; }</style></head>
  <body>${coin(Math.round(size * 0.86))}</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const shoot = async (html, width, height, file, transparent = false) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(PUBLIC, file), omitBackground: transparent });
    await page.close();
    console.log(`  ✓ public/${file}`);
  };
  await shoot(OG, 1200, 630, 'og-image.png');
  await shoot(ICON(32), 32, 32, 'favicon-32.png', true);
  await shoot(ICON(180).replace('background:transparent', 'background:#2f3a8f'), 180, 180, 'apple-touch-icon.png');
  await browser.close();
})();
