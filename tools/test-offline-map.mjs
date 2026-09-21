import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BBOX,
  buildOfflineMap,
  exportRequests,
  fitWebMercatorSize,
  toWebMercatorBounds,
} from './build-offline-map.mjs';

test('the default bounds contain the curated western North Carolina places', () => {
  assert.deepEqual(DEFAULT_BBOX, [34.9, -84.2, 36.6, -80.9]);
});

test('Web Mercator bounds and output dimensions preserve the projected aspect', () => {
  const bounds = toWebMercatorBounds(DEFAULT_BBOX);
  assert.ok(bounds.west < bounds.east);
  assert.ok(bounds.south < bounds.north);
  const size = fitWebMercatorSize(bounds, 4096);
  assert.equal(size.width, 4096);
  assert.ok(size.height > 2200 && size.height < 3000, `unexpected height ${size.height}`);
});

test('requests use the USGS orthophoto and the 3DEP multidirectional hillshade', () => {
  const bounds = toWebMercatorBounds(DEFAULT_BBOX);
  const size = fitWebMercatorSize(bounds, 4096);
  const req = exportRequests(bounds, size);
  assert.match(req.orthophoto, /USGSImageryOnly\/MapServer\/export/);
  assert.match(req.hillshade, /3DEPElevation\/ImageServer\/exportImage/);
  assert.equal(JSON.parse(new URL(req.hillshade).searchParams.get('renderingRule')).rasterFunction,
    'Hillshade Multidirectional');
  assert.match(req.orthophoto, /imageSR=3857/);
});

test('the build checkpoints each valid image and skips completed outputs', async () => {
  const out = await mkdtemp(join(tmpdir(), 'dark-sky-offline-map-'));
  const calls = [];
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9]);
  const fetchImpl = async url => {
    calls.push(String(url));
    return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    const first = await buildOfflineMap({ out, maxDimension: 512, fetchImpl, log: () => {} });
    assert.equal(calls.length, 2);
    assert.equal(first.layers.length, 2);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.bounds, { south: 34.9, west: -84.2, north: 36.6, east: -80.9 });
    assert.equal(manifest.layers.orthophoto.bytes, jpeg.length);
    assert.equal(manifest.layers.hillshade.bytes, jpeg.length);
    assert.equal(manifest.layers.hillshade.renderingFunction, 'Hillshade Multidirectional');

    await buildOfflineMap({ out, maxDimension: 512, fetchImpl, log: () => {} });
    assert.equal(calls.length, 2, 'a resumed build does not fetch completed layers again');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
