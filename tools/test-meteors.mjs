// node --test tools/test-meteors.mjs
//
// the meteor shower block in index.html, between the "meteors:start" and
// "meteors:end" markers, evaluated in a vm next to tools/sky-astro.js, which is
// all it leans on. the dates are checked against numbers published elsewhere
// rather than against this code's own output:
//
//   solar longitude   meeus example 25.a, 0.001 deg: the same series, so only
//                     the ra/dec round trip separates us
//   geminids 2025     the imo's 2025 calendar puts the peak at 14 december,
//                     08h UT. three hours of slack is an eighth of a degree of
//                     solar longitude, finer than the published lambda itself
//
// the night rule and the moon verdict are checked on their own terms.

// the night a peak belongs to is a local date, so pin the zone before anything
// makes a Date
process.env.TZ = 'America/New_York';

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const astro = readFileSync(new URL('./sky-astro.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = page.indexOf('// --- meteors:start');
const end = page.indexOf('// --- meteors:end');
assert.ok(start >= 0 && end > start, 'the meteors:start and meteors:end markers are still in index.html');
const block = page.slice(start, end);

const ctx = vm.createContext({ Math, Date, Map });
vm.runInContext(`${astro}\n${block}\nglobalThis.M = { SHOWERS, Sky, solarLongitude, solarLongitudeTime, showerNight, showerPeaks, showerOutlook };`, ctx);
const M = ctx.M;
const byName = name => M.SHOWERS.find(s => s.name === name);
const WAYNESVILLE = [35.4887, -82.9887];

test('solar longitude (meeus example 25.a, back to the equinox of date)', () => {
  // 1992 october 13.0 TD: apparent longitude 199.90895 degrees, of date
  const jd = 2448908.5;
  const T = (jd - 2451545) / 36525;
  const ofDate = M.solarLongitude(jd) + 1.396971 * T;
  assert.ok(Math.abs(ofDate - 199.90895) < 1e-3, `got ${ofDate}`);
});

test('the peak instant lands on its own solar longitude', () => {
  for (const s of M.SHOWERS) {
    for (const y of [2024, 2026, 2031]) {
      const t = M.solarLongitudeTime(s.lam, y);
      assert.equal(t.getUTCFullYear(), y, `${s.name} ${y} stays in its year`);
      const lam = M.solarLongitude(M.Sky.julianDay(t));
      const miss = Math.abs(((lam - s.lam + 540) % 360) - 180);
      assert.ok(miss < 1e-4, `${s.name} ${y}: ${miss} deg off`);
    }
  }
});

test('geminids 2025 peak against the imo calendar', () => {
  const t = M.solarLongitudeTime(byName('Geminids').lam, 2025);
  const hours = (t - Date.UTC(2025, 11, 14, 8)) / 3600000;
  assert.ok(Math.abs(hours) < 3, `${t.toISOString()} is ${hours.toFixed(1)} h from 2025-12-14T08Z`);
});

test('every peak night falls inside its own activity range', () => {
  for (const p of M.showerPeaks(new Date(2026, 0, 1), new Date(2030, 11, 31))) {
    const { from, to, name } = p.shower;
    const md = p.night.getMonth() * 100 + p.night.getDate() + 100;
    const lo = from[0] * 100 + from[1], hi = to[0] * 100 + to[1];
    // the quadrantids run across new year, so their range wraps
    const inside = lo <= hi ? md >= lo && md <= hi : md >= lo || md <= hi;
    assert.ok(inside, `${name} night ${p.night.toDateString()} outside ${from}..${to}`);
  }
});

test('a peak belongs to the night whose 3am is nearest', () => {
  const night = (d, h) => M.showerNight(new Date(2026, 7, d, h)).getDate();
  assert.equal(night(13, 3), 12, '3am on the 13th is the night of the 12th');
  assert.equal(night(13, 14), 12, '2pm on the 13th is still nearer the 13th’s 3am');
  assert.equal(night(13, 16), 13, '4pm on the 13th is nearer the 14th’s 3am');
  assert.equal(night(12, 23), 12, '11pm on the 12th is the night of the 12th');
});

test('a year of peaks comes back once each, in night order', () => {
  const peaks = M.showerPeaks(new Date(2026, 9, 8), new Date(2027, 9, 7));
  assert.equal(peaks.length, M.SHOWERS.length);
  assert.equal(new Set(peaks.map(p => p.shower.name)).size, M.SHOWERS.length);
  for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i].night >= peaks[i - 1].night);
});

test('the moon verdict follows the moon', () => {
  const at = (name, y) => M.showerPeaks(new Date(y, 0, 1), new Date(y, 11, 31)).find(p => p.shower.name === name);
  // 2026: a thin crescent that sets in the evening for the geminids, and a
  // moon a day or two short of full for the ursids
  const gem = M.showerOutlook(at('Geminids', 2026), ...WAYNESVILLE);
  const urs = M.showerOutlook(at('Ursids', 2026), ...WAYNESVILLE);
  assert.equal(gem.verdict, 'dark');
  assert.ok(gem.best.rate > 120, `geminids ceiling ${gem.best.rate}`);
  assert.equal(urs.verdict, 'moonlit');
  assert.equal(urs.moonMin, urs.darkMin, 'a near-full moon is up all night in december');
  // the radiant's altitude caps the eta aquariids however dark it is
  const eta = M.showerOutlook(at('Eta Aquariids', 2027), ...WAYNESVILLE);
  assert.ok(eta.bestClear < byName('Eta Aquariids').zhr / 2, `eta aquariids ceiling ${eta.bestClear}`);
});
