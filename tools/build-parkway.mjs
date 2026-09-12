// writes the blue ridge parkway's centreline into index.html, between the
// parkway:start and parkway:end markers.
//
// the page ships one file with no build step, so the road travels as a plain
// array of [lat, lon] segments alongside the spots rather than being fetched at
// runtime: it works from file://, offline, and cannot break because somebody
// else's api changed. this script is the only thing that needs a network, and
// only when the route itself changes, which is close to never.
//
//   node tools/build-parkway.mjs            # rewrite index.html in place
//   node tools/build-parkway.mjs --dry-run  # print the stats and change nothing
//
// the geometry is openstreetmap's, via overpass; osm data is ODbL, so the page
// credits it in the map attribution.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'index.html');
const START = '// --- parkway:start (generated, do not edit by hand) ---';
const END = '// --- parkway:end ---';

// what the page covers: western north carolina, from the cherohala skyway east
// to doughton park, with enough margin that the road does not stop dead at the
// edge of the spots. the parkway keeps going into virginia; that half is not
// this page's subject and would only make the file bigger.
const BBOX = { s: 34.9, w: -84.4, n: 36.7, e: -80.3 };

// douglas-peucker tolerance in degrees. 0.0013 is roughly 120 metres here,
// which holds every switchback the eye can see at the zooms this map uses and
// throws away the survey-grade wiggle between them.
const TOLERANCE = 0.0013;
const PRECISION = 4;      // ~11 m, and four decimals keep the file readable
const MIN_POINTS = 4;     // drop stubs: pull-offs, ramps, severed fragments

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const QUERY = `[out:json][timeout:180];
rel["type"="route"]["route"="road"]["name"="Blue Ridge Parkway"];
way(r)["highway"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
out geom;`;

// perpendicular distance from p to the segment ab, in degrees. good enough for
// simplification at this latitude: longitude is squashed by cos(lat) first so a
// degree east and a degree north cost about the same.
const K = Math.cos(35.6 * Math.PI / 180);
function segDist(p, a, b) {
  const px = p[1] * K, py = p[0], ax = a[1] * K, ay = a[0], bx = b[1] * K, by = b[0];
  const dx = bx - ax, dy = by - ay;
  if (!dx && !dy) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  let far = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > far) { far = d; idx = i; }
  }
  if (far <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}

const inBox = p => p[0] >= BBOX.s && p[0] <= BBOX.n && p[1] >= BBOX.w && p[1] <= BBOX.e;

console.log('asking overpass for the parkway…');
const res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(QUERY),
  headers: { 'content-type': 'application/x-www-form-urlencoded' } });
if (!res.ok) throw new Error(`overpass ${res.status} ${res.statusText}`);
const data = await res.json();

const ways = (data.elements || []).filter(e => e.type === 'way' && Array.isArray(e.geometry));
if (!ways.length) throw new Error('overpass returned no ways — the relation may have been renamed');

let rawPoints = 0;
const segments = [];
for (const w of ways) {
  // a way can leave and re-enter the box; keep each run inside it rather than
  // drawing the shortcut across the gap
  let run = [];
  const flush = () => {
    if (run.length >= MIN_POINTS) {
      const simple = simplify(run, TOLERANCE).map(p => p.map(v => +v.toFixed(PRECISION)));
      if (simple.length >= 2) segments.push(simple);
    }
    run = [];
  };
  for (const g of w.geometry) {
    const p = [g.lat, g.lon];
    rawPoints++;
    if (inBox(p)) run.push(p); else flush();
  }
  flush();
}
if (!segments.length) throw new Error('nothing left after clipping — check BBOX');

const kept = segments.reduce((n, s) => n + s.length, 0);
const body = segments.map(s => '  [' + s.map(p => `[${p[0]},${p[1]}]`).join(',') + '],').join('\n');
const block = `${START}\nconst PARKWAY = [\n${body}\n];\n${END}`;

const html = fs.readFileSync(FILE, 'utf8');
const from = html.indexOf(START), to = html.indexOf(END);
if (from < 0 || to < 0) throw new Error('markers missing from index.html');
const next = html.slice(0, from) + block + html.slice(to + END.length);

console.log(`${ways.length} ways, ${rawPoints} points → ${segments.length} segments, ${kept} points`);
console.log(`${(Buffer.byteLength(block) / 1024).toFixed(1)} kB of index.html`);
if (process.argv.includes('--dry-run')) { console.log('dry run, nothing written'); process.exit(0); }
if (next === html) { console.log('unchanged'); process.exit(0); }
fs.writeFileSync(FILE, next);
console.log('index.html updated');
