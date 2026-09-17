// writes every named overlook on the north carolina parkway into index.html,
// between the overlooks:start and overlooks:end markers, the way
// build-parkway.mjs writes the road.
//
//   node tools/build-overlooks.mjs            # rewrite index.html in place
//   node tools/build-overlooks.mjs --dry-run  # print the counts and change nothing
//   node tools/build-overlooks.mjs --replay   # reuse the last overpass response, no network
//
// then, because both read OVERLOOKS:
//   python tools/build_horizons.py
//   node tools/build-skyglow.mjs --fix
//
// the points are openstreetmap's, via overpass, under ODbL, which the page
// already credits. they are surveyed map features, not coordinates worked out
// from a milepost.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ask } from './overpass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'index.html');
const RAW = path.join(ROOT, 'tools', '.overlooks-raw.json');
const START = '// --- overlooks:start (generated, do not edit by hand) ---';
const END = '// --- overlooks:end ---';

// the same box build-parkway.mjs uses: the page's subject is western north
// carolina, and the elevation grid the panoramas need stops at 37 n anyway
const BBOX = { s: 34.9, w: -84.4, n: 36.7, e: -80.3 };
const NEAR_ROAD_M = 400;   // a viewpoint further than this from the road is a trail summit, not a pull-off
const NEAR_SPOT_M = 300;   // closer than this to a curated spot and it is that spot
const SAME_M = 150;        // a node and a way with one name this close are one overlook mapped twice
const GENERIC = new Set(['scenic overlook']);

const QUERY = `[out:json][timeout:180];
rel["type"="route"]["route"="road"]["name"="Blue Ridge Parkway"];
way(r)["highway"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e})->.bp;
(node(around.bp:${NEAR_ROAD_M})["tourism"="viewpoint"];way(around.bp:${NEAR_ROAD_M})["tourism"="viewpoint"];);
out center tags;`;

// only what the name says. the road line in the page is simplified to 120 m, so
// a milepost measured along it would be wrong and look right.
export function milepost(name) {
  const m = /\bMP\s*(\d{1,3}(?:\.\d+)?)/i.exec(name);
  return m ? +m[1] : null;
}

const RAD = Math.PI / 180;
export function metres(a, b) {
  const dp = (b.lat - a.lat) * RAD, dl = (b.lon - a.lon) * RAD;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(x));
}

// osm commonly carries the same pull-off as two features under two spellings,
// one with the milepost in the name and one without. lowercase, drop a
// trailing "(MP 399.7)" or bare "(348.8)" parenthetical, and collapse
// whitespace, so those two spellings compare equal.
export function baseName(name) {
  return name.toLowerCase().replace(/\s*\((?:mp\s*)?\d{1,3}(?:\.\d+)?\)\s*$/i, '').replace(/\s+/g, ' ').trim();
}

export function parseSpots(html) {
  const block = html.split('const SPOTS = [', 2)[1].split('\n];', 1)[0];
  const re = /\{ name: (?:'([^']+)'|"([^"]+)"), lat: (-?[\d.]+), lon: (-?[\d.]+),([^\n]*)/g;
  return [...block.matchAll(re)].map(m => {
    const v = /view: \[(-?[\d.]+), *(-?[\d.]+)\]/.exec(m[5]);
    return { name: m[1] ?? m[2], lat: +m[3], lon: +m[4], view: v ? [+v[1], +v[2]] : null };
  });
}

// the whole filter, with the count after each step so a dry run can show where
// the numbers went
export function pick(elements, spots) {
  const all = elements.map(e => ({
    id: e.type[0] + e.id, name: (e.tags?.name || '').trim(),
    lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, isNode: e.type === 'node',
  })).filter(o => isFinite(o.lat) && isFinite(o.lon));
  const named = all.filter(o => o.name && !GENERIC.has(o.name.toLowerCase()));
  const taken = spots.flatMap(s => [{ lat: s.lat, lon: s.lon }, ...(s.view ? [{ lat: s.view[0], lon: s.view[1] }] : [])]);
  const clear = named.filter(o => !taken.some(t => metres(o, t) < NEAR_SPOT_M));
  // osm commonly tags the same pull-off twice, once with the milepost in the
  // name and once without: compare on baseName so the two spellings collapse.
  // whichever spelling carries the milepost sorts first and is the one kept;
  // failing that, nodes first, since a node is the point somebody placed,
  // where a way's centre is only computed
  const rank = o => milepost(o.name) === null ? 1 : 0;
  const kept = [];
  for (const o of [...clear].sort((a, b) => (rank(a) - rank(b)) || (b.isNode - a.isNode)))
    if (!kept.some(k => baseName(k.name) === baseName(o.name) && metres(k, o) < SAME_M)) kept.push(o);
  kept.sort((a, b) => b.lat - a.lat);
  return {
    counts: { returned: elements.length, named: named.length, clearOfSpots: clear.length, distinct: kept.length },
    kept: kept.map(o => {
      const mp = milepost(o.name);
      return { id: o.id, name: o.name, lat: +o.lat.toFixed(4), lon: +o.lon.toFixed(4), ...(mp === null ? {} : { mp }) };
    }),
  };
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const replay = process.argv.includes('--replay');
  const html = fs.readFileSync(FILE, 'utf8');
  const spots = parseSpots(html);
  if (!spots.length) throw new Error('no spots parsed from index.html');
  let elements;
  if (replay) {
    elements = JSON.parse(fs.readFileSync(RAW, 'utf8')).elements;
  } else {
    const data = await ask(QUERY);
    const tmp = `${RAW}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, RAW);
    elements = data.elements;
  }
  const { counts, kept } = pick(elements, spots);
  console.log(`viewpoints within ${NEAR_ROAD_M} m of the parkway: ${counts.returned}`);
  console.log(`  named, and not just "scenic overlook":   ${counts.named}`);
  console.log(`  more than ${NEAR_SPOT_M} m from a curated spot:      ${counts.clearOfSpots}`);
  console.log(`  after collapsing one overlook mapped twice: ${counts.distinct}`);
  console.log(`  of which carry a milepost in the name:   ${kept.filter(o => o.mp !== undefined).length}`);
  // a run that comes back nearly empty is overpass having a bad day, and
  // writing it would quietly delete the layer
  if (kept.length < 50) throw new Error(`refusing to write: only ${kept.length} overlooks, expected over a hundred`);
  const block = [START, 'const OVERLOOKS = [', ...kept.map(o => '  ' + JSON.stringify(o) + ','), '];', END].join('\n');
  console.log(`  block: ${(block.length / 1024).toFixed(1)} kB`);
  if (dry) { console.log('dry run, index.html left alone'); return; }
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error('the overlooks markers are missing from index.html');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const next = html.slice(0, a) + block.replace(/\n/g, eol) + html.slice(b + END.length);
  if (next === html) { console.log('unchanged'); return; }
  fs.writeFileSync(FILE, next);
  console.log('index.html updated');
}

// run only when called as a script, so the tests can import the functions
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
