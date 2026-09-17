// checks the three tab panels: one open at a time, the hash still selects one,
// and the two things that cannot be measured in a hidden panel (the leaflet map
// and the skyline canvases) come out the right size once their tab is opened.
//
//   node tools/check-tabs.mjs            # assert only, ~20 s
//   node tools/check-tabs.mjs --shots    # also write png per tab to tools/.shots/
//
// exits non-zero on the first failed assertion.

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// a path argument checks some other copy of the page — a staged blob, say —
// rather than the working tree's index.html
const FILE = process.argv.slice(2).find(a => !a.startsWith('--')) || 'index.html';
const URL_ = pathToFileURL(join(ROOT, FILE)).href;
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = join(ROOT, 'tools', '.shots');
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

let failed = 0;
function ok(cond, what) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) failed++;
}

// a 1x1 transparent png, served locally in place of every light pollution
// tile. the weather and basemap hosts are simply aborted, since nothing here
// reads their response; the atlas tiles cannot be, because the light
// pollution layer is on by default and its own tileerror handler removes the
// layer and posts a visible message after four failures, which is a change
// in the behaviour under test, not a quiet no-op.
const LP_BLANK = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

// works on a page or a browser context alike: both expose .route with the
// same signature, and routing a context covers every page it opens after.
async function quiet(target) {
  await target.route('**://api.open-meteo.com/**', r => r.abort());
  await target.route('**://*.tile.opentopomap.org/**', r => r.abort());
  await target.route('**://basemap.nationalmap.gov/**', r => r.abort());
  await target.route('**://djlorenz.github.io/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: LP_BLANK }));
}

// the page draws from the network (open-meteo, basemap tiles, atlas tiles);
// none of it is needed for layout, so a run offline still has to pass
async function open(browser, viewport, hash = '') {
  const page = await browser.newPage({ viewport });
  await quiet(page);
  await page.goto(URL_ + hash);
  await page.waitForFunction(() => document.querySelectorAll('[role="tabpanel"]').length === 3);
  return page;
}

const visible = page => page.$$eval('[role="tabpanel"]',
  ps => ps.filter(p => p.offsetParent !== null || getComputedStyle(p).display !== 'none').map(p => p.id));
const selected = page => page.$$eval('[role="tab"]',
  ts => ts.filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.id));

// the installed chrome first: playwright's own build is a 180 MB download and
// the one this version wants is usually not the one already on the machine
const browser = await chromium.launch({ channel: 'chrome' })
  .catch(() => chromium.launch());
if (SHOTS) await mkdir(SHOT_DIR, { recursive: true });

// --- one panel at a time, and the tabs switch it ---
{
  const page = await open(browser, DESKTOP);
  ok((await visible(page)).join() === 'panel-when', 'opens on the calendar panel');
  ok((await selected(page)).join() === 'tab-when', 'its tab is the selected one');

  for (const [tab, panel] of [['tab-tonight', 'panel-tonight'], ['tab-where', 'panel-where'], ['tab-when', 'panel-when']]) {
    await page.click(`#${tab}`);
    ok((await visible(page)).join() === panel, `${tab} shows only ${panel}`);
    ok((await selected(page)).join() === tab, `${tab} is marked selected`);
    ok(await page.evaluate(() => location.hash) !== '', `${tab} writes a hash`);
  }

  // arrow keys, since the tab bar is the page's only navigation on a phone
  await page.focus('#tab-when');
  await page.keyboard.press('ArrowLeft');
  ok((await selected(page)).join() === 'tab-where', 'arrow-left from the first tab wraps to the last');

  // the complaint that started this check: as three identical cards the tabs
  // read as decoration. the selected one has to differ in more than a border
  // colour, and the bar needs its rail, or nothing says these are tabs at all.
  const look = await page.evaluate(() => {
    const sel = document.querySelector('[role="tab"][aria-selected="true"]');
    const un = document.querySelector('[role="tab"][aria-selected="false"]');
    const q = t => getComputedStyle(t.querySelector('b')).color;
    return { lit: q(sel), quiet: q(un),
             accent: getComputedStyle(sel).boxShadow,
             rail: getComputedStyle(document.querySelector('.guide')).borderBottomWidth };
  });
  ok(look.lit !== look.quiet, `the selected question is lit and the others are not (${look.lit} vs ${look.quiet})`);
  ok(look.accent !== 'none', 'the selected tab carries an accent, not just a border');
  ok(parseFloat(look.rail) > 0, 'the tab bar sits on a rail');

  // the notes list and the credits sit outside every panel: they are never hidden
  ok(await page.isVisible('#notes') && await page.isVisible('#credits'), 'notes and credits stay outside the tabs');
  await page.close();
}

// --- deep link into a panel ---
{
  const page = await open(browser, DESKTOP, '#where');
  ok((await visible(page)).join() === 'panel-where', '#where opens the spots panel');

  // the map: built on first reveal, so it must have a real size and real bounds
  const map = await page.evaluate(() => {
    const el = document.getElementById('map');
    // spotState is a top-level const in a classic script: reachable by name,
    // not as a window property
    const b = typeof spotState !== 'undefined' ? spotState.map?.getBounds?.() : null;
    return { w: el.clientWidth, h: el.clientHeight, span: b ? b.getNorth() - b.getSouth() : 0 };
  });
  ok(map.w > 200 && map.h > 100, `map has a size (${map.w}x${map.h})`);
  ok(map.span > 0.05, `map is framed on the spots (${map.span.toFixed(2)} degrees tall)`);

  // the skyline canvases: painted at the panel's real width, not the 300px default
  const cv = await page.evaluate(() => {
    const c = document.querySelector('#spot-list canvas.skyline');
    if (!c) return null;
    return { client: c.clientWidth, backing: c.width, dpr: window.devicePixelRatio };
  });
  if (cv === null) ok(true, 'no skyline canvases in this build, nothing to size');
  else ok(cv.backing === Math.round(cv.client * cv.dpr),
    `skyline canvas painted at panel width (${cv.client} css px, ${cv.backing} device px)`);

  // a hike-in spot shows the climb, a drive-up spot shows one figure
  const tags = await page.$$eval('#spot-list .tag', els => els.map(e => e.textContent));
  ok(tags.includes('3,890 ft lot · 5,835 ft view'), 'mount sterling shows lot and view elevation');
  ok(tags.includes('4,620 ft'), 'cove field, with no walk, shows one');

  // this panel is drawn twice: once by renderSpotList at load, once when the
  // tab first opens. a skyline has to take one click to open and one to close,
  // not two of each, which is what a listener bound per draw would cost.
  if (cv !== null) {
    const box = '#spot-list .pano';
    await page.click(`${box} canvas.skyline`);
    ok(await page.$eval(box, b => b.classList.contains('open')), 'one click opens a skyline');
    await page.click(`${box} canvas.skyline`);
    ok(await page.$eval(box, b => !b.classList.contains('open')), 'and one closes it again');
  }
  await page.close();
}

// --- the remembered tab, and the hash outranking it ---
{
  // one context, so the two loads share a localStorage the way two visits do
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const first = await ctx.newPage();
  await first.goto(URL_);
  await first.click('#tab-tonight');
  await first.close();

  const back = await ctx.newPage();
  await back.goto(URL_);
  await back.waitForFunction(() => document.querySelectorAll('[role="tabpanel"]').length === 3);
  ok((await visible(back)).join() === 'panel-tonight', 'a return visit opens the tab you left on');
  ok(await back.evaluate(() => location.hash) === '#tonight', 'and puts that tab in the URL');

  const linked = await ctx.newPage();
  await linked.goto(URL_ + '#where');
  await linked.waitForFunction(() => document.querySelectorAll('[role="tabpanel"]').length === 3);
  ok((await visible(linked)).join() === 'panel-where', 'a hash outranks the remembered tab');
  await ctx.close();
}

// --- values saved by the page before recall/remember existed still load ---
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const seed = await ctx.newPage();
  await seed.goto(URL_);
  await seed.evaluate(() => {
    localStorage.setItem('darksky.home', JSON.stringify({ lat: 35.5951, lon: -82.5515, name: 'Asheville' }));
    localStorage.setItem('darksky.lightpollution', '0');
    localStorage.setItem('darksky.tab', 'tab-where');
  });
  await seed.close();
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const got = await page.evaluate(() => ({
    home: spotState.home.name, tab: document.querySelector('[role="tab"][aria-selected="true"]').id,
    lp: !!document.querySelector('.leaflet-control-layers-overlays input:checked'),
    helper: typeof recall === 'function' && typeof remember === 'function',
  }));
  ok(got.helper, 'recall and remember exist');
  ok(got.home === 'Asheville', 'an old-format home point still loads');
  ok(got.tab === 'tab-where', 'an old raw tab id still loads');
  ok(got.lp === false, "an old raw '0' still switches the light pollution layer off");
  await ctx.close();
}

// --- an in-page link that points into another panel ---
{
  const page = await open(browser, DESKTOP);
  // the footnote links to the disclaimer, which lives in the spots panel
  await page.click('p.foot a[href="#check-before-you-go"]');
  ok((await visible(page)).join() === 'panel-where', 'a footnote link into the spots panel opens it');
  ok(await page.isVisible('#check-before-you-go'), 'and its target is visible');
  await page.close();
}

// --- phone width: the tab strip is sticky and shows short labels ---
{
  const page = await open(browser, PHONE);
  const strip = await page.evaluate(() => {
    const g = document.querySelector('.guide');
    return { pos: getComputedStyle(g).position, h: g.getBoundingClientRect().height,
             short: getComputedStyle(document.querySelector('.guide .short')).display };
  });
  ok(strip.pos === 'sticky', 'the tab bar is sticky on a phone');
  ok(strip.h < 80, `and is a strip rather than three cards (${Math.round(strip.h)}px)`);
  ok(strip.short === 'block', 'showing the short labels');

  // the real path onto the map: land on the calendar, then tap the map tab, so
  // the map and the canvases are built while the panel is already on screen
  await page.click('#tab-where');
  const built = await page.evaluate(() => {
    const el = document.getElementById('map');
    const c = document.querySelector('#spot-list canvas.skyline');
    return { w: el.clientWidth, h: el.clientHeight,
             cv: c ? c.width === Math.round(c.clientWidth * devicePixelRatio) && c.clientWidth > 0 : null };
  });
  ok(built.w > 200 && built.h > 100, `tapping the map tab builds a sized map (${built.w}x${built.h})`);
  ok(built.cv !== false, 'and skylines painted at the panel width');
  await page.close();
}

// --- how the where tab was left comes back ---
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const a = await ctx.newPage();
  await a.goto(URL_ + '#where');
  await a.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  await a.click('[data-filter="camp"]');
  await a.click('[data-sort="dist"]');
  await a.click('.leaflet-control-layers-base label:has-text("imagery")');
  await a.evaluate(() => spotState.map.setView([35.33, -82.88], 13, { animate: false }));
  // opening a panorama re-renders the list; it must not reframe the map
  await a.click('#spot-list .pano canvas.skyline');
  ok(await a.evaluate(() => spotState.map.getZoom()) === 13, 'opening a panorama leaves the map where it was');
  // the same has to hold for a keyboard toggle: tab to the canvas, press enter
  await a.evaluate(() => spotState.map.setView([35.33, -82.88], 13, { animate: false }));
  await a.focus('#spot-list .pano canvas.skyline');
  await a.keyboard.press('Enter');
  await a.waitForTimeout(800); // flyTo runs 600ms; let it finish either way
  const kb = await a.evaluate(() => ({ zoom: spotState.map.getZoom(), active: spotState.active }));
  ok(kb.zoom === 13, 'a keyboard toggle leaves the map where it was too');
  ok(kb.active === null, 'and does not select the card either');
  await a.close();

  const b = await ctx.newPage();
  await b.goto(URL_ + '#where');
  await b.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const got = await b.evaluate(() => ({
    filter: spotState.filter, sort: spotState.sort,
    pressed: document.querySelector('[data-filter][aria-pressed="true"]').dataset.filter,
    sorted: document.querySelector('[data-sort][aria-pressed="true"]').dataset.sort,
    base: document.querySelector('.leaflet-control-layers-base input:checked').nextElementSibling.textContent.trim(),
    zoom: spotState.map.getZoom(), lat: spotState.map.getCenter().lat,
  }));
  ok(got.filter === 'camp' && got.pressed === 'camp', 'the filter comes back, and its button shows it');
  ok(got.sort === 'dist' && got.sorted === 'dist', 'the sort comes back, and its button shows it');
  ok(got.base === 'imagery', 'the basemap comes back');
  ok(got.zoom === 13 && Math.abs(got.lat - 35.33) < 0.01, `the map view comes back (z${got.zoom}, ${got.lat.toFixed(3)})`);
  const pins = await b.evaluate(() => ({ shown: [...spotState.markers.values()].filter(m => spotState.map.hasLayer(m)).length,
    camps: SPOTS.filter(s => s.kind === 'camp').length }));
  ok(pins.shown === pins.camps, `a restored filter filters the map pins too, not just the cards (${pins.shown} of ${pins.camps})`);

  // values that no longer mean anything fall back rather than being trusted
  await b.evaluate(() => {
    localStorage.setItem('darksky.filter', 'gone');
    localStorage.setItem('darksky.sort', '{"x":1}');
    localStorage.setItem('darksky.basemap', 'mars');
    localStorage.setItem('darksky.mapView', JSON.stringify({ lat: 5, lon: 5, zoom: 99 }));
  });
  await b.close();
  const c = await ctx.newPage();
  await c.goto(URL_ + '#where');
  await c.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const bad = await c.evaluate(() => ({ filter: spotState.filter, sort: spotState.sort,
    base: document.querySelector('.leaflet-control-layers-base input:checked').nextElementSibling.textContent.trim(),
    lat: spotState.map.getCenter().lat, cards: document.querySelectorAll('#spot-list .spot').length }));
  ok(bad.filter === 'all' && bad.sort === 'mins' && bad.base === 'topo', 'garbage under a key loads the default');
  ok(bad.lat > 34 && bad.lat < 37 && bad.cards === 40, 'a map view off the page is ignored, and all 40 cards draw');
  await ctx.close();
}

// --- the selected spot, its open panorama and the scrubber come back ---
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const a = await ctx.newPage();
  await a.goto(URL_ + '#where');
  await a.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const name = await a.$eval('#spot-list .spot:nth-child(2)', el => el.dataset.name);
  await a.click('#spot-list .spot:nth-child(2) .name');
  await a.click('#spot-list .spot:nth-child(2) canvas.skyline');
  const clock = await a.evaluate(() => {
    const s = document.querySelector('#spot-list .pano.open input');
    s.value = String(Math.max(0, Number(s.max) - 3));
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#spot-list .pano.open .pano-time span').textContent;
  });
  await a.close();

  const b = await ctx.newPage();
  await b.goto(URL_ + '#where');
  await b.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const got = await b.evaluate(() => ({
    active: spotState.active, card: document.querySelector('#spot-list .spot.active')?.dataset.name,
    open: document.querySelector('#spot-list .pano.open canvas')?.dataset.pano,
    clock: document.querySelector('#spot-list .pano.open .pano-time span')?.textContent,
  }));
  ok(got.active === name && got.card === name, 'the selected spot comes back selected');
  ok(got.open === name, 'with its panorama open');
  ok(got.clock === clock, `and the scrubber at the same clock time (${got.clock})`);

  ok(await b.evaluate(() => nearestSlice([new Date(2026, 8, 17, 20, 0), new Date(2026, 8, 17, 23, 50), new Date(2026, 8, 18, 0, 10)], '00:05')) === 2,
    'a time after midnight matches the slice after midnight, not the evening one');
  await b.evaluate(() => { localStorage.setItem('darksky.active', 'Nowhere Knob'); localStorage.setItem('darksky.pano', 'Nowhere Knob'); });
  await b.reload();
  await b.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  ok(await b.evaluate(() => spotState.active === null && spotState.pano === null), 'a remembered spot that no longer exists is dropped');
  await ctx.close();
}

// --- the parkway overlooks layer ---
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const a = await ctx.newPage();
  await a.goto(URL_ + '#where');
  await a.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const n = await a.evaluate(() => OVERLOOKS.length);
  ok(n > 50, `the page carries the overlooks (${n})`);
  ok(await a.$$eval('.ovl-pin', e => e.length) === 0, 'the layer is off on a first visit');
  await a.click('.leaflet-control-layers-overlays label:has-text("parkway overlooks")');
  ok(await a.$$eval('.ovl-pin', e => e.length) === n, 'switching it on draws one marker per overlook');
  ok(await a.$$eval('#spot-list .spot', e => e.length) === 40, 'and the 40 cards are still 40');

  // open one from the middle of the list, not an end of it
  const id = await a.evaluate(() => OVERLOOKS[Math.floor(OVERLOOKS.length / 2)].id);
  await a.evaluate(i => OVL_open(i), id);
  await a.waitForSelector('.leaflet-popup .ovl canvas.skyline');
  const pop = await a.evaluate(() => {
    const c = document.querySelector('.leaflet-popup .ovl canvas.skyline');
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // a filled sky-wash background alone (no stars, moon or labels) tops out
    // well under 600 for r+g+b, so counting only genuinely bright pixels
    // tells a real panorama apart from a background a solid fill could also
    // produce; distinct sampled colours is a cheap second signal against a
    // uniform fill specifically. thresholds measured against the flattest and
    // most enclosed overlook in tools/.shots/measure-canvas-signal.mjs.
    let bright = 0;
    const colours = new Set();
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] + px[i + 1] + px[i + 2] > 600) bright++;
      if ((i / 4) % 37 === 0) colours.add(px[i] + ',' + px[i + 1] + ',' + px[i + 2]);
    }
    return { sized: c.width === Math.round(c.clientWidth * devicePixelRatio) && c.clientWidth > 200, bright, colours: colours.size,
             text: document.querySelector('.leaflet-popup .ovl').textContent };
  });
  ok(pop.sized, 'the popup panorama is painted at its real width');
  ok(pop.bright > 1, `and paints real stars, moon or labels, not just a filled background (${pop.bright} bright px)`);
  ok(pop.colours >= 30, `with more than a flat wash of colour (${pop.colours} distinct, sampled)`);
  ok(/\d,?\d{3} ft/.test(pop.text), 'the popup lists the elevation');
  ok(pop.text.includes('modelled from bare earth, not visited; trees and the cut bank are not in it'), 'and says what the model cannot see');
  await a.close();

  const b = await ctx.newPage();
  await b.goto(URL_ + '#where');
  await b.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  ok(await b.$$eval('.ovl-pin', e => e.length) === n, 'the layer comes back on');
  ok(await b.evaluate(i => spotState.active === 'ov:' + i, id), 'and the overlook that was open is still the selected one');
  ok(await b.$('.leaflet-popup .ovl canvas.skyline') !== null, 'with its popup open');
  await ctx.close();
}

// --- the overlook popup fits a phone ---
{
  const ctx = await browser.newContext({ viewport: PHONE });
  await quiet(ctx);
  const page = await ctx.newPage();
  await page.goto(URL_ + '#where');
  await page.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  // the layers control collapses to an icon under 720px and only expands on
  // real hover, which a synthetic click does not reliably trigger; a direct
  // dom click on the checkbox sidesteps that and still fires leaflet's toggle
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('.leaflet-control-layers-overlays label')]
      .find(l => l.textContent.includes('parkway overlooks'));
    label.querySelector('input').click();
  });
  const id = await page.evaluate(() => OVERLOOKS[Math.floor(OVERLOOKS.length / 2)].id);
  await page.evaluate(i => OVL_open(i), id);
  await page.waitForSelector('.leaflet-popup .ovl canvas.skyline');
  await page.waitForTimeout(500); // let leaflet's autopan finish settling
  const fit = await page.evaluate(() => {
    const map = document.getElementById('map').getBoundingClientRect();
    const wrap = document.querySelector('.leaflet-popup').getBoundingClientRect();
    const title = document.querySelector('.leaflet-popup .ovl b').getBoundingClientRect();
    const c = document.querySelector('.leaflet-popup .ovl canvas.skyline');
    const within = (r, box) => r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;
    return { wrapWithin: within(wrap, map), titleWithin: within(title, map),
             sized: c.width === Math.round(c.clientWidth * devicePixelRatio) && c.clientWidth > 0,
             wrap, map };
  });
  ok(fit.wrapWithin, `the popup sits inside the map on a phone (popup ${Math.round(fit.wrap.width)}x${Math.round(fit.wrap.height)}, map ${Math.round(fit.map.width)}x${Math.round(fit.map.height)})`);
  ok(fit.titleWithin, 'and the title is inside the map too, not clipped above it');
  ok(fit.sized, 'and the canvas is still painted at its real width');

  // sitting inside the map's own box is not the same as being paintable: the
  // map's corner controls live in leaflet's control pane, above the popup
  // pane regardless of any z-index on the popup, and can still cover it
  const painted = await page.evaluate(() => {
    const r = document.querySelector('.leaflet-popup .ovl b').getBoundingClientRect();
    const insidePopup = el => !!el && !!el.closest('.leaflet-popup');
    return { left: insidePopup(document.elementFromPoint(r.left + 3, r.top + r.height / 2)),
             right: insidePopup(document.elementFromPoint(r.right - 3, r.top + r.height / 2)) };
  });
  ok(painted.left, 'the left edge of the title paints as itself, not a map control sitting over it');
  ok(painted.right, 'and so does the right edge');

  await page.evaluate(() => spotState.map.closePopup());
  await page.waitForTimeout(100);
  const back = await page.evaluate(() => ({
    narrow: document.getElementById('map').classList.contains('ovl-popup-narrow'),
    zoomVisible: getComputedStyle(document.querySelector('.leaflet-control-zoom')).visibility !== 'hidden',
  }));
  ok(!back.narrow && back.zoomVisible, 'and the zoom control is back once the popup closes');
  await ctx.close();
}

if (SHOTS) {
  for (const [name, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    for (const tab of ['when', 'tonight', 'where']) {
      const page = await open(browser, viewport, '#' + tab);
      await page.waitForTimeout(1200); // let the forecast placeholders and canvases settle
      await page.screenshot({ path: join(SHOT_DIR, `${name}-${tab}.png`), fullPage: true });
      await page.close();
    }
  }
  console.log(`\nshots in ${SHOT_DIR}`);
}

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
