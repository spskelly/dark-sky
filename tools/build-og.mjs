// regenerates og.png, the social card, with tonight's actual moon on it.
//
// the phase is not recomputed here. the script loads index.html in a real
// browser and calls the page's own lunationFraction() / moonSvg() / phaseWord(),
// so the card can never drift from the calendar it advertises. external hosts
// (leaflet, fonts, open-meteo, tiles) are blocked: the page degrades cleanly and
// the astronomy is pure maths that needs no network.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'og.png');
const PORT = 8977;

const b64 = f => fs.readFileSync(path.join(ROOT, 'node_modules', f)).toString('base64');
const FONT = {
  serif: b64('@fontsource/fraunces/files/fraunces-latin-300-normal.woff2'),
  serifItalic: b64('@fontsource/fraunces/files/fraunces-latin-300-italic.woff2'),
  sans: b64('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2'),
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
// everything off-origin is blocked; we only need the page's own script to evaluate
await page.route('**/*', route =>
  route.request().url().startsWith(`http://127.0.0.1:${PORT}`)
    ? route.continue()
    : route.abort());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof moonSvg === 'function');

// ask the page what the sky is doing, using the same functions the calendar uses
const sky = await page.evaluate(() => {
  const now = new Date();
  const p = lunationFraction(now);
  const half = Math.floor(state.win / 2);
  const upcoming = phasesBetween(now, addDays(now, 60));
  const nextNew = upcoming.find(e => e.phase === 0);
  const recent = phasesBetween(addDays(now, -(half + 1)), now).filter(e => e.phase === 0).pop();
  const anchor = recent && now < addDays(addDays(recent.date, half), 1) ? recent : nextNew;
  const ws = addDays(anchor.date, -half), we = addDays(anchor.date, half);
  const inWindow = now >= new Date(ws.getFullYear(), ws.getMonth(), ws.getDate()) && now < addDays(we, 1);
  const md = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return {
    svg: moonSvg(p, 500, 'N'),
    phase: phaseWord(p),
    illum: Math.round((1 - Math.cos(2 * Math.PI * p)) / 2 * 100),
    window: inWindow
      ? `dark-sky window now, through ${md(we)}`
      : `next dark-sky window ${md(ws)}–${we.getMonth() === ws.getMonth() ? we.getDate() : md(we)}`,
  };
});

// deterministic starfield, kept clear of the copy
let seed = 20260912;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const TEXT = { x0: 580, x1: 1160, y0: 140, y1: 520 };
let stars = '', placed = 0;
for (let i = 0; placed < 80 && i < 4000; i++) {
  const x = Math.round(600 + rnd() * 580), y = Math.round(rnd() * 630);
  if (x > TEXT.x0 && x < TEXT.x1 && y > TEXT.y0 && y < TEXT.y1) continue;
  stars += `<circle cx="${x}" cy="${y}" r="${(rnd() * 1.7 + 0.5).toFixed(1)}" fill="#ece7d4" opacity="${(rnd() * 0.45 + 0.15).toFixed(2)}"/>`;
  placed++;
}

const card = `<style>
@font-face{font-family:F;src:url(data:font/woff2;base64,${FONT.serif}) format("woff2");font-weight:300}
@font-face{font-family:F;src:url(data:font/woff2;base64,${FONT.serifItalic}) format("woff2");font-weight:300;font-style:italic}
@font-face{font-family:P;src:url(data:font/woff2;base64,${FONT.sans}) format("woff2")}
*{margin:0;box-sizing:border-box}
body{--moon:#ece7d4;width:1200px;height:630px;background:#0f1a34;overflow:hidden;position:relative;font-family:P,sans-serif}
svg.bg{position:absolute;inset:0}
.moon{position:absolute;left:50px;top:65px;width:500px;height:500px;filter:drop-shadow(0 0 40px rgba(236,231,212,.20))}
.moon svg{display:block;width:500px;height:500px}
.txt{position:absolute;left:600px;top:0;width:545px;height:630px;display:flex;flex-direction:column;justify-content:center;gap:16px}
h1{font-family:F,serif;font-weight:300;font-size:70px;line-height:1.02;color:#d5dbea;letter-spacing:-.01em}
h1 em{font-style:italic;color:#ece7d4}
.phase{font-size:25px;color:#ece7d4}
.phase span{color:#8b96b3}
p{font-size:21px;line-height:1.5;color:#8b96b3;max-width:34ch}
.win{display:inline-flex;align-items:center;gap:10px;font-size:21px;color:#5fc2ad}
.win i{width:11px;height:11px;border-radius:50%;background:#5fc2ad;display:block;flex:none}
.url{position:absolute;left:600px;bottom:46px;font-size:17px;color:#a9a58f;letter-spacing:.02em}
</style>
<svg class="bg" viewBox="0 0 1200 630">
  <defs><radialGradient id="g" cx="25%" cy="50%" r="42%">
    <stop offset="0%" stop-color="#ece7d4" stop-opacity="0.15"/><stop offset="100%" stop-color="#ece7d4" stop-opacity="0"/>
  </radialGradient></defs>
  <rect width="1200" height="630" fill="#0f1a34"/>${stars}
  <circle cx="300" cy="315" r="360" fill="url(#g)"/>
</svg>
<div class="moon">${sky.svg}</div>
<div class="txt">
  <h1>dark sky<br><em>calendar</em></h1>
  <div class="phase">tonight: ${sky.phase} <span>· ${sky.illum}% lit</span></div>
  <p>every new-moon window for the next twelve months, tonight's cloud cover hour by hour, and 20 dark places to point a lens from.</p>
  <span class="win"><i></i>${sky.window}</span>
</div>
<div class="url">spskelly.github.io/dark-sky</div>`;

const shot = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await shot.setContent(card, { waitUntil: 'load' });
await shot.evaluate(() => document.fonts.ready);
await shot.waitForTimeout(300);
await shot.screenshot({ path: OUT });

await browser.close();
server.close();
console.log(`og.png: ${sky.phase}, ${sky.illum}% lit — ${sky.window}`);
