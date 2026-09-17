// node --test tools/test-astro.mjs
//
// every assertion below is against a number jean meeus published in
// "astronomical algorithms" (2nd ed.), not against this code's own output, so a
// green run means the algorithms are right rather than unchanged.
//
// tolerances, and why each one is what it is:
//   sidereal time, precession   1e-5 .. 1e-3 deg   full-precision formulae, only
//                                                  rounding separates us
//   sun                         2e-5 deg vs 25.a   same low-accuracy series
//                               0.01 deg vs 25.b   the series' own stated error
//   moon                        0.03 deg           tables 47.A and 47.B are cut
//                                                  at 25 terms each. the dropped
//                                                  coefficients sum to 0.045 deg
//                                                  worst case and about 0.012
//                                                  deg in quadrature; the miss
//                                                  on 47.a below happens to be
//                                                  0.0022 deg. even the worst
//                                                  case is a tenth of the moon's
//                                                  diameter, under a pixel at
//                                                  the panorama's 3 px/deg
//   illuminated fraction        2e-4               follows from the above
//
// the block under test is tools/sky-astro.js, read and evaluated in a vm with
// nothing but Math in scope, which is also the proof it can be pasted into
// index.html between the astro markers without dragging anything along.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(new URL('./sky-astro.js', import.meta.url), 'utf8');
const Sky = vm.runInNewContext(src + ';Sky', { Math });

// report the miss on every check, so a passing run still shows how close it is
function near(actual, expected, tol, label) {
  const d = actual - expected;
  console.log(`  ${label.padEnd(34)} got ${actual.toFixed(6).padStart(12)}  meeus ${expected.toFixed(6).padStart(12)}  delta ${d.toExponential(2).padStart(10)}`);
  assert.ok(Math.abs(d) <= tol, `${label}: |${d}| > ${tol}`);
}

const hms = (h, m, s) => 15 * (h + m / 60 + s / 3600);
const dms = (d, m, s) => Math.sign(d || 1) * (Math.abs(d) + m / 60 + s / 3600);

test('julian day (ch.7, example 7.a)', () => {
  // 1957 october 4.81 UT, sputnik 1, is JD 2436116.31
  near(Sky.julianDay(new Date(Date.UTC(1957, 9, 4, 19, 26, 24))), 2436116.31, 1e-6, 'JD 1957 Oct 4.81');
  // 1987 april 10.0 UT is JD 2446895.5, the epoch example 12.a works from
  near(Sky.julianDay(new Date(Date.UTC(1987, 3, 10))), 2446895.5, 1e-9, 'JD 1987 Apr 10.0');
});

test('sidereal time (ch.12, example 12.a)', () => {
  // meeus: mean sidereal time at greenwich, 1987 april 10 at 0h UT, is
  // 13h10m46.3668s = 197.693195 degrees
  near(Sky.lmst(2446895.5, 0), 197.693195, 1e-5, 'GMST 1987 Apr 10.0');
  // example 12.b, the same day at 19h21m00s UT: 8h34m57.0896s
  near(Sky.lmst(2446895.5 + (19 + 21 / 60) / 24, 0), hms(8, 34, 57.0896), 1e-4, 'GMST 1987 Apr 10 19:21');
  // east-positive longitude, so an observer 90 degrees east is 6h further on
  near(Sky.lmst(2446895.5, 90), 197.693195 + 90, 1e-5, 'LMST at lon +90');
});

test('sun (ch.25, examples 25.a and 25.b)', () => {
  const jde = 2448908.5;                       // 1992 october 13.0 TD
  const s = Sky.sunPosition(jde);
  // example 25.a, the low-accuracy series this code implements:
  // apparent alpha = 198.38083 deg, delta = -7.78507 deg
  near(s.ra, 198.38083, 2e-5, 'sun RA vs 25.a');
  near(s.dec, -7.78507, 2e-5, 'sun Dec vs 25.a');
  // example 25.b, the full VSOP87 answer for the same instant:
  // alpha = 13h13m30.749s, delta = -7 deg 47' 01".74. the gap below is the
  // low-accuracy series' real error, and it is inside meeus's stated 0.01 deg
  near(s.ra, hms(13, 13, 30.749), 0.01, 'sun RA vs 25.b (VSOP87)');
  near(s.dec, -dms(7, 47, 1.74), 0.01, 'sun Dec vs 25.b (VSOP87)');
  // 25.b also gives R = 0.99760775 AU
  near(s.distKm / 149597870.7, 0.99760775, 1e-4, 'sun distance AU vs 25.b');
});

test('moon (ch.47, example 47.a)', () => {
  const jde = 2448724.5;                       // 1992 april 12.0 TD
  const m = Sky.moonPosition(jde);
  // meeus: apparent alpha = 134.688470 deg, delta = +13.768368 deg,
  // distance = 368409.7 km
  near(m.ra, 134.688470, 0.03, 'moon RA vs 47.a');
  near(m.dec, 13.768368, 0.03, 'moon Dec vs 47.a');
  // the dropped tail of table 47.A costs more in distance than in longitude:
  // about 46 km, 0.013 percent, which moves the horizontal parallax by 0.0003
  // degrees and the drawn disc by nothing at all
  near(m.distKm, 368409.7, 60, 'moon distance km vs 47.a');
});

test('illumination and bright limb (ch.48, example 48.a)', () => {
  const jde = 2448724.5;                       // same instant as 47.a
  // location is irrelevant to these two: ch.48 works from the geocentric places
  const m = Sky.moonTopocentric(jde, 35.45, -83.14, 1800);
  // meeus: k = 0.6786 and chi = 285.0 degrees
  near(m.illum, 0.6786, 2e-4, 'illuminated fraction vs 48.a');
  near(m.limbAngle, 285.0, 0.5, 'bright limb angle vs 48.a');
});

test('topocentric parallax (ch.40, against the parallax published in 47.a)', () => {
  const jde = 2448724.5;
  const m = Sky.moonPosition(jde);
  // put the observer on the equator with the moon exactly on his horizon: the
  // whole parallax is then vertical and equals the equatorial horizontal
  // parallax, which example 47.a gives as pi = 0.991990 degrees
  const theta = m.ra + 90;
  const lon = theta - Sky.lmst(jde, 0);
  const t = Sky.moonTopocentric(jde, 0, lon, 0);
  const geo = Sky.equatorialToHorizontal(m.ra, m.dec, theta, 0);
  const topo = Sky.equatorialToHorizontal(t.ra, t.dec, theta, 0);
  near(geo.alt, 0, 1e-9, 'geocentric altitude is zero by construction');
  near(geo.alt - topo.alt, 0.991990, 1e-3, 'horizontal parallax vs 47.a');
  // with the moon on the horizon the observer is not nearer it but off to one
  // side, so the topocentric distance is the hypotenuse: sqrt(d^2 + R^2), about
  // 55 km further out. this is the check that the vector really is a vector
  near(t.distKm, Math.hypot(m.distKm, 6378.14), 0.01, 'topocentric distance, km');
});

test('equatorial to horizontal round trip', () => {
  const lat = 35.4524, lmstDeg = 142.1234;     // waterrock knob, arbitrary sidereal time
  for (const [ra, dec] of [[0, 0], [83.6, 22.0], [279.2, 38.8], [37.95, 89.26], [200, -45]]) {
    const { alt, az } = Sky.equatorialToHorizontal(ra, dec, lmstDeg, lat);
    // the inverse rotation, written out here rather than shipped: nothing in
    // the panorama needs to go this direction
    const d2 = Math.asin(Math.sin(lat * Math.PI / 180) * Math.sin(alt * Math.PI / 180)
      + Math.cos(lat * Math.PI / 180) * Math.cos(alt * Math.PI / 180) * Math.cos(az * Math.PI / 180)) * 180 / Math.PI;
    const H = Math.atan2(-Math.cos(alt * Math.PI / 180) * Math.sin(az * Math.PI / 180),
      Math.cos(lat * Math.PI / 180) * Math.sin(alt * Math.PI / 180)
      - Math.sin(lat * Math.PI / 180) * Math.cos(alt * Math.PI / 180) * Math.cos(az * Math.PI / 180)) * 180 / Math.PI;
    const ra2 = ((lmstDeg - H) % 360 + 360) % 360;
    near(ra2, ra, 1e-9, `round trip RA ${ra}`);
    near(d2, dec, 1e-9, `round trip Dec ${dec}`);
  }
  // azimuth convention: an object on the meridian south of the zenith reads 180
  const south = Sky.equatorialToHorizontal(lmstDeg, 0, lmstDeg, lat);
  near(south.az, 180, 1e-9, 'due south azimuth');
  near(south.alt, 90 - lat, 1e-9, 'meridian altitude of the equator');
});

test('parallactic angle (ch.14)', () => {
  const lat = 35.4524;
  // on the meridian, an object transiting south of the zenith has the pole
  // straight up from it, so q is exactly zero
  near(Sky.parallacticAngle(100, 10, 100, lat), 0, 1e-12, 'q on meridian, south of zenith');
  // and one transiting north of the zenith has the pole straight down from it
  near(Math.abs(Sky.parallacticAngle(100, 80, 100, lat)), 180, 1e-12, 'q on meridian, north of zenith');
  // the sign is the side of the meridian: negative east of it, positive west,
  // and symmetric about it for the same object
  const east = Sky.parallacticAngle(100, 10, 100 - 30, lat);
  const west = Sky.parallacticAngle(100, 10, 100 + 30, lat);
  assert.ok(east < 0 && west > 0, `q should straddle zero, got ${east} and ${west}`);
  near(west, -east, 1e-12, 'q is symmetric about the meridian');
  // closed form to check against something other than itself: for an observer on
  // the equator watching a point on the celestial equator, tan(lat) is zero and
  // the angle collapses to a right angle on whichever side of the meridian it is
  near(Sky.parallacticAngle(0, 0, 45, 0), 90, 1e-12, 'q at lat 0, dec 0, H +45');
  near(Sky.parallacticAngle(0, 0, -45, 0), -90, 1e-12, 'q at lat 0, dec 0, H -45');
  // at the north pole the zenith is the pole, so q is zero wherever you look
  near(Sky.parallacticAngle(0, 40, 137, 90), 0, 1e-12, 'q at the north pole');
  // the zenith is degenerate (both arguments vanish). it must not be NaN
  const z = Sky.parallacticAngle(100, lat, 100, lat);
  assert.ok(Number.isFinite(z), `q at the zenith is ${z}`);
  // what the renderer actually asks for: the bright limb measured from the
  // zenith direction rather than from the celestial pole
  const jd = Sky.julianDay(new Date(Date.UTC(2026, 8, 16, 1, 0)));
  const m = Sky.moonTopocentric(jd, lat, -83.1387, 1830);
  const q = Sky.parallacticAngle(m.ra, m.dec, Sky.lmst(jd, -83.1387), lat);
  assert.ok(Number.isFinite(m.limbAngle - q), 'limbAngle - q is finite');
});

test('refraction (bennett)', () => {
  // at the zenith there is nothing to refract through
  near(Sky.refract(90) - 90, 0, 0.01, 'refraction at zenith, deg');
  // at the horizon bennett gives 34.5 arcmin, the classic half a degree that
  // makes the sun visible while it is geometrically already down
  near((Sky.refract(0) - 0) * 60, 34.5, 0.2, 'refraction at horizon, arcmin');
  // and it falls off fast: about 5.3 arcmin at 10 degrees up
  near((Sky.refract(10) - 10) * 60, 5.3, 0.2, 'refraction at 10 deg, arcmin');
  // the clamp keeps it finite where the panorama actually draws
  assert.ok(Number.isFinite(Sky.refract(-10)), 'refraction stays finite below the horizon');
});

test('precession (ch.21, example 21.b)', () => {
  // theta persei, J2000 alpha 2h44m11.986s delta +49d13'42".48, carried to
  // 2462088.69 (2028 november 13.19). meeus applies proper motion first:
  // +0.03425 s/yr in alpha, -0.0895 "/yr in delta, over 28.8672 years
  const yr = 28.8672;
  const ra0 = hms(2, 44, 11.986) + yr * 0.03425 * 15 / 3600;
  const dec0 = dms(49, 13, 42.48) + yr * -0.0895 / 3600;
  const p = Sky.precess(ra0, dec0, 2451545.0, 2462088.69);
  // meeus: alpha = 2h46m11.331s, delta = +49d20'54".54
  near(p.ra, hms(2, 46, 11.331), 1e-3, 'theta Per RA 2028 vs 21.b');
  near(p.dec, dms(49, 20, 54.54), 1e-3, 'theta Per Dec 2028 vs 21.b');
  // a catalogue drawn on tonight's sky is out by about a third of a degree if
  // this step is skipped, which is the reason it exists
  const now = Sky.precess(83.633, 22.014, 2451545.0, 2461041.5);   // 2026, near betelgeuse
  const moved = Math.hypot((now.ra - 83.633) * Math.cos(22.014 * Math.PI / 180), now.dec - 22.014);
  assert.ok(moved > 0.3 && moved < 0.4, `J2000 to 2026 shift ${moved} deg, expected about 0.35`);
  // and it is reversible
  const back = Sky.precess(now.ra, now.dec, 2461041.5, 2451545.0);
  near(back.ra, 83.633, 1e-6, 'precession round trip RA');
  near(back.dec, 22.014, 1e-6, 'precession round trip Dec');
});

test('galactic to equatorial', () => {
  // l = 0, b = 0 is the galactic centre, within 0.1 deg of sagittarius A* at
  // 17h45m40s, -29d00'28" (J2000)
  const c = Sky.galacticToEquatorial(0, 0);
  near(c.ra, hms(17, 45, 40), 0.15, 'galactic centre RA');
  near(c.dec, -dms(29, 0, 28), 0.15, 'galactic centre Dec');
  // the north galactic pole, b = +90, is the defining constant of the rotation
  const p = Sky.galacticToEquatorial(123, 90);
  near(p.ra, 192.85948, 1e-6, 'north galactic pole RA');
  near(p.dec, 27.12825, 1e-6, 'north galactic pole Dec');
  // and the band is continuous: stepping l all the way round stays on a great
  // circle, so every point at b = 0 is 90 degrees from that pole
  for (let l = 0; l < 360; l += 30) {
    const q = Sky.galacticToEquatorial(l, 0);
    const cosSep = Math.sin(27.12825 * Math.PI / 180) * Math.sin(q.dec * Math.PI / 180)
      + Math.cos(27.12825 * Math.PI / 180) * Math.cos(q.dec * Math.PI / 180)
      * Math.cos((192.85948 - q.ra) * Math.PI / 180);
    assert.ok(Math.abs(cosSep) < 1e-12, `l=${l} is not on the galactic equator`);
  }
});
