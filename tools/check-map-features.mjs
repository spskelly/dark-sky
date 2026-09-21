#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOT_ROOT = join(tmpdir(), 'dark-sky-map-check');
const SPOT_AND_OVERLOOK_COUNT = 154;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures++;
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const path = normalize(join(ROOT, relative));
    if (!path.startsWith(ROOT)) throw new Error('outside root');
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'content-length': info.size });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const { port } = server.address();
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

try {
  const page = await context.newPage();
  page.on('pageerror', error => console.log(`page error: ${error.message}`));
  await page.goto(`http://127.0.0.1:${port}/#where`);
  await page.waitForFunction(() => document.querySelector('#offline-map-status')?.textContent.includes('6.2 MB'));
  let state = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.leaflet-control-layers-base label')].map(label => label.textContent.trim()),
    sectors: spotState.viewSectors.allCount,
    visibleSectors: spotState.viewSectors.getLayers().length,
    balds: SPOTS.filter(spot => spot.bald).length,
  }));
  check(state.labels.join('|') === 'topo|imagery', 'only the current online maps appear before download');
  check(state.sectors === SPOT_AND_OVERLOOK_COUNT, `view sectors cover all ${SPOT_AND_OVERLOOK_COUNT} modelled places`);
  check(state.visibleSectors === 38, 'hidden Parkway overlooks do not clutter the curated-place sector layer');
  check(state.balds === 8, 'only the eight explicitly reviewed bald locations are marked');

  await page.click('#offline-map-action');
  await page.waitForFunction(() => document.querySelector('#offline-map-action')?.textContent === 'remove maps', null, { timeout: 30000 });
  state = await page.evaluate(async () => ({
    labels: [...document.querySelectorAll('.leaflet-control-layers-base label')].map(label => label.textContent.trim()),
    cache: await spotState.offlineMaps.store.inspect(),
  }));
  check(state.cache.ready && state.cache.bytes === 6218950, 'the validated 6.2 MB bundle is stored in the app-owned cache');
  check(state.labels.includes('3DEP hillshade · downloaded') && state.labels.includes('orthophoto · downloaded'), 'downloaded maps enter the layer picker');

  await page.getByText('3DEP hillshade · downloaded', { exact: true }).click();
  await page.getByText('best sky direction', { exact: true }).click();
  await page.waitForTimeout(600);
  await page.locator('#where').screenshot({ path: `${SHOT_ROOT}-desktop.png` });

  await page.reload();
  await page.waitForFunction(() => document.querySelector('#offline-map-action')?.textContent === 'remove maps');
  check(await page.getByText('3DEP hillshade · downloaded', { exact: true }).isVisible(), 'downloaded layers return after a reload');
  await page.click('#offline-map-action');
  await page.waitForFunction(() => document.querySelector('#offline-map-action')?.textContent === 'download maps', null, { timeout: 10000 });
  check((await page.locator('.leaflet-control-layers-base label').allTextContents()).length === 2, 'remove maps returns the picker to the two online layers');

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`http://127.0.0.1:${port}/#where`);
  await phone.waitForFunction(() => document.querySelector('#offline-map-status')?.textContent.includes('6.2 MB'));
  await phone.locator('#offline-map-download').screenshot({ path: `${SHOT_ROOT}-phone.png` });
  console.log(`screenshots: ${SHOT_ROOT}-desktop.png; ${SHOT_ROOT}-phone.png`);
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}

if (failures) process.exitCode = 1;
