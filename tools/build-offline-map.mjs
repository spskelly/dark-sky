#!/usr/bin/env node

// Build two bounded, browser-ready western North Carolina map images from
// public USGS services. Each image is its own checkpoint: a valid final file
// is skipped on the next run, and downloads are renamed into place only after
// their JPEG signature and response type have been checked.

import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BBOX = [34.9, -84.2, 36.6, -80.9];
const EARTH_M = 6378137;

function checkBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(v => !Number.isFinite(Number(v)))) {
    throw new Error('bbox must be south west north east');
  }
  const [south, west, north, east] = bbox.map(Number);
  if (south >= north || west >= east || south <= -85 || north >= 85) throw new Error('invalid bbox');
  return [south, west, north, east];
}

function mercatorY(lat) {
  return EARTH_M * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
}

export function toWebMercatorBounds(input) {
  const [south, west, north, east] = checkBbox(input);
  return {
    west: EARTH_M * west * Math.PI / 180,
    south: mercatorY(south),
    east: EARTH_M * east * Math.PI / 180,
    north: mercatorY(north),
  };
}

export function fitWebMercatorSize(bounds, maxDimension = 4096) {
  const widthM = bounds.east - bounds.west;
  const heightM = bounds.north - bounds.south;
  if (!(widthM > 0 && heightM > 0)) throw new Error('projected bounds must have positive area');
  const limit = Math.max(256, Math.round(maxDimension));
  if (widthM >= heightM) return { width: limit, height: Math.max(1, Math.round(limit * heightM / widthM)) };
  return { width: Math.max(1, Math.round(limit * widthM / heightM)), height: limit };
}

function exportUrl(base, bounds, size, extra) {
  const url = new URL(base);
  url.search = new URLSearchParams({
    bbox: [bounds.west, bounds.south, bounds.east, bounds.north].map(v => v.toFixed(3)).join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${size.width},${size.height}`,
    format: 'jpg',
    compressionQuality: '88',
    f: 'image',
    ...extra,
  }).toString();
  return url.toString();
}

export function exportRequests(bounds, size) {
  return {
    orthophoto: exportUrl(
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export',
      bounds,
      size,
    ),
    hillshade: exportUrl(
      'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage',
      bounds,
      size,
      { renderingRule: JSON.stringify({ rasterFunction: 'Hillshade Multidirectional' }) },
    ),
  };
}

async function validJpeg(path) {
  try {
    const info = await stat(path);
    if (info.size < 8) return false;
    const handle = await open(path, 'r');
    try {
      const head = Buffer.alloc(3);
      await handle.read(head, 0, 3, 0);
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function fetchLayer({ name, url, path, fetchImpl, force, log }) {
  if (!force && await validJpeg(path)) {
    const info = await stat(path);
    log(`${name}: cached ${(info.size / 1e6).toFixed(2)} MB`);
    return { name, file: path, bytes: info.size, status: 'cached' };
  }
  const temp = `${path}.tmp`;
  await rm(temp, { force: true });
  log(`${name}: requesting ${url}`);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${name} export failed: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('image/')) throw new Error(`${name} export returned ${contentType || 'no content type'}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error(`${name} export was not a JPEG`);
  }
  await writeFile(temp, bytes);
  await rename(temp, path);
  log(`${name}: wrote ${(bytes.length / 1e6).toFixed(2)} MB`);
  return { name, file: path, bytes: bytes.length, status: 'written' };
}

export async function buildOfflineMap(options = {}) {
  const out = resolve(options.out || join(ROOT, 'assets', 'offline-map'));
  const bbox = checkBbox(options.bbox || DEFAULT_BBOX);
  const projected = toWebMercatorBounds(bbox);
  const size = fitWebMercatorSize(projected, options.maxDimension || 4096);
  const requests = exportRequests(projected, size);
  const fetchImpl = options.fetchImpl || fetch;
  const log = options.log || console.log;
  const force = Boolean(options.force);
  const dryRun = Boolean(options.dryRun);
  const files = {
    orthophoto: join(out, 'orthophoto.jpg'),
    hillshade: join(out, 'multidirectional-hillshade.jpg'),
  };

  log(`bounds: ${bbox.join(' ')}; image: ${size.width} x ${size.height}`);
  if (dryRun) {
    log(`orthophoto: ${requests.orthophoto}`);
    log(`hillshade: ${requests.hillshade}`);
    log('dry run, nothing touched');
    return { bbox, projected, size, layers: [] };
  }

  await mkdir(out, { recursive: true });
  const layers = [];
  for (const name of ['orthophoto', 'hillshade']) {
    layers.push(await fetchLayer({ name, url: requests[name], path: files[name], fetchImpl, force, log }));
  }
  const manifest = {
    schemaVersion: 1,
    built: new Date().toISOString(),
    bounds: { south: bbox[0], west: bbox[1], north: bbox[2], east: bbox[3] },
    projection: 'EPSG:3857',
    width: size.width,
    height: size.height,
    layers: {
      orthophoto: {
        file: 'orthophoto.jpg',
        bytes: layers.find(layer => layer.name === 'orthophoto').bytes,
        source: 'USGSImageryOnly MapServer; primarily USDA NAIP in the conterminous United States',
        request: requests.orthophoto,
      },
      hillshade: {
        file: 'multidirectional-hillshade.jpg',
        bytes: layers.find(layer => layer.name === 'hillshade').bytes,
        source: 'USGS 3DEP Elevation ImageServer',
        renderingFunction: 'Hillshade Multidirectional',
        request: requests.hillshade,
      },
    },
  };
  const manifestPath = join(out, 'manifest.json');
  const temp = `${manifestPath}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temp, manifestPath);
  return { bbox, projected, size, layers, manifest };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--max-dimension') opts.maxDimension = Number(argv[++i]);
    else if (arg === '--bbox') opts.bbox = argv.slice(i + 1, i + 5).map(Number), i += 4;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildOfflineMap(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
