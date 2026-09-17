// node --test tools/test-panorama.mjs
//
// the azimuth-to-x mapping is the one piece of the panorama that is pure
// arithmetic, and the one place a wrap bug hides: get it wrong and a star or
// a ridge sample lands on the wrong side of the canvas, or a line segment
// straddling the back of the view stretches into a stripe across the front
// of it. tested here in isolation, against a vm context so a broken mapping
// fails a fast assertion instead of a squint at a screenshot.
//
// the block under test is tools/sky-panorama.js, read and evaluated the same
// way tools/test-astro.mjs evaluates sky-astro.js: in a vm with nothing but
// Math in scope, which is also the proof it can be pasted into index.html
// between the panorama markers without dragging anything along. drawPanorama
// itself needs a canvas and Sky/STARS, so it is not exercised here; azToX and
// wrapNear need neither.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./sky-panorama.js', import.meta.url), 'utf8');
// the sky-panorama.js source assumes HORIZON_ALT_MIN/RANGE from the generated
// horizons block; only decodeHorizon touches them, and nothing here calls it
const ctx = { Math, HORIZON_ALT_MIN: -10, HORIZON_ALT_RANGE: 90 };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { azToX, wrapNear, panProject } = ctx;

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
  // must NOT collapse to the same x -- that is the one case wrapNear cannot
  // be allowed near, which is why the ridge sweep bypasses it
  for (const az of [0, 1, 45, 90, 180, 270, 300, 359, 360]) {
    assert.equal(azToX(az, 180, 360, 720), az / 360 * 720, `az ${az}`);
  }
  assert.equal(azToX(0, 180, 360, 720), 0);
  assert.equal(azToX(360, 180, 360, 720), 720);
});

test('wrapNear picks the copy of az within 180 degrees of centre', () => {
  assert.equal(wrapNear(10, 350), 370);     // 20 degrees past the centre, not 340 short of it
  assert.equal(wrapNear(340, 10), -20);     // and the other way round
  assert.equal(wrapNear(190, 180), 190);    // already within range: untouched
  assert.equal(wrapNear(0, 180), 0);        // the thumb's own case: identity for anything in [0, 360)
  assert.equal(wrapNear(350, 180), 350);
});

test('wrapNear composed with azToX reproduces the thumb mapping for any az in [0, 360)', () => {
  // panX is azToX(wrapNear(az, az0), az0, fovDeg, w); at the thumb defaults
  // (centre 180, a 360 degree window) that has to still be az / 360 * w for
  // every az the old, unwrapped formula ever normalised into range
  for (let az = 0; az < 360; az += 17) {
    const x = azToX(wrapNear(az, 180), 180, 360, 900);
    assert.ok(Math.abs(x - az / 360 * 900) < 1e-9, `az ${az}`);
  }
});

test('a point just inside a window near the wrap resolves to just inside the canvas', () => {
  // heading 350, a 120 degree window: 290..360/0..50. a star at raw azimuth 10
  // is physically 20 degrees clockwise of the heading, not 340 the long way
  // round, so it belongs a fifth of the way in from the right edge
  const az0 = 350, fov = 120, w = 1200;
  const x = azToX(wrapNear(10, az0), az0, fov, w);
  assert.ok(x > w / 2 && x < w, `expected inside the right half, got ${x}`);
  assert.ok(Math.abs(x - (w / 2 + (20 / fov) * w)) < 1e-9);
});

test('the point diametrically opposite the heading is not ambiguous inside the window', () => {
  // exactly opposite the centre is the one point wrapNear cannot place inside
  // any window narrower than a full turn; both raw copies land the same
  // multiple of a turn-width off-canvas, never inside [0, w]
  const az0 = 40, fov = 120, w = 900;
  const opposite = (az0 + 180) % 360;
  const x = azToX(wrapNear(opposite, az0), az0, fov, w);
  assert.ok(x < 0 || x > w, `expected off-canvas, got ${x}`);
});

test('a segment straddling the wrap is only ever drawn at one of the three turn copies', () => {
  // the milky way and constellation lines try k = -1, 0, 1 turns either side
  // of the raw, locally-unwrapped position. for a window narrower than a
  // turn, at most one of the three can land a given point inside the canvas;
  // this is the property that keeps a segment from being drawn twice inside
  // the visible strip, which is what a stripe actually is
  const az0 = 200, fov = 120, w = 800, turn = 360 / fov * w;
  for (const az of [0, 47, 123.4, 199, 260, 300, 355]) {
    const base = azToX(az, az0, fov, w);
    const inside = [-1, 0, 1].filter(k => base + k * turn >= 0 && base + k * turn <= w);
    assert.ok(inside.length <= 1, `az ${az} landed inside the canvas at ${inside.length} of the 3 copies`);
  }
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
