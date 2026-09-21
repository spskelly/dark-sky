import test from 'node:test';
import assert from 'node:assert/strict';

import { createOfflineMapStore } from '../assets/offline-map-store.mjs';

class MemoryCache {
  constructor() { this.entries = new Map(); }
  async match(key) {
    const response = this.entries.get(String(key));
    return response ? response.clone() : undefined;
  }
  async put(key, response) { this.entries.set(String(key), response.clone()); }
}

function memoryCaches() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new MemoryCache());
      return stores.get(name);
    },
    async delete(name) { return stores.delete(name); },
  };
}

const manifest = {
  schemaVersion: 1,
  bounds: { south: 34.9, west: -84.2, north: 36.6, east: -80.9 },
  layers: {
    orthophoto: { file: 'orthophoto.jpg', bytes: 9 },
    hillshade: { file: 'multidirectional-hillshade.jpg', bytes: 10 },
  },
};

const jpeg = size => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
};

test('offline map layers are unavailable until the complete manifest-backed bundle is cached', async () => {
  const cachesImpl = memoryCaches();
  const store = createOfflineMapStore({
    cachesImpl,
    baseUrl: 'https://example.test/dark-sky/',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  assert.deepEqual(await store.inspect(), { ready: false, bytes: 0, manifest: null });
});

test('download caches the manifest and both verified layers with progress', async () => {
  const cachesImpl = memoryCaches();
  const requests = [];
  const progress = [];
  const fetchImpl = async url => {
    requests.push(String(url));
    if (String(url).endsWith('manifest.json')) {
      return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });
    }
    const size = String(url).endsWith('orthophoto.jpg') ? 9 : 10;
    return new Response(jpeg(size), { headers: { 'content-type': 'image/jpeg' } });
  };
  const store = createOfflineMapStore({ cachesImpl, fetchImpl, baseUrl: 'https://example.test/dark-sky/' });
  const result = await store.download(event => progress.push(event));

  assert.equal(result.ready, true);
  assert.equal(result.bytes, 19);
  assert.deepEqual(requests, [
    'https://example.test/dark-sky/assets/offline-map/manifest.json',
    'https://example.test/dark-sky/assets/offline-map/orthophoto.jpg',
    'https://example.test/dark-sky/assets/offline-map/multidirectional-hillshade.jpg',
  ]);
  assert.deepEqual(progress.map(item => item.completed), [0, 1, 2]);
  assert.equal((await store.inspect()).ready, true);
});

test('a wrong-sized or non-JPEG layer cannot mark a bundle ready', async () => {
  const cachesImpl = memoryCaches();
  const store = createOfflineMapStore({
    cachesImpl,
    baseUrl: 'https://example.test/dark-sky/',
    fetchImpl: async url => String(url).endsWith('manifest.json')
      ? new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } })
      : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }),
  });
  await assert.rejects(store.download(), /valid JPEG/);
  assert.equal(cachesImpl.stores.has(store.cacheName), false, 'an incomplete bundle does not consume device storage');
  assert.equal((await store.inspect()).ready, false);
});

test('remove deletes only the application-owned offline map cache', async () => {
  const cachesImpl = memoryCaches();
  const store = createOfflineMapStore({
    cachesImpl,
    baseUrl: 'https://example.test/dark-sky/',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  await cachesImpl.open('unrelated-cache');
  await cachesImpl.open(store.cacheName);
  await store.remove();
  assert.equal(cachesImpl.stores.has(store.cacheName), false);
  assert.equal(cachesImpl.stores.has('unrelated-cache'), true);
});
