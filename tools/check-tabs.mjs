// checks the tab panels: one open at a time, the hash still selects one,
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
// a path argument checks some other copy of the page (a staged blob, say)
// rather than the working tree's index.html
const FILE = process.argv.slice(2).find(a => !a.startsWith('--')) || 'index.html';
const URL_ = pathToFileURL(join(ROOT, FILE)).href;
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = join(ROOT, 'tools', '.shots');
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const N_PANELS = 4;

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
  await page.waitForFunction(n => document.querySelectorAll('[role="tabpanel"]').length === n, N_PANELS);
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

  for (const [tab, panel] of [['tab-where', 'panel-where'], ['tab-sky', 'panel-sky'], ['tab-notes', 'panel-notes'], ['tab-when', 'panel-when']]) {
    await page.click(`#${tab}`);
    ok((await visible(page)).join() === panel, `${tab} shows only ${panel}`);
    ok((await selected(page)).join() === tab, `${tab} is marked selected`);
    ok(await page.evaluate(() => location.hash) !== '', `${tab} writes a hash`);
  }

  // arrow keys, since the tab bar is the page's only navigation on a phone
  await page.focus('#tab-when');
  await page.keyboard.press('ArrowLeft');
  ok((await selected(page)).join() === 'tab-notes', 'arrow-left from the first tab wraps to the last');

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

  // reading the mountains, the footnote and the credits are the field notes
  // tab: reference reading, shown when asked for and under nothing else
  await page.click('#tab-when');
  ok(!(await page.isVisible('#notes')) && !(await page.isVisible('#credits')), 'notes and credits are not under the calendar');
  await page.click('#tab-notes');
  ok(await page.isVisible('#notes') && await page.isVisible('p.foot') && await page.isVisible('#credits'), 'the field notes tab holds notes, footnote and credits');
  // there is no tonight tab: the hour-by-hour row lives in the home strip
  ok(await page.$('#tab-tonight') === null, 'there is no "will it be clear" tab');
  ok(await page.$('.home-strip details #tonight') !== null, 'the hourly forecast is a fold in the home strip');
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

  // the notes are for somebody planning a night, not for whoever keeps the
  // page: nothing about what an entry used to say or how it was measured
  const inside = await page.$$eval('#spot-list .note', els => els.map(e => e.textContent)
    .filter(t => /this page used to|used to say|the model|the listed|this entry|\u2014/.test(t)).map(t => t.slice(0, 40)));
  ok(inside.length === 0, `no card note is written to the maintainer (${inside.join(' | ') || 'none'})`);

  // this panel is drawn twice: once by renderSpotList at load, once when the
  // tab first opens. a listener bound per draw would fire twice on one click;
  // bindSkylineToggle only binds once. a click takes the reader to the sky
  // tab with that spot loaded, and the map tab is one tap back.
  if (cv !== null) {
    const name = await page.$eval('#spot-list .pano canvas.skyline', c => c.dataset.pano);
    await page.click('#spot-list .pano canvas.skyline');
    ok((await visible(page)).join() === 'panel-sky', 'one click on a thumbnail opens the sky tab');
    ok(await page.evaluate(() => viewerState.key) === name, 'with that spot loaded in the viewer');
    ok(await page.$eval('#sky-place', s => s.value) === name, 'and the place chooser showing it');
    await page.click('#tab-where');
    ok((await visible(page)).join() === 'panel-where' && await page.evaluate(() => viewerState.key) === name,
      'the map tab is one tap back, and the viewer keeps its place');
  }
  await page.close();
}

// --- the sky viewer tab: opens from a card, turns, remembers where ---
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const pixHash = (page, selector) => page.$eval(selector, c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
    return h;
  });
  const thumb = '#spot-list .pano canvas.skyline';

  const a = await ctx.newPage();
  await a.goto(URL_ + '#where');
  await a.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const opener = await a.$eval(thumb, c => c.dataset.pano);
  await a.click(thumb);
  await a.waitForSelector('#sky-viewer[data-place]');

  // default heading is south, 25 degrees up, 100 degree field, the same
  // default openSkyViewer falls back to with nothing remembered yet
  const centred = await a.evaluate(() => ({ az: skyView.az, alt: skyView.alt, fov: skyView.fov }));
  ok(centred.az === 180 && centred.alt === 25 && centred.fov === 100,
    `the viewer opens facing south, 25 degrees up, 100 degree field (${JSON.stringify(centred)})`);
  ok(await a.$eval('#sky-viewer-title', e => e.textContent) === opener, 'and its title is the spot that opened it');

  const before = await pixHash(a, '.sky-viewer-canvas');
  const cvBox = await a.$eval('.sky-viewer-canvas', c => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // drag most of the way across the canvas: mouse down, move, up. the
  // synthetic pointer events chromium fires alongside these are what the
  // viewer's own drag handler listens for, the same path a touch drag would
  // take.
  await a.mouse.move(cvBox.x + cvBox.w * 0.85, cvBox.y + cvBox.h / 2);
  await a.mouse.down();
  await a.mouse.move(cvBox.x + cvBox.w * 0.15, cvBox.y + cvBox.h / 2, { steps: 8 });
  await a.mouse.up();

  const az = await a.evaluate(() => skyView.az);
  ok(az !== 180, `dragging left turned the heading off the default (now ${az.toFixed(1)})`);
  ok(await pixHash(a, '.sky-viewer-canvas') !== before, 'and redrew the canvas');
  ok(await a.evaluate(() => JSON.parse(localStorage.getItem('darksky.skyView')).az) === az, 'and stored the new heading');
  ok(await a.evaluate(() => spotState.active) === null, 'the drag did not select the card');

  // the chooser switches place without leaving the tab
  await a.selectOption('#sky-place', 'Cove Field Ridge Overlook');
  ok(await a.evaluate(() => viewerState.key) === 'Cove Field Ridge Overlook' && await a.$eval('#sky-viewer-title', e => e.textContent) === 'Cove Field Ridge Overlook',
    'the place chooser loads another spot');
  await a.close();

  // a reload brings the heading back; the key is shared, not per spot
  const b = await ctx.newPage();
  await b.goto(URL_ + '#where');
  await b.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  ok(await b.evaluate(() => skyView.az) === az, `a reload restores the shared heading (${az.toFixed(1)})`);

  // garbage under the key falls back to the same default the page opens on
  await b.evaluate(() => localStorage.setItem('darksky.skyView', 'not a view'));
  await b.close();
  const c = await ctx.newPage();
  await c.goto(URL_ + '#where');
  await c.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  ok(await c.evaluate(() => skyView.az === 180 && skyView.alt === 25 && skyView.fov === 100),
    'garbage under the heading key falls back to the default view');

  // arrow keys turn the view when the canvas has focus. darksky.pano has the
  // earlier visit's place loaded already, so the tab is all that is needed
  ok(await c.evaluate(() => viewerState.key === 'Cove Field Ridge Overlook'), 'the place last viewed is loaded again on return');
  await c.click('#tab-sky');
  await c.waitForSelector('#sky-viewer[data-place]');
  await c.focus('.sky-viewer-canvas');
  const rightBefore = await c.evaluate(() => skyView.az);
  await c.keyboard.press('ArrowRight');
  const afterRight = await c.evaluate(() => skyView.az);
  ok(afterRight !== rightBefore, `the right arrow key turns the view (${rightBefore} to ${afterRight})`);
  await c.keyboard.press('ArrowLeft');
  await c.keyboard.press('ArrowLeft');
  const afterLeft = await c.evaluate(() => skyView.az);
  ok(afterLeft !== afterRight, 'and the left arrow key turns it back the other way');

  // Home resets the view, whatever it has been dragged or turned to
  await c.keyboard.press('Home');
  ok(await c.evaluate(() => skyView.az === 180 && skyView.alt === 25 && skyView.fov === 100),
    'Home resets to the default view');

  // looking down has a floor: the bottom edge of the canvas never sits more
  // than about ten degrees under level, since a wide canvas otherwise fills
  // its lower half with ground. the floor follows the canvas shape and zoom.
  for (let i = 0; i < 20; i++) await c.keyboard.press('ArrowDown');
  const low = await c.evaluate(() => {
    const cv = document.querySelector('.sky-viewer-canvas');
    const view = { az0: skyView.az, alt0: skyView.alt, fov: skyView.fov, w: cv.clientWidth, h: cv.clientHeight };
    // the altitude at the bottom centre, found by walking down from level
    let bottom = 0;
    for (let a = 0; a >= -60; a -= 0.5) { const p = panProject(a, skyView.az, view); if (!p || p.y > cv.clientHeight) break; bottom = a; }
    return { alt: skyView.alt, floor: skyAltFloor(), bottom };
  });
  ok(low.alt === low.floor && low.floor > 12, `arrow-down stops at the floor (${low.floor.toFixed(1)} degrees up on this canvas)`);
  ok(low.bottom >= -11, `where the canvas bottom is about ten degrees under level (${low.bottom})`);
  await ctx.close();
}

// --- a cold visit to the sky tab has a place loaded already ---
{
  const page = await open(browser, DESKTOP, '#sky');
  const got = await page.evaluate(() => ({
    key: viewerState.key, first: visibleSpots().find(s => HORIZONS[s.name]).name,
    shown: getComputedStyle(document.getElementById('sky-viewer')).display !== 'none',
    options: document.querySelectorAll('#sky-place option').length,
    drawn: (() => { const c = document.querySelector('.sky-viewer-canvas'); return c.width > 300 && c.height > 300; })(),
  }));
  ok(got.key === got.first && got.shown, `#sky on a first visit shows the nearest spot (${got.key})`);
  ok(got.options > 60, `and the chooser lists the spots and the overlooks (${got.options})`);
  ok(got.drawn, 'with the canvas painted at a real size');
  await page.close();
}

// --- the sky from a point picked on the map ---
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const a = await ctx.newPage();
  await a.goto(URL_ + '#sky');
  await a.waitForSelector('#sky-viewer[data-place]');
  // picking needs a click on the map, so the button goes to the map tab armed
  await a.click('#sky-pick');
  ok((await selected(a)).join() === 'tab-where', 'pick a point opens the map tab');
  ok(await a.evaluate(() => spotState.picking) === 'sky', 'armed for the sky, not for home');
  ok(/sky/.test(await a.$eval('#spot-msg', e => e.textContent)), 'and says so in words');
  await a.waitForFunction(() => spotState.map);
  await a.evaluate(() => spotState.map.fire('click', { latlng: L.latLng(35.5, -82.9) }));
  await a.waitForSelector('#sky-viewer[data-place]');
  const got = await a.evaluate(() => ({
    tab: document.querySelector('[role="tab"][aria-selected="true"]').id, key: viewerState.key,
    home: spotState.home.lat, picking: spotState.picking,
    flat: viewerState.horizon && [...viewerState.horizon].every(v => v === 0),
    title: document.getElementById('sky-viewer-title').textContent,
    caveat: document.querySelector('.sky-viewer-caveat').textContent,
    sub: document.querySelector('.sky-viewer-elev').textContent,
    place: document.getElementById('sky-place').value,
    marker: !!spotState.skyMarker && spotState.map.hasLayer(spotState.skyMarker),
    pressed: document.getElementById('sky-pick').getAttribute('aria-pressed'),
  }));
  ok(got.tab === 'tab-sky' && got.key === 'pt:35.5000,-82.9000', `the click loads that point into the sky tab (${got.key})`);
  ok(got.home !== 35.5, 'and did not move home');
  ok(got.picking === false && got.pressed === 'false', 'and disarms the pick');
  ok(got.flat, 'the horizon is flat, since no terrain is modelled for a point yet');
  ok(/flat/.test(got.caveat), `and the caveat says so (${got.caveat})`);
  ok(got.sub === '35.5000, -82.9000', `the subtitle is the coordinates (${got.sub})`);
  ok(got.place === '__point', 'the chooser shows a picked point');
  ok(got.marker, 'and the map carries a marker for it');
  await a.close();

  // the point comes back on the next visit, marker and all
  const b = await ctx.newPage();
  await b.goto(URL_ + '#where');
  await b.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const back = await b.evaluate(() => ({ key: viewerState.key, marker: !!spotState.skyMarker && spotState.map.hasLayer(spotState.skyMarker) }));
  ok(back.key === 'pt:35.5000,-82.9000' && back.marker, 'a picked point is loaded again on return, with its marker');
  // and the home pick still sets home, not the sky
  await b.click('#home-pick');
  await b.evaluate(() => spotState.map.fire('click', { latlng: L.latLng(35.6, -83.0) }));
  ok(await b.evaluate(() => spotState.home.lat === 35.6 && viewerState.key === 'pt:35.5000,-82.9000'), 'pick on map for home still sets home and leaves the sky alone');
  await ctx.close();
}

// --- the sky viewer's date picker ---
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const page = await ctx.newPage();
  await page.goto(URL_ + '#where');
  await page.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  await page.click('#spot-list .pano canvas.skyline');
  await page.waitForSelector('#sky-viewer[data-place]');

  const setDate = v => page.evaluate(val => {
    const el = document.querySelector('.sky-viewer-date');
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
  const read = () => page.evaluate(() => ({
    title: document.getElementById('sky-viewer-title').textContent,
    sum: document.querySelector('.sky-viewer-sum').textContent,
  }));

  const before = await read();
  // six months out: far enough that the moon and the galactic core sentence
  // are not tonight's, whatever tonight happens to be
  const picked = await page.evaluate(() => {
    const p = easternParts(new Date(Date.now() + 183 * 86400000));
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  });
  await setDate(picked);
  const after = await read();
  ok(after.title !== before.title && after.title.includes(','), `picking a date names it in the title (${after.title})`);
  ok(after.sum !== before.sum, 'and changes the moon and core sentence');

  // picking tonight's own eastern date back is picking "tonight" again
  const today = await page.evaluate(() => easternTodayISO());
  await setDate(today);
  ok((await read()).title === before.title, 'and picking tonight again drops the date from the title');
  await ctx.close();
}

// --- the summary sentence and the scrubber are always Carolina time ---
{
  // a viewer's own device clock is the wrong clock for a page about North
  // Carolina skies. a context whose timezone is nowhere near Eastern is the
  // proof: if fmtClock or panTime ever went back to reading getHours()
  // straight off the Date, this would show Tokyo's wall clock instead.
  const ctx = await browser.newContext({ viewport: DESKTOP, timezoneId: 'Asia/Tokyo' });
  await quiet(ctx);
  const page = await ctx.newPage();
  await page.goto(URL_ + '#where');
  await page.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);

  const fixed = Date.UTC(2026, 11, 25, 3, 17);   // an arbitrary real instant
  const got = await page.evaluate(t => ({ clock: fmtClock(new Date(t)), sentence: panTime(new Date(t)) }), fixed);

  // computed independently, in this node process, unaffected by the page's
  // simulated timezone -- the same algorithm fmtClock uses, written again
  // rather than shared, so a shared bug cannot pass both
  const parts = new Intl.DateTimeFormat('en-US',
    { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(fixed));
  let h = Number(parts.find(p => p.type === 'hour').value);
  const m = parts.find(p => p.type === 'minute').value;
  const eastern = (h % 12 || 12) + ':' + m + (h < 12 ? 'am' : 'pm');

  ok(got.clock === eastern, `the scrubber label is Eastern time from a Tokyo browser (got ${got.clock}, want ${eastern})`);
  ok(got.sentence === eastern, `and so is the summary sentence's time (got ${got.sentence})`);

  // Tokyo is 13 or 14 hours ahead of Eastern, so its own wall clock for the
  // same instant never lands on the same hour; if this ever matched, the
  // check above would have been unable to tell "correct" from "coincidence"
  const tokyoLocalHour = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(fixed));
  ok(Number(tokyoLocalHour) !== h, `Tokyo's own hour differs from Eastern's for this instant (${tokyoLocalHour} vs ${h}), so the match above is not a coincidence`);

  // "tonight" in the sky viewer has to be the eastern evening too, not the
  // Tokyo calendar date it may already have turned over to
  const eToday = await page.evaluate(() => easternTodayISO());
  const nowParts = new Intl.DateTimeFormat('en-US',
    { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const val = t => nowParts.find(p => p.type === t).value;
  const wantToday = `${val('year')}-${val('month')}-${val('day')}`;
  ok(eToday === wantToday, `the sky viewer's "tonight" is the eastern evening (got ${eToday}, want ${wantToday}) even from a Tokyo browser`);
  await ctx.close();
}

// --- the remembered tab, and the hash outranking it ---
{
  // one context, so the two loads share a localStorage the way two visits do
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const first = await ctx.newPage();
  await first.goto(URL_);
  await first.click('#tab-notes');
  await first.close();

  const back = await ctx.newPage();
  await back.goto(URL_);
  await back.waitForFunction(n => document.querySelectorAll('[role="tabpanel"]').length === n, N_PANELS);
  ok((await visible(back)).join() === 'panel-notes', 'a return visit opens the tab you left on');
  ok(await back.evaluate(() => location.hash) === '#notes', 'and puts that tab in the URL');

  const linked = await ctx.newPage();
  await linked.goto(URL_ + '#where');
  await linked.waitForFunction(n => document.querySelectorAll('[role="tabpanel"]').length === n, N_PANELS);
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
  const page = await open(browser, DESKTOP, '#notes');
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

// --- the sky viewer on a tall phone canvas ---
{
  // the field of view is set across the width, so a portrait canvas sees far
  // below the horizon. whatever is down there has to be ground, never more sky
  const ctx = await browser.newContext({ viewport: PHONE });
  await quiet(ctx);
  const page = await ctx.newPage();
  await page.goto(URL_ + '#where');
  await page.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  await page.evaluate(() => openSkyViewerForSpot('Waterrock Knob'));
  await page.waitForSelector('#sky-viewer[data-place]');
  ok((await visible(page)).join() === 'panel-sky', 'opening a spot in the viewer shows the sky tab');
  await page.waitForTimeout(200);
  const low = await page.$eval('.sky-viewer-canvas', cv => {
    const g = cv.getContext('2d');
    const d = g.getImageData(0, Math.floor(cv.height * 0.9), cv.width, Math.floor(cv.height * 0.08)).data;
    let bright = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 110) bright++;
    return { bright, tall: cv.height > cv.width };
  });
  ok(low.tall, 'the phone viewer canvas is taller than it is wide');
  ok(await page.evaluate(() => skyView.alt >= 30 && skyAltFloor() <= 35), `and the default view opens higher there, at the capped floor (${await page.evaluate(() => skyView.alt)})`);
  ok(low.bright === 0, `and the bottom of it is ground, with no sky under the ridge (${low.bright} bright pixels)`);
  const sub = await page.$eval('.sky-viewer-elev', e => e.textContent);
  ok(!sub.includes('&') && sub.includes('ft'), `the elevation line is text, not markup (${sub})`);
  // the level line: where flat would be, drawn over the ground, so the gap up
  // to the crest reads as degrees of sky the terrain takes. on the most
  // enclosed overlook the ridge used to bury everything at 0 degrees
  await page.evaluate(() => openSkyViewerForOverlook(OVERLOOKS.find(o => /Ballhoot/.test(o.name)).id));
  await page.waitForTimeout(200);
  const level = await page.$eval('.sky-viewer-canvas', cv => {
    const g = cv.getContext('2d');
    const k = cv.width / cv.clientWidth;
    const view = { az0: skyView.az, alt0: skyView.alt, fov: skyView.fov, w: cv.clientWidth, h: cv.clientHeight };
    let warm = 0, tried = 0;
    for (let az = skyView.az - 25; az <= skyView.az + 25; az += 0.5) {
      const p = panProject(0, az, view);
      if (!p) continue;
      tried++;
      // a one pixel anti-aliased line rarely lands on a whole pixel: take the column
      const d = g.getImageData(Math.round(p.x * k), Math.round(p.y * k) - 1, 1, 3).data;
      if ([0, 4, 8].some(i => d[i] > d[i + 2] + 30)) warm++;
    }
    return { warm, tried, ridge: horizonAt(viewerState.horizon, skyView.az) };
  });
  const fit = await page.$eval('.sky-viewer-canvas', cv => Math.abs(cv.height - cv.clientHeight * devicePixelRatio));
  ok(fit <= 1, `the canvas is drawn at the size it is shown at (${fit}px off)`);
  ok(level.ridge > 5, `ballhoot scar is enclosed to the south (${level.ridge.toFixed(1)} degrees)`);
  ok(level.warm >= 15, `and a level line at 0 degrees shows over its ground (${level.warm} of ${level.tried} samples)`);
  await ctx.close();
}

// --- the home strip above the tabs ---
{
  // a made-up forecast, flat on purpose: 10 per cent cloud and 50 degrees every
  // hour, so the headline has one right answer whatever time this runs
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const time = Array.from({ length: 8 * 24 }, (_, i) => iso(new Date(day0.getTime() + i * 3600000)));
  const flat = v => time.map(() => v);
  const at = (k, hr) => iso(new Date(day0.getTime() + (k * 24 + hr) * 3600000));
  const fake = {
    hourly: { time, cloud_cover: flat(10), cloud_cover_low: flat(10), cloud_cover_mid: flat(0), cloud_cover_high: flat(0),
      temperature_2m: flat(50), wind_speed_10m: flat(5), dew_point_2m: flat(40), precipitation_probability: flat(0) },
    daily: { sunrise: [0, 1, 2, 3, 4, 5, 6, 7].map(k => at(k, 7)), sunset: [0, 1, 2, 3, 4, 5, 6, 7].map(k => at(k, 19)) },
  };
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  await ctx.route('**://api.open-meteo.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => /cloud/.test(document.getElementById('home-sky')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const line = await page.$eval('#home-sky', e => e.textContent);
  ok(/at home: clear, 10% cloud, low 50/.test(line), `the home strip reads the forecast in the calendar's own words (${line})`);
  const above = await page.evaluate(() => document.querySelector('.home-strip').getBoundingClientRect().bottom
    <= document.querySelector('[role="tablist"]').getBoundingClientRect().top);
  ok(above, 'and it sits above the tabs');
  // the hour-by-hour row is a fold under the headline, closed until asked for,
  // and drawn from the same forecast whichever tab is open
  const fold = await page.evaluate(() => {
    const d = document.querySelector('.home-strip details.home-hours');
    return { open: d.open, hours: d.querySelectorAll('#tonight .hr').length, label: d.querySelector('summary').textContent.trim() };
  });
  ok(!fold.open, 'the hourly fold starts closed');
  ok(fold.hours > 0, `and already holds the hourly row (${fold.hours} hours)`);
  ok(fold.label === 'hour by hour', `under the label "hour by hour" (${fold.label})`);
  // picking needs the map, and the map has no size inside a hidden panel
  await page.click('#home-pick');
  ok((await selected(page)).join() === 'tab-where', 'pick on map opens the where tab first');
  ok(await page.$eval('#home-pick', b => b.getAttribute('aria-pressed')) === 'true', 'and arms the pick');
  ok(errors.length === 0, `nothing threw while the page loaded (${errors.join(' | ') || 'none'})`);
  await ctx.close();
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
  // opening the sky viewer re-renders the list; it must not reframe the map
  await a.click('#spot-list .pano canvas.skyline');
  await a.waitForSelector('#sky-viewer[data-place]');
  ok(await a.evaluate(() => spotState.map.getZoom()) === 13, 'opening the sky viewer leaves the map where it was');
  ok(await a.evaluate(() => spotState.active) === null, 'and does not select the card either');
  await a.click('#tab-where');

  // the same has to hold for a keyboard toggle: tab to the canvas, press enter
  await a.evaluate(() => spotState.map.setView([35.33, -82.88], 13, { animate: false }));
  await a.focus('#spot-list .pano canvas.skyline');
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => document.getElementById('panel-sky').offsetParent !== null);
  const kb = await a.evaluate(() => ({ zoom: spotState.map.getZoom(), active: spotState.active }));
  ok(kb.zoom === 13, 'a keyboard toggle leaves the map where it was too');
  ok(kb.active === null, 'and does not select the card either');
  await a.click('#tab-where');
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

  // the same for the three keys the earlier block does not cover, since a
  // throw on the way up blanks the page rather than degrading it
  await c.evaluate(() => {
    localStorage.setItem('darksky.overlooks', 'yes please');
    localStorage.setItem('darksky.showAll', '{oops');
    localStorage.setItem('darksky.panoWhen', '[1,2,3]');
  });
  await c.close();
  const d = await ctx.newPage();
  await d.goto(URL_ + '#where');
  await d.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const junk = await d.evaluate(() => ({ cards: document.querySelectorAll('#spot-list .spot').length,
    pins: document.querySelectorAll('.ovl-pin').length }));
  ok(junk.cards === 40 && junk.pins === 0,
    `junk under the overlook keys still loads 40 cards with the layer off (${junk.cards} cards, ${junk.pins} pins)`);
  await ctx.close();
}

// --- the selected spot, its open sky viewer and the scrubber come back ---
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const a = await ctx.newPage();
  await a.goto(URL_ + '#where');
  await a.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  const name = await a.$eval('#spot-list .spot:nth-child(2)', el => el.dataset.name);
  await a.click('#spot-list .spot:nth-child(2) .name');
  await a.click('#spot-list .spot:nth-child(2) canvas.skyline');
  await a.waitForSelector('#sky-viewer[data-place]');
  const clock = await a.evaluate(() => {
    const s = document.querySelector('.sky-viewer-time input');
    s.value = String(Math.max(0, Number(s.max) - 3));
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('.sky-viewer-time span').textContent;
  });
  await a.close();

  const b = await ctx.newPage();
  await b.goto(URL_ + '#where');
  await b.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  // the link said #where, so the map tab shows; the viewer still has its
  // place loaded for when the sky tab is opened
  const got = await b.evaluate(() => ({
    active: spotState.active, card: document.querySelector('#spot-list .spot.active')?.dataset.name,
    key: viewerState.key, title: document.getElementById('sky-viewer-title')?.textContent,
    clock: document.querySelector('.sky-viewer-time span')?.textContent,
  }));
  ok(got.active === name && got.card === name, 'the selected spot comes back selected');
  ok((await visible(b)).join() === 'panel-where', 'a #where link still opens the map tab');
  ok(got.key === name && got.title === name, 'with the viewer holding its place for the sky tab');
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

  // six generated blocks written by three different tools, and the one thing
  // no single tool can check is whether they still agree with each other.
  // regenerating one and forgetting the rest shows up here and nowhere else.
  const gaps = await a.evaluate(() => {
    const ids = new Set(OVERLOOKS.map(o => o.id));
    const names = new Set(SPOTS.map(s => s.name));
    const label = new Map(OVERLOOKS.map(o => [o.id, `${o.name} (${o.id})`]));
    const missing = (want, have, say = k => k) => [...want].filter(k => !(k in have)).map(say);
    const stray = (have, want, say = k => k) => Object.keys(have).filter(k => !want.has(k)).map(say);
    const ov = k => label.get(k) || k;
    return {
      'every overlook has a horizon': missing(ids, OVERLOOK_HORIZONS, ov),
      'no horizon is left over from a dropped overlook': stray(OVERLOOK_HORIZONS, ids),
      'every overlook has a sky line': missing(ids, OVERLOOK_SKY, ov),
      'no sky line is left over from a dropped overlook': stray(OVERLOOK_SKY, ids),
      'every spot has a sky line': missing(names, SKY),
      'no sky line is left over from a dropped spot': stray(SKY, names),
      'every spot has a horizon': missing(names, HORIZONS),
    };
  });
  for (const [what, list] of Object.entries(gaps))
    ok(list.length === 0, list.length ? `${what} -- ${list.length} without one: ${list.join('; ')}` : what);
  ok(await a.$$eval('.ovl-pin', e => e.length) === 0, 'the layer is off on a first visit');
  await a.click('.leaflet-control-layers-overlays label:has-text("parkway overlooks")');
  ok(await a.$$eval('.ovl-pin', e => e.length) === n, 'switching it on draws one marker per overlook');
  ok(await a.$$eval('#spot-list .spot', e => e.length) === 40, 'and the 40 cards are still 40');

  // open one from the middle of the list, not an end of it
  const id = await a.evaluate(() => OVERLOOKS[Math.floor(OVERLOOKS.length / 2)].id);
  await a.evaluate(i => OVL_open(i), id);
  await a.waitForSelector('.leaflet-popup .ovl canvas.skyline');
  // the caveat the page itself computes for this overlook -- whichever text
  // that is, empty CANOPY or filled, the popup and the viewer must agree on it
  const wantCaveat = await a.evaluate(i => canopyCaveat(CANOPY[i]), id);
  const pop = await a.evaluate(() => {
    const c = document.querySelector('.leaflet-popup .ovl canvas.skyline');
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // the popup's own canvas is the closed thumbnail strip now -- no stars,
    // no moon, the sky viewer draws those -- so what tells a real ridge
    // apart from a flat fill is variety of colour across the crest's
    // gradient, not brightness.
    const colours = new Set();
    for (let i = 0; i < px.length; i += 4) {
      if ((i / 4) % 37 === 0) colours.add(px[i] + ',' + px[i + 1] + ',' + px[i + 2]);
    }
    return { sized: c.width === Math.round(c.clientWidth * devicePixelRatio) && c.clientWidth > 200, colours: colours.size,
             text: document.querySelector('.leaflet-popup .ovl').textContent,
             hasOpenBtn: !!document.querySelector('.leaflet-popup .ovl-open'),
             hasScrubber: !!document.querySelector('.leaflet-popup .pano-time'),
             hasSky: !!document.querySelector('.leaflet-popup .ovl > .sky') };
  });
  ok(pop.sized, 'the popup panorama is painted at its real width');
  ok(pop.colours >= 5, `and paints a real ridge, not a flat fill (${pop.colours} distinct colours, sampled)`);
  ok(/\d,?\d{3} ft/.test(pop.text), 'the popup lists the elevation');
  ok(pop.text.includes(wantCaveat), 'and says what the model computes for this overlook');
  ok(pop.hasOpenBtn, 'the popup has its own "open sky view" button');
  ok(!pop.hasScrubber, 'and no scrubber of its own');
  ok(!pop.hasSky, 'and no sky sentence of its own -- that moved into the viewer');

  // the button opens the sky tab with this overlook's own name and caveat
  await a.click('.leaflet-popup .ovl-open');
  await a.waitForSelector('#sky-viewer[data-place]');
  const viewer = await a.evaluate(() => ({
    title: document.getElementById('sky-viewer-title').textContent,
    caveat: document.querySelector('.sky-viewer-caveat').textContent,
    place: document.getElementById('sky-place').value,
  }));
  ok((await visible(a)).join() === 'panel-sky' && viewer.title.length > 0, `"open sky view" opens the sky tab, titled ${JSON.stringify(viewer.title)}`);
  ok(viewer.caveat.includes(wantCaveat), 'with the same caveat the popup shows');
  ok(viewer.place === 'ov:' + id, 'and the chooser lists the overlook');
  await a.close();

  const b = await ctx.newPage();
  await b.goto(URL_ + '#where');
  await b.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  ok(await b.$$eval('.ovl-pin', e => e.length) === n, 'the layer comes back on');
  ok(await b.evaluate(i => spotState.active === 'ov:' + i, id), 'and the overlook that was open is still the selected one');
  ok(await b.$('.leaflet-popup .ovl canvas.skyline') !== null, 'with its popup open');
  await ctx.close();
}

// --- one selection at a time, and a closed overlook stays closed ---
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  await quiet(ctx);
  const a = await ctx.newPage();
  await a.goto(URL_ + '#where');
  await a.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  await a.evaluate(() => {
    [...document.querySelectorAll('.leaflet-control-layers-overlays label')]
      .find(l => l.textContent.includes('parkway overlooks')).querySelector('input').click();
  });
  const id = await a.evaluate(() => OVERLOOKS[Math.floor(OVERLOOKS.length / 2)].id);

  // selecting a card and then an overlook must not leave two things selected
  await a.click('#spot-list .spot:nth-child(2) .name');
  ok(await a.$$eval('#spot-list .spot.active', e => e.length) === 1, 'a card click selects that card');
  await a.evaluate(i => OVL_open(i), id);
  await a.waitForSelector('.leaflet-popup .ovl');
  ok(await a.$$eval('#spot-list .spot.active', e => e.length) === 0, 'opening an overlook drops the card highlight');

  // the reader closing the popup is the reader deselecting it. a direct dom
  // click, because leaflet is still autopanning the popup and a real mouse
  // click keeps missing a target that is moving under it
  await a.waitForTimeout(600);
  await a.evaluate(() => document.querySelector('.leaflet-popup-close-button').click());
  await a.waitForTimeout(100);
  ok(await a.evaluate(() => spotState.active) === null, 'closing the popup clears the selection');
  await a.close();

  const b = await ctx.newPage();
  await b.goto(URL_ + '#where');
  await b.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  await b.waitForTimeout(300);
  ok(await b.$('.leaflet-popup') === null, 'and a popup closed last visit does not come back');
  ok(await b.evaluate(() => spotState.active) === null, 'with nothing selected either');
  await ctx.close();
}

// --- a restored popup panning itself into view is not the reader's map view ---
{
  const ctx = await browser.newContext({ viewport: PHONE });
  await quiet(ctx);
  const a = await ctx.newPage();
  await a.goto(URL_ + '#where');
  await a.waitForFunction(() => typeof spotState !== 'undefined' && spotState.map);
  // an overlook a little north of centre: its popup opens off the top of a
  // phone-sized map, so leaflet autopans to bring it in
  const seeded = await a.evaluate(() => {
    const o = OVERLOOKS[Math.floor(OVERLOOKS.length / 2)];
    const view = { lat: +(o.lat - 0.002).toFixed(5), lon: +o.lon.toFixed(5), zoom: 13 };
    localStorage.setItem('darksky.overlooks', '1');
    localStorage.setItem('darksky.active', 'ov:' + o.id);
    localStorage.setItem('darksky.mapView', JSON.stringify(view));
    return JSON.stringify(view);
  });
  await a.close();
  const b = await ctx.newPage();
  await b.goto(URL_ + '#where');
  await b.waitForSelector('.leaflet-popup .ovl');
  await b.waitForTimeout(800); // leaflet's autopan is animated; let it land
  ok(await b.evaluate(() => localStorage.getItem('darksky.mapView')) === seeded,
    'the remembered map view survives a restored popup autopanning');
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
    for (const tab of ['when', 'where', 'sky', 'notes']) {
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
