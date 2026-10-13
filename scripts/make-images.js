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
const rules = require('../shared/rules');
const { GAME_NAME, GAME_TAGLINE } = rules;

const PUBLIC = path.join(__dirname, '..', 'public');
// Inlined: a page set with setContent may not load file:// fonts.
const font = (file) => `data:font/woff2;base64,${fs.readFileSync(path.join(PUBLIC, 'fonts', file)).toString('base64')}`;
const FONTS = `
  @font-face { font-family: 'Baloo 2'; font-weight: 500 800; src: url('${font('baloo2.woff2')}') format('woff2'); }
  @font-face { font-family: 'Inter'; font-weight: 400 700; src: url('${font('inter.woff2')}') format('woff2'); }`;

const coin = (size) => `
  <div style="width:${size}px;height:${size}px;border-radius:50%;display:grid;place-items:center;
    background:radial-gradient(circle at 35% 30%,#f7c548,#f2952c 60%,#c96a12);box-shadow:0 0 0 ${size * 0.04}px rgba(255,255,255,0.2),0 0 0 ${size * 0.07}px #6366f1">
    <div style="width:${size * 0.72}px;height:${size * 0.72}px;border-radius:50%;background:#1e1b4b;color:#fff;display:grid;place-items:center;
      font:800 ${size * 0.5}px/1 'Baloo 2'">₹</div>
  </div>`;

const OG = `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
  body { margin:0; width:1200px; height:630px; overflow:hidden; font-family:Inter; color:#f8fafc;
    background:
      radial-gradient(circle at 80% 20%, rgba(99, 102, 241, 0.25), transparent 50%),
      linear-gradient(135deg, #0b0f19 0%, #1e1b4b 60%, #0f172a 100%); }
  .wrap { position:absolute; inset:0; display:flex; align-items:center; gap:56px; padding:0 90px; }
  .glow { position:absolute; right:-100px; top:-60px; width:640px; height:640px; border-radius:50%; opacity:.4;
    background: radial-gradient(circle, #6366f1 0%, rgba(139, 92, 246, 0.3) 40%, transparent 70%); }
  h1 { font:800 120px/0.95 'Baloo 2'; color:#ffffff; margin:0; text-shadow: 0 4px 24px rgba(99, 102, 241, 0.4); }
  p { font:500 32px/1.3 Inter; color:#94a3b8; margin:18px 0 0; max-width:640px; }
  .tiles { display:flex; gap:12px; margin-top:34px; }
  .tile { width:82px; height:116px; border-radius:10px; background:#1e293b; border:2px solid #334155; overflow:hidden;
    font:700 15px/1.1 Inter; text-align:center; display:flex; flex-direction:column; box-shadow: 0 8px 16px rgba(0,0,0,0.4); }
  .tile span { flex:1; display:grid; place-items:center; padding:0 4px; color:#f8fafc; }
  .band { height:26px; }
</style></head><body><div class="glow"></div><div class="wrap">${coin(260)}<div>
  <h1>${GAME_NAME}</h1><p>${GAME_TAGLINE}</p>
  <div class="tiles">${[['#ef4444', 'Shanghai'], ['#f59e0b', 'Paris'], ['#10b981', 'London'], ['#3b82f6', 'New York'], ['#ec4899', 'Rome']]
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
