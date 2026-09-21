const DEFAULT_CACHE_NAME = 'blue-ridge-skyline-offline-map-v1';
const DEFAULT_MANIFEST = 'assets/offline-map/manifest.json';
const LAYER_ORDER = ['orthophoto', 'hillshade'];

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || !value.bounds || !value.layers) {
    throw new Error('offline map manifest is not supported');
  }
  for (const key of LAYER_ORDER) {
    const layer = value.layers[key];
    if (!layer || typeof layer.file !== 'string' || layer.file.includes('..') || !Number.isInteger(layer.bytes) || layer.bytes < 4) {
      throw new Error(`offline map manifest has an invalid ${key} layer`);
    }
  }
  return value;
}

function jpegBytes(bytes, expected) {
  return bytes.byteLength === expected && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function createOfflineMapStore(options = {}) {
  const cachesImpl = options.cachesImpl || globalThis.caches;
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const baseUrl = options.baseUrl || globalThis.location?.href;
  const cacheName = options.cacheName || DEFAULT_CACHE_NAME;
  const manifestUrl = new URL(options.manifestUrl || DEFAULT_MANIFEST, baseUrl).href;

  function supported() {
    return Boolean(cachesImpl?.open && cachesImpl?.delete && fetchImpl && baseUrl);
  }

  function requireSupport() {
    if (!supported()) throw new Error('offline map downloads are unavailable in this browser');
  }

  function layerEntries(manifest) {
    return LAYER_ORDER.map(key => ({
      key,
      ...manifest.layers[key],
      url: new URL(manifest.layers[key].file, manifestUrl).href,
    }));
  }

  async function inspect() {
    if (!supported()) return { ready: false, bytes: 0, manifest: null };
    const cache = await cachesImpl.open(cacheName);
    const response = await cache.match(manifestUrl);
    if (!response) return { ready: false, bytes: 0, manifest: null };
    try {
      const manifest = validateManifest(await response.json());
      const layers = layerEntries(manifest);
      for (const layer of layers) {
        if (!await cache.match(layer.url)) return { ready: false, bytes: 0, manifest: null };
      }
      return {
        ready: true,
        bytes: layers.reduce((total, layer) => total + layer.bytes, 0),
        manifest,
      };
    } catch {
      return { ready: false, bytes: 0, manifest: null };
    }
  }

  async function download(onProgress = () => {}) {
    requireSupport();
    const manifestResponse = await fetchImpl(manifestUrl, { cache: 'no-store' });
    if (!manifestResponse.ok) throw new Error(`offline map manifest failed: HTTP ${manifestResponse.status}`);
    const manifest = validateManifest(await manifestResponse.json());
    const layers = layerEntries(manifest);
    const cache = await cachesImpl.open(cacheName);
    try {
      onProgress({ completed: 0, total: layers.length, key: null });
      for (let index = 0; index < layers.length; index++) {
        const layer = layers[index];
        const response = await fetchImpl(layer.url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${layer.key} download failed: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!jpegBytes(bytes, layer.bytes)) throw new Error(`${layer.key} download was not a valid JPEG`);
        await cache.put(layer.url, new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }));
        onProgress({ completed: index + 1, total: layers.length, key: layer.key });
      }
      await cache.put(manifestUrl, new Response(JSON.stringify(manifest), {
        headers: { 'content-type': 'application/json' },
      }));
    } catch (error) {
      await cachesImpl.delete(cacheName);
      throw error;
    }
    return inspect();
  }

  async function available() {
    requireSupport();
    const response = await fetchImpl(manifestUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`offline map manifest failed: HTTP ${response.status}`);
    const manifest = validateManifest(await response.json());
    return {
      bytes: layerEntries(manifest).reduce((total, layer) => total + layer.bytes, 0),
      manifest,
    };
  }

  async function load() {
    requireSupport();
    const state = await inspect();
    if (!state.ready) return null;
    const cache = await cachesImpl.open(cacheName);
    const urls = {};
    for (const layer of layerEntries(state.manifest)) {
      const response = await cache.match(layer.url);
      urls[layer.key] = URL.createObjectURL(await response.blob());
    }
    return {
      ...state,
      urls,
      release() { Object.values(urls).forEach(url => URL.revokeObjectURL(url)); },
    };
  }

  async function remove() {
    if (!cachesImpl?.delete) return false;
    return cachesImpl.delete(cacheName);
  }

  return { cacheName, supported, inspect, available, download, load, remove };
}

if (typeof window !== 'undefined') {
  window.DarkSkyOfflineMaps = { createOfflineMapStore };
}
