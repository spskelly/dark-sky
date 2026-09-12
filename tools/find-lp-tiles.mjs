// finds where the light pollution tiles actually live, and writes that into
// index.html.
//
// the overlay is somebody else's static tile set on github pages. it gets
// republished under a new folder every few years — lp2016, lp2020, lp2022 —
// and when it moves, every tile the page asks for comes back 404 and the layer
// turns itself off. this script runs from a machine that can reach the host
// and finds the url that works now, so the fix is a command rather than a
// guess at a path.
//
//   node tools/find-lp-tiles.mjs                     # search, report, change nothing
//   node tools/find-lp-tiles.mjs --fix               # ... and write the winner in
//   node tools/find-lp-tiles.mjs --url '<tpl>' --fix # skip the search, use this one
//
// two passes. first it reads the overlay's own page and the scripts that page
// loads, and pulls out the code that builds a tile url — that is the answer
// rather than a guess at it. only when nothing turns up does it fall back to
// trying the shapes tile sets of this kind usually take.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'index.html');
const HOST = 'https://djlorenz.github.io';

// newest first, so a live older folder never wins over the current one
const FOLDERS = ['lp2024', 'lp2023', 'lp2022', 'lp2021', 'lp2020', 'lp2016'];

// asheville: somewhere with enough sky glow that a missing tile means the url
// is wrong rather than that the tile was never drawn. these sets often ship
// nothing at all for empty ocean, so probing the atlantic would prove nothing.
const PROBE = { lat: 35.5951, lon: -82.5515 };
const SCREEN_Z = 4;              // cheap first pass: every set has low zooms
const SWEEP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const HEADERS = { 'user-agent': 'dark-sky-calendar tools (+https://github.com/spskelly/dark-sky)' };

// --- the shapes to try, when reading the source turns nothing up ------------
const PATHS = ['overlay/tiles/', 'tiles/', 'overlay/', ''];
const NAMES = [
  'tile_{z}_{x}_{y}.png',
  'tile_{z}_{x}_{-y}.png',
  'tile_{z}_{y}_{x}.png',
  '{z}/{x}/{y}.png',
  '{z}/{x}/{-y}.png',
  '{z}_{x}_{y}.png',
  'tile_{z}_{x}_{y}.jpg',
];

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };

// --- tiles ------------------------------------------------------------------
function tile(lat, lon, z) {
  const n = 2 ** z;
  const r = lat * Math.PI / 180;
  return {
    x: Math.floor((lon + 180) / 360 * n),
    y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n),
    n,
  };
}

// leaflet's own placeholders, so whatever wins pastes straight into the page.
// {-y} is the tms flip, which leaflet expands by itself.
function expand(tpl, z) {
  const { x, y, n } = tile(PROBE.lat, PROBE.lon, z);
  return tpl.replace(/\{z\}/g, z).replace(/\{x\}/g, x)
    .replace(/\{-y\}/g, n - 1 - y).replace(/\{y\}/g, y);
}

async function get(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    return { ok: res.ok, status: res.status, type: res.headers.get('content-type') || '', res };
  } catch (e) {
    return { ok: false, status: 0, type: '', why: e.message };
  }
}

// github pages answers a missing file with a 404 *page*, so a 200 is not
// enough on its own — it has to actually be an image
const isTile = r => r.ok && /^image\//.test(r.type);

// --- pass one: read the overlay's own code ----------------------------------
const HINTS = [
  /getTileUrl[\s\S]{0,400}?\n\s*\}/g,
  /["'`][^"'`\n]{0,140}tiles?[^"'`\n]{0,140}\.(?:png|jpe?g|webp)[^"'`\n]{0,40}["'`]/gi,
];

async function readSource() {
  const pages = [];
  for (const f of FOLDERS) pages.push(`${HOST}/astronomy/${f}/overlay/`, `${HOST}/astronomy/${f}/`);
  pages.push(`${HOST}/astronomy/`);

  const seen = new Set();
  const found = [];
  for (const url of pages) {
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await get(url);
    if (!r.ok) continue;
    const html = await r.res.text();
    console.log(`  read ${url} — ${(html.length / 1024).toFixed(1)} kB`);
    const bodies = [html];
    // the url builder lives in a loaded script about as often as in the page
    for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
      let src;
      try { src = new URL(m[1], url).href; } catch { continue; }
      if (!src.startsWith(HOST) || seen.has(src)) continue;
      seen.add(src);
      const s = await get(src);
      if (!s.ok) continue;
      bodies.push(await s.res.text());
      console.log(`  read ${src}`);
    }
    for (const body of bodies)
      for (const re of HINTS)
        for (const m of body.matchAll(re))
          found.push({ url, text: m[0].replace(/\s+/g, ' ').trim().slice(0, 300) });
  }
  return found;
}

// --- pass two: try the usual shapes -----------------------------------------
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function search() {
  const tpls = [];
  for (const f of FOLDERS) for (const p of PATHS) for (const n of NAMES)
    tpls.push(`${HOST}/astronomy/${f}/${p}${n}`);

  console.log(`trying ${tpls.length} shapes at zoom ${SCREEN_Z}…`);
  const screened = await pool(tpls, 6, async tpl => isTile(await get(expand(tpl, SCREEN_Z))) ? tpl : null);
  return screened.filter(Boolean);
}

// how deep the set goes is worth knowing for its own sake: maxNativeZoom has
// to match it, or leaflet asks for tiles that were never drawn and the layer
// looks broken at exactly the zoom someone uses to pick a spot.
async function depth(tpl) {
  const hits = [];
  for (const z of SWEEP) if (isTile(await get(expand(tpl, z)))) hits.push(z);
  return hits;
}

// --- writing it back --------------------------------------------------------
function applyFix(tpl, maxNative) {
  const html = fs.readFileSync(FILE, 'utf8');
  let next = html;

  const line = /const LP_TILES = '[^']*';/;
  if (!line.test(next)) throw new Error('could not find the LP_TILES line in index.html');
  next = next.replace(line, `const LP_TILES = '${tpl}';`);

  // the credit has to point at the folder the tiles came from, not the one
  // that moved out from under it
  const home = tpl.match(/^(https:\/\/djlorenz\.github\.io\/astronomy\/[^/]+\/)/);
  if (home) next = next.replace(
    /(href=")https:\/\/djlorenz\.github\.io\/astronomy\/[^"]*(" target="_blank" rel="noopener">D\. Lorenz)/,
    `$1${home[1]}$2`);

  if (maxNative != null) next = next.replace(/maxNativeZoom: \d+/, `maxNativeZoom: ${maxNative}`);

  if (next === html) { console.log('index.html already says this'); return; }
  fs.writeFileSync(FILE, next);
  console.log('index.html updated');
}

// --- go ---------------------------------------------------------------------
const given = opt('--url');
let winner = null, zooms = null;

if (given) {
  console.log(`checking the url you gave…`);
  zooms = await depth(given);
  if (!zooms.length) {
    console.log(`\nno tile came back from ${given}`);
    console.log(`tried: ${SWEEP.map(z => expand(given, z)).slice(0, 3).join('\n       ')}`);
    process.exit(1);
  }
  winner = given;
} else {
  console.log('reading the overlay\'s own pages…');
  const found = await readSource();
  if (found.length) {
    console.log(`\nthe overlay builds its tile urls like this:`);
    const seen = new Set();
    for (const f of found) {
      if (seen.has(f.text)) continue;
      seen.add(f.text);
      console.log(`\n  from ${f.url}\n  ${f.text}`);
    }
    console.log('\nif that names a path this script did not try, re-run with');
    console.log("  node tools/find-lp-tiles.mjs --url '<the url, with {z} {x} {y} in it>' --fix");
  } else {
    console.log('  nothing in the pages named a tile file');
  }

  console.log('');
  const hits = await search();
  if (!hits.length) {
    console.log('\nnone of the usual shapes answered with an image.');
    console.log('open the overlay in a browser, watch the network tab, and pass');
    console.log('one working tile url back with --url (put {z} {x} {y} in place');
    console.log('of the numbers).');
    process.exit(1);
  }
  winner = hits[0];
  if (hits.length > 1) {
    console.log(`\n${hits.length} shapes answered; taking the newest folder:`);
    for (const h of hits) console.log(`  ${h}`);
  }
  zooms = await depth(winner);
}

const maxNative = zooms.length ? Math.max(...zooms) : null;
console.log(`\nworks: ${winner}`);
console.log(`zooms with tiles: ${zooms.join(', ')}  → maxNativeZoom: ${maxNative}`);
console.log(`sample: ${expand(winner, Math.min(8, maxNative ?? 8))}`);

if (!flag('--fix')) { console.log('\nnothing written. add --fix to put it in index.html'); process.exit(0); }
applyFix(winner, maxNative);
