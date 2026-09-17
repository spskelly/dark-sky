// samples the light pollution atlas at every spot, and in a ring around it, so
// the spot notes can say what the sky is actually like instead of what someone
// remembered.
//
//   node tools/build-skyglow.mjs              # sample and report
//   node tools/build-skyglow.mjs --fix        # write the block into index.html
//   node tools/build-skyglow.mjs --check      # compare the block with the page,
//                                             # exit 1 if they differ, 0 if not
//   node tools/build-skyglow.mjs --json sky.json
//   node tools/build-skyglow.mjs --html some/copy.html   # read that page, not index.html
//   node tools/build-skyglow.mjs --refetch     # ask the host again for every tile,
//                                              # for the tiles recorded as missing,
//                                              # and for the legend pages
//
// --check is the staleness guard for both sky blocks: move a spot or rebuild
// the overlook list and the sampled colours change, and this is what says so.
// It needs a warm tile cache or --replay, since a check that reaches the
// network is a check nobody runs. --check and --fix together is an error.
//
// the atlas ships as png tiles coloured by sky brightness, so reading it means
// reading pixels. that is what tools/png.mjs is for: node ships zlib, a png is
// a zlib stream plus five row filters, and decoding one here keeps this script
// runnable on a bare node install like every other tool in this repo. needing
// a headless browser to read three tiles would not be worth it.
//
// this writes nothing into index.html. the scale below was not guessed from
// what the colours look like: it is fixed by a transect walking into asheville
// and checked on every run against a dozen places whose skies are not in
// question, from the sahara to manhattan. if any of them steps backwards the
// run says so. what a band means in mag/arcsec2 is still the atlas author's
// business, so the run also prints his own two legend pages verbatim.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opt = n => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
const has = n => process.argv.includes(n);
// --html is what makes --check testable: a temp copy of the page with one
// coordinate nudged has to be checkable without touching the real one
const FILE = opt('--html') ? path.resolve(opt('--html')) : path.join(ROOT, 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
if (has('--check') && has('--fix')) throw new Error('--check and --fix are opposites: pass one or the other');
// a run can be replayed from saved samples instead of fetched. the wording
// below is the part most likely to need another pass, and re-reading ten tiles
// off somebody else's server to re-punctuate a sentence is rude as well as
// slow. it is also the only way any of this is testable offline.
const replay = opt('--replay') ? JSON.parse(fs.readFileSync(opt('--replay'), 'utf8')).samples : null;

// --- what the page already knows --------------------------------------------
const TILES = (html.match(/const LP_TILES = '([^']+)'/) || [])[1];
const ZOOM = +((html.match(/maxNativeZoom: (\d+)/) || [])[1] || 0);
if (!TILES || !ZOOM) throw new Error('could not read LP_TILES / maxNativeZoom from index.html');

const slice = (a, b) => {
  const i = html.indexOf(a), j = html.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`could not find ${a} in index.html`);
  return html.slice(i, j);
};
const SPOT_RE = /\{ name: (?:'([^']+)'|"([^"]+)"), lat: (-?[\d.]+), lon: (-?[\d.]+),/g;
const spots = [...slice('const SPOTS = [', '\n];').matchAll(SPOT_RE)]
  .map(m => ({ name: m[1] ?? m[2], lat: +m[3], lon: +m[4] }));
if (!spots.length) throw new Error('no spots parsed');

// --- geometry ---------------------------------------------------------------
const RAD = Math.PI / 180;
// where in its tile a point falls, as a fraction. the pixel comes later, from
// the tile that actually arrives: these are 1024 px, and assuming the usual
// 256 reads every sample at a quarter of its true offset.
function place(lat, lon, z) {
  const n = 2 ** z, r = lat * RAD;
  const fx = (lon + 180) / 360 * n;
  const fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, u: fx - x, v: fy - y };
}
// a point a given distance and bearing away, on the sphere
function move(lat, lon, km, bearing) {
  const R = 6371, d = km / R, b = bearing * RAD, p1 = lat * RAD, l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / RAD, lon: l2 / RAD };
}

const KM_PER_TILE = 40075 * Math.cos(35.6 * RAD) / (2 ** ZOOM);
const COMPASS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const RINGS = [10, 25, 50];
const key = (name, part) => `${name}|${part}`;

// the overlooks ride the same path as the spots: same samples, same wording.
// their tag is the osm id behind a prefix no spot name can start with, since
// two overlooks can share a name. when the atlas is replaced by a computed
// model (2026-09-13-skyglow-model-design.md) they follow with no second change.
const OV = 'ov:';
const ovBlock = html.includes('const OVERLOOKS = [') ? html.split('const OVERLOOKS = [')[1].split('];')[0] : '';
const overlooks = ovBlock.split('\n').map(l => l.trim().replace(/,$/, '')).filter(l => l.startsWith('{'))
  .map(l => JSON.parse(l)).map(o => ({ name: OV + o.id, label: o.name, lat: o.lat, lon: o.lon }));
const points = [...spots, ...overlooks];

// --- what to sample ---------------------------------------------------------
const want = [];
const at = (lat, lon, tag) => {
  const p = place(lat, lon, ZOOM);
  want.push({ key: `${ZOOM}/${p.x}/${p.y}`, u: p.u, v: p.v, tag, x: p.x, y: p.y });
};
for (const s of points) {
  at(s.lat, s.lon, key(s.name, 'self'));
  for (const km of RINGS)
    COMPASS.forEach((dir, i) => {
      const q = move(s.lat, s.lon, km, i * 45);
      at(q.lat, q.lon, key(s.name, dir + km));
    });
}

// a line from a dark spot into asheville. it walks from a sky everyone agrees
// is dark to one everyone agrees is not, which is what fixes the direction of
// the scale below.
const CITY = { name: 'asheville', lat: 35.5951, lon: -82.5515 };

// places whose sky is not in question, darkest first. these are the check on
// the scale: read in this order the colours must never step backwards, and any
// pair that does means the scale below is wrong.
//
// the ocean and greenland entries earn their place by failing. the atlas ships
// no tile at all for either, which is the answer to a question that was open
// until the last run: blue is not water. water is nothing.
const REFERENCE = [
  ['mid-atlantic ocean', 34.0, -60.0, 'no lights for a thousand miles'],
  ['greenland interior', 72.0, -40.0, 'ice sheet, nobody home'],
  ['sahara, libya', 23.0, 14.0, 'desert, essentially pristine'],
  ['great basin np, nevada', 38.98, -114.30, 'one of the darkest skies in the lower 48'],
  ['boundary waters, minnesota', 47.95, -91.50, 'dark sky sanctuary'],
  ['cherry springs, pennsylvania', 41.66, -77.82, 'gold tier dark sky park'],
  ['blue ridge, mid-page', 35.60, -82.90, 'a ridge on this very map'],
  ['asheville downtown', 35.5951, -82.5515, 'small city'],
  ['knoxville downtown', 35.9606, -83.9207, 'mid-size city'],
  ['charlotte downtown', 35.2271, -80.8431, 'big city'],
  ['atlanta downtown', 33.7490, -84.3880, 'bigger city'],
  ['manhattan', 40.7128, -74.0060, 'about as bright as it gets'],
];
for (const [name, lat, lon] of REFERENCE) at(lat, lon, `ref|${name}`);
const hav = (a, b) => {
  const dp = (b.lat - a.lat) * RAD, dl = (b.lon - a.lon) * RAD;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dl / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
};
const anchor = spots.find(s => /mitchell/i.test(s.name))
  || spots.slice().sort((a, b) => hav(CITY, b) - hav(CITY, a))[0];
const STEPS = 12;
for (let i = 0; i <= STEPS; i++)
  at(anchor.lat + (CITY.lat - anchor.lat) * i / STEPS,
     anchor.lon + (CITY.lon - anchor.lon) * i / STEPS, `transect|${i}`);

// --- the scale --------------------------------------------------------------
// every tile ships its own palette holding only the colours that tile happens
// to use, in whatever order they were written. an index therefore means nothing
// outside the tile it came from: index 9 is #222222 out in nevada and #f2f2f2
// in charlotte. so nothing below touches an index. colour is the only thing
// that carries across tiles.
//
// the order is three greys, five dark/light hue pairs, three greys again, and
// it is not a guess about what the colours look like. the transect fixes the
// middle (green -> olive -> yellow -> orange -> red, rising into town) and the
// reference points fix the ends and the direction, with the
// greys landing above red because knoxville reads #a0a0a0 while asheville, a
// tenth the size, reads #fb5a49. the check below re-runs that argument on
// every run rather than trusting this comment.
//
// the names have to survive being read next to the map. the scale is built from
// dark/light pairs of one hue, so "green" and "dark green" is no help at all
// when you are looking at two greens and working out which one you are standing
// in. every name says which half of its pair it is.
const SCALE = [
  ['#000000', 'black'],
  ['#222222', 'near black'],
  ['#424242', 'charcoal'],
  ['#142f72', 'deep blue'],
  ['#2154d8', 'bright blue'],
  ['#0f5714', 'deep green'],
  ['#1fa12a', 'bright green'],
  ['#6e641e', 'olive'],
  ['#b8a625', 'yellow'],
  ['#bf641e', 'burnt orange'],
  ['#fd9650', 'bright orange'],
  ['#fb5a49', 'red'],
  ['#fb998a', 'pink'],
  ['#a0a0a0', 'grey'],
  ['#f2f2f2', 'off white'],
  ['#ffffff', 'white'],
];
const RANK = new Map(SCALE.map(([h], i) => [h, i + 1]));
const NAME = new Map(SCALE);

const tiles = {};
for (const w of want) tiles[w.key] = TILES
  .replace('{z}', ZOOM).replace('{x}', w.x).replace('{y}', w.y)
  .replace('{-y}', 2 ** ZOOM - 1 - w.y);

console.log(`${spots.length} spots and ${overlooks.length} overlooks, ${want.length} samples, ${Object.keys(tiles).length} tile(s) at zoom ${ZOOM}`);

// --- fetch and read the tiles ----------------------------------------------
const UA = { 'user-agent': 'dark-sky-calendar tools (+https://github.com/spskelly/dark-sky)' };
const TILE_CACHE = path.join(ROOT, 'tools', '.skyglow-cache');
fs.mkdirSync(TILE_CACHE, { recursive: true });
// a cached file is named from the url's own path, not a hand-built z/x/y key,
// so a future atlas year (a new LP_TILES template) misses the cache on its
// own instead of silently reading last year's bytes for the same tile.
const cacheFile = url => path.join(TILE_CACHE, new URL(url).pathname.replace(/[^A-Za-z0-9.]+/g, '_').replace(/^_+/, ''));
let hit = 0;
const planes = {};
for (const [k, url] of replay ? [] : Object.entries(tiles)) {
  let img = null, why = '', known = false;
  try {
    // a tile is fetched once and kept. the atlas changes once a year, and its
    // host owes this project nothing, so --refetch is the only way to ask twice.
    const file = cacheFile(url);
    const gone = file + '.missing';
    if (!has('--refetch') && fs.existsSync(file)) { img = decodePng(fs.readFileSync(file)); hit++; }
    else if (!has('--refetch') && fs.existsSync(gone)) { known = true; hit++; }
    else {
      const r = await fetch(url, { headers: UA });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        img = decodePng(buf);                       // decode first: never keep a tile that will not read
        fs.writeFileSync(file + '.tmp', buf);
        fs.renameSync(file + '.tmp', file);
      } else {
        why = `${r.status} ${r.statusText}`;
        // a 404 means the atlas has no tile there, ever, which is worth
        // remembering. any other failure says nothing about the tile, so it
        // is not cached and the next run asks again.
        if (r.status === 404) { fs.writeFileSync(gone + '.tmp', ''); fs.renameSync(gone + '.tmp', gone); }
      }
    }
  } catch (e) { why = e.message; }
  planes[k] = img;
  console.log(`  ${known ? 'known missing (404, cached)' : img ? `got  ${img.width}x${img.height}, colour type ${img.color}, depth ${img.depth}` : `MISS ${why}`}  ${url}`);
}
if (!replay) console.log(`  ${hit} tile(s) from the cache, ${Object.keys(tiles).length - hit} asked of the host`);
if (replay) console.log(`  (replaying ${Object.keys(replay).length} saved samples, nothing fetched)`);
const missing = Object.values(planes).filter(p => !p).length;
if (missing) console.log(`  (${missing} tile(s) absent. the atlas ships none over open water or empty ice, ` +
  `so a missing tile is the floor of the scale, not a fault)`);

const size = Object.values(planes).find(Boolean)?.width || 0;
if (size) {
  const kmPx = KM_PER_TILE / size;
  console.log(`\ntiles are ${size} px, so one pixel is about ${kmPx.toFixed(2)} km ` +
    `and the ${RINGS[0]} km ring sits ${(RINGS[0] / kmPx).toFixed(0)} px out`);
}

const hex = c => c ? '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('') : null;
const read = want.map(w => {
  const img = planes[w.key];
  if (!img) return null;
  const px = Math.min(img.width - 1, Math.floor(w.u * img.width));
  const py = Math.min(img.height - 1, Math.floor(w.v * img.height));
  return hex(img.rgba(px, py));
});
const got = new Map();
if (replay) for (const [tag, h] of Object.entries(replay)) got.set(tag, h);
else want.forEach((w, i) => got.set(w.tag, read[i]));

// a rank on the scale, 1 darkest. a tile that does not exist is darker than
// anything the atlas bothered to draw, so it ranks 0 rather than going missing.
const rank = tag => {
  const h = got.get(tag);
  if (h === null) return 0;
  return h === undefined ? null : (RANK.get(h) ?? null);
};
const pad = v => (v == null ? ' ?' : String(v).padStart(2));

// --- anything the scale does not account for --------------------------------
const census = new Map();
for (const h of got.values()) if (h) census.set(h, (census.get(h) || 0) + 1);
const unknown = [...census.keys()].filter(h => !RANK.has(h));
if (unknown.length) {
  console.log(`\n!! ${unknown.length} colour(s) turned up that the scale does not list: ${unknown.join(' ')}`);
  console.log('   the scale above is incomplete; do not trust a rank until they are placed.');
}

console.log(`\ncolours that actually turned up, darkest first (${[...census.values()].reduce((a, b) => a + b, 0)} samples):`);
for (const [h, n] of SCALE.map(([h], i) => [h, census.get(h) || 0]))
  if (n) console.log(`  ${String(RANK.get(h)).padStart(2)}  ${h}  ${NAME.get(h).padEnd(11)} ${n} sample(s)`);

// --- does the scale survive the places we already know? ---------------------
console.log('\nreference points, darkest expectation first:\n');
let last = -1, breaks = 0;
for (const [name, , , why] of REFERENCE) {
  const h = got.get(`ref|${name}`), r = rank(`ref|${name}`);
  const back = r != null && r < last;
  if (back) breaks++;
  if (r != null) last = Math.max(last, r);
  const shown = h === null ? '(no tile)' : h === undefined ? '(not sampled)' : `${h} ${NAME.get(h) || '?'}`;
  console.log(`  ${pad(r)}  ${name.padEnd(28)} ${shown.padEnd(22)} ${why}${back ? '   <-- STEPS BACK' : ''}`);
}
const checked = REFERENCE.filter(([n]) => rank(`ref|${n}`) != null).length;
console.log(breaks ? `\n  ${breaks} reference point(s) contradict the scale. it is wrong somewhere.`
  : checked < 3 ? `\n  only ${checked} reference point(s) were read; that settles nothing.`
  : '\n  no reference point steps backwards, so the scale holds from the sahara to manhattan.');

// --- and the transect -------------------------------------------------------
const walk = Array.from({ length: STEPS + 1 }, (_, i) => rank(`transect|${i}`));
console.log(`\n${anchor.name} to ${CITY.name}, ${hav(anchor, CITY).toFixed(0)} km in ${STEPS} steps:`);
console.log('  ' + walk.map(pad).join(' '));
const seenWalk = walk.filter(v => v != null);
const rising = walk.every((v, i) => i === 0 || v == null || walk[i - 1] == null || v >= walk[i - 1]);
console.log(seenWalk.length < 3 ? '  -> not enough of the walk was read to say anything'
  : !rising ? '  -> NOT monotone; something is off'
  : seenWalk[0] === seenWalk[seenWalk.length - 1] ? '  -> flat the whole way, which settles nothing'
  : '  -> rises the whole way into town, as it must');

// --- the spots --------------------------------------------------------------
// what a spot's own pixel says, and where the glow around it comes from. the
// second matters more on a ridge: the sky overhead can be fine while one
// horizon is a dome of orange, and that decides which way to point a camera.
const summary = [];
for (const s of points) {
  const here = rank(key(s.name, 'self'));
  const ring = [];
  for (const km of RINGS) for (const d of COMPASS) {
    const r = rank(key(s.name, d + km));
    if (r != null) ring.push({ d, km, r });
  }
  // ties are the normal case out here: a spot can have four quiet horizons and
  // one bad one. picking a single compass point off a stable sort would answer
  // "n" for everything, so name every direction that shares the extreme.
  const pick = (rows, want) => {
    if (!rows.length) return null;
    const r = want === 'max' ? Math.max(...rows.map(x => x.r)) : Math.min(...rows.map(x => x.r));
    const hit = rows.filter(x => x.r === r).sort((a, b) => a.km - b.km);
    const km = hit[0].km;
    return { r, km, dirs: [...new Set(hit.filter(x => x.km === km).map(x => x.d))] };
  };
  const worst = pick(ring, 'max');
  // the darkest horizon, taken at the widest ring where the towns show up
  const best = pick(ring.filter(x => x.km === RINGS[RINGS.length - 1]), 'min');
  summary.push({ s, here, ring, worst, best });
}

console.log('\nsky glow by rank, 1 darkest (see the scale above):\n');
const WIDE = Math.max(...points.map(s => (s.label || s.name).length)) + 2;
console.log('spot'.padEnd(WIDE) + 'here  ' + RINGS.map(km => `${km} km: ` + COMPASS.join(' ')).join('   '));
for (const { s, here } of summary) {
  const ring = RINGS.map(km => COMPASS.map(d => pad(rank(key(s.name, d + km)))).join(' ')).join('   ');
  console.log((s.label || s.name).padEnd(WIDE) + pad(here) + '    ' + ring);
}

console.log('\nwhere the glow comes from, and where it does not:\n');
const side = w => (w ? `${w.dirs.join('/').padEnd(8)} (${pad(w.r)})` : '-'.padEnd(13));
for (const { s, here, worst, best } of summary) {
  const h = got.get(key(s.name, 'self'));
  console.log((s.label || s.name).padEnd(WIDE) +
    `${pad(here)} ${(NAME.get(h) || '?').padEnd(11)}` +
    ` glow from ${side(worst)}${worst ? ` at ${String(worst.km).padStart(2)} km` : '      '}` +
    `   darkest horizon ${side(best)}`);
}

// --- what the numbers behind the colours are --------------------------------
// the site has two pages that are nothing but the legend. they are the real
// answer to what a colour means, and they were being fetched and thrown away
// for being over the dump threshold. read them.
const HOST = 'https://djlorenz.github.io';
const LEGEND = [`${HOST}/astronomy/lp/colors.html`, `${HOST}/astronomy/lp/bortle.html`];
const text = h => h
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

if (!replay) console.log('\nwhat the atlas says its colours mean:');
let legendHit = 0;
for (const url of replay ? [] : LEGEND) {
  const file = cacheFile(url);
  let body;
  if (!has('--refetch') && fs.existsSync(file)) { body = fs.readFileSync(file, 'utf8'); legendHit++; }
  else {
    body = await fetch(url, { headers: UA }).then(r => r.ok ? r.text() : '').catch(() => '');
    if (body) { fs.writeFileSync(file + '.tmp', body); fs.renameSync(file + '.tmp', file); }
  }
  if (!body) { console.log(`  ${url} -- could not read`); continue; }
  console.log(`\n  ${url} (${(body.length / 1024).toFixed(1)} kB)`);
  console.log(text(body).split('\n').map(l => '    | ' + l).join('\n'));
  // the legend is usually a table of swatches; pull any colour it names too
  const cols = [...new Set([...body.matchAll(/#[0-9a-f]{6}\b|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)/gi)].map(m => m[0].toLowerCase()))];
  if (cols.length) console.log('    colours named on the page: ' + cols.join(' '));
  const imgs = [...body.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => new URL(m[1], url).href);
  if (imgs.length) console.log('    legend image(s): ' + imgs.join(' '));
}
if (!replay) console.log(`\n  ${legendHit} legend page(s) from the cache, ${LEGEND.length - legendHit} asked of the host`);

// --- and what a card gets to say about it -----------------------------------
// the wording is generated rather than written by hand for forty spots, and it
// is deliberately comparative. the atlas has not been read for magnitudes yet,
// so a band is described against things on this page -- the darkest colour that
// appears anywhere in these mountains, and downtown asheville -- rather than
// against a number nobody here has measured.
const LONG = { n: 'north', ne: 'northeast', e: 'east', se: 'southeast',
               s: 'south', sw: 'southwest', w: 'west', nw: 'northwest' };
// eight bearings that happen to be next to each other read as an arc, not a
// list. almost every spot out here has one bad side and a quiet remainder.
const arc = dirs => {
  const have = new Set(dirs);
  if (dirs.length === 1) return LONG[dirs[0]];
  for (let i = 0; i < 8; i++)
    if (COMPASS.every((_, k) => have.has(COMPASS[(i + k) % 8]) === (k < dirs.length)))
      return `${LONG[COMPASS[i]]} through ${LONG[COMPASS[(i + dirs.length - 1) % 8]]}`;
  const w = COMPASS.filter(d => have.has(d)).map(d => LONG[d]);
  return w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
};
const BAND = {
  6: 'the darkest band anywhere on this page',
  7: 'the usual reading along the high ridges',
  8: 'a band off the best in these mountains',
  9: 'washed by town glow',
  10: 'bright for somewhere you would drive to for the sky',
  11: 'bright for somewhere you would drive to for the sky',
  12: 'as bright as downtown asheville',
};
const band = r => BAND[r] || (r < 6 ? 'darker than anywhere else in these mountains'
  : 'brighter than downtown asheville');
// "every side" takes a singular verb, so it counts as one for agreement
const where = dirs => (dirs.length >= 7 ? 'every side' : arc(dirs));
const toward = dirs => (dirs.length >= 7 ? 'on every side' : `to the ${arc(dirs)}`);
const many = dirs => dirs.length > 1 && dirs.length < 7;

const notes = [];
for (const { s, here, ring, worst, best } of summary) {
  // rank 0 means the atlas ships no tile there, which is the floor of the scale
  // out at sea and a failed fetch anywhere near these mountains. either way it
  // is not a measurement, and a card is better with no sky line than with a
  // confident one built out of nothing.
  if (!here) continue;
  const colour = NAME.get(got.get(key(s.name, 'self')));
  const said = [];
  if (worst && worst.r > here) {
    said.push(`brightest ${toward(worst.dirs)} at ${worst.km} km`);
    // the far ring finds the cities, but a town just down the mountain is the
    // one that ruins an exposure, and picking a single maximum hides it
    const near = ring.filter(x => x.km === RINGS[0]);
    const top = near.length ? Math.max(...near.map(x => x.r)) : here;
    const dirs = near.filter(x => x.r === top).map(x => x.d);
    if (top > here && String(dirs) !== String(worst.dirs))
      said[0] += `, and already brighter ${RINGS[0]} km ${toward(dirs)}`;
  } else said.push('nothing within 50 km reads brighter than the spot itself');
  if (best) said.push(best.r < here
    ? `${where(best.dirs)} ${many(best.dirs) ? 'are' : 'is'} darker still at ${best.km} km`
    : best.r === here
    ? `${where(best.dirs)} ${many(best.dirs) ? 'stay' : 'stays'} as dark as the spot out to ${best.km} km`
    : `even the quietest side, ${where(best.dirs)}, sits a band up`);
  // the colour travels with the sentence: a card can then show the band itself
  // rather than ask somebody to match a word against a pixel
  notes.push([s.name, got.get(key(s.name, 'self')),
    `${colour} on the overlay, ${band(here)}. ${said.join('; ')}.`]);
}

const START = '// --- skyglow:start (generated, do not edit by hand) ---';
const END = '// --- skyglow:end ---';
// the page's map key is built from this rather than from an impression of it.
// the old key was a seven-stop gradient with one green in it, and the atlas has
// sixteen bands and two greens.
const block = [START,
  'const SKY_SCALE = [',
  ...SCALE.map(([h, n]) => `  [${JSON.stringify(h)}, ${JSON.stringify(n)}],`),
  '];',
  'const SKY = {',
  ...notes.filter(([n]) => !n.startsWith(OV)).map(([n, h, t]) => `  ${JSON.stringify(n)}: [${JSON.stringify(h)},\n    ${JSON.stringify(t)}],`),
  '};',
  'const OVERLOOK_SKY = {',
  ...notes.filter(([n]) => n.startsWith(OV)).map(([n, h, t]) => `  ${JSON.stringify(n.slice(OV.length))}: [${JSON.stringify(h)},\n    ${JSON.stringify(t)}],`),
  '};', END].join('\n');

// the block is generated line for line, so an entry is a line opening with a
// quoted key plus everything up to its closing bracket. comparing by key names
// which spot or overlook moved rather than only saying the block differs.
const entriesOf = text => {
  const out = new Map();
  let key = null;
  for (const line of text.split('\n')) {
    const m = /^ {2}("(?:[^"\\]|\\.)*"): \[/.exec(line);
    if (m) key = JSON.parse(m[1]);
    if (key === null) continue;
    out.set(key, (out.get(key) || '') + line + '\n');
    if (/\],$/.test(line)) key = null;
  }
  return out;
};

let checkFailed = false;
if (has('--fix')) {
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`the skyglow markers are missing from ${FILE}`);
  // a colour the scale cannot place would put a wrong band on a card, and the
  // cards are the whole point, so refuse rather than write something plausible
  if (unknown.length) throw new Error(`refusing to write: ${unknown.length} colour(s) are not on the scale`);
  // a run where nothing came back would otherwise quietly empty the block
  if (notes.length < points.length)
    throw new Error(`refusing to write: only ${notes.length} of ${points.length} spots got a reading`);
  // index.html is CRLF; html was read without newline translation, so a plain
  // \n block would mix line endings. match what the file already uses.
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(FILE, html.slice(0, a) + block.replace(/\n/g, eol) + html.slice(b + END.length));
  console.log(`\nwrote ${notes.length} sky lines into index.html`);
} else if (has('--check')) {
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`the skyglow markers are missing from ${FILE}`);
  // the page is CRLF and the block above is built with \n, so the comparison
  // is on line endings normalised to \n, not on the bytes
  const onPage = html.slice(a, b + END.length).replace(/\r\n/g, '\n');
  if (onPage === block) {
    console.log(`\nthe sky block in ${path.basename(FILE)} is what this run would write.`);
  } else {
    const mine = entriesOf(block), theirs = entriesOf(onPage);
    const keys = [...new Set([...theirs.keys(), ...mine.keys()])].filter(k => mine.get(k) !== theirs.get(k));
    console.log(`\nthe sky block in ${path.basename(FILE)} is not what this run would write.`);
    for (const k of keys)
      console.log(`  ${k}: ${!theirs.has(k) ? 'this run adds it' : !mine.has(k) ? 'in the page, but this run does not produce it' : 'differs'}`);
    if (!keys.length) console.log('  no entry differs by key, so it is the scale or the block layout that changed');
    checkFailed = true;
  }
} else {
  console.log('\nwhat each card would say (pass --fix to write it in):\n');
  for (const [n, , t] of notes) console.log(`  ${n}\n    ${t}`);
}

const out = opt('--json');
if (out) {
  fs.writeFileSync(out, JSON.stringify({
    samples: Object.fromEntries(got),
    scale: SCALE.map(([h, n], i) => ({ rank: i + 1, hex: h, name: n })),
    transect: walk,
    reference: REFERENCE.map(([n, lat, lon, why]) => ({ name: n, why, hex: got.get(`ref|${n}`), rank: rank(`ref|${n}`) })),
    spots: summary.map(({ s, here, worst, best }) => ({
      name: s.name, lat: s.lat, lon: s.lon,
      here, hex: got.get(key(s.name, 'self')), band: NAME.get(got.get(key(s.name, 'self'))),
      worst, darkestHorizon: best,
      ring: Object.fromEntries(RINGS.flatMap(km => COMPASS.map(d => [d + km, rank(key(s.name, d + km))]))),
    })),
  }, null, 2));
  console.log(`\nwrote ${out}`);
}
if (!has('--fix') && !has('--check')) console.log('\nnothing was written into index.html.');
if (checkFailed) process.exit(1);
