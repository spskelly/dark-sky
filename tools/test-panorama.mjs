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
const { azToX, wrapNear } = ctx;

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
