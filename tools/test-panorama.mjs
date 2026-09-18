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
const { azToX, panProject, easternInstant, easternParts, decodeHorizon, decodeCanopy, panMaxProfile, panBlocking, panLayerAt, horizonSummary } = ctx;

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

// panProject: the stereographic map the dialog viewer draws through. every
// draw routine in that mode goes through this one function, so a bug here is
// a bug everywhere -- the ridge, the stars, the grid, the moon.
test('panProject: the view centre maps to the centre of the canvas', () => {
  const view = { az0: 200, alt0: 25, fov: 100, w: 900, h: 600 };
  const p = panProject(25, 200, view);
  assert.ok(Math.abs(p.x - 450) < 1e-6 && Math.abs(p.y - 300) < 1e-6, `expected (450, 300), got (${p.x}, ${p.y})`);
});

test('panProject: a point 90 degrees off in azimuth at the view centre\'s own altitude lands left or right, never above or below the centre row by much', () => {
  const view = { az0: 200, alt0: 25, fov: 100, w: 900, h: 600 };
  const right = panProject(25, 290, view);   // +90 degrees of azimuth: clockwise, so screen-right
  const left = panProject(25, 110, view);    // -90 degrees: screen-left
  assert.ok(right.x > 450, `expected right of centre, got x=${right.x}`);
  assert.ok(left.x < 450, `expected left of centre, got x=${left.x}`);
  // symmetric off the view centre's own meridian, so the two are mirror images
  assert.ok(Math.abs((right.x - 450) + (left.x - 450)) < 1e-6,
    `expected the pair symmetric about the centre column (right ${right.x}, left ${left.x})`);
});

test('panProject: directly behind the viewer returns null', () => {
  const view = { az0: 180, alt0: 25, fov: 100, w: 900, h: 600 };
  // the antipode of the view centre: 180 degrees of angular distance, the
  // farthest a point can be, and well past the 100 degree cull
  assert.equal(panProject(-25, 0, view), null);
});

test('panProject: a point 150 degrees off is culled, one 80 degrees off is not', () => {
  const view = { az0: 180, alt0: 0, fov: 100, w: 900, h: 600 };
  assert.equal(panProject(0, 330, view), null);          // 150 degrees of azimuth off, same altitude
  assert.ok(panProject(0, 260, view) !== null);          // 80 degrees off: still in front of the viewer
});

test('panProject: the zenith projects to a finite point when looking straight up', () => {
  const view = { az0: 0, alt0: 90, fov: 100, w: 900, h: 600 };
  const p = panProject(90, 0, view);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `expected finite, got (${p.x}, ${p.y})`);
  assert.ok(Math.abs(p.x - 450) < 1e-6 && Math.abs(p.y - 300) < 1e-6, 'and it is the view centre, so it is the canvas centre');
  // a point 10 degrees down from the zenith, at any azimuth, is the same
  // angular distance from centre either way -- looking straight up, altitude
  // circles are rings, not the strips they are everywhere else
  const a = panProject(80, 0, view), b = panProject(80, 200, view);
  const ra = Math.hypot(a.x - 450, a.y - 300), rb = Math.hypot(b.x - 450, b.y - 300);
  assert.ok(Math.abs(ra - rb) < 1e-6, `expected the same radius at any azimuth (${ra} vs ${rb})`);
});

test('panProject: fov is a true angular field, not an azimuth degree count', () => {
  // at alt0 = 0, an azimuth offset and the true angular distance from centre
  // are the same thing (both points sit on the horizon), so this is the one
  // case an edge lands at a known pixel exactly
  const view = { az0: 90, alt0: 0, fov: 80, w: 1000, h: 600 };
  const edgeR = panProject(0, 90 + 40, view);
  const edgeL = panProject(0, 90 - 40, view);
  assert.ok(Math.abs(edgeR.x - 1000) < 1e-6, `right edge of the window at x=1000, got ${edgeR.x}`);
  assert.ok(Math.abs(edgeL.x - 0) < 1e-6, `left edge of the window at x=0, got ${edgeL.x}`);

  // away from the horizon, an azimuth offset of fov/2 is NOT fov/2 of true
  // angular distance (lines of azimuth converge toward the pole, the same
  // way lines of longitude do) -- an offset that has to hug the edge exactly
  // would be the wrong fix; a straight-up offset of fov/2, which is always a
  // true angular distance whatever the altitude, is the one that belongs on
  // the edge instead
  const tilted = { az0: 90, alt0: 40, fov: 80, w: 1000, h: 600 };
  const notEdge = panProject(40, 90 + 40, tilted);
  assert.ok(Math.abs(notEdge.x - 1000) > 1, `an azimuth offset off the horizon should miss the edge, got ${notEdge.x}`);
  const trueEdge = panProject(40 + 40, 90, tilted);
  assert.ok(Math.abs(trueEdge.x - 500) < 1e-6, 'a pure altitude offset stays on the centre column');
  assert.ok(trueEdge.y < 300, 'and moves toward the top of the canvas');
  const radius = Math.hypot(trueEdge.x - 500, trueEdge.y - 300);
  assert.ok(Math.abs(radius - 500) < 1e-6, `fov/2 of true angular distance lands exactly on the edge radius (${radius})`);
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

test('sentence: with a canopy the ridge alone is not tracked twice for nothing', () => {
  // the two tracks agree on the crossing azimuth family; the strings only
  // differ where the layers do, which the tests above pin down. this one
  // guards the shape: two bodies, comma separated, no trailing punctuation.
  const s = say(ridge, { t: swTrees, s: null });
  assert.ok(s.split(', ').length >= 3 && !s.endsWith('.'), s);
});
