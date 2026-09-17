// Builds tools/stars.js: bright stars plus constellation stick figures, as
// plain script source ready to paste into index.html.
//
// The catalogue is "everything to magnitude 4.5, plus the stars a constellation
// line actually needs". The extras are marked so the renderer can tell them
// apart; they are drawn at their true magnitude, which is faint.
//
// Sources and licenses are recorded in tools/STARS-LICENSE.md. Short version:
//   stars  - HYG Database v4.1 (Astronomy Nexus), CC BY-SA 4.0
//   lines  - d3-celestial constellations.lines.json (Olaf Frohn), BSD 3-Clause,
//            digitised from the IAU / Sky & Telescope charts (CC BY 4.0)
//
// Run:  node tools/build-starcat.mjs
// Downloads are cached in tools/.starcat-cache/, so re-running does not re-fetch.
// This script runs approximately never. Keep it boring.

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CACHE = path.join(HERE, '.starcat-cache');
const MAG_LIMIT = 4.5;    // the catalogue proper
const POOL_LIMIT = 7.0;   // candidates a constellation line may reach down to
const MATCH_DEG = 0.35;   // a line vertex this close to a star is that star

const SOURCES = {
  'hygdata_v41.csv': 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv',
  'constellations.lines.json': 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json',
};

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function cached(name) {
  const final = path.join(CACHE, name);
  if (fs.existsSync(final)) return fs.readFileSync(final, 'utf8');
  fs.mkdirSync(CACHE, { recursive: true });
  process.stdout.write(`fetching ${name} ... `);
  const body = await get(SOURCES[name]);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, final);
  console.log(`${body.length} bytes`);
  return body.toString('utf8');
}

// Minimal quote-aware CSV row splitter. HYG quotes some fields and not others.
function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function angSep(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180;
  const c = Math.sin(dec1 * r) * Math.sin(dec2 * r)
    + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.cos((ra1 - ra2) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) / r;
}

const r2 = n => Number(n.toFixed(2));

// ---- candidate pool -------------------------------------------------------

const csv = await cached('hygdata_v41.csv');
const rows = csv.split('\n');
const head = splitCsv(rows[0]);
const [iId, iProper, iRa, iDec, iMag] =
  ['id', 'proper', 'ra', 'dec', 'mag'].map(k => head.indexOf(k));
if ([iId, iProper, iRa, iDec, iMag].some(i => i < 0)) throw new Error('HYG header changed');

const pool = [];
for (let i = 1; i < rows.length; i++) {
  if (!rows[i]) continue;
  const f = splitCsv(rows[i]);
  if (f[iId] === '0') continue;                 // row 0 is the Sun
  const mag = parseFloat(f[iMag]);
  if (!(mag <= POOL_LIMIT)) continue;
  pool.push({
    ra: parseFloat(f[iRa]) * 15,
    dec: parseFloat(f[iDec]),
    mag,
    name: f[iProper] || '',
    lineOnly: false,
  });
}

// ---- constellation lines pick their own stars out of the pool -------------

const lines = JSON.parse(await cached('constellations.lines.json'));
const polylines = [];   // pool indices, before renumbering
let vertices = 0, unmatched = 0;
const unmatchedIn = new Set();
for (const feature of lines.features) {
  for (const poly of feature.geometry.coordinates) {
    const run = [];
    for (const [lon, lat] of poly) {
      vertices++;
      const ra = lon < 0 ? lon + 360 : lon;
      let best = -1, bestSep = MATCH_DEG;
      for (let i = 0; i < pool.length; i++) {
        const sep = angSep(ra, lat, pool[i].ra, pool[i].dec);
        if (sep < bestSep) { bestSep = sep; best = i; }
      }
      if (best < 0) {
        // nothing in the pool at this vertex: the chart reaches a star fainter
        // than POOL_LIMIT. Break the run rather than invent a join.
        unmatched++;
        unmatchedIn.add(feature.id);
        continue;
      }
      if (pool[best].mag > MAG_LIMIT) pool[best].lineOnly = true;
      if (run[run.length - 1] !== best) run.push(best);
    }
    if (run.length > 1) polylines.push({ id: feature.id, run });
  }
}

// ---- the catalogue: mag <= 4.5, plus whatever the lines needed ------------

const keep = pool.filter(s => s.mag <= MAG_LIMIT || s.lineOnly);
keep.sort((a, b) => a.mag - b.mag || a.ra - b.ra);
const indexOfStar = new Map(keep.map((s, i) => [s, i]));
const segments = polylines.map(p => p.run.map(i => indexOfStar.get(pool[i])));

// ---- checks ---------------------------------------------------------------

function check(name, ra, dec, mag) {
  const i = keep.findIndex(s => s.name === name);
  if (i < 0) throw new Error(`${name} missing from catalogue`);
  const s = keep[i];
  const sep = angSep(r2(s.ra), r2(s.dec), ra, dec);
  if (sep > 0.05) throw new Error(`${name} at ${r2(s.ra)},${r2(s.dec)}, expected ${ra},${dec}`);
  if (mag !== undefined && Math.abs(r2(s.mag) - mag) > 0.05) throw new Error(`${name} mag ${r2(s.mag)}, expected ${mag}`);
  console.log(`ok  ${name.padEnd(8)} [${i}] ra ${r2(s.ra)} dec ${r2(s.dec)} mag ${r2(s.mag)} (${sep.toFixed(4)} deg from expected)`);
}
check('Sirius', 101.29, -16.72, -1.46);
check('Polaris', 37.95, 89.26);
check('Vega', 279.23, 38.78);

// ---- write ----------------------------------------------------------------

// [ra, dec, mag] with two optional trailing slots: name, then 1 for a star that
// is only here because a constellation line needs it. An unnamed line-only star
// carries 0 in the name slot so the flag keeps its position.
const starLines = keep.map(s => {
  const f = [r2(s.ra), r2(s.dec), r2(s.mag)];
  if (s.name) f.push(JSON.stringify(s.name));
  else if (s.lineOnly) f.push(0);
  if (s.lineOnly) f.push(1);
  return `[${f.join(',')}],`;
});

const out = `// --- stars:start (generated by tools/build-starcat.mjs, do not edit by hand) ---
// [ra, dec, mag, name?, lineOnly?]  ra and dec in degrees, J2000.
// Every star to magnitude ${MAG_LIMIT}, plus the fainter ones a constellation line
// needs to close its figure. Those carry a trailing 1 and are drawn at their
// own true magnitude, so they look as faint as they are. Unnamed stars with the
// flag carry 0 in the name slot to hold its position.
// HYG Database v4.1, https://github.com/astronexus/HYG-Database, CC BY-SA 4.0.
const STARS = [
${starLines.join('\n')}
];
// Constellation stick figures, as runs of indices into STARS.
// d3-celestial constellations.lines.json, (c) 2015 Olaf Frohn, BSD 3-Clause,
// digitised from the IAU / Sky & Telescope constellation charts, CC BY 4.0.
const CONSTELLATION_LINES = [
${segments.map(s => `[${s.join(',')}],`).join('\n')}
];
// --- stars:end ---
`;

const dest = path.join(HERE, 'stars.js');
fs.writeFileSync(`${dest}.tmp`, out);
fs.renameSync(`${dest}.tmp`, dest);

const extra = keep.filter(s => s.lineOnly);
const named = keep.filter(s => s.name).length;
const starBytes = Buffer.byteLength(out.slice(0, out.indexOf('// Constellation stick')));
console.log(`\n${keep.length} stars (${named} named): ${keep.length - extra.length} to mag ${MAG_LIMIT}, ${extra.length} fainter ones required by lines (mag ${r2(Math.min(...extra.map(s => s.mag)))} to ${r2(Math.max(...extra.map(s => s.mag)))})`);
console.log(`${segments.length} line runs from ${vertices} vertices, ${unmatched} vertices unmatched${unmatchedIn.size ? ` in ${[...unmatchedIn].join(' ')}` : ''}`);
console.log(`stars.js ${Buffer.byteLength(out)} bytes total, ${starBytes} of that the STARS block`);
