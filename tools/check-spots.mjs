// checks where the spot pins actually are, and can move the ones that are
// demonstrably wrong.
//
// the coordinates are hand-entered notes and read as approximate, which was
// invisible until the parkway got drawn on the map: a pull-off a mile off the
// road it is a pull-off on is obvious the moment the road is there.
//
//   node tools/check-spots.mjs           # report, change nothing
//   node tools/check-spots.mjs --snap    # put roadside pull-offs on the road
//   node tools/check-spots.mjs --osm     # compare every spot to openstreetmap
//   node tools/check-spots.mjs --osm --fix
//
// two independent references, neither of them a guess:
//
//   the parkway centreline already in the page. anything tagged with a milepost
//   is on that road, so an overlook more than a few tens of metres off it is
//   wrong by construction. --snap moves those, and only those, onto it.
//
//   openstreetmap's own named features, for everything else. --osm reports the
//   distance between our coordinate and the node osm has under the same name;
//   --fix applies it for point features only, never for the centroid of a park
//   the size of a county.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask } from './overpass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'index.html');

const SNAP_MIN = 100;      // metres: below this a pull-off is already on the road
const SNAP_MAX = 3000;     // metres: past this, something else is wrong, so say so
const OSM_WARN = 2000;     // metres: report an osm disagreement bigger than this
const OSM_FIX_MAX = 5000;  // metres: refuse to apply a move larger than this

// ---------- reading the page ----------

const html = fs.readFileSync(FILE, 'utf8');
const slice = (start, end) => {
  const a = html.indexOf(start);
  if (a < 0) throw new Error(`${start} missing from index.html`);
  return html.slice(a, html.indexOf(end, a));
};

// two names carry an apostrophe and are quoted with " instead of '
const SPOT_RE = /\{ name: (?:'([^']+)'|"([^"]+)"), lat: (-?[\d.]+), lon: (-?[\d.]+),([^\n]*?)tags: \[([^\]]*)\]/g;
const spots = [...slice('const SPOTS = [', '\n];').matchAll(SPOT_RE)].map(m => ({
  name: m[1] ?? m[2],
  lat: +m[3], lon: +m[4],
  // the source's own text for the numbers: 35.4400 reparsed and restringified
  // is 35.44, which would no longer match the line it came from
  rawLat: m[3], rawLon: m[4],
  tags: [...m[6].matchAll(/'([^']*)'/g)].map(t => t[1]),
  mp: (m[6].match(/parkway mp ([\d.]+)/) || [])[1],
}));
const parkway = html.includes('const PARKWAY = [];') ? []
  : JSON.parse('[' + slice('const PARKWAY = [', '\n];')
      .replace('const PARKWAY = [', '').replace(/,\s*$/, '') + ']');
console.log(`${spots.length} spots, ${parkway.length} parkway segments, ` +
  `${parkway.reduce((n, s) => n + s.length, 0)} points\n`);
if (!spots.length) throw new Error('no spots parsed — the SPOTS format changed');

// ---------- geometry ----------

const rad = d => d * Math.PI / 180;
const K = Math.cos(rad(35.6));            // this latitude's longitude squash
const metres = (a, b) => [(b.lon - a.lon) * K * 111320, (b.lat - a.lat) * 110540];
const dist = (a, b) => Math.hypot(...metres(a, b));

// nearest point on the segment ab to p, as a coordinate and a distance
function nearestOn(p, a, b) {
  const [ax, ay] = metres(p, a), [bx, by] = metres(p, b);
  const dx = bx - ax, dy = by - ay;
  const t = (dx || dy) ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / (dx * dx + dy * dy))) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return { d: Math.hypot(x, y), lat: p.lat + y / 110540, lon: p.lon + x / (K * 111320) };
}

function nearestOnParkway(p) {
  let best = { d: Infinity };
  for (const seg of parkway) {
    for (let i = 0; i < seg.length - 1; i++) {
      const c = nearestOn(p, { lat: seg[i][0], lon: seg[i][1] }, { lat: seg[i + 1][0], lon: seg[i + 1][1] });
      if (c.d < best.d) best = c;
    }
  }
  return best;
}

// a pull-off is part of the road. a summit, a campground or anything with a walk
// in it is not, and its milepost is where you leave the parkway rather than
// where the spot is, so it is left alone.
const isRoadside = s => s.mp &&
  (/overlook$/i.test(s.name) || s.tags.includes('drive-up')) &&
  !s.tags.some(t => /\bmi\b|hike|trail|fr \d/i.test(t));

// two spots ON ONE ROAD cannot be farther apart in a straight line than the
// difference in their mileposts. where they are, a coordinate is wrong.
//
// only points actually on the road can be compared this way: a summit up a
// side road is legitimately farther from its neighbour than its milepost
// suggests, because its milepost is the turning, not the spot.
const ON_ROAD = 250;
function consistency(list, label) {
  const pk = list.filter(s => s.mp && nearestOnParkway(s).d < ON_ROAD).sort((a, b) => a.mp - b.mp);
  const bad = [];
  for (let i = 0; i < pk.length - 1; i++) {
    const a = pk[i], b = pk[i + 1];
    const dmp = b.mp - a.mp;
    if (!dmp) continue;
    const ratio = dist(a, b) / (dmp * 1609.34);
    if (ratio > 1.02) bad.push(`${a.name} ↔ ${b.name}: ${(dist(a, b) / 1000).toFixed(2)} km apart but ${dmp.toFixed(1)} milepost miles`);
  }
  console.log(`${label}: ${pk.length} spots on the road, ${bad.length} impossible pair(s)`);
  for (const b of bad) console.log('  ' + b);
  return bad.length;
}

// ---------- the parkway report ----------

const pad = (s, n) => String(s).slice(0, n - 1).padEnd(n);
console.log(pad('spot', 32) + pad('mp', 9) + 'to parkway'.padStart(11) + '   ');
// the same objects the spots array holds, not copies of them: --snap moves
// these and the check afterwards has to see the move
const onRoad = spots.filter(s => s.mp).map(s => Object.assign(s, { near: nearestOnParkway(s) }))
  .sort((a, b) => a.near.d - b.near.d);
for (const s of onRoad) {
  const verdict = !isRoadside(s) ? 'off-road by design'
    : s.near.d < SNAP_MIN ? 'on the road'
    : s.near.d > SNAP_MAX ? 'TOO FAR TO TRUST — check by hand'
    : 'ROADSIDE, OFF THE ROAD';
  console.log(pad(s.name, 32) + pad(s.mp, 9) + `${Math.round(s.near.d)} m`.padStart(11) + '   ' + verdict);
}
console.log();
consistency(spots, 'before');

// ---------- --snap ----------

let next = html;
const rewrite = (spot, lat, lon) => {
  const q = spot.name.includes("'") ? '"' : "'";
  const head = `{ name: ${q}${spot.name}${q}, lat: ${spot.rawLat}, lon: ${spot.rawLon},`;
  if (!next.includes(head)) throw new Error(`could not find ${spot.name} to rewrite`);
  next = next.replace(head, () => `{ name: ${q}${spot.name}${q}, lat: ${lat}, lon: ${lon},`);
  spot.rawLat = String(lat); spot.rawLon = String(lon);
};

if (process.argv.includes('--snap')) {
  const moving = onRoad.filter(s => isRoadside(s) && s.near.d >= SNAP_MIN && s.near.d <= SNAP_MAX);
  console.log(`\nsnapping ${moving.length} roadside pull-off(s) onto the centreline:`);
  for (const s of moving) {
    const lat = +s.near.lat.toFixed(4), lon = +s.near.lon.toFixed(4);
    console.log(`  ${pad(s.name, 32)} ${s.lat},${s.lon} → ${lat},${lon}  (${Math.round(s.near.d)} m)`);
    rewrite(s, lat, lon);
    s.lat = lat; s.lon = lon;
  }
  console.log();
  consistency(spots, 'after');
}

// ---------- --osm ----------

const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// our names carry context osm does not: "Roan Highlands, Carvers Gap",
// "Kuwohi (Clingmans Dome)", "Sam Knob / Flat Laurel Creek"
const variants = name => [...new Set([name, ...name.split(/[/,]|\(|\)/)].map(norm).filter(Boolean))];

if (process.argv.includes('--osm')) {
  const lats = spots.map(s => s.lat), lons = spots.map(s => s.lon);
  const bbox = [Math.min(...lats) - 0.1, Math.min(...lons) - 0.1, Math.max(...lats) + 0.1, Math.max(...lons) + 0.1]
    .map(n => n.toFixed(3)).join(',');
  const data = await ask(`[out:json][timeout:180];
(
  nwr["name"]["tourism"~"^(viewpoint|camp_site|picnic_site|attraction)$"](${bbox});
  nwr["name"]["natural"="peak"](${bbox});
  nwr["name"]["man_made"~"^(tower|survey_point)$"](${bbox});
  nwr["name"]["highway"="rest_area"](${bbox});
  nwr["name"]["leisure"="park"](${bbox});
);
out center;`);

  const features = (data.elements || []).map(e => ({
    name: e.tags?.name || '', type: e.type,
    lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon,
    kind: e.tags?.tourism || e.tags?.natural || e.tags?.man_made || e.tags?.highway || e.tags?.leisure || '',
  })).filter(f => f.name && isFinite(f.lat));
  console.log(`\n${features.length} named osm features in the box\n`);

  const fixes = [];
  console.log(pad('spot', 32) + 'osm says'.padStart(10) + '   match');
  for (const s of spots) {
    const want = variants(s.name);
    const hits = features.filter(f => want.includes(norm(f.name)))
      .map(f => ({ ...f, d: dist(s, f) })).sort((a, b) => a.d - b.d);
    if (!hits.length) { console.log(pad(s.name, 32) + '—'.padStart(10) + '   not named in osm, left alone'); continue; }
    const h = hits[0];
    // a way or relation reports its centroid, which for a park is a point in
    // the woods rather than the parking: report it, never apply it
    const applicable = h.type === 'node' && h.d <= OSM_FIX_MAX;
    const note = h.d < OSM_WARN ? 'agrees' : applicable ? 'DISAGREES — fixable' : `disagrees (${h.type} ${h.kind}, centroid)`;
    console.log(pad(s.name, 32) + `${Math.round(h.d)} m`.padStart(10) + `   ${note}`);
    if (applicable && h.d >= OSM_WARN) fixes.push([s, h]);
  }

  if (fixes.length && process.argv.includes('--fix')) {
    console.log(`\napplying ${fixes.length} osm coordinate(s):`);
    for (const [s, h] of fixes) {
      const lat = +h.lat.toFixed(4), lon = +h.lon.toFixed(4);
      console.log(`  ${pad(s.name, 32)} → ${lat},${lon}  (${Math.round(h.d)} m, osm ${h.type} ${h.kind})`);
      rewrite(s, lat, lon);
      s.lat = lat; s.lon = lon;
    }
    console.log();
    consistency(spots, 'after osm');
  } else if (fixes.length) {
    console.log(`\n${fixes.length} spot(s) osm would move. re-run with --fix to apply.`);
  }
}

// ---------- writing ----------

if (next === html) { console.log('\nnothing changed'); process.exit(0); }
// keep the file's own line endings: a windows checkout holds it as crlf
fs.writeFileSync(FILE, next);
console.log('\nindex.html updated');
