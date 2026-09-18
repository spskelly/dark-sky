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
// reviewed standing spots, { osm id: [lat, lon, note] }: where a person stands
// to see the sky from this pull-off, when the osm point sits in the trees. the
// dot on the map goes here, the skyline is drawn from here, and a note says
// what the walk is. kept by hand; see docs/horizon_panorama.md#standing-spots
const VIEWS = path.join(ROOT, 'tools', 'overlook-views.json');
const START = '// --- overlooks:start (generated, do not edit by hand) ---';
const END = '// --- overlooks:end ---';

// the same box build-parkway.mjs uses: the page's subject is western north
// carolina, and the elevation grid the panoramas need stops at 37 n anyway
const BBOX = { s: 34.9, w: -84.4, n: 36.7, e: -80.3 };
const NEAR_ROAD_M = 400;   // a viewpoint further than this from the road is a trail summit, not a pull-off
const NEAR_SPOT_M = 300;   // closer than this to a curated spot and it is that spot
const SAME_M = 150;        // two viewpoints this close are one pull-off mapped twice, whatever they are called
const MOVED_WARN_M = 60;   // an applied standing spot further than this from the osm point is likely a mistyped coordinate

export function movedTooFar(m) {
  return m > MOVED_WARN_M;
}
// the parkway crosses into virginia at about 36.55 n, and it runs north-east
// from there, so nothing on this road in north carolina lies north of this.
// the page's subject is western north carolina and the elevation grid the
// panoramas need stops at 37 n, so a virginia overlook gets rays that run off
// the grid and a horizon that is not a measurement. the filter is on latitude
// rather than on the query box because --replay re-filters a response that was
// fetched with the wider box.
const NC_NORTH = 36.56;
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

// one row of the generated block. osm names are anybody's to edit, and this
// lands inside the page's own <script>: JSON.stringify leaves "</script>"
// alone, so a name carrying one would close the element. escaping every "<"
// costs nothing and every reader of this block (build_horizons.py,
// check_alignment.py, build-skyglow.mjs) parses it as real JSON, which reads
// < back as <.
export function row(o) {
  return JSON.stringify(o).replace(/</g, '\\u003c');
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
export function pick(elements, spots, views = {}) {
  const all = elements.map(e => ({
    id: e.type[0] + e.id, name: (e.tags?.name || '').trim(),
    lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, isNode: e.type === 'node',
  })).filter(o => isFinite(o.lat) && isFinite(o.lon));
  const named = all.filter(o => o.name && !GENERIC.has(o.name.toLowerCase()));
  const inNC = named.filter(o => o.lat <= NC_NORTH);
  const taken = spots.flatMap(s => [{ lat: s.lat, lon: s.lon }, ...(s.view ? [{ lat: s.view[0], lon: s.view[1] }] : [])]);
  const clear = inNC.filter(o => !taken.some(t => metres(o, t) < NEAR_SPOT_M));
  // osm commonly tags the same pull-off twice, and the two entries need not
  // share a name: one reads "View Hominy Valley" and the other "Hominy Valley
  // (MP 404.2)", one "Beaver Dam Overlook Parking" and the other "Beaver Dam
  // Gap Overlook (MP 401.7)". names are therefore not compared at all. two
  // viewpoints within SAME_M are one pull-off for this page's purposes: the
  // raycast starts 150 m out and the elevation cell is 10 m, so the two would
  // draw the same horizon under different names.
  // whichever spelling carries the milepost sorts first and is the one kept;
  // failing that, nodes first, since a node is the point somebody placed,
  // where a way's centre is only computed
  const rank = o => milepost(o.name) === null ? 1 : 0;
  const kept = [];
  for (const o of [...clear].sort((a, b) => (rank(a) - rank(b)) || (b.isNode - a.isNode)))
    if (!kept.some(k => metres(k, o) < SAME_M)) kept.push(o);
  kept.sort((a, b) => b.lat - a.lat);
  // a separate list, not a key on the kept rows: kept rows are written into
  // the page as-is, and the moved distance is only for this run's own log.
  const applied = [];
  return {
    counts: { returned: elements.length, named: named.length, inNorthCarolina: inNC.length,
              clearOfSpots: clear.length, distinct: kept.length },
    kept: kept.map(o => {
      const mp = milepost(o.name);
      const v = views[o.id];
      // three readers (build_horizons.parse_overlooks, check_alignment.py,
      // build-skyglow.mjs) split the OVERLOOKS block on "];", so a note
      // carrying it would corrupt every one of them
      if (v && v[2] && v[2].includes('];'))
        throw new Error(`overlook-views.json note for ${o.id} contains "];", which the OVERLOOKS block readers split on`);
      // a reviewed spot is kept exact: it was placed to the metre on purpose,
      // where the osm point is only cut to the 10 m the terrain needs
      const at = v ? { lat: v[0], lon: v[1] } : { lat: +o.lat.toFixed(4), lon: +o.lon.toFixed(4) };
      if (v) applied.push({ id: o.id, name: o.name, movedM: metres({ lat: o.lat, lon: o.lon }, at) });
      return { id: o.id, name: o.name, ...at, ...(mp === null ? {} : { mp }), ...(v && v[2] ? { note: v[2] } : {}) };
    }),
    applied,
  };
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const replay = process.argv.includes('--replay');
  const html = fs.readFileSync(FILE, 'utf8');
  const spots = parseSpots(html);
  if (!spots.length) throw new Error('no spots parsed from index.html');
  const views = fs.existsSync(VIEWS) ? JSON.parse(fs.readFileSync(VIEWS, 'utf8')) : {};
  let elements;
  if (replay) {
    // the raw file is written by a real run and is not in the repository, so
    // --replay on a fresh checkout finds nothing. say which file and how to
    // make it, rather than an ENOENT on a path nobody recognises.
    if (!fs.existsSync(RAW)) throw new Error(
      `no saved overpass response at ${RAW}. run "node tools/build-overlooks.mjs" once, without --replay, to record one.`);
    elements = JSON.parse(fs.readFileSync(RAW, 'utf8')).elements;
  } else {
    const data = await ask(QUERY);
    const tmp = `${RAW}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, RAW);
    elements = data.elements;
  }
  const { counts, kept, applied } = pick(elements, spots, views);
  console.log(`viewpoints within ${NEAR_ROAD_M} m of the parkway: ${counts.returned}`);
  console.log(`  named, and not just "scenic overlook":   ${counts.named}`);
  console.log(`  south of ${NC_NORTH} n, so in north carolina:   ${counts.inNorthCarolina}`);
  console.log(`  more than ${NEAR_SPOT_M} m from a curated spot:      ${counts.clearOfSpots}`);
  console.log(`  after collapsing one overlook mapped twice: ${counts.distinct}`);
  console.log(`  of which carry a milepost in the name:   ${kept.filter(o => o.mp !== undefined).length}`);
  const stale = Object.keys(views).filter(id => !kept.some(o => o.id === id));
  console.log(`standing spots applied: ${Object.keys(views).length - stale.length}`);
  for (const id of stale) console.warn(`  overlook-views.json names ${id}, which is no longer in the list`);
  for (const a of applied) {
    console.log(`  ${a.name} (${a.id}): moved ${a.movedM.toFixed(0)} m from the osm point`);
    if (movedTooFar(a.movedM))
      console.warn(`    over ${MOVED_WARN_M} m, check the coordinate in tools/overlook-views.json`);
  }
  // a run that comes back nearly empty is overpass having a bad day, and
  // writing it would quietly delete the layer
  if (kept.length < 50) throw new Error(`refusing to write: only ${kept.length} overlooks, expected over a hundred`);
  const block = [START, 'const OVERLOOKS = [', ...kept.map(o => '  ' + row(o) + ','), '];', END].join('\n');
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
