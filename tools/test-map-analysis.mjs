import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { bestViewingSector, sectorSvgPath } = require('../assets/map-analysis.js');

const profile = value => Array.from({ length: 360 }, () => value);

test('finds a broad low eastern horizon', () => {
  const p = profile(24);
  for (let az = 55; az <= 125; az++) p[az] = 2;
  const got = bestViewingSector(p, { width: 60 });
  assert.equal(got.allAround, false);
  assert.ok(Math.abs(got.bearing - 90) <= 1, `expected east, got ${got.bearing}`);
  assert.ok(got.mean < 3);
  assert.ok(got.p90 < 3);
});

test('a sector can cross north without splitting', () => {
  const p = profile(20);
  for (let az = 330; az < 360; az++) p[az] = 1;
  for (let az = 0; az <= 30; az++) p[az] = 1;
  const got = bestViewingSector(p, { width: 60 });
  assert.ok(got.bearing <= 1 || got.bearing >= 359, `expected north, got ${got.bearing}`);
});

test('a uniformly low skyline is described as open all around', () => {
  const got = bestViewingSector(profile(3), { width: 60 });
  assert.equal(got.allAround, true);
  assert.equal(got.mean, 3);
});

test('tree or structure obstruction can redirect the selected sector', () => {
  const terrain = profile(12);
  for (let az = 60; az <= 120; az++) terrain[az] = 1;
  for (let az = 240; az <= 300; az++) terrain[az] = 4;
  const canopy = profile(-10);
  for (let az = 60; az <= 120; az++) canopy[az] = 35;
  const blocked = terrain.map((v, az) => Math.max(v, canopy[az]));
  const got = bestViewingSector(blocked, { width: 60 });
  assert.ok(Math.abs(got.bearing - 270) <= 1, `expected west, got ${got.bearing}`);
});

test('sector SVG paths are finite and retain the requested angular width', () => {
  const east = sectorSvgPath(90, 60);
  assert.match(east, /^M 32 32 L /);
  assert.ok(!east.includes('NaN'));
  assert.notEqual(east, sectorSvgPath(180, 60));
});
