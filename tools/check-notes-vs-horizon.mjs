// every card's hand-written note next to what its measured horizon says, so
// a claim like "wide south-facing sky" can be checked against the ridge that
// is actually there. prints one block per spot: the eight compass sectors'
// mean and peak ridge altitude and, where the 2017 lidar covers the spot,
// the mean with trees and structures included, the high and low sides, and
// the note with its directional words marked. the judgement is a human's;
// this only puts the two side by side.
//
//   node tools/check-notes-vs-horizon.mjs            # all spots
//   node tools/check-notes-vs-horizon.mjs "Max Patch" # one
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const B64 = html.match(/PAN_B64 *= *'([^']+)'/)[1];
const MIN = +html.match(/HORIZON_ALT_MIN *= *([-\d.]+)/)[1];
const RANGE = +html.match(/HORIZON_ALT_RANGE *= *([-\d.]+)/)[1];

// the SPOTS array and HORIZONS block, read out of the page rather than by
// running it: both are plain literals
const spotsSrc = html.slice(html.indexOf('const SPOTS = ['), html.indexOf('];', html.indexOf('const SPOTS = [')) + 2);
const SPOTS = new Function(spotsSrc + ' return SPOTS;')();
const horSrc = html.slice(html.indexOf('const HORIZONS = {'), html.indexOf('};', html.indexOf('const HORIZONS = {')) + 2);
const HORIZONS = new Function(horSrc + ' return HORIZONS;')();

// the canopy block, if the page has one: the highest of ridge, trees and
// structures is what a note's "wide south sky" has to be judged against
const canIdx = html.indexOf('const CANOPY = {');
const CANOPY = canIdx < 0 ? {} : new Function(html.slice(canIdx, html.indexOf('};', canIdx) + 2) + ' return CANOPY;')();
const withCanopy = (alt, e) => {
  if (!e) return null;
  const out = alt.slice();
  for (const k of ['t', 's']) if (e[k]) decode(e[k]).forEach((v, i) => { if (v > out[i]) out[i] = v; });
  return out;
};

const decode = s => Array.from({ length: 360 }, (_, i) => MIN + (B64.indexOf(s[2 * i]) * 64 + B64.indexOf(s[2 * i + 1])) * RANGE / 4095);
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const only = process.argv[2];

for (const s of SPOTS) {
  if (only && s.name !== only) continue;
  const h = HORIZONS[s.name];
  if (!h) { console.log(`\n== ${s.name}: no horizon\n`); continue; }
  const alt = decode(h);
  const all = withCanopy(alt, CANOPY[s.name]);
  const sectors = DIRS.map((d, i) => {
    const c = i * 45; let sum = 0, peak = -99, tsum = 0;
    for (let k = -22; k <= 22; k++) {
      const j = ((c + k) % 360 + 360) % 360;
      sum += alt[j]; peak = Math.max(peak, alt[j]);
      if (all) tsum += all[j];
    }
    return { d, mean: sum / 45, peak, tmean: all ? tsum / 45 : null };
  });
  const hi = [...sectors].sort((a, b) => b.mean - a.mean);
  const words = s.note.replace(/\b(north|south|east|west|northeast|northwest|southeast|southwest|ridge|valley|open|360|facing|horizon|wide|enclosed|treeline|trees|tower)\b/gi, m => m.toUpperCase());
  console.log(`\n== ${s.name} (${s.elev} ft${s.view ? ', view point set' : ''})`);
  console.log('   ' + sectors.map(x => `${x.d}:${x.mean.toFixed(1)}/${x.peak.toFixed(1)}${x.tmean === null ? '' : '/' + x.tmean.toFixed(1)}`).join('  '));
  if (all) console.log('   (sector: ridge mean/ridge peak/with trees mean)'); else console.log('   (no canopy entry: trees not modelled here)');
  console.log(`   highest ${hi[0].d} (${hi[0].mean.toFixed(1)}), lowest ${hi[7].d} (${hi[7].mean.toFixed(1)}), overall peak ${Math.max(...alt).toFixed(1)}`);
  console.log('   tags: ' + s.tags.join(', '));
  console.log('   ' + words);
}
