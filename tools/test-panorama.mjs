// node --test tools/test-panorama.mjs
//
// the azimuth-to-x mapping is the thumbnail's whole projection, a full turn
// at a fixed centre and a fixed window, pure arithmetic: get it wrong and a
// ridge sample lands on the wrong side of the canvas. tested here in
// isolation, against a vm context so a broken mapping fails a fast assertion
// instead of a squint at a screenshot. the dialog's own projection,
// stereographic and centred on wherever the reader is looking, is
// panProject below; the eastern-date anchoring both the thumbnail and the
// dialog share is below that.
//
// the block under test is tools/sky-panorama.js, read and evaluated the same
// way tools/test-astro.mjs evaluates sky-astro.js: in a vm with nothing but
// Math in scope, which is also the proof it can be pasted into index.html
// between the panorama markers without dragging anything along. drawPanorama
// itself needs a canvas and Sky/STARS, so it is not exercised here; azToX
// needs neither.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const src = readFileSync(new URL('./sky-panorama.js', import.meta.url), 'utf8');
const astro = readFileSync(new URL('./sky-astro.js', import.meta.url), 'utf8');
// the sky-panorama.js source assumes HORIZON_ALT_MIN/RANGE from the generated
// horizons block, and Sky from the astro block for the sentence tests below;
// both are loaded the way index.html loads them, as earlier scripts in the
// same scope
const ctx = { Math, HORIZON_ALT_MIN: -10, HORIZON_ALT_RANGE: 90 };
vm.createContext(ctx);
vm.runInContext(astro, ctx);
vm.runInContext(src, ctx);
const { azToX, panProject, panCompassMarks, easternInstant, easternParts, decodeHorizon, decodeRidgeLayers, decodeRidgeRanges, panTerrainBands, panSceneBands, panVisibleRidgeMasks, panDistanceRuns, panTreeOcclusionProfile, decodeCanopy, panMaxProfile, panBlocking, panBlock, clearsRidge, panLayerAt, panTerrainVisibleThroughCanopy, horizonSummary } = ctx;

test('azToX is a plain affine map: the window edges land on 0 and w', () => {
  // centre 180, a 120 degree window: the edges are 120 and 240
  assert.equal(azToX(120, 180, 120, 900), 0);
  assert.equal(azToX(180, 180, 120, 900), 450);
  assert.equal(azToX(240, 180, 120, 900), 900);
});

test('azToX at the thumb defaults reproduces the old full-turn formula exactly', () => {
  // the old code was az / 360 * w after folding az into [0, 360); azToX with
  // centre 180 and a 360 degree window has to match it for every az that
  // formula ever saw, including the ridge sweep's two ends, 0 and 360, which
  // must NOT collapse to the same x -- the thumbnail's ridge draws both
  for (const az of [0, 1, 45, 90, 180, 270, 300, 359, 360]) {
    assert.equal(azToX(az, 180, 360, 720), az / 360 * 720, `az ${az}`);
  }
  assert.equal(azToX(0, 180, 360, 720), 0);
  assert.equal(azToX(360, 180, 360, 720), 720);
});

test('compass marks stay in the sky at the top of the current landscape window', () => {
  const marks = panCompassMarks({ az0: 180, w: 1100, h: 600 });
  assert.deepEqual(Array.from(marks, m => m.label), ['SE', 'S', 'SW']);
  assert.deepEqual(Array.from(marks, m => Math.round(m.x)), [100, 550, 1000]);
  assert.deepEqual(Array.from(panCompassMarks({ az0: 160, w: 1100, h: 600 }), m => m.label), ['SE', 'S']);
});

test('ridge bands decode nearest first and paint farthest first', () => {
  const band = v => {
    const n = Math.round((v + 10) / 90 * 4095);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    return (chars[Math.floor(n / 64)] + chars[n % 64]).repeat(360);
  };
  const layers = decodeRidgeLayers([band(12), band(5), band(1)]);
  assert.equal(layers.length, 3);
  assert.ok(Math.abs(layers[0][0] - 12) < 0.03);
  assert.deepEqual(Array.from(panTerrainBands(layers[0], layers), p => Math.round(p[0])), [1, 5, 12]);
  assert.equal(decodeRidgeLayers(null), null);
});

test('the continuous DEM skyline stays behind every adaptive ridge track', () => {
  const skyline = flat(8), near = flat(4), far = flat(6);
  assert.deepEqual(Array.from(panSceneBands(skyline, [near, far]), p => Math.round(p[0])), [8, 6, 4]);
  assert.deepEqual(Array.from(panSceneBands(skyline, null), p => Math.round(p[0])), [8]);
});

test('a full skyline labels separate sustained distance tracks instead of chasing the viewport centre', () => {
  const run = [
    { m: 29000, p: { x: 0 } }, { m: 29425, p: { x: 1 } }, { m: 29125, p: { x: 2 } },
    { m: 76450, p: { x: 3 } }, { m: 80200, p: { x: 4 } }, { m: 79725, p: { x: 5 } },
  ];
  const tracks = panDistanceRuns([run]);
  assert.deepEqual(Array.from(tracks, a => a.length), [3, 3]);
  assert.equal(Math.round(tracks[0][1].m / 1000), 29);
  assert.equal(Math.round(tracks[1][1].m / 1000), 80);
});

test('every sustained, distinct exposed ridge is drawn at a bearing', () => {
  const bands = [flat(4), flat(4.5), flat(6), flat(8), flat(10)];
  const masks = panVisibleRidgeMasks(bands);
  assert.equal(masks[0][120], 1, 'foreground terrain is always present');
  assert.equal(masks[1][120], 0, 'a shallow shell is not a separate ridge');
  assert.equal(masks[2][120], 1, 'the first clear farther crest is retained');
  assert.equal(masks[3][120], 1, 'another independently exposed crest is retained');
  assert.equal(masks[4][120], 1, 'a deep view may retain still another crest');
});

test('a one-degree notch does not manufacture an extra ridge band', () => {
  const near = flat(4), middle = flat(4);
  const far = flat(4);
  far[120] = 8;
  const masks = panVisibleRidgeMasks([near, middle, far]);
  assert.equal(masks[2][120], 0);
});

test('tree crowns are opaque only where they overlap the terrain silhouette', () => {
  const cover = panTreeOcclusionProfile([12, 3, -6], [5, 5, -2]);
  assert.deepEqual(Array.from(cover), [5, 3, -6]);
  assert.equal(panTreeOcclusionProfile(null, [5]), null);
});

test('ridge distance bands decode in 25 m steps', () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const encoded = n => (chars[Math.floor(n / 64)] + chars[n % 64]).repeat(360);
  const ranges = decodeRidgeRanges([encoded(20), encoded(480)]);
  assert.deepEqual(Array.from(ranges, p => p[0]), [500, 12000]);
  assert.equal(decodeRidgeRanges(undefined), null);
});

// panProject is a deliberately stable horizon window. There is no virtual
// camera pitch or zoom: turning only moves the bearing beneath a fixed scale.
test('panProject: the centre bearing stays centred and level stays at one stable row', () => {
  const view = { az0: 200, w: 900, h: 600 };
  const p = panProject(0, 200, view);
  assert.ok(Math.abs(p.x - 450) < 1e-6, `expected centre x 450, got ${p.x}`);
  assert.ok(Math.abs(p.y - (68 / 86 * 600)) < 1e-6, `expected fixed level row, got ${p.y}`);
});

test('panProject: bearings map linearly across the fixed 110 degree window', () => {
  const view = { az0: 90, w: 1100, h: 600 };
  assert.equal(panProject(0, 35, view).x, 0);
  assert.equal(panProject(0, 145, view).x, 1100);
  assert.equal(panProject(0, 146, view), null);
  assert.equal(panProject(0, 34, view), null);
});

test('panProject: altitude is linear and independent of bearing', () => {
  const view = { az0: 0, w: 1000, h: 860 };
  const a = panProject(20, 0, view), b = panProject(20, 30, view);
  assert.equal(a.y, b.y);
  assert.ok(panProject(30, 0, view).y < a.y, 'higher altitude moves up');
  assert.equal(panProject(69, 0, view), null);
});

// eastern-date anchoring: which evening a picked date or "tonight" means has
// to come from the eastern civil calendar, DST-safe, and never from the
// reader's own device clock.
// ponytail: {...x} rather than x itself in every deepEqual below -- x comes
// back from the vm context sky-panorama.js runs in, a different realm with
// its own Object.prototype, and deepEqual's strict mode treats that as "not
// the same kind of object" even when every field matches. spreading it into
// a literal built in this realm is the cheap fix; panProject's own tests
// above sidestep the same issue by comparing plain numbers instead.
test('easternInstant: a January evening (standard time) round-trips to 17:00 eastern', () => {
  assert.deepEqual({ ...easternParts(easternInstant(2026, 1, 15, 17)) }, { y: 2026, mo: 1, d: 15, h: 17, mi: 0 });
});
test('easternInstant: a July evening (daylight time) round-trips to 17:00 eastern', () => {
  assert.deepEqual({ ...easternParts(easternInstant(2026, 7, 15, 17)) }, { y: 2026, mo: 7, d: 15, h: 17, mi: 0 });
});
test('easternInstant: the 2026 spring-forward date (clocks jump at 2am eastern) still round-trips to 17:00', () => {
  assert.deepEqual({ ...easternParts(easternInstant(2026, 3, 8, 17)) }, { y: 2026, mo: 3, d: 8, h: 17, mi: 0 });
});
test('easternInstant: the 2026 fall-back date (clocks jump at 2am eastern) still round-trips to 17:00', () => {
  assert.deepEqual({ ...easternParts(easternInstant(2026, 11, 1, 17)) }, { y: 2026, mo: 11, d: 1, h: 17, mi: 0 });
});
test('easternInstant: the four dates above are not all the same UTC offset (DST actually moved something)', () => {
  const utcHours = [[2026, 1, 15], [2026, 7, 15], [2026, 3, 8], [2026, 11, 1]]
    .map(([y, mo, d]) => easternInstant(y, mo, d, 17).getUTCHours());
  assert.deepEqual(utcHours, [22, 21, 21, 22], `UTC hour of 5pm eastern on each date: ${utcHours}`);
});

test('easternInstant/easternParts do not depend on the process\'s own timezone: TZ=Asia/Tokyo gives the same instants and eastern parts', () => {
  const child = join(dirname(fileURLToPath(import.meta.url)), 'eastern-tz-child.mjs');
  const out = execFileSync(process.execPath, [child], { env: { ...process.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8' });
  const fromTokyo = JSON.parse(out);
  const dates = [[2026, 1, 15], [2026, 7, 15], [2026, 3, 8], [2026, 11, 1]];
  const fromHere = dates.map(([y, mo, d]) => {
    const t = easternInstant(y, mo, d, 17);
    return { iso: t.toISOString(), parts: { ...easternParts(t) } };
  });
  assert.deepEqual(fromTokyo, fromHere,
    'a Tokyo process timezone must not change which instant or which eastern date these resolve to');
});

// the canopy layers: decoded beside the terrain, combined only where a
// consumer needs the highest thing in the way
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const flat = v => new Float64Array(360).fill(v);
const enc = v => { const q = Math.round((v + 10) * 4095 / 90); const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; return (B[Math.floor(q / 64)] + B[q % 64]).repeat(360); };

test('decodeCanopy: t and s decode, a missing layer is null, a missing entry is null', () => {
  const c = decodeCanopy({ t: enc(12), s: enc(30) });
  assert.ok(Math.abs(c.t[0] - 12) < 0.03 && Math.abs(c.s[359] - 30) < 0.03);
  assert.equal(decodeCanopy({ t: enc(12) }).s, null);
  assert.equal(decodeCanopy(undefined), null);
});

test('panBlocking: the highest of ridge, trees and structures per azimuth', () => {
  const ridge = flat(2); ridge[100] = 20;
  const b = panBlocking(ridge, { t: flat(12), s: null });
  assert.equal(b[0], 12);
  assert.equal(b[100], 20);
  const c = panBlocking(ridge, { t: flat(12), s: flat(15) });
  assert.equal(c[0], 15);
});

test('panBlocking with no canopy is the ridge itself, the same object', () => {
  const ridge = flat(2);
  assert.equal(panBlocking(ridge, null), ridge);
  assert.equal(panBlocking(ridge, { t: null, s: null }), ridge);
  assert.equal(panMaxProfile(ridge, null), ridge);
});

test('panLayerAt names the highest layer and gives ties to the ridge', () => {
  const ridge = flat(5);
  assert.equal(panLayerAt(ridge, null, 90), 'ridge');
  assert.equal(panLayerAt(ridge, { t: flat(5), s: null }, 90), 'ridge');
  assert.equal(panLayerAt(ridge, { t: flat(6), s: null }, 90), 'trees');
  assert.equal(panLayerAt(ridge, { t: flat(6), s: flat(7) }, 90), 'structure');
  assert.equal(panLayerAt(ridge, { t: flat(6), s: flat(6) }, 90), 'trees');
});

// the window: f and b, decoded as lo/hi beside t, and what a body sees
// through the gap under the crowns.
const withWindow = () => ({ t: flat(60), s: null, lo: flat(-5), hi: flat(40) });

test('decodeCanopy: f and b decode to lo and hi, and are null when absent', () => {
  const enc2 = v => { const q = Math.round((v + 10) / 90 * 4095); return B64[q >> 6] + B64[q & 63]; };
  const str = v => enc2(v).repeat(360);
  const c = decodeCanopy({ t: str(60), f: str(-5), b: str(40) });
  assert.ok(Math.abs(c.lo[0] + 5) < 0.05 && Math.abs(c.hi[0] - 40) < 0.05);
  const d = decodeCanopy({ t: str(60) });
  assert.equal(d.lo, null); assert.equal(d.hi, null);
});

test('panBlock: no window is exactly panBlocking; a window gives floor, hi and top', () => {
  const ridge2 = flat(3);
  assert.equal(panBlock(ridge2, null), ridge2);
  const plain = panBlock(ridge2, { t: flat(12), s: null, lo: null, hi: null });
  assert.deepEqual(Array.from(plain), Array.from(panBlocking(ridge2, { t: flat(12), s: null })));
  const w = panBlock(ridge2, withWindow());
  assert.equal(w.floor[0], 3); assert.equal(w.hi[0], 40); assert.equal(w.top[0], 60);
});

test('clearsRidge: inside the window is seen, in the crowns is not, above the tree line is', () => {
  const w = panBlock(flat(3), withWindow());
  assert.equal(clearsRidge(w, { alt: 20, az: 90 }), true);
  assert.equal(clearsRidge(w, { alt: 50, az: 90 }), false);
  assert.equal(clearsRidge(w, { alt: 65, az: 90 }), true);
  assert.equal(clearsRidge(w, { alt: 2, az: 90 }), false);
});

test('ridge labels only appear where their terrain is visible through foreground canopy', () => {
  const c = withWindow();
  assert.equal(panTerrainVisibleThroughCanopy(20, c, 90), true, 'the open window exposes a ridge inside it');
  assert.equal(panTerrainVisibleThroughCanopy(40, c, 90), false, 'the crown above that window hides it');
  assert.equal(panTerrainVisibleThroughCanopy(-6, c, 90), false, 'the foreground below that window hides it');
  assert.equal(panTerrainVisibleThroughCanopy(20, { ...c, s: flat(25) }, 90), false, 'a foreground structure hides it too');
});

test('a window under the ridge is no window', () => {
  const w = panBlock(flat(45), withWindow());
  assert.equal(clearsRidge(w, { alt: 42, az: 90 }), false);
});

test('panLayerAt names the trees when a body meets the crowns from below', () => {
  assert.equal(panLayerAt(flat(3), withWindow(), 90, 40), 'trees');
  assert.equal(panLayerAt(flat(3), withWindow(), 90, 3), 'ridge');
});

// the sentence. a september evening at doubletop, the site the feature was
// built for: with the ridge alone the core drops behind the southwest
// around midnight; a tree line across the south-west takes it two hours
// earlier, and the sentence has to say both.
const DOUBLETOP = { lat: 35.3907, lon: -83.0372, elevM: 1635.6, date: easternInstant(2026, 9, 17, 21) };
const say = (horizon, canopy) => horizonSummary({ ...DOUBLETOP, horizon, canopy });
const ridge = flat(2);
const swTrees = flat(-10); for (let az = 190; az <= 270; az++) swTrees[az] = 30;

test('sentence: no canopy is exactly today\'s sentence, and so is a canopy below the ridge', () => {
  const plain = say(ridge, null);
  assert.match(plain, /^moon .*core .*/);
  assert.equal(say(ridge, { t: flat(-10), s: null }), plain);
  assert.equal(say(ridge, { t: null, s: null }), plain);
  assert.doesNotMatch(plain, /trees|structure|\(the ridge/);
});

test('sentence: a south-west tree line sets the core earlier and names the ridge time beside it', () => {
  const s = say(ridge, { t: swTrees, s: null });
  assert.match(s, /core .*drops behind the (south|southwest|west) trees \d+:\d\d[ap]m \(the ridge \d+:\d\d[ap]m\)/, s);
});

test('sentence: a structure is named as one', () => {
  const s = say(ridge, { t: null, s: swTrees });
  assert.match(s, /drops behind the (south|southwest|west) structure \d+:\d\d[ap]m \(the ridge /, s);
});

test('sentence: trees that block all night say when the ridge alone would have let the core through', () => {
  const s = say(ridge, { t: flat(80), s: null });
  assert.match(s, /core never clears the trees tonight \(above the ridge (dusk|\d+:\d\d[ap]m) to (\d+:\d\d[ap]m|first light)\)/, s);
  assert.match(s, /moon never clears the trees tonight \(above the ridge /, s);
});

test('sentence: a tree line within five minutes of the ridge names the trees but adds no ridge time', () => {
  const near = flat(2.01);   // a hair above the ridge everywhere: the trees, but the same crossing
  const s = say(ridge, { t: near, s: null });
  assert.match(s, /trees/, s);
  assert.doesNotMatch(s, /\(the ridge/, s);
});

test('sentence: entering the window from above the crowns names the trees at every window height (the crossing altitude, not a ten-minute sample past it)', () => {
  const t = flat(-10); for (let az = 190; az <= 270; az++) t[az] = 35;
  const lo = flat(-10);
  for (const hiVal of [8, 12, 16, 20]) {
    const hi = flat(-10); for (let az = 190; az <= 270; az++) hi[az] = hiVal;
    const s = say(ridge, { t, s: null, lo, hi });
    assert.match(s, /moon clears the (south|southwest|west) trees \d+:\d\d[ap]m \(above the ridge at dusk\)/, `hi=${hiVal}: ${s}`);
  }
});

test('sentence: already up inside the window at dusk is named the trees too, not only at a rise or set', () => {
  const t = flat(-10); for (let az = 190; az <= 270; az++) t[az] = 35;
  const lo = flat(-10);
  const hi = flat(-10); for (let az = 190; az <= 270; az++) hi[az] = 12;
  const s = say(ridge, { t, s: null, lo, hi });
  assert.match(s, /core already clear of the (south|southwest|west) trees at dusk/, s);
});

test('sentence: with a canopy the sentence keeps its shape, comma separated parts and no trailing full stop', () => {
  // shape only; the tests above pin down the content.
  const s = say(ridge, { t: swTrees, s: null });
  assert.ok(s.split(', ').length >= 3 && !s.endsWith('.'), s);
});

// a window under the crowns is a hole cut out of the tree ring, not the ring
// dropping to the window floor with a crown band laid over it: that drew the
// ring's edge and the band's edge as two chords across one degree, 54 degrees
// tall at View Waynesville (azimuth 77 to 78), with a crest stroked down the
// first and sky showing between them
const winCanopy = () => {
  const t = new Float64Array(360).fill(58), lo = new Float64Array(360).fill(58), hi = new Float64Array(360).fill(58);
  for (let a = 78; a <= 80; a++) { lo[a] = 4.5; hi[a] = 7.5; }
  return { t, s: null, lo, hi };
};

test('panWindowHoles: one hole per window, spanning its degrees and no further', () => {
  const c = winCanopy();
  const plain = x => JSON.parse(JSON.stringify(x));   // arrays from the vm context have its prototype
  const holes = plain(ctx.panWindowHoles(c.lo, c.hi, true));
  assert.equal(holes.length, 1);
  const { top, floor } = holes[0];
  assert.deepEqual(top.map(p => p[0]), [77.5, 78, 79, 80, 80.5]);
  assert.deepEqual(top.map(p => p[1]), [7.5, 7.5, 7.5, 7.5, 7.5]);
  assert.deepEqual(floor.map(p => p[1]), [4.5, 4.5, 4.5, 4.5, 4.5]);
  assert.equal(ctx.panWindowHoles(null, null, true).length, 0);
  assert.equal(ctx.panWindowHoles(c.t, c.t, true).length, 0);
});

test('panWindowHoles: a window through north is one hole in the dialog, two on the flat strip', () => {
  const lo = new Float64Array(360).fill(20), hi = new Float64Array(360).fill(20);
  for (const a of [358, 359, 0, 1]) { lo[a] = 2; hi[a] = 9; }
  const round = ctx.panWindowHoles(lo, hi, true);
  assert.equal(round.length, 1);
  assert.deepEqual([round[0].top[0][0], round[0].top.at(-1)[0]], [357.5, 361.5]);
  assert.equal(ctx.panWindowHoles(lo, hi, false).length, 2);
});

test('panRidgeStrip: holes are cut from the fill, and the crest follows the tree line unbroken', () => {
  const calls = [];
  const rec = name => (...a) => calls.push([name, ...a]);
  const g = { beginPath: rec('begin'), moveTo: rec('move'), lineTo: rec('line'), closePath: rec('close'),
              fill: rec('fill'), stroke: rec('stroke'), setLineDash: () => {} };
  const c = winCanopy();
  ctx.panRidgeStrip(g, c.t, 360, 100, { fill: '#000', crest: '#fff', dash: [] }, ctx.panWindowHoles(c.lo, c.hi, false));
  const fillAt = calls.findIndex(k => k[0] === 'fill');
  assert.equal(calls[fillAt][1], 'evenodd');
  const x = az => vm.runInContext(`panXLin(${az}, 360)`, ctx);
  assert.ok(calls.slice(0, fillAt).some(k => k[0] === 'move' && k[1] === x(77.5)), 'the hole is a subpath of the fill');
  // the crest: the tree line's 361 points in one stroke, then the window floor
  const crest = calls.slice(fillAt + 1);
  const firstStroke = crest.findIndex(k => k[0] === 'stroke');
  assert.equal(crest.slice(0, firstStroke).filter(k => k[0] === 'move').length, 1);
  assert.equal(crest.slice(0, firstStroke).filter(k => k[0] === 'line').length, 360);
  assert.ok(crest.slice(firstStroke).some(k => k[0] === 'move' && k[1] === x(77.5)), 'the window floor gets its own crest');
});
