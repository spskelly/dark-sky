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
// the sky-panorama.js source assumes HORIZON_ALT_MIN/RANGE from the generated
// horizons block; only decodeHorizon touches them, and nothing here calls it
const ctx = { Math, HORIZON_ALT_MIN: -10, HORIZON_ALT_RANGE: 90 };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { azToX, panProject, easternInstant, easternParts } = ctx;

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
