// samples the light pollution atlas at every spot, and in a ring around it, so
// the spot notes can say what the sky is actually like instead of what someone
// remembered.
//
//   node tools/build-skyglow.mjs              # sample and report
//   node tools/build-skyglow.mjs --json sky.json
//
// the atlas ships as png tiles coloured by sky brightness, so reading it means
// reading pixels. chromium is already a dev dependency for the social card, so
// the tiles are decoded in a canvas rather than by hand-rolling a png reader:
// far fewer lines that can be quietly wrong about filters and bit depths. the
// tiles are fetched in node and handed over as data urls, so nothing depends
// on the tile host's cors headers.
//
// this writes nothing into index.html. what a colour *means* is the atlas
// author's business and not something to invent, so the run also dumps
// whatever the site's own source says about its palette, and a census of every
// colour that actually turned up. the mapping from colour to sky brightness
// goes in once that has been read, not before.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pw from 'playwright';

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
function pixel(lat, lon, z) {
  const n = 2 ** z, r = lat * RAD;
  const fx = (lon + 180) / 360 * n;
  const fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, px: Math.min(255, Math.floor((fx - x) * 256)), py: Math.min(255, Math.floor((fy - y) * 256)) };
}
// a point a given distance and bearing away, on the sphere
function move(lat, lon, km, bearing) {
  const R = 6371, d = km / R, b = bearing * RAD, p1 = lat * RAD, l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / RAD, lon: l2 / RAD };
}

// how wide one pixel is here, which is what decides whether a ring radius is a
// real measurement or the same pixel read eight times over
const KM_PER_PX = 40075 * Math.cos(35.6 * RAD) / (2 ** ZOOM) / 256;
const COMPASS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const RINGS = [10, 25, 50];
const key = (name, part) => `${name}|${part}`;

// --- what to sample ---------------------------------------------------------
const want = [];
const at = (lat, lon, tag) => {
  const p = pixel(lat, lon, ZOOM);
  want.push({ key: `${ZOOM}/${p.x}/${p.y}`, px: p.px, py: p.py, tag, x: p.x, y: p.y });
};
for (const s of spots) {
  at(s.lat, s.lon, key(s.name, 'self'));
  for (const km of RINGS)
    COMPASS.forEach((dir, i) => {
      const q = move(s.lat, s.lon, km, i * 45);
      at(q.lat, q.lon, key(s.name, dir + km));
    });
}

const tiles = {};
for (const w of want) tiles[w.key] = TILES
  .replace('{z}', ZOOM).replace('{x}', w.x).replace('{y}', w.y)
  .replace('{-y}', 2 ** ZOOM - 1 - w.y);

console.log(`${spots.length} spots, ${want.length} samples, ${Object.keys(tiles).length} tile(s) at zoom ${ZOOM}`);
console.log(`one pixel is about ${KM_PER_PX.toFixed(2)} km, so the ${RINGS[0]} km ring is ${(RINGS[0] / KM_PER_PX).toFixed(1)} px out\n`);

// --- fetch the tiles --------------------------------------------------------
const UA = { 'user-agent': 'dark-sky-calendar tools (+https://github.com/spskelly/dark-sky)' };
const asDataUrl = async url => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  const type = r.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await r.arrayBuffer());
  return `data:${type};base64,${buf.toString('base64')}`;
};
const urls = {};
for (const [k, url] of Object.entries(tiles)) {
  urls[k] = await asDataUrl(url);
  console.log(`  ${urls[k] ? 'got ' : 'MISS'} ${url}`);
}

// --- read the pixels --------------------------------------------------------
// same escape hatch as the social card build, for a checkout whose browsers
// live somewhere playwright does not look
const browser = await pw.chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
const read = await page.evaluate(async ({ urls, want }) => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const planes = {};
  for (const [k, src] of Object.entries(urls)) {
    if (!src) { planes[k] = null; continue; }
    const img = new Image();
    const ok = await new Promise(done => { img.onload = () => done(true); img.onerror = () => done(false); img.src = src; });
    if (!ok) { planes[k] = null; continue; }
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(img, 0, 0);
    planes[k] = ctx.getImageData(0, 0, 256, 256).data;
  }
  return want.map(w => {
    const d = planes[w.key];
    if (!d) return null;
    const i = (w.py * 256 + w.px) * 4;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  });
}, { urls, want });
await browser.close();

const hex = c => c ? '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('') : '--';
const got = new Map();
want.forEach((w, i) => got.set(w.tag, read[i]));

// --- report -----------------------------------------------------------------
console.log('\nspot colours at their own coordinates:\n');
for (const s of spots) {
  console.log(`${s.name.padEnd(30)} ${hex(got.get(key(s.name, 'self')))}`);
  for (const km of RINGS)
    console.log(`${String(km + ' km').padStart(30)} ${COMPASS.map(d => hex(got.get(key(s.name, d + km)))).join(' ')}`);
}
console.log(`\nring columns are ${COMPASS.join(' ')}`);

// every distinct colour the atlas actually used here. a discrete palette shows
// up as a short list, which is most of the way to knowing what its steps mean.
const census = new Map();
for (const c of read) if (c) census.set(hex(c), (census.get(hex(c)) || 0) + 1);
console.log(`\n${census.size} distinct colours across ${read.filter(Boolean).length} samples:`);
for (const [c, n] of [...census].sort((a, b) => b[1] - a[1])) console.log(`  ${c}  ${n}`);

// --- what does a colour mean? ask the site, do not invent it ----------------
console.log('\nlooking for the atlas own palette...');
const GH = 'https://api.github.com/repos/djlorenz/djlorenz.github.io/contents/';
const listing = await fetch(GH + 'astronomy/src', { headers: { ...UA, accept: 'application/vnd.github+json' } })
  .then(r => r.ok ? r.json() : null).catch(() => null);
if (!Array.isArray(listing)) {
  console.log('  could not list astronomy/src (rate limited, or it is not there)');
} else {
  console.log(`  astronomy/src: ${listing.map(e => e.name).join(', ')}`);
  const RGB_LIST = /\[\s*(?:\[\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\]\s*,?\s*){4,}\]/g;
  const HEX_LIST = /(?:["']#[0-9a-fA-F]{6}["']\s*,\s*){4,}/g;
  for (const e of listing.filter(e => e.type === 'file' && /\.(js|html|txt|py|f90|c)$/i.test(e.name)).slice(0, 12)) {
    const body = await fetch(e.download_url, { headers: UA }).then(r => r.ok ? r.text() : '').catch(() => '');
    if (!body) continue;
    const found = [...body.matchAll(RGB_LIST), ...body.matchAll(HEX_LIST)].map(m => m[0]);
    if (found.length) {
      console.log(`\n  ${e.name} names a palette:`);
      for (const f of found.slice(0, 3)) console.log('    ' + f.replace(/\s+/g, ' ').slice(0, 600));
    }
  }
}

const out = opt('--json');
if (out) {
  fs.writeFileSync(out, JSON.stringify(spots.map(s => ({
    name: s.name, lat: s.lat, lon: s.lon,
    self: got.get(key(s.name, 'self')),
    ring: Object.fromEntries(RINGS.flatMap(km => COMPASS.map(d => [d + km, got.get(key(s.name, d + km))]))),
  })), null, 2));
  console.log(`\nwrote ${out}`);
}
console.log('\nnothing written into index.html - the colours mean nothing until the palette above is read.');
