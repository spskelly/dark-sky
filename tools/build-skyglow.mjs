// samples the light pollution atlas at every spot, and in a ring around it, so
// the spot notes can say what the sky is actually like instead of what someone
// remembered.
//
//   node tools/build-skyglow.mjs              # sample and report
//   node tools/build-skyglow.mjs --json sky.json
//
// the atlas ships as png tiles coloured by sky brightness, so reading it means
// reading pixels. that is what tools/png.mjs is for: node ships zlib, a png is
// a zlib stream plus five row filters, and decoding one here keeps this script
// runnable on a bare node install like every other tool in this repo. needing
// a headless browser to read three tiles would not be worth it.
//
// this writes nothing into index.html. what a colour *means* is the atlas
// author's business and not something to invent, so the run also dumps
// whatever the site's own source says about its palette, and a census of every
// colour that actually turned up. the mapping from colour to sky brightness
// goes in once that has been read, not before.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const opt = n => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };

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

// --- what to sample ---------------------------------------------------------
const want = [];
const at = (lat, lon, tag) => {
  const p = place(lat, lon, ZOOM);
  want.push({ key: `${ZOOM}/${p.x}/${p.y}`, u: p.u, v: p.v, tag, x: p.x, y: p.y });
};
for (const s of spots) {
  at(s.lat, s.lon, key(s.name, 'self'));
  for (const km of RINGS)
    COMPASS.forEach((dir, i) => {
      const q = move(s.lat, s.lon, km, i * 45);
      at(q.lat, q.lon, key(s.name, dir + km));
    });
}

// a line from a dark spot into asheville. the palette is a list and the index
// is a rank, but nothing says which end is dark — this settles it by walking
// somewhere the answer is already known.
const CITY = { name: 'asheville', lat: 35.5951, lon: -82.5515 };

// the palette is a list, and this atlas does not order it by brightness: the
// remotest spots on the page come back as index 7, darker than index 0. so
// rather than read meaning into a colour, sample places whose sky is not in
// question and let them sort the scale out. the ocean entry is doing a second
// job: if open water comes back as its own colour, that colour is "no data"
// and not darkness, which is worth knowing before calling somewhere pristine.
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

const tiles = {};
for (const w of want) tiles[w.key] = TILES
  .replace('{z}', ZOOM).replace('{x}', w.x).replace('{y}', w.y)
  .replace('{-y}', 2 ** ZOOM - 1 - w.y);

console.log(`${spots.length} spots, ${want.length} samples, ${Object.keys(tiles).length} tile(s) at zoom ${ZOOM}`);

// --- fetch and read the tiles ----------------------------------------------
const UA = { 'user-agent': 'dark-sky-calendar tools (+https://github.com/spskelly/dark-sky)' };
const planes = {};
for (const [k, url] of Object.entries(tiles)) {
  let img = null, why = '';
  try {
    const r = await fetch(url, { headers: UA });
    if (r.ok) img = decodePng(Buffer.from(await r.arrayBuffer()));
    else why = `${r.status} ${r.statusText}`;
  } catch (e) { why = e.message; }
  planes[k] = img;
  console.log(`  ${img ? `got  ${img.width}x${img.height}, colour type ${img.color}, depth ${img.depth}` : `MISS ${why}`}  ${url}`);
}

const size = Object.values(planes).find(Boolean)?.width || 0;
if (size) {
  const kmPx = KM_PER_TILE / size;
  console.log(`\ntiles are ${size} px, so one pixel is about ${kmPx.toFixed(2)} km ` +
    `and the ${RINGS[0]} km ring sits ${(RINGS[0] / kmPx).toFixed(0)} px out`);
}

const read = want.map(w => {
  const img = planes[w.key];
  if (!img) return null;
  const px = Math.min(img.width - 1, Math.floor(w.u * img.width));
  const py = Math.min(img.height - 1, Math.floor(w.v * img.height));
  return { rgba: img.rgba(px, py), idx: img.index(px, py) };
});

const hex = c => c ? '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('') : '------';
const got = new Map();
want.forEach((w, i) => got.set(w.tag, read[i]));
const idx = t => { const g = got.get(t); return g && g.idx != null ? g.idx : null; };
const pad = v => (v == null ? ' -' : String(v).padStart(2));

// --- the scale the atlas brought with it ------------------------------------
const first = Object.values(planes).find(Boolean);
if (first && first.palette) {
  console.log(`\nthe tiles carry their own palette, ${first.palette.length} entries:`);
  first.palette.forEach((c, i) => {
    const used = read.filter(r => r && r.idx === i).length;
    console.log(`  ${String(i).padStart(2)}  ${hex(c)}  alpha ${String(c[3]).padStart(3)}` +
      (used ? `   ${used} sample(s) here` : ''));
  });
}

// --- which end of the palette is dark ---------------------------------------
const walk = Array.from({ length: STEPS + 1 }, (_, i) => idx(`transect|${i}`));
console.log(`\n${anchor.name} to ${CITY.name}, ${hav(anchor, CITY).toFixed(0)} km in ${STEPS} steps:`);
console.log('  ' + walk.map(pad).join(' '));
const ends = [walk[0], walk[walk.length - 1]];
console.log(ends[0] == null || ends[1] == null ? '  (incomplete)'
  : ends[1] > ends[0] ? '  -> index rises toward town, so a higher index is a brighter sky'
  : ends[1] < ends[0] ? '  -> index falls toward town, so a LOWER index is a brighter sky'
  : '  -> both ends the same; the transect settles nothing');

// --- the scale, against places whose sky is not in question -----------------
console.log('\nreference points, darkest expectation first:\n');
for (const [name, , , why] of REFERENCE) {
  const g = got.get(`ref|${name}`);
  const i = g && g.idx != null ? g.idx : null;
  console.log(`  ${name.padEnd(28)} ${i == null ? ' - (no tile)' : pad(i) + '  ' + hex(g.rgba)}   ${why}`);
}

// --- the spots --------------------------------------------------------------
console.log('\nsky glow by palette index (see the scale above):\n');
console.log('spot'.padEnd(32) + 'here   ' + RINGS.map(km => `${km} km: ` + COMPASS.join(' ')).join('   '));
for (const s of spots) {
  const ring = RINGS.map(km => COMPASS.map(d => pad(idx(key(s.name, d + km)))).join(' ')).join('   ');
  console.log(s.name.padEnd(32) + pad(idx(key(s.name, 'self'))) + '     ' + ring);
}

const census = new Map();
for (const r of read) if (r) census.set(r.idx, (census.get(r.idx) || 0) + 1);
console.log(`\n${census.size} distinct levels across ${read.filter(Boolean).length} samples: ` +
  [...census].sort((a, b) => a[0] - b[0]).map(([i, n]) => `${i}x${n}`).join('  '));

// --- what the numbers behind the colours are --------------------------------
// src/ holds pako, which means the viewer inflates the binary tiles and works
// out brightness itself. that code is the real scale; find it rather than
// reverse-engineer a colour ramp.
console.log('\nlooking for the viewer that reads the binary tiles...');
const UA2 = { 'user-agent': UA['user-agent'] };
const HOST = 'https://djlorenz.github.io';
// lp2025/ and astronomy/ both 404; the folders that answered before are these,
// and each was a few hundred bytes, which means a signpost rather than content
const pages = [`${HOST}/astronomy/lp/`, `${HOST}/astronomy/lp2022/`, `${HOST}/astronomy/lp2020/`];
const seen = new Set();
for (const url of pages) {
  if (seen.has(url) || seen.size > 20) continue;   // following links must terminate
  seen.add(url);
  const body = await fetch(url, { headers: UA2 }).then(r => r.ok ? r.text() : '').catch(() => '');
  if (!body) continue;
  console.log(`  read ${url} (${(body.length / 1024).toFixed(1)} kB)`);
  if (body.length < 6000) console.log(body.split('\n').map(l => '    | ' + l).join('\n'));
  // a stub points somewhere; follow it rather than stopping at the signpost
  for (const m of body.matchAll(/(?:href|src|url)=["']?([^"'>\s]+\.html?)/gi)) {
    try { const u = new URL(m[1], url).href; if (u.startsWith(HOST) && !pages.includes(u)) pages.push(u); } catch {}
  }
  const srcs = [...body.matchAll(/<script[^>]+src=["\']([^"\']+)["\']/gi)].map(m => new URL(m[1], url).href);
  for (const src of srcs) {
    if (seen.has(src) || !src.startsWith(HOST) || /pako|geocoder/i.test(src)) continue;
    seen.add(src);
    const js = await fetch(src, { headers: UA2 }).then(r => r.ok ? r.text() : '').catch(() => '');
    if (!js) continue;
    console.log(`  read ${src} (${(js.length / 1024).toFixed(1)} kB)`);
    // how a value becomes a colour, and how a binary tile is addressed
    const bits = [
      ...js.matchAll(/(?:binary_tiles|\.bin\b)[^\n]{0,160}/g),
      ...js.matchAll(/function\s+\w*(?:colou?r|brightness|bortle|ratio|magnitude)\w*[\s\S]{0,500}?\n\}/gi),
      ...js.matchAll(/\[\s*(?:\[\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\]\s*,?\s*){4,}\]/g),
      ...js.matchAll(/(?:21\.\d|20\.\d|bortle)[^\n]{0,120}/gi),
    ].map(m => m[0].replace(/\s+/g, ' ').trim());
    for (const b of [...new Set(bits)].slice(0, 14)) console.log('      ' + b.slice(0, 220));
  }
}

const out = opt('--json');
if (out) {
  fs.writeFileSync(out, JSON.stringify({
    palette: first && first.palette,
    transect: walk,
    spots: spots.map(s => ({
      name: s.name, lat: s.lat, lon: s.lon, here: idx(key(s.name, 'self')),
      ring: Object.fromEntries(RINGS.flatMap(km => COMPASS.map(d => [d + km, idx(key(s.name, d + km))]))),
    })),
  }, null, 2));
  console.log(`\nwrote ${out}`);
}
console.log('\nnothing written into index.html yet.');
