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
//   node tools/find-lp-tiles.mjs                     # look, report, change nothing
//   node tools/find-lp-tiles.mjs --fix               # ... and write the winner in
//   node tools/find-lp-tiles.mjs --url '<tpl>' --fix # skip the search, use this one
//   node tools/find-lp-tiles.mjs --year 2022        # pin an atlas year, newest wins by default
//
// three passes, cheapest and most certain first.
//
//   1. a github pages site is served straight out of a public repo, so the
//      file layout can be *read* through the contents api instead of guessed
//      at. one real tile filename is all this needs.
//   2. failing that, read the site's own pages — dumping the small ones whole,
//      because a 300-byte page is a signpost to somewhere else, not content —
//      and follow where they point.
//   3. only then try the shapes tile sets of this kind usually take.
//
// a filename says which numbers are in it but not which is z, which is x and
// which is y, so the last step is always the same: put them in every way
// round and let the network say which one is right.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'index.html');

// overridable only so the tests can point these at a local stand-in
const HOST = process.env.LP_HOST || 'https://djlorenz.github.io';
const GH_API = process.env.LP_GH_API || 'https://api.github.com';

// a user's github pages site is the repo <user>.github.io in their account
const REPO = new URL(HOST).hostname.replace(/\.github\.io$/, '') + '/' + new URL(HOST).hostname;
const BASE = 'astronomy';   // where the atlases live on the site

// two places far apart, both with enough sky glow that a missing tile means
// the url is wrong rather than that the tile was never drawn — these sets
// often ship nothing at all for empty ocean. a template has to work for both,
// which is what rules out x and y being the right numbers the wrong way round.
const PROBES = [
  { name: 'asheville', lat: 35.5951, lon: -82.5515 },
  { name: 'phoenix', lat: 33.4484, lon: -112.0740 },
];
const SWEEP = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MIN_HITS = 3;          // per probe, before a template is believed
const DUMP_UNDER = 4096;     // a page this small is a signpost; print it whole
const MAX_PAGES = 30;
const HEADERS = { 'user-agent': 'dark-sky-calendar tools (+https://github.com/spskelly/dark-sky)' };

// --- the shapes to try, when reading turns nothing up -----------------------
const PATHS = ['overlay/tiles/', 'tiles/', 'overlay/', 'map/tiles/', ''];
const NAMES = [
  'tile_{z}_{x}_{y}.png', 'tile_{z}_{x}_{-y}.png', 'tile_{z}_{y}_{x}.png',
  '{z}/{x}/{y}.png', '{z}/{x}/{-y}.png', '{z}_{x}_{y}.png', 'tile_{z}_{x}_{y}.jpg',
];

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const WANT_YEAR = +(opt('--year') || 0);

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
function expand(tpl, z, at = PROBES[0]) {
  const { x, y, n } = tile(at.lat, at.lon, z);
  return tpl.replace(/\{z\}/g, z).replace(/\{x\}/g, x)
    .replace(/\{-y\}/g, n - 1 - y).replace(/\{y\}/g, y);
}

async function get(url, extra) {
  try {
    const res = await fetch(url, { headers: { ...HEADERS, ...extra }, redirect: 'follow' });
    return { ok: res.ok, status: res.status, type: res.headers.get('content-type') || '', res };
  } catch (e) {
    return { ok: false, status: 0, type: '', why: e.message };
  }
}

// github pages answers a missing file with a 404 *page*, so a 200 is not
// enough on its own — it has to actually be an image
const isTile = r => r.ok && /^image\//.test(r.type);

// a template is believed only when it holds at several zooms in both places
async function verify(tpl) {
  const hits = {};
  for (const at of PROBES) {
    hits[at.name] = [];
    for (const z of SWEEP) if (isTile(await get(expand(tpl, z, at)))) hits[at.name].push(z);
    if (hits[at.name].length < MIN_HITS) return null;
  }
  return hits;
}

// --- pass one: read the repo the site is served from ------------------------
let apiCalls = 0;
async function ls(p) {
  if (apiCalls++ > 24) return null;          // unauthenticated api allows 60/hour
  const r = await get(`${GH_API}/repos/${REPO}/contents/${p}`, { accept: 'application/vnd.github+json' });
  if (r.status === 403) { console.log('  github api is rate limiting; try again in an hour'); return null; }
  if (!r.ok) return null;
  const j = await r.res.json().catch(() => null);
  return Array.isArray(j) ? j : null;
}

// which folder to open first. the site keeps several atlases side by side and
// the same tiles twice — once as images, once as packed binary for its own
// viewer — so walking in alphabetical order lands on nine-year-old sky glow
// inside a folder that is not even images. newest first, images before
// binaries, anything named for tiles before anything not.
const yearOf = n => +((n.match(/(?:19|20)\d{2}/) || [0])[0]);
function rank(name) {
  return [
    /tile/i.test(name) ? 0 : 1,
    /binary/i.test(name) ? 1 : 0,
    -yearOf(name),
    name,
  ];
}
const byPreference = (a, b) => {
  const x = rank(a.name), y = rank(b.name);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

// a numbered folder is a zoom level — start low, there are fewer tiles — but
// the same site numbers folders by year, and there the newest is the one worth
// having. the range tells them apart.
const isYear = n => +n >= 1900 && +n <= 2100;
const byNumber = (a, b) =>
  isYear(a.name) && isYear(b.name) ? +b.name - +a.name : +a.name - +b.name;

const TILEISH = /\d+\D+\d+\D+\d+\.(?:png|jpe?g|webp)$/i;
const NUMERIC = /^\d+$/;

// walk down until a file with three numbers in its name turns up, following
// numbered folders as readily as named ones: {z}/{x}/{y}.png is a directory
// tree, tile_z_x_y.png is a flat one, and this finds either.
async function findSample(dir, depth = 0) {
  if (depth > 4) return null;
  const entries = await ls(dir);
  if (!entries) return null;
  const files = entries.filter(e => e.type === 'file');
  const dirs = entries.filter(e => e.type === 'dir');
  console.log(`  ${dir}/ — ${dirs.length} folder(s), ${files.length} file(s)` +
    (depth === 0 || entries.length <= 12 ? `: ${entries.map(e => e.name).slice(0, 12).join(', ')}` : ''));

  const hit = files.find(f => TILEISH.test(f.name));
  if (hit) return { dir, name: hit.name };

  // a numbered folder is a zoom level; a lone image under one is the tile
  const numeric = dirs.filter(d => NUMERIC.test(d.name)).sort(byNumber);
  for (const d of numeric.slice(0, 2)) {
    const deeper = await findSample(`${dir}/${d.name}`, depth + 1);
    if (deeper) return deeper;
    // the leaf may be a bare number: 6.png under {z}/{x}/
    const inner = await ls(`${dir}/${d.name}`);
    const img = inner && inner.find(e => e.type === 'file' && /\.(png|jpe?g|webp)$/i.test(e.name));
    if (img) return { dir: `${dir}/${d.name}`, name: img.name };
  }
  const named = dirs.filter(d => !NUMERIC.test(d.name)).sort(byPreference);
  const years = [...new Set(named.map(d => yearOf(d.name)).filter(Boolean))].sort((a, b) => b - a);
  if (years.length > 1) console.log(`    years here: ${years.join(', ')} — taking ${years[0]}`);
  for (const d of (WANT_YEAR ? named.filter(d => yearOf(d.name) === WANT_YEAR || !yearOf(d.name)) : named).slice(0, 4)) {
    const deeper = await findSample(`${dir}/${d.name}`, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

// the filename says which numbers are there, not what they mean. put z, x and
// y into the slots every way round and hand the lot to the network.
function templatesFrom(dir, name) {
  const rel = `${dir}/${name}`.replace(/^\/+/, '');
  const parts = rel.split(/(\d+)/);
  const slots = parts.reduce((a, p, i) => (/^\d+$/.test(p) ? [...a, i] : a), []);
  if (slots.length < 3) return [];
  // when a path carries more than three numbers, the last three are the tile
  const use = slots.slice(-3);
  const perms = [['z', 'x', 'y'], ['z', 'y', 'x'], ['x', 'y', 'z'], ['y', 'x', 'z'], ['x', 'z', 'y'], ['y', 'z', 'x']];
  const out = new Set();
  for (const perm of perms) for (const flip of [false, true]) {
    const c = parts.slice();
    perm.forEach((k, n) => { c[use[n]] = k === 'y' && flip ? '{-y}' : `{${k}}`; });
    out.add(`${HOST}/${c.join('')}`);
  }
  return [...out];
}

// --- pass two: read the site's own pages ------------------------------------
const HINTS = [
  /getTileUrl[\s\S]{0,400}?\n\s*\}/g,
  /["'`][^"'`\n]{0,140}tiles?[^"'`\n]{0,140}\.(?:png|jpe?g|webp)[^"'`\n]{0,40}["'`]/gi,
];

// a page can point somewhere without linking a tile: a meta refresh, a frame,
// or just a link to the real map. follow all three.
function pointsTo(html, from) {
  const out = [];
  const add = h => { try { const u = new URL(h, from).href; if (u.startsWith(HOST)) out.push(u); } catch {} };
  for (const m of html.matchAll(/<meta[^>]+http-equiv=["']?refresh[^>]*content=["'][^"']*url=([^"';\s]+)/gi)) add(m[1]);
  for (const m of html.matchAll(/<(?:script|iframe|frame)[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) if (/\.html?$|\/$/i.test(m[1])) add(m[1]);
  return [...new Set(out)];
}

async function readSite(fromCode) {
  const seen = new Set();
  const queue = [`${HOST}/${BASE}/`];
  for (const f of ['lp2024', 'lp2023', 'lp2022', 'lp2021', 'lp2020', 'lp2016'])
    queue.push(`${HOST}/${BASE}/${f}/`);

  const found = [];
  while (queue.length && seen.size < MAX_PAGES) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await get(url);
    if (!r.ok) continue;
    if (/^image\//.test(r.type)) continue;
    const body = await r.res.text();
    console.log(`  read ${url} — ${(body.length / 1024).toFixed(1)} kB`);
    // a page this small is a signpost, not content. print it whole: that is
    // the thing the first version of this script threw away.
    if (body.length < DUMP_UNDER)
      console.log(body.split('\n').map(l => '    | ' + l).join('\n'));
    for (const re of HINTS)
      for (const m of body.matchAll(re))
        found.push({ url, text: m[0].replace(/\s+/g, ' ').trim().slice(0, 300) });
    for (const t of templatesFromCode(body, url)) fromCode.push(t);
    if (/\.html?$|\/$/i.test(url)) for (const next of pointsTo(body, url)) queue.push(next);
  }
  return found;
}

// a page that builds its tile url in javascript has already told us the
// answer; turn the concatenation into a template rather than printing it for
// somebody to read. "dat/" + z + "_" + c.x + "_" + c.y + ".png" becomes
// dat/{z}_{x}_{y}.png, and verify() is what decides whether the reading was
// right, so a misparse costs nothing.
function templatesFromCode(code, from) {
  const out = new Set();
  for (const m of code.matchAll(/(["'])[^"'\n]*\1(?:\s*\+\s*[^+;\n]+)+/g)) {
    const expr = m[0];
    if (!/\.(?:png|jpe?g|webp)/i.test(expr)) continue;
    let rel = '', ok = true;
    for (let part of expr.split('+')) {
      part = part.trim();
      const lit = /^(["'])([^"']*)\1$/.exec(part);
      if (lit) { rel += lit[2]; continue; }
      // a y built by subtracting from the row count is the tms flip
      if (/\by\b/i.test(part) && /-/.test(part)) { rel += '{-y}'; continue; }
      const id = (part.match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1] || '';
      if (/^zoom$|^z$/i.test(id)) rel += '{z}';
      else if (/^x$/i.test(id)) rel += '{x}';
      else if (/^y$/i.test(id)) rel += '{y}';
      else { ok = false; break; }
    }
    if (!ok || !/\{z\}/.test(rel) || !/\{x\}/.test(rel) || !/\{-?y\}/.test(rel)) continue;
    // new URL() percent-encodes the braces; leaflet needs them back
    try { out.add(new URL(rel, from).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}')); } catch {}
  }
  return [...out];
}

// --- pass three: the usual shapes -------------------------------------------
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function blindSearch(dirs) {
  const tpls = [];
  for (const d of dirs) for (const p of PATHS) for (const n of NAMES)
    tpls.push(`${HOST}/${BASE}/${d}/${p}${n}`.replace(/([^:])\/\/+/g, '$1/'));
  console.log(`trying ${tpls.length} shapes at zoom 4…`);
  const screened = await pool(tpls, 6, async t => isTile(await get(expand(t, 4))) ? t : null);
  return screened.filter(Boolean);
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
  const home = tpl.match(/^(https?:\/\/[^/]+\/astronomy\/[^/]+\/)/);
  if (home) next = next.replace(
    /(href=")https:\/\/djlorenz\.github\.io\/astronomy\/[^"]*(" target="_blank" rel="noopener">D\. Lorenz)/,
    `$1${home[1]}$2`);

  if (maxNative != null) next = next.replace(/maxNativeZoom: \d+/, `maxNativeZoom: ${maxNative}`);

  if (next === html) { console.log('index.html already says this'); return; }
  fs.writeFileSync(FILE, next);
  console.log('index.html updated');
}

async function believe(tpls, label) {
  for (const t of tpls) {
    const hits = await verify(t);
    if (hits) return { tpl: t, hits, label };
  }
  return null;
}

// --- go ---------------------------------------------------------------------
let win = null;

const given = opt('--url');
if (given) {
  console.log('checking the url you gave…');
  win = await believe([given], 'you');
  if (!win) {
    console.log(`\nno tile came back from ${given}`);
    for (const z of [4, 6, 8]) console.log(`  tried ${expand(given, z)}`);
    process.exit(1);
  }
} else {
  console.log(`reading the layout of ${REPO}…`);
  const sample = await findSample(BASE);
  if (sample) {
    console.log(`\n  a real tile: ${sample.dir}/${sample.name}`);
    win = await believe(templatesFrom(sample.dir, sample.name), 'the repo listing');
  } else {
    console.log('  could not read the layout');
  }

  if (!win) {
    console.log('\nreading the site\'s own pages…');
    const fromCode = [];
    const found = await readSite(fromCode);
    if (found.length) {
      console.log('\nthe site names these tile files:');
      const seen = new Set();
      for (const f of found) {
        if (seen.has(f.text)) continue;
        seen.add(f.text);
        console.log(`  ${f.text}\n    (on ${f.url})`);
      }
    }
    if (fromCode.length) {
      console.log(`\nthe site's own code builds tile urls like this:`);
      for (const t of fromCode) console.log(`  ${t}`);
      win = await believe(fromCode, "the site's own code");
    }

    if (win) { /* read, not guessed */ } else {
    console.log('');
    const hits = await blindSearch(['lp2024', 'lp2023', 'lp2022', 'lp2021', 'lp2020', 'lp2016']);
    win = await believe(hits, 'the shape search');
    }
  }
}

if (!win) {
  console.log('\nnothing answered with an image at both probe points.');
  console.log('open the overlay in a browser, watch the network tab, and pass one');
  console.log('working tile url back with the numbers replaced:');
  console.log("  node tools/find-lp-tiles.mjs --url 'https://…/{z}/{x}/{y}.png' --fix");
  process.exit(1);
}

const zooms = [...new Set(Object.values(win.hits).flat())].sort((a, b) => a - b);
const maxNative = Math.max(...zooms);
console.log(`\nfound by ${win.label}: ${win.tpl}`);
for (const [where, zs] of Object.entries(win.hits)) console.log(`  ${where}: zooms ${zs.join(', ')}`);
console.log(`maxNativeZoom: ${maxNative}`);
console.log(`sample: ${expand(win.tpl, Math.min(8, maxNative))}`);

if (!flag('--fix')) { console.log('\nnothing written. add --fix to put it in index.html'); process.exit(0); }
applyFix(win.tpl, maxNative);
