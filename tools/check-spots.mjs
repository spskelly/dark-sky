// checks where the spot pins actually are, and can move the ones that are
// demonstrably wrong.
//
// the coordinates are hand-entered notes and read as approximate, which was
// invisible until the parkway got drawn on the map: a pull-off a mile off the
// road it is a pull-off on is obvious the moment the road is there.
//
//   node tools/check-spots.mjs             # report, change nothing
//   node tools/check-spots.mjs --snap      # put roadside pull-offs on the road
//   node tools/check-spots.mjs --osm       # compare every spot to openstreetmap
//   node tools/check-spots.mjs --osm --fix
//   node tools/check-spots.mjs --osm --refresh   # ignore the cached osm answer
//
// two independent references, neither of them a guess:
//
//   the parkway centreline already in the page. anything tagged with a milepost
//   is on that road, so an overlook more than a few tens of metres off it is
//   wrong by construction. --snap moves those, and only those, onto it.
//
//   openstreetmap's own named features, for everything else. --osm reports what
//   osm has under the same name and how far off it is. --fix applies only the
//   features that ARE the spot: never a park's centroid, which is a point in
//   the woods, and never a peak, because for a summit this list deliberately
//   carries the parking rather than the top.
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

// apostrophes come out rather than becoming a space: "Devil's Courthouse" has
// to meet osm's "Devils Courthouse", not turn into "devil s courthouse"
const norm = s => s.toLowerCase().replace(/['\u2019]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/^mt /, 'mount ');
// the generic half of a name, which one side usually spells out and the other
// leaves off: ours says "Graveyard Fields" where osm says "Graveyard Fields
// Overlook", and they are the same place
const GENERIC = /\b(overlook|campground|camp site|picnic area|picnic site|recreation area|state park|state recreational forest|summit|tower|lookout|area)\b/g;
const core = s => norm(s).replace(GENERIC, '').replace(/\s+/g, ' ').trim();
// our names also carry context osm does not: "Roan Highlands, Carvers Gap",
// "Kuwohi (Clingmans Dome)", "Sam Knob / Flat Laurel Creek"
const variants = name => [...new Set([name, ...name.split(/[/,]|\(|\)/)].map(norm).filter(Boolean))];

// osm features that ARE the destination, so their coordinate is the one to
// take. a peak is not one of them: for a summit this list deliberately carries
// the parking or the trailhead, which is what you drive to, and moving those to
// the top of the mountain would make every drive time on the page a lie.
const DESTINATION = new Set(['viewpoint', 'rest_area', 'tower', 'picnic_site', 'camp_site', 'attraction']);

if (process.argv.includes('--osm')) {
  // this asks for every named park, peak, viewpoint and tower in a box the size
  // of western north carolina, which overpass rates as heavy and throttles. an
  // around: query per spot ought to be cheaper and came back with nothing at
  // all, so this is the shape that is known to work, and the answer is cached
  // for a day: it only has to get through once.
  const lats = spots.map(s => s.lat), lons = spots.map(s => s.lon);
  const bbox = [Math.min(...lats) - 0.1, Math.min(...lons) - 0.1, Math.max(...lats) + 0.1, Math.max(...lons) + 0.1]
    .map(n => n.toFixed(3)).join(',');
  const query = `[out:json][timeout:180];
(
  nwr["name"]["tourism"~"^(viewpoint|camp_site|picnic_site|attraction)$"](${bbox});
  nwr["name"]["natural"="peak"](${bbox});
  nwr["name"]["man_made"~"^(tower|survey_point)$"](${bbox});
  nwr["name"]["highway"="rest_area"](${bbox});
  nwr["name"]["leisure"="park"](${bbox});
);
out center;`;

  // overpass is rate limited and this answer barely changes: keep it, so that
  // re-reading the report costs nothing and a --fix run cannot be blocked by a
  // busy server
  const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.osm-cache.json');
  let data;
  if (!process.argv.includes('--refresh') && fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    const age = (Date.now() - fs.statSync(CACHE).mtimeMs) / 3600e3;
    if (c.query === query) {
      data = c.data;
      console.log(`using the osm answer cached ${age.toFixed(1)} h ago (--refresh to ask again)`);
    }
  }
  if (!data) {
    data = await ask(query);
    fs.writeFileSync(CACHE, JSON.stringify({ query, data }));
  }
  // overpass reports a runtime error in the body of a 200, and an empty answer
  // to a query this broad means the query is wrong, not the county empty
  if (data.remark) console.log(`overpass remarked: ${data.remark}`);
  if (!data.elements?.length) {
    throw new Error('overpass returned no features at all. that is a problem with the query, ' +
      'not with the spots \u2014 nothing below would mean anything, so stopping here.');
  }

  const features = (data.elements || []).map(e => ({
    name: e.tags?.name || '', type: e.type,
    lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon,
    kind: e.tags?.tourism || e.tags?.natural || e.tags?.man_made || e.tags?.highway || e.tags?.leisure || '',
  })).filter(f => f.name && isFinite(f.lat));
  console.log(`\n${features.length} named osm features in the box\n`);

  const fixes = [];
  console.log(pad('spot', 31) + pad('osm calls it', 31) + pad('what', 13) + 'apart'.padStart(7) + '  verdict');
  for (const s of spots) {
    const want = variants(s.name), mine = core(s.name);
    const scored = features.map(f => {
      const theirs = core(f.name);
      const tier = want.includes(norm(f.name)) ? 2                  // the same name
        : mine && theirs === mine ? 1                               // the same bar the generic word
        : mine && theirs && (theirs.includes(mine) || mine.includes(theirs)) ? 0   // one inside the other
        : -1;
      return tier < 0 ? null : { ...f, d: dist(s, f), tier };
    }).filter(Boolean).sort((x, y) => (y.tier - x.tier) || (x.d - y.d));
    if (!scored.length) { console.log(pad(s.name, 31) + '\u2014'); continue; }
    const h = scored[0];
    // a way or relation reports its centroid, which for a park is a point in
    // the woods rather than its parking: report it, never apply it
    const why =
      h.tier === 0 ? 'name only close, check by hand'
      : h.type !== 'node' ? `${h.type} centroid, check by hand`
      : !DESTINATION.has(h.kind) ? 'osm has the summit, we want the access \u2014 kept'
      : h.d < 30 ? 'already there'
      : h.d > OSM_FIX_MAX ? 'too far apart to be the same thing'
      : 'WOULD MOVE';
    console.log(pad(s.name, 31) + pad(h.name, 31) + pad(`${h.type[0]} ${h.kind}`, 13) +
      `${Math.round(h.d)} m`.padStart(7) + '  ' + why);
    if (why === 'WOULD MOVE') fixes.push([s, h]);
  }

  if (fixes.length && process.argv.includes('--fix')) {
    console.log(`\napplying ${fixes.length} osm coordinate(s):`);
    for (const [s, h] of fixes) {
      const lat = +h.lat.toFixed(4), lon = +h.lon.toFixed(4);
      console.log(`  ${pad(s.name, 31)} \u2192 ${lat},${lon}  (${Math.round(h.d)} m to osm's ${h.kind} "${h.name}")`);
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
