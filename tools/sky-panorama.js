/* sky-panorama.js -- the horizon panorama and the one line of prose under it.

   plain script, no module syntax: this file gets pasted into index.html
   between the panorama markers, so every name here has to be safe at the top
   level of that file (index.html already owns `rad`, so nothing here is
   called that).

   assumes, already in scope:
     Sky.*              from the astro block (tools/sky-astro.js)
     STARS              from the star block (tools/stars.js)
     HORIZON_ALT_MIN, HORIZON_ALT_RANGE, HORIZONS   from the generated
                        horizons block, which is why they are not declared here
     HORIZON_LAYERS     from the generated horizons block: the near, middle
                        and far bare-earth ridge bands, when available
     CANOPY             from the generated canopy block: decoded here and
                        painted in front of every terrain band

   public: decodeHorizon(s), decodeCanopy(e), drawPanorama(canvas, opts),
            horizonSummary(opts), panBlocking(horizon, canopy),
            panProject(alt, az, view), panDir16(az),
            easternParts(instant), easternInstant(y, mo, d, hour, minute)
*/

const PAN_D2R = Math.PI / 180;
const J2000 = 2451545.0;
const PAN_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// 360 samples, two base64 chars each, 12 bits per sample. index i is azimuth
// i degrees true from north, increasing clockwise.
function decodeHorizon(s) {
  const alt = new Float64Array(360);
  for (let i = 0; i < 360; i++) {
    const v = PAN_B64.indexOf(s.charAt(2 * i)) * 64 + PAN_B64.indexOf(s.charAt(2 * i + 1));
    alt[i] = HORIZON_ALT_MIN + v * HORIZON_ALT_RANGE / 4095;
  }
  return alt;
}

// Three distance-separated bare-earth profiles, nearest first. Old cached
// pages do not have them, so a missing or malformed entry simply leaves the
// established single skyline in place.
function decodeRidgeLayers(entry) {
  if (!Array.isArray(entry)) return null;
  try {
    const out = entry.map(decodeHorizon);
    return out.length ? out : null;
  } catch (e) { return null; }
}

// Ridge-band distances use the same 12-bit two-character packing as altitude,
// but at 25 m per step. Zero is an empty shell at that bearing.
const PAN_RANGE_UNIT_M = 25;
function decodeRidgeRanges(entry) {
  if (!Array.isArray(entry)) return null;
  try {
    return entry.map(s => {
      const out = new Float64Array(360);
      for (let i = 0; i < 360; i++) out[i] = (PAN_B64.indexOf(s.charAt(2 * i)) * 64 + PAN_B64.indexOf(s.charAt(2 * i + 1))) * PAN_RANGE_UNIT_M;
      return out;
    });
  } catch (e) { return null; }
}

// ridge altitude at any azimuth, linear between the two whole degrees either side
function horizonAt(horizon, azDeg) {
  const a = ((azDeg % 360) + 360) % 360;
  const i = Math.floor(a);
  const f = a - i;
  return horizon[i] * (1 - f) + horizon[(i + 1) % 360] * f;
}

// the canopy block's entry for a place, decoded: { t, s, lo, hi } with a
// Float64Array per layer that is there and null for one that is not, or null
// for no entry at all. lo/hi are the window under the tree line, f and b in
// the encoded entry: the floor a body has to clear and the top of the open
// sky before the crowns start. the layers stay separate from the ridge: what
// is drawn and what is named both need to know which layer a degree belongs to.
function decodeCanopy(e) {
  if (!e) return null;
  return { t: e.t ? decodeHorizon(e.t) : null, s: e.s ? decodeHorizon(e.s) : null,
           lo: e.f ? decodeHorizon(e.f) : null, hi: e.b ? decodeHorizon(e.b) : null };
}

// per-azimuth maximum of two profiles; a null second returns the first as is
function panMaxProfile(a, b) {
  if (!b) return a;
  const out = new Float64Array(360);
  for (let i = 0; i < 360; i++) out[i] = Math.max(a[i], b[i]);
  return out;
}

// the windows under the crowns, as holes to cut out of the tree ring: one per
// run of azimuths where the window top sits over its floor, each sample
// standing for its own degree, so a hole spans half a degree past its first
// and last sample and no further. top runs along the window top, floor along
// its floor, both in azimuth order; azimuths keep counting past 360 through
// north. circular joins a window through north into one hole (the dialog);
// the flat strip, which has two ends, gets two. drawing the ring down to the
// floor with a crown band over it instead interpolated both across the degree
// where a window starts, two chords up to 54 degrees tall with sky between
// them (View Waynesville, azimuth 77 to 78, 2026-09-18).
function panWindowHoles(lo, hi, circular) {
  if (!lo || !hi) return [];
  const open = [];
  for (let a = 0; a < 360; a++) open.push(hi[a] > lo[a]);
  return panRuns(open, circular).map(run => {
    const a0 = run[0], last = run[run.length - 1];
    const top = [[a0 - 0.5, hi[a0]]], floor = [[a0 - 0.5, lo[a0]]];
    run.forEach((i, k) => { top.push([a0 + k, hi[i]]); floor.push([a0 + k, lo[i]]); });
    top.push([a0 + run.length - 0.5, hi[last]]);
    floor.push([a0 + run.length - 0.5, lo[last]]);
    return { top, floor };
  });
}

// the holes the structures ring needs: a window only shows sky above whatever
// structure stands in it, so its floor is the higher of the two
function panStructureHoles(canopy, circular) {
  return canopy.lo ? panWindowHoles(panMaxProfile(canopy.lo, canopy.s), canopy.hi, circular) : [];
}

// the profile a body actually has to clear: the highest of ridge, trees and
// structures. with nothing above the ridge it is the ridge itself, the same
// object, which is what keeps the no-canopy sentence exactly what it was.
function panBlocking(horizon, canopy) {
  if (!canopy || (!canopy.t && !canopy.s)) return horizon;
  return panMaxProfile(panMaxProfile(horizon, canopy.t), canopy.s);
}

// what a body has to clear, window and all. with no window this is exactly
// panBlocking, the same profile the page has always used. with one it is the
// floor under the window (ridge, trees below it, structures), the window's
// top where the crowns start, and the top of everything. where the window
// is shut or under the ridge, hi is pulled down to the floor.
function panBlock(horizon, canopy) {
  if (!canopy || !canopy.lo || !canopy.hi) return panBlocking(horizon, canopy);
  const floor = panMaxProfile(panMaxProfile(horizon, canopy.lo), canopy.s);
  const hi = new Float64Array(360);
  for (let i = 0; i < 360; i++) hi[i] = Math.max(canopy.hi[i], floor[i]);
  return { floor, hi, top: panBlocking(horizon, canopy) };
}

// which layer sits highest at an azimuth. ties go to the ridge, so a tree
// line flush with the crest is still "the ridge". with an altitude given and
// a window open there, a body at or just under the window's top is named the
// trees too: it is meeting the crowns from below, not sitting at the ridge.
function panLayerAt(horizon, canopy, az, alt) {
  const ridgeAlt = horizonAt(horizon, az);
  if (canopy && canopy.lo && alt !== undefined) {
    const floor = Math.max(ridgeAlt, horizonAt(canopy.lo, az));
    const top = horizonAt(canopy.hi, az);
    if (top > floor + 0.5 && alt >= top - 0.5) return 'trees';
  }
  let word = 'ridge', best = ridgeAlt;
  const treeFloor = canopy && (canopy.lo || canopy.t);
  if (treeFloor && horizonAt(treeFloor, az) > best) { word = 'trees'; best = horizonAt(treeFloor, az); }
  if (canopy && canopy.s && horizonAt(canopy.s, az) > best) word = 'structure';
  return word;
}

// ---------- projection ----------
// cylindrical: azimuth linear, altitude linear. this is the thumbnail's own
// projection now -- the open, turnable sky moved to the stereographic one
// below -- so it only ever draws one fixed window: the full turn, altitude
// -3 to +24. on that scale a sixty pixel strip gives a typical ridge nine
// pixels and it reads as a smudge otherwise. every thumbnail shares the one
// window, so two spots side by side still compare honestly.
const PAN_TOP = 24;
const PAN_BOT = -8;
const PAN_AZ0 = 180;      // where the fixed window's centre sits; nothing in
                          // a full turn depends on where that centre falls
const PAN_FOV_DEG = 360;

// azimuth to x. pure, so it is what tools/test-panorama.mjs exercises
// directly. the thumbnail never needs to wrap an azimuth toward a moving
// heading -- it has no heading, the whole turn is always on screen -- so
// this is the only mapping left; a window narrower than 360 needs the wrap
// wrapNear used to do, and that window is the dialog's now, projected
// through panProject below instead.
function azToX(az, az0, fovDeg, w) {
  return (az - az0 + fovDeg / 2) / fovDeg * w;
}
const panXLin = (az, w) => azToX(az, PAN_AZ0, PAN_FOV_DEG, w);
const panY = (alt, h) => (PAN_TOP - alt) / (PAN_TOP - PAN_BOT) * h;

// ---------- stable horizon window, for the dialog viewer ----------
// The viewer is intentionally a conventional landscape window, not a virtual
// camera.  A fixed scale keeps the ridges legible as the reader turns, and
// avoids the fish-eye/zoom effect that made the old free-look view feel like
// it was changing the terrain rather than simply looking along it.
const PAN_VIEW_FOV = 110;
const PAN_VIEW_TOP = 68;
const PAN_VIEW_BOT = -18;

function panAzDelta(az, az0) {
  return ((az - az0 + 540) % 360) - 180;
}

// The one projection used by the dialog: azimuth and altitude are both
// linear. It returns null beyond this fixed horizon window, so callers can
// split a star path or ridge run at its edges.
function panProject(alt, az, view) {
  const d = panAzDelta(az, view.az0);
  if (Math.abs(d) > PAN_VIEW_FOV / 2 || alt < PAN_VIEW_BOT || alt > PAN_VIEW_TOP) return null;
  return {
    x: view.w / 2 + d / PAN_VIEW_FOV * view.w,
    y: (PAN_VIEW_TOP - alt) / (PAN_VIEW_TOP - PAN_VIEW_BOT) * view.h,
  };
}

// Like panProject, but deliberately allows an off-canvas point. It is used
// to close a filled silhouette cleanly at the two sides of the clipped window.
function panProjectWide(alt, az, view) {
  const d = panAzDelta(az, view.az0);
  return {
    x: view.w / 2 + d / PAN_VIEW_FOV * view.w,
    y: (PAN_VIEW_TOP - alt) / (PAN_VIEW_TOP - PAN_VIEW_BOT) * view.h,
  };
}

// ---------- sky positions ----------

// one place that turns a J2000 right ascension and declination into where it
// actually is in the drawing, precession and refraction included.
function panAltAz(ra, dec, ctxSky) {
  const p = Sky.precess(ra, dec, J2000, ctxSky.jd);
  const h = Sky.equatorialToHorizontal(p.ra, p.dec, ctxSky.lmst, ctxSky.lat);
  return { alt: Sky.refract(h.alt), az: h.az };
}

function skyContext(opts) {
  const jd = Sky.julianDay(opts.date);
  return { jd: jd, lmst: Sky.lmst(jd, opts.lon), lat: opts.lat, lon: opts.lon, elevM: opts.elevM || 0 };
}

function moonAltAz(ctxSky) {
  const m = Sky.moonTopocentric(ctxSky.jd, ctxSky.lat, ctxSky.lon, ctxSky.elevM);
  const h = Sky.equatorialToHorizontal(m.ra, m.dec, ctxSky.lmst, ctxSky.lat);
  // limbAngle is a position angle from the celestial pole; up in this drawing
  // is the zenith. the parallactic angle between them runs to tens of degrees
  // for a low moon, which is every moon this feature is about.
  const q = Sky.parallacticAngle(m.ra, m.dec, ctxSky.lmst, ctxSky.lat);
  return { alt: Sky.refract(h.alt), az: h.az, illum: m.illum, limbPA: m.limbAngle - q };
}

// the sun, refracted like everything else, so the disc sits on the ridge at
// the moment the sentence says it does. no topocentric correction: parallax
// on the sun is 9 arcseconds, a thousandth of its own diameter.
function sunAltAz(ctxSky) {
  const s = Sky.sunPosition(ctxSky.jd);
  const h = Sky.equatorialToHorizontal(s.ra, s.dec, ctxSky.lmst, ctxSky.lat);
  return { alt: Sky.refract(h.alt), az: h.az };
}

// ponytail: the milky way is drawn from its J2000 galactic rotation with no
// precession. 0.35 degrees of drift inside a band 25 degrees wide is invisible.
function galAltAz(l, b, ctxSky) {
  const e = Sky.galacticToEquatorial(l, b);
  const h = Sky.equatorialToHorizontal(e.ra, e.dec, ctxSky.lmst, ctxSky.lat);
  return { alt: h.alt, az: h.az };
}

// ---------- drawing ----------

function drawPanorama(canvas, opts) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  // the dialog viewer draws with no horizon at all -- a flat line and a
  // caveat, for a picked point before phase 2's terrain exists -- so only
  // the thumbnail, which has nothing to fall back to, requires one
  if (!ctx || (!opts.horizon && opts.mode !== 'view' && opts.mode !== 'day')) return false;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (opts.mode === 'view') { drawSkyView(ctx, w, h, opts); return true; }
  if (opts.mode === 'day') { drawDayView(ctx, w, h, opts); return true; }
  if (opts.mode === 'thumb') { drawRidge(ctx, opts.horizon, w, h, opts.canopy, opts.ridges); return true; }
  return false;
}

const PAN_COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// The few cardinal/intercardinal marks inside the current landscape window.
// They deliberately live at the top, outside the terrain-and-distance label
// zone, while the precise sixteen-point heading remains in the control bar.
function panCompassMarks(view) {
  const half = PAN_VIEW_FOV / 2;
  return PAN_COMPASS.map((label, i) => ({ label, az: i * 45, d: panAzDelta(i * 45, view.az0) }))
    .filter(mark => Math.abs(mark.d) <= half - 2)
    .map(mark => ({ ...mark, x: (mark.d + half) / (2 * half) * view.w }));
}

// STARS is an array of arrays, [ra, dec, mag] with a name appended only for the
// ones worth labelling, so anything past index 2 is optional.
// the catalogue runs past a thousand stars including figure-only faint ones.
// narrow canvases get a magnitude cut rather than a shorter catalogue, because
// the constellation lines index into the full list.
const starMagLimit = w => (w < 520 ? 4.2 : 6);

// the ridge, the thumbnail's whole drawing: the full turn, degree by degree,
// filled from the crest down to the bottom edge. the open, turnable sky and
// its own ridge fill, wash, stars and moon live in drawSkyView below now.
// one filled strip: the full turn, degree by degree, from the crest down to
// the bottom edge, plus a one pixel crest line. the thumbnail's whole
// drawing is distance bands back to front, then the nearby lidar layers.
function panRidgeStrip(ctx, prof, w, h, style, holes) {
  const altAt = i => prof[((Math.round(i) % 360) + 360) % 360];
  ctx.beginPath();
  ctx.moveTo(panXLin(0, w), h);
  for (let i = 0; i <= 360; i++) ctx.lineTo(panXLin(i, w), panY(altAt(i), h));
  ctx.lineTo(panXLin(360, w), h);
  ctx.closePath();
  // each window a subpath inside the strip, so even-odd leaves it unfilled
  for (const { top, floor } of holes || []) {
    top.forEach(([az, alt], k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, panXLin(az, w), panY(alt, h)));
    for (let k = floor.length - 1; k >= 0; k--) ctx.lineTo(panXLin(floor[k][0], w), panY(floor[k][1], h));
    ctx.closePath();
  }
  ctx.fillStyle = style.fill;
  ctx.fill('evenodd');

  // a rim of sky light along the crest. without it the silhouette reads as a
  // hole punched in the canvas rather than as a ridge with sky behind it.
  ctx.beginPath();
  for (let i = 0; i <= 360; i++) {
    const x = panXLin(i, w);
    const y = panY(altAt(i), h);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.setLineDash(style.dash);
  ctx.strokeStyle = style.crest;
  ctx.lineWidth = 1;
  ctx.stroke();
  // and along each window's floor: the tops of what stands under the crowns
  if (holes && holes.length) {
    ctx.beginPath();
    for (const { floor } of holes) {
      floor.forEach(([az, alt], k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, panXLin(az, w), panY(alt, h)));
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// the layers, back to front. A tree crown against open sky stays translucent,
// which preserves a little depth in the near field. Where that crown overlaps
// the top terrain silhouette it is painted again, opaque: a distant ridge,
// moon or core must never show through nearby foliage. The only other opening
// is a lidar-confirmed canopy window, cut out before either pass is filled.
const PAN_LAYERS = {
  far: { fill: '#334d7c', crest: 'rgba(174,193,226,0.28)', dash: [], rim: null },
  farMiddle: { fill: '#2a416d', crest: 'rgba(160,181,220,0.32)', dash: [], rim: null },
  middle: { fill: '#21365e', crest: 'rgba(150,173,213,0.38)', dash: [], rim: null },
  nearMiddle: { fill: '#182b4d', crest: 'rgba(143,165,207,0.42)', dash: [], rim: null },
  near: { fill: null, crest: 'rgba(122,140,186,0.75)', dash: [], rim: null },
  structures: { fill: '#343946', crest: 'rgba(196,200,210,0.75)', dash: [4, 3], rim: null },
  trees: { fill: 'rgba(8,28,16,0.7)', crest: 'rgba(118,168,118,0.6)', dash: [], rim: 'rgba(130,190,130,0.10)' },
  // This is a depth mask, not a statement that every square metre below a
  // crown is forest. Keeping it translucent lets the bare-earth surface read
  // through a foreground tree wall (road cut, grass verge, rock), while the
  // crown itself above the terrain retains its green, opaque presence.
  treeOcclusion: { fill: 'rgba(7,16,18,0.38)', crest: 'rgba(0,0,0,0)', dash: [], rim: null },
};

// Local ground context is deliberately separate from the horizon. These are
// surveyed/map features in metres east, north, and elevation relative to the
// calibrated ground. More sites will be generated into this shape once the
// Steestachee reference implementation is settled.
const PAN_FOREGROUND = {
  'ov:n981574350': { eye: 1.2, roads: [
    { width: 6.5, points: [[79.1,70.8,-6.8],[33.3,37.1,-2.9],[15.1,24.1,-1.2],[-34.5,-1.5,5.8],[-52,-7.1,3.2],[-70.4,-11.1,6.3],[-91,-13.6,5.4],[-113.3,-13.4,7]] },
    { width: 5.5, points: [[-34.5,-1.5,5.8],[-15.6,-5.8,1.2],[-2,-5,0.2],[12.6,1,-0.5],[25.4,10.6,-1.9],[33.5,26.4,-3],[33.3,37.1,-2.9]] },
  ] },
};

function drawForegroundRoads(ctx, foreground, view, terrain) {
  if (!foreground || !foreground.roads) return;
  const project = ([east, north, z]) => {
    const r = Math.hypot(east, north);
    if (r < 1) return null;
    const az = Math.atan2(east, north) / PAN_D2R;
    const alt = Math.atan2(z - foreground.eye, r) / PAN_D2R;
    // A local road hidden by the terrain silhouette must stay hidden.
    if (terrain && alt < horizonAt(terrain, az) - 0.35) return null;
    return panProject(alt, az, view);
  };
  ctx.save();
  ctx.fillStyle = 'rgba(65,70,79,0.78)';
  ctx.strokeStyle = 'rgba(174,179,187,0.26)';
  ctx.lineWidth = 1;
  for (const road of foreground.roads) {
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i], b = road.points[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
      if (!d) continue;
      const nx = -dy / d * road.width / 2, ny = dx / d * road.width / 2;
      const q = [project([a[0]+nx,a[1]+ny,a[2]]), project([b[0]+nx,b[1]+ny,b[2]]),
                 project([b[0]-nx,b[1]-ny,b[2]]), project([a[0]-nx,a[1]-ny,a[2]])];
      if (q.some(p => !p)) continue;
      ctx.beginPath(); ctx.moveTo(q[0].x,q[0].y); q.slice(1).forEach(p => ctx.lineTo(p.x,p.y)); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
}

// The area shared by a tree fill and terrain is the part at or below the
// lower of their crests. Paint that second pass solid, but leave foliage above
// the terrain line in the translucent sky-facing pass.
function panTreeOcclusionProfile(trees, terrain) {
  if (!trees || !terrain) return null;
  return trees.map((tree, az) => Math.min(tree, terrain[az]));
}

// Generated stacks are near-to-far by actual exposed crest rank. Paint the
// farthest first, then step toward the observer. A legacy place has one line.
function panTerrainBands(horizon, ridges) {
  const bands = ridges && ridges.length ? ridges : [horizon];
  return bands.slice().reverse();
}

// The adaptive profiles describe additional, sustained ridge traces; they do
// not replace the DEM's per-bearing skyline. Keep that complete envelope as
// the far ground layer, or a short/fragmented track can leave a real distant
// crest out of the view altogether.
function panSceneBands(horizon, ridges) {
  return ridges && ridges.length ? [horizon, ...panTerrainBands(horizon, ridges)] : [horizon];
}

// An adaptive DEM stack is already made of exposed crest records. This client
// pass supports old shell caches too: a farther crest must still rise clearly
// above the terrain already visible at that bearing, and must persist long
// enough to read as a ridge rather than a one-degree sampling blip.
const PAN_RIDGE_SEPARATION = 0.75;
const PAN_RIDGE_MIN_RUN = 3;
const PAN_RIDGE_EMPTY = HORIZON_ALT_MIN + 0.1;

function panSustainedRidgeMask(candidate) {
  const n = candidate.length;
  const out = new Uint8Array(n);
  // Rotate after any gap so a run across north is treated as one run.
  const gap = candidate.findIndex(v => !v);
  if (gap < 0) return candidate.slice();
  let run = [];
  for (let j = 1; j <= n; j++) {
    const i = (gap + j) % n;
    if (candidate[i]) run.push(i);
    else {
      if (run.length >= PAN_RIDGE_MIN_RUN) run.forEach(k => { out[k] = 1; });
      run = [];
    }
  }
  return out;
}

function panVisibleRidgeMasks(ridges) {
  if (!ridges || !ridges.length) return null;
  const masks = ridges.map(() => new Uint8Array(360));
  const visibleTop = new Float64Array(360);
  visibleTop.fill(-Infinity);
  for (let az = 0; az < 360; az++) {
    if (ridges[0][az] > PAN_RIDGE_EMPTY) {
      masks[0][az] = 1;
      visibleTop[az] = ridges[0][az];
    }
  }
  // Walk outward. Every sustained crest that clears the previous visible
  // envelope gets its own band; rejected one-degree fluctuations do not lift
  // the envelope and cannot hide a real farther ridge.
  for (let i = 1; i < ridges.length; i++) {
    const candidate = new Uint8Array(360);
    for (let az = 0; az < 360; az++) {
      if (ridges[i][az] > PAN_RIDGE_EMPTY && ridges[i][az] > visibleTop[az] + PAN_RIDGE_SEPARATION) candidate[az] = 1;
    }
    masks[i] = panSustainedRidgeMask(candidate);
    for (let az = 0; az < 360; az++) {
      if (masks[i][az]) visibleTop[az] = ridges[i][az];
    }
  }
  return masks;
}

function panMaskAt(mask, az) {
  if (!mask) return true;
  return !!mask[((Math.round(az) % 360) + 360) % 360];
}

function panTerrainLayer(i, n) {
  if (n === 1 || i === n - 1) return PAN_LAYERS.near;
  // No palette bucket count: interpolate the haze from remote blue to the
  // nearer indigo so a location with eight real crests remains legible.
  const t = i / (n - 1);
  const mix = (a, b) => Math.round(a + (b - a) * t);
  return {
    fill: `rgb(${mix(51, 24)},${mix(77, 43)},${mix(124, 77)})`,
    crest: `rgba(${mix(174, 143)},${mix(193, 165)},${mix(226, 207)},${(0.28 + 0.18 * t).toFixed(2)})`,
    dash: [], rim: null,
  };
}

function drawRidge(ctx, horizon, w, h, canopy, ridges) {
  const g = ctx.createLinearGradient(0, panY(PAN_TOP * 0.3, h), 0, h);
  g.addColorStop(0, '#121c38');
  g.addColorStop(1, '#070c1a');
  const bands = panSceneBands(horizon, ridges);
  bands.forEach((profile, i) => {
    const layer = panTerrainLayer(i, bands.length);
    panRidgeStrip(ctx, profile, w, h, { ...layer, fill: layer.fill || g }, undefined);
  });
  // Lidar is sampled within 200 m of the pin; it is foreground, not a tint on
  // the distant horizon. Its own profile must be drawn, rather than maxed with
  // the ridge, so trees below a ridge still stand in front of it.
  if (canopy && canopy.t) {
    const holes = panWindowHoles(canopy.lo, canopy.hi, false);
    panRidgeStrip(ctx, canopy.t, w, h, PAN_LAYERS.trees, holes);
    panRidgeStrip(ctx, panTreeOcclusionProfile(canopy.t, horizon), w, h, PAN_LAYERS.treeOcclusion, holes);
  }
  if (canopy && canopy.s) panRidgeStrip(ctx, canopy.s, w, h, PAN_LAYERS.structures, panStructureHoles(canopy, false));
}

// ---------- the dialog viewer (stereographic) ----------
// same drawing job as the flat open view above -- wash, milky way, stars,
// figures, moon, grid, ridge -- but every point goes through panProject
// instead of panX/panY. a null from panProject means "not in front of the
// viewer", so a line or a quad with a null end is just skipped: there is no
// wrap-copy loop to write here, because a stereographic view never has to
// repeat itself to cover the seam the way the cylinder does.

// the sky's colour is a function of one number: how far the sun is above or
// below the horizon. these are the keyframes, sun altitude paired with the
// gradient read zenith, middle, horizon. the -18 row is the night wash this
// view has always drawn, unchanged, so a dark-hours screenshot still matches.
// they are eyeballed against photographs rather than computed from a
// scattering model, which is the right trade for a planning drawing.
const PAN_SKY_KEYS = [
  [-18, [6, 11, 25], [14, 24, 52], [23, 37, 74]],        // astronomical dark
  [-12, [8, 15, 36], [19, 29, 62], [58, 63, 104]],       // nautical twilight
  [-6, [13, 26, 60], [37, 49, 95], [176, 106, 82]],      // civil twilight
  [-0.5, [29, 53, 102], [106, 90, 134], [224, 146, 92]], // sunrise / sunset
  [6, [40, 84, 158], [82, 130, 190], [196, 190, 190]],   // low sun
  [25, [45, 99, 180], [91, 143, 212], [168, 196, 228]],  // full day
];

const panLerp = (a, b, t) => a + (b - a) * t;
const panMixRgb = (a, b, t) =>
  'rgb(' + Math.round(panLerp(a[0], b[0], t)) + ',' + Math.round(panLerp(a[1], b[1], t)) + ','
  + Math.round(panLerp(a[2], b[2], t)) + ')';

// the three gradient colours at a given sun altitude, linearly between the two
// keyframes it falls between and clamped to the ends outside the table
function panSkyColors(sunAlt) {
  let i = 0;
  while (i < PAN_SKY_KEYS.length - 2 && sunAlt > PAN_SKY_KEYS[i + 1][0]) i++;
  const lo = PAN_SKY_KEYS[i], hi = PAN_SKY_KEYS[i + 1];
  const t = Math.max(0, Math.min(1, (sunAlt - lo[0]) / (hi[0] - lo[0])));
  return [panMixRgb(lo[1], hi[1], t), panMixRgb(lo[2], hi[2], t), panMixRgb(lo[3], hi[3], t)];
}

// 0 in the dark, 1 once the sun is properly up. what the ridge haze and the
// star fades key off, so they all brighten together rather than each picking
// its own idea of "daytime".
const panDayFactor = sunAlt => Math.max(0, Math.min(1, (sunAlt + 6) / 12));

// what is still visible overhead as the sun comes up. the brighter stars hold
// on into civil twilight and are gone soon after sunrise; the milky way needs
// a properly dark sky and goes first, which is the whole premise of this page.
const panStarFade = sunAlt => Math.max(0, Math.min(1, (-4 - sunAlt) / 11));
const panMilkyWayFade = sunAlt => Math.max(0, Math.min(1, (-10 - sunAlt) / 8));

function drawSkyWashView(ctx, w, h, view) {
  // brightest at the true horizon below the view centre, same reasoning as
  // the flat wash: the very bottom of the canvas is behind the ridge
  const horizon = panProject(0, view.az0, view) || { y: h * 0.7 };
  const c = panSkyColors(view.sunAlt);
  const g = ctx.createLinearGradient(0, 0, 0, horizon.y);
  g.addColorStop(0, c[0]);
  g.addColorStop(0.7, c[1]);
  g.addColorStop(1, c[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function milkyWayPathView(ctx, sky, halfWidth, view) {
  ctx.beginPath();
  let prev = null;
  for (let l = 0; l <= 360; l += 2) {
    const b = halfWidth * (0.42 + 0.58 * (0.5 + 0.5 * Math.cos(l * PAN_D2R)));
    const top = galAltAz(l, b, sky), bot = galAltAz(l, -b, sky);
    if (prev) {
      const pts = [
        panProject(prev.top.alt, prev.top.az, view),
        panProject(prev.bot.alt, prev.bot.az, view),
        panProject(bot.alt, bot.az, view),
        panProject(top.alt, top.az, view),
      ];
      if (pts.every(Boolean)) {
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.lineTo(pts[2].x, pts[2].y);
        ctx.lineTo(pts[3].x, pts[3].y);
        ctx.closePath();
      }
    }
    prev = { top: top, bot: bot };
  }
}

function drawMilkyWayView(ctx, sky, view, w, h) {
  const fade = panMilkyWayFade(view.sunAlt);
  if (fade <= 0) return;
  ctx.globalAlpha = fade;
  const bands = [[22, 0.015], [17, 0.018], [12, 0.020], [7.5, 0.023], [3.5, 0.027]];
  const blurred = 'filter' in ctx;
  if (blurred) ctx.filter = 'blur(9px)';
  for (let i = 0; i < bands.length; i++) {
    milkyWayPathView(ctx, sky, bands[i][0], view);
    ctx.fillStyle = 'rgba(198,208,238,' + bands[i][1] + ')';
    ctx.fill();
  }
  if (blurred) ctx.filter = 'none';

  const core = galAltAz(0, 0, sky);
  const cp = panProject(core.alt, core.az, view);
  if (cp) {
    const r = Math.max(34, w * 0.055);
    const g = ctx.createRadialGradient(cp.x, cp.y, 0, cp.x, cp.y, r);
    g.addColorStop(0, 'rgba(236,231,212,0.14)');
    g.addColorStop(1, 'rgba(236,231,212,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cp.x - r, cp.y - r, r * 2, r * 2);
    if (core.alt > 2) {
      ctx.fillStyle = 'rgba(169,165,143,0.85)';
      ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('galactic core', cp.x, cp.y - r * 0.52);
    }
  }
  ctx.globalAlpha = 1;
}

function drawStarsView(ctx, sky, view, w, h) {
  const fade = panStarFade(view.sunAlt);
  if (fade <= 0) return;
  const list = (typeof STARS !== 'undefined' && STARS) || [];
  const limit = starMagLimit(w);
  const seen = new Array(list.length);
  ctx.fillStyle = '#e9edf8';
  for (let i = 0; i < list.length; i++) {
    const mag = list[i][2];
    if (mag > limit) { seen[i] = null; continue; }
    const p = panAltAz(list[i][0], list[i][1], sky);
    const at = panProject(p.alt, p.az, view);
    seen[i] = at;
    if (!at) continue;
    const r = Math.max(0.4, 1.7 - 0.30 * mag);
    ctx.globalAlpha = fade * Math.max(0.2, Math.min(1, 1.02 - 0.16 * mag));
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (mag < 1.0) {
      ctx.globalAlpha = fade * 0.13;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r * 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = fade;
  drawFiguresView(ctx, seen);
  ctx.globalAlpha = 1;
}

function drawFiguresView(ctx, seen) {
  if (typeof CONSTELLATION_LINES === 'undefined' || !CONSTELLATION_LINES) return;
  ctx.beginPath();
  for (let r = 0; r < CONSTELLATION_LINES.length; r++) {
    const run = CONSTELLATION_LINES[r];
    for (let i = 1; i < run.length; i++) {
      const a = seen[run[i - 1]], b = seen[run[i]];
      if (!a || !b) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
  }
  ctx.strokeStyle = 'rgba(152,172,224,0.17)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// the sun is the same half a degree across as the moon, so it gets the same
// radius. drawn a little below the horizon as well as above it: the disc
// sitting just behind a ridge is exactly the moment somebody scrubbing for
// sunrise is looking for, and refraction already lifts the real one.
function drawSunView(ctx, sky, view) {
  const s = sunAltAz(sky);
  if (s.alt < -3) return;
  const p = panProject(s.alt, s.az, view);
  if (!p) return;
  const r = 9;

  // the glow is what actually reads as "the sun is over there" once the disc
  // itself is behind a ridge, so it grows as the sun climbs.
  // ponytail: kept dim on purpose. the canopy layers are 81% opaque by
  // design, so the reader can see terrain through a foreground tree wall,
  // and anything bright enough behind them bleeds through and reads as a sun
  // inside the mountain. dim enough and that bleed is just light in the trees,
  // which is what it actually looks like.
  const reach = r * (4.5 + 3 * panDayFactor(s.alt));
  const g = ctx.createRadialGradient(p.x, p.y, r, p.x, p.y, reach);
  g.addColorStop(0, 'rgba(255,224,160,0.26)');
  g.addColorStop(1, 'rgba(255,224,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(p.x - reach, p.y - reach, reach * 2, reach * 2);

  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  // low sun is orange through the thickness of air it is shining along, and
  // whites out as it climbs; the same reason a sunset is red
  ctx.fillStyle = panMixRgb([245, 158, 74], [255, 246, 214], panDayFactor(s.alt));
  ctx.fill();
}

function drawMoonView(ctx, sky, view) {
  const m = moonAltAz(sky);
  const p = panProject(m.alt, m.az, view);
  if (!p) return;
  const r = 9;

  const g = ctx.createRadialGradient(p.x, p.y, r, p.x, p.y, r * 5);
  g.addColorStop(0, 'rgba(236,231,212,0.17)');
  g.addColorStop(1, 'rgba(236,231,212,0)');
  ctx.fillStyle = g;
  ctx.fillRect(p.x - r * 5, p.y - r * 5, r * 10, r * 10);

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  // the unlit part is the night sky showing through, so it follows the sky:
  // a dark disc in a daylit view would read as a hole, and a daytime moon is
  // in fact a pale wash barely darker than what is behind it
  ctx.fillStyle = panMixRgb([16, 28, 58], [150, 176, 208], panDayFactor(view.sunAlt));
  ctx.fill();
  ctx.strokeStyle = 'rgba(95,116,173,0.5)';
  ctx.lineWidth = 0.75;
  ctx.stroke();

  const k = Math.max(0, Math.min(1, m.illum));
  if (k > 0.02) {
    // the zenith direction on screen tilts away from straight up once the
    // view looks away from the moon; a point nudged a degree higher in
    // altitude, projected the same way, says which way it tilted here.
    const up = panProject(Math.min(90, m.alt + 1), m.az, view) || { x: p.x, y: p.y - 1 };
    const upAngle = Math.atan2(up.y - p.y, up.x - p.x);
    ctx.rotate(upAngle - (m.limbPA || 0) * PAN_D2R);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r, 0, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, r * Math.abs(1 - 2 * k), r, 0, Math.PI / 2, -Math.PI / 2, k < 0.5);
    ctx.closePath();
    ctx.fillStyle = '#ece7d4';
    ctx.fill();
  }
  ctx.restore();
}

// a run of samples is a path only where every point in it is in front of the
// viewer; split on every null instead of drawing through it, so a line or a
// filled ridge never stretches across the gap where the back of the view
// would otherwise be. circular joins the last run back onto the first when
// both ends of the sweep are visible, for a sweep around a full circle
// (the ridge, an altitude ring) rather than a line with two real ends (an
// azimuth line, alt -10 to 90).
function panRuns(points, circular) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i]) { (cur || (cur = [])).push(i); }
    else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  if (circular && runs.length > 1 && points[0] && points[points.length - 1]) {
    const first = runs[0], last = runs[runs.length - 1];
    if (first[0] === 0 && last[last.length - 1] === points.length - 1) {
      runs.pop();
      runs[0] = last.concat(first);
    }
  }
  return runs;
}

function panStrokeRuns(ctx, pts, circular) {
  for (const run of panRuns(pts, circular)) {
    if (run.length < 2) continue;
    ctx.beginPath();
    run.forEach(function (i, k) {
      const p = pts[i];
      if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }
}

// altitude circles every 10 degrees, azimuth lines every 45, compass letters
// at the horizon. looking straight up, every altitude circle is the same
// angular distance from the view centre at every azimuth, so it survives as
// one circular run rather than being cut into pieces -- that is the case
// panRuns's circular join exists for.
function drawGridView(ctx, view, w, h) {
  ctx.strokeStyle = 'rgba(95,116,173,0.20)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 5]);
  for (let a = -10; a <= 90; a += 10) {
    const pts = [];
    for (let az = 0; az <= 360; az += 5) pts.push(panProject(a, az, view));
    panStrokeRuns(ctx, pts, true);
  }
  ctx.setLineDash([2, 7]);
  ctx.strokeStyle = 'rgba(95,116,173,0.13)';
  for (let az = 0; az < 360; az += 45) {
    const pts = [];
    for (let a = -10; a <= 90; a += 5) pts.push(panProject(a, az, view));
    panStrokeRuns(ctx, pts, false);
  }
  ctx.setLineDash([]);

  // how high each circle is, up the middle of the view
  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(139,150,179,0.7)';
  for (let a = 10; a <= 80; a += 10) {
    const p = panProject(a, view.az0, view);
    if (p) ctx.fillText(a + '\u00b0', p.x + 4, p.y - 3);
  }
}

// True level is a quiet reference, drawn after the ridge so its gap to the
// crest still reads as sky taken by terrain. Heading already lives in the
// control bar; repeating compass letters across the landscape made a crowded
// ridge hard to read.
function drawLevelView(ctx, view) {
  const pts = [];
  for (let az = 0; az <= 360; az += 5) pts.push(panProject(0, az, view));
  ctx.setLineDash([3, 7]);
  ctx.strokeStyle = 'rgba(155,170,202,0.28)';
  ctx.lineWidth = 1;
  panStrokeRuns(ctx, pts, true);
  ctx.setLineDash([]);
}

function drawCompassTopView(ctx, view) {
  ctx.save();
  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const mark of panCompassMarks(view)) {
    ctx.fillStyle = Math.abs(mark.d) < 1 ? 'rgba(236,231,212,0.82)' : 'rgba(174,190,220,0.58)';
    ctx.fillText(mark.label, mark.x, 12);
  }
  ctx.restore();
}

// One open landscape silhouette. Unlike the former all-sky ring, this has
// no back side or moving vanishing point: it is simply the 110 degrees in
// front of the reader, which makes a drag feel like turning toward a view.
function panWindowRidge(ctx, prof, view, w, h, style, holes, mask) {
  const step = 0.5, half = PAN_VIEW_FOV / 2;
  const crest = [];
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  for (let d = -half; d <= half + 0.01; d += step) {
    const p = panProjectWide(horizonAt(prof, view.az0 + d), view.az0 + d, view);
    crest.push({ ...p, active: panMaskAt(mask, view.az0 + d) });
  }
  // Terrain masks have no canopy holes. Fill each exposed run independently,
  // rather than filling the hidden shell underneath a nearer ridge.
  const runs = [];
  let run = null;
  crest.forEach((p, i) => {
    if (p.active) (run || (run = [])).push(i);
    else if (run) { runs.push(run); run = null; }
  });
  if (run) runs.push(run);
  if (mask) {
    for (const r of runs) {
      if (!r.length) continue;
      ctx.beginPath();
      ctx.moveTo(crest[r[0]].x, h);
      r.forEach(i => ctx.lineTo(crest[i].x, crest[i].y));
      ctx.lineTo(crest[r.at(-1)].x, h);
      ctx.closePath();
      if (style.fill) { ctx.fillStyle = style.fill; ctx.fill(); }
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(0, h);
    crest.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(w, h);
    ctx.closePath();
  // Tree windows are still punched out before the crown band is painted, so
  // nearby vegetation remains foreground without becoming one solid wall.
  for (const { top, floor } of holes || []) {
    // panWindowHoles is circular because it is also used by the thumbnail.
    // In this open window, a hole on the far side of the horizon can wrap
    // across the projected seam and carve a false vertical drop through the
    // local tree line. Only carry a mask path that reaches this view.
    if (!top.some(([az]) => Math.abs(panAzDelta(az, view.az0)) <= half + 1)) continue;
    top.forEach(([az, alt], k) => {
      const p = panProjectWide(alt, az, view);
      if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    });
    for (let k = floor.length - 1; k >= 0; k--) {
      const p = panProjectWide(floor[k][1], floor[k][0], view);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }
    if (style.fill) { ctx.fillStyle = style.fill; ctx.fill('evenodd'); }
  }
  if (style.rim) {
    for (const r of runs) {
      ctx.beginPath();
      r.forEach((i, k) => k ? ctx.lineTo(crest[i].x, crest[i].y) : ctx.moveTo(crest[i].x, crest[i].y));
      ctx.strokeStyle = style.rim;
      ctx.lineWidth = 11;
      ctx.stroke();
    }
  }
  for (const r of runs) {
    ctx.beginPath();
    r.forEach((i, k) => k ? ctx.lineTo(crest[i].x, crest[i].y) : ctx.moveTo(crest[i].x, crest[i].y));
    ctx.setLineDash(style.dash);
    ctx.strokeStyle = style.crest;
    ctx.lineWidth = style.crestWidth || 1;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function panDistanceLabel(m) {
  if (m >= 10000) return Math.round(m / 1000) + ' km';
  if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
  return Math.round(m / 25) * 25 + ' m';
}

// A few quiet labels belong beside their actual ridge crests, not in a key
// below the scene. Each uses its own bearing so it reports a real ray rather
// than a generic distance for the whole band.
// Whether a terrain point is actually visible through the local vegetation.
// This mirrors the foreground mask: an open lidar window is transparent, but
// a crown or structure in front of the point is not.
function panTerrainVisibleThroughCanopy(alt, canopy, az) {
  if (!canopy) return true;
  if (canopy.s && horizonAt(canopy.s, az) > alt + 0.1) return false;
  if (!canopy.t || horizonAt(canopy.t, az) <= alt + 0.1) return true;
  if (!canopy.lo || !canopy.hi) return false;
  const lo = horizonAt(canopy.lo, az), hi = horizonAt(canopy.hi, az);
  return hi > lo + 0.1 && alt > lo + 0.1 && alt < hi - 0.1;
}

const PAN_MAX_RIDGE_LABELS = 3;
const PAN_DISTANCE_TRACK_LOG_GAP = 0.22;

// The all-azimuth DEM skyline is not itself a single ridge. Split its clear
// samples where the terrain hit jumps in range, so 29 km and 76 km crests in
// adjacent notches receive their own anchored labels rather than one label
// that chases the middle of the window.
function panDistanceRuns(runs) {
  const out = [];
  for (const run of runs) {
    let part = [];
    for (const point of run) {
      const prev = part.at(-1);
      if (prev && Math.abs(Math.log(point.m / prev.m)) > PAN_DISTANCE_TRACK_LOG_GAP) {
        if (part.length >= PAN_RIDGE_MIN_RUN) out.push(part);
        part = [];
      }
      part.push(point);
    }
    if (part.length >= PAN_RIDGE_MIN_RUN) out.push(part);
  }
  return out;
}

function drawRidgeDistancesView(ctx, terrain, terrainRange, ridges, ridgeRanges, canopy, ridgeMasks, view, w, h) {
  const sources = [];
  // The complete skyline is most important: it can be a far crest precisely
  // where a short tracked profile ends. Then add sustained tracks far to near.
  if (terrain && terrainRange) sources.push({ profile: terrain, ranges: terrainRange, mask: null, base: true });
  if (ridges && ridgeRanges) {
    for (let i = ridges.length - 1; i >= 0; i--)
      if (ridgeRanges[i]) sources.push({ profile: ridges[i], ranges: ridgeRanges[i], mask: ridgeMasks && ridgeMasks[i] });
  }
  if (!sources.length) return;
  ctx.save();
  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  const half = PAN_VIEW_FOV / 2;
  const placed = [];
  for (const source of sources) {
    if (placed.length >= PAN_MAX_RIDGE_LABELS) break;
    // A global physical ridge can only cross part of this particular window.
    // Find its longest exposed local run, rather than deriving a label bearing
    // from its global array index (which made a 16-track view label one ridge).
    const runs = [], run = [];
    for (let d = -half; d <= half; d += 1) {
      const az = view.az0 + d;
      const alt = horizonAt(source.profile, az);
      const m = horizonAt(source.ranges, az);
      const p = panProject(alt, az, view);
      if (m && panMaskAt(source.mask, az) &&
          panTerrainVisibleThroughCanopy(alt, canopy, az) && p && p.y >= 16 && p.y <= h - 8) {
        run.push({ p, m });
      } else if (run.length) { runs.push(run.splice(0)); }
    }
    if (run.length) runs.push(run);
    const longest = runs.reduce((best, candidate) => candidate.length > best.length ? candidate : best, []);
    if (!longest.length) continue;
    // A complete skyline can cross several physical ridges in this one view;
    // each stable distance run gets its own anchor. Tracked profiles already
    // represent one physical ridge, so they keep their longest clear run.
    const labelRuns = source.base
      ? panDistanceRuns(runs).sort((a, b) =>
        Math.abs(a[Math.floor(a.length / 2)].p.x - w / 2) - Math.abs(b[Math.floor(b.length / 2)].p.x - w / 2))
      : [longest];
    for (const preferred of labelRuns) {
      if (placed.length >= PAN_MAX_RIDGE_LABELS) break;
      // Work outward from the actual run's midpoint if another label is there.
      // Unlike the previous centre-seeking rule, turning the view does not
      // make this text migrate onto an unrelated ridge or notch.
      const mid = Math.floor(preferred.length / 2);
      const candidates = [mid];
      for (let step = 1; step < preferred.length; step++) {
        if (mid - step >= 0) candidates.push(mid - step);
        if (mid + step < preferred.length) candidates.push(mid + step);
      }
      const label = panDistanceLabel(preferred[mid].m);
      const labelW = ctx.measureText(label).width;
      const choice = candidates.map(k => preferred[k]).find(({ p }) => {
        const box = { left: p.x + 4, right: p.x + 4 + labelW, top: p.y - 16, bottom: p.y - 3 };
        return placed.every(q =>
          // Two tracks at effectively the same distance do not earn two
          // labels merely because their pale fills happened to separate.
          Math.abs(Math.log(preferred[mid].m / q.m)) > 0.12 &&
          (box.right + 10 < q.left || box.left > q.right + 10 ||
           box.bottom + 7 < q.top || box.top > q.bottom + 7));
      });
      if (!choice) continue;
      // The full skyline identifies the actual opening being viewed. Keep it
      // quiet, but give it enough contrast to survive the sky wash.
      ctx.fillStyle = source.base
        ? 'rgba(215,226,246,0.72)'
        : 'rgba(207,219,239,0.42)';
      ctx.fillText(label, Math.min(w - 42, choice.p.x + 5), choice.p.y - 4);
      placed.push({ left: choice.p.x + 4, right: choice.p.x + 4 + labelW, top: choice.p.y - 16, bottom: choice.p.y - 3, m: choice.m });
    }
  }
  const near = ridges && ridges[0] || terrain;
  const nearAlt = near && horizonAt(near, view.az0);
  if (near && nearAlt <= -1.5 && panTerrainVisibleThroughCanopy(nearAlt, canopy, view.az0)) {
    const p = panProject(nearAlt, view.az0, view);
    if (p) ctx.fillText('valley \u2193', p.x + 7, Math.max(14, p.y - 5));
  }
  ctx.restore();
}

function drawRidgeView(ctx, horizon, horizonRange, view, w, h, canopy, ridges, ridgeRanges, key) {
  const terrain = horizon || new Float64Array(360);   // a picked point: flat at 0
  // in daylight a ridge is hazy blue-grey, not black: air between here and
  // there scatters light into the line of sight. without this the terrain
  // reads as a hole punched in a bright sky.
  // ponytail: only the distant terrain hazes. the near canopy and structure
  // layers stay dark, which is what a tree fifty metres away actually looks
  // like against a bright sky.
  const day = panDayFactor(view.sunAlt);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, panMixRgb([11, 18, 38], [96, 116, 142], day));
  g.addColorStop(1, panMixRgb([3, 6, 15], [54, 68, 88], day));
  // The full DEM raycast is the authoritative skyline. The experimental
  // tracked crests and local road ribbons can form angular 1-D fragments or
  // duplicate the same physical ridge, so they remain analysis data only
  // until a real surface renderer can validate them against the ground view.
  const ridgeMasks = null;
  panWindowRidge(ctx, terrain, view, w, h,
    { fill: g, crest: 'rgba(202,220,248,' + (0.78 - 0.5 * day).toFixed(3) + ')', crestWidth: 1.6, dash: [], rim: null });
  if (canopy && canopy.t) {
    const holes = panWindowHoles(canopy.lo, canopy.hi, true);
    panWindowRidge(ctx, canopy.t, view, w, h, PAN_LAYERS.trees, holes);
    panWindowRidge(ctx, panTreeOcclusionProfile(canopy.t, terrain), view, w, h, PAN_LAYERS.treeOcclusion, holes);
  }
  if (canopy && canopy.s) panWindowRidge(ctx, canopy.s, view, w, h, PAN_LAYERS.structures, panStructureHoles(canopy, true));
  drawRidgeDistancesView(ctx, horizon, horizonRange, null, null, canopy, ridgeMasks, view, w, h);
  if (!horizon) {
    const label = panProject(0, view.az0, view);
    if (label) {
      ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(236,231,212,0.75)';
      ctx.fillText('terrain not modelled', label.x, label.y + 16);
    }
  }
}

function drawSkyView(ctx, w, h, opts) {
  const sky = skyContext(opts);
  // the sun's altitude is read once and carried on the view: the wash, the
  // star and milky way fades and the ridge haze are all the same daylight,
  // so they have to come from the same number rather than each recomputing it
  const view = { az0: opts.az0, w: w, h: h, sunAlt: sunAltAz(sky).alt };
  drawSkyWashView(ctx, w, h, view);
  drawMilkyWayView(ctx, sky, view, w, h);
  drawStarsView(ctx, sky, view, w, h);
  drawSunView(ctx, sky, view);
  drawMoonView(ctx, sky, view);
  drawGridView(ctx, view, w, h);
  drawCompassTopView(ctx, view);
  drawRidgeView(ctx, opts.horizon, opts.horizonRange, view, w, h, opts.canopy, opts.ridges, opts.ridgeRanges, opts.key);
  drawLevelView(ctx, view);
}

// ---------- the whole day at one glance (the strip under the viewer) ----------
//
// the turnable view above answers "what is up right now". this answers "where
// does the sun come up from here, and how high does it get", which is a
// question about a day rather than a moment: it is drawn once per date and
// does not move with the scrubber or with the heading.
//
// the projection is the thumbnail's flat one -- azimuth straight across, a
// full turn, no heading -- because a track is a shape, and a shape has to be
// whole to be read. it gets its own altitude window: the sun reaches 78
// degrees here in June, which the thumbnail's -8 to 24 strip cannot hold.

const PAN_DAY_TOP = 84, PAN_DAY_BOT = -8;
const panDayY = alt => (PAN_DAY_TOP - alt) / (PAN_DAY_TOP - PAN_DAY_BOT);
const PAN_DAY_STEP_MIN = 10;

// the chosen eastern calendar day, midnight to midnight, in ten minute steps.
// midnight rather than the scrubber's noon anchor: the sun is near due north
// at local midnight, and due north is this projection's seam, so a day that
// starts there draws as one sweep from one edge to the other rather than a
// shape cut in half down the middle.
//
// ponytail: on the two days a year the eastern offset changes, this walks 24
// hours of real time from eastern midnight and so ends an hour either side of
// the next one. that is the honest thing to draw -- a track is a fact about
// elapsed time, not about what the clock was doing -- and it keeps the step
// count fixed.
function panDaySamples(day, opts) {
  const start = easternInstant(day.y, day.mo, day.d, 0);
  const out = [];
  for (let i = 0; i <= 24 * 60 / PAN_DAY_STEP_MIN; i++) {
    const t = new Date(start.getTime() + i * PAN_DAY_STEP_MIN * 60000);
    const sky = skyContext({ date: t, lat: opts.lat, lon: opts.lon, elevM: opts.elevM });
    out.push({ t: t, sun: sunAltAz(sky), moon: moonAltAz(sky) });
  }
  return out;
}

// the day's sky, blended across the turn. the sun passes through every
// azimuth in twenty-four hours -- due south around noon, due north around
// local midnight -- so every column of this strip has exactly one moment when
// the sun stood over it, and the column is painted the colour the sky was at
// that moment. dawn in the east, blue in the south, sunset in the west, night
// in the north, the whole day in one image.
//
// the stops have to be handed over in order and the day's azimuths start
// partway along (clock midnight is not solar midnight), so they are sorted by
// x rather than left in time order. the two samples either side of the wrap
// are both within an hour of solar midnight, so no seam shows.
function drawDayWash(ctx, samples, w, h) {
  const stops = samples
    .map(s => ({ x: Math.max(0, Math.min(1, panXLin(s.sun.az, w) / w)), c: panSkyColors(s.sun.alt) }))
    .sort((a, b) => a.x - b.x);
  const ramp = i => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    stops.forEach(s => g.addColorStop(s.x, s.c[i]));
    return g;
  };
  // the wash has to vary with height as well as with direction -- blue
  // overhead at midday, orange along the horizon at sunrise -- and a canvas
  // gradient is one-dimensional. so: paint the zenith colours over
  // everything, rub them out toward the horizon line with a vertical alpha
  // gradient, then paint the horizon colours in behind whatever survived.
  //
  // compositing rather than a stack of banded fills with falling alpha, which
  // was the first try: 48 bands across a strip this wide read as visible
  // horizontal stripes, and the overlap row of each band composited twice.
  // this way the vertical blend is exact and costs three fills.
  const floor = panDayY(0) * h;
  ctx.fillStyle = ramp(0);
  ctx.fillRect(0, 0, w, h);
  const fade = ctx.createLinearGradient(0, 0, 0, floor);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = ramp(2);
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
}

// ponytail: one silhouette of everything in the way, not the viewer's stack of
// distance bands and canopy layers. this is a chart of where the sky is open,
// and "open or not" is one shape. drawn here rather than through
// panRidgeStrip because that one is welded to the thumbnail's altitude scale
// and has four other callers.
function drawDaySilhouette(ctx, prof, w, h) {
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i <= 360; i++) ctx.lineTo(panXLin(i, w), panDayY(prof[i % 360]) * h);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(6,10,20,0.88)';
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i <= 360; i++) {
    const x = panXLin(i, w), y = panDayY(prof[i % 360]) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(150,173,213,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// altitude lines every 20 degrees, drawn under the ridge: they are the
// scale, not the subject
function drawDayGrid(ctx, w, h) {
  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.setLineDash([2, 5]);
  ctx.strokeStyle = 'rgba(95,116,173,0.22)';
  ctx.fillStyle = 'rgba(169,165,143,0.55)';
  ctx.lineWidth = 1;
  ctx.textAlign = 'left';
  for (let a = 0; a <= 80; a += 20) {
    const y = panDayY(a) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    // 80 is skipped: its label sits in the rounded corner and gets clipped,
    // and nothing here needs reading off to that precision
    if (a && a < 80) ctx.fillText(a + '\u00b0', 3, y - 3);
  }
  ctx.setLineDash([]);
}

// the compass, drawn last of all. these sit at the foot of the strip, where
// the silhouette is opaque, so drawn any earlier they are simply painted
// over. north is this projection's seam, so it is written at both ends, and
// every label is nudged inboard far enough to stay on the canvas.
function drawDayCompass(ctx, w, h) {
  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(207,219,239,0.75)';
  // a full turn across a phone is about 360 css px, which runs the eight
  // points into each other and into the rise and set times. narrow canvases
  // get the four cardinals only; the ticks they label are 90 degrees apart
  // either way, so nothing about the scale changes
  const step = w < 560 ? 90 : 45;
  const marks = PAN_COMPASS
    .map((label, i) => [label, i * 45])
    .filter(m => m[1] % step === 0)
    .map(m => [m[0], panXLin(m[1], w)])
    .concat([['N', w]]);
  for (const mark of marks) ctx.fillText(mark[0], Math.max(9, Math.min(w - 9, mark[1])), h - 5);
}

// a track is cut wherever it jumps the seam at due north, so a polyline never
// stretches back across the whole strip, and cut again wherever keep() turns
// false, which is how the clear-of-the-ridge parts are drawn separately from
// the blocked ones.
function panTrackRuns(pts, w, keep) {
  const runs = [];
  let cur = null;
  for (const p of pts) {
    if (!keep(p)) { if (cur && cur.length > 1) runs.push(cur); cur = null; continue; }
    if (cur && Math.abs(p.x - cur[cur.length - 1].x) > w / 2) {
      if (cur.length > 1) runs.push(cur);
      cur = null;
    }
    (cur || (cur = [])).push(p);
  }
  if (cur && cur.length > 1) runs.push(cur);
  return runs;
}

function panDayStroke(ctx, run) {
  ctx.beginPath();
  run.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.stroke();
}

// a small filled triangle at b, pointing the way the track is going. both
// bodies sweep left to right here, since azimuth only ever increases through
// a day; the arrows are there to say which way time runs along a line that
// otherwise has no beginning and no end.
function panDayArrow(ctx, a, b, fill) {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
  ctx.beginPath();
  ctx.moveTo(5.5, 0);
  ctx.lineTo(-4, 3.4);
  ctx.lineTo(-4, -3.4);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

// every time the body crosses what stands in the way, bisected to the minute
// the way the sentence under the viewer does it. all of them, not just the
// first: a track that dips into a notch and comes back out is exactly the
// thing this drawing exists to show.
function panDayCrossings(samples, key, block, opts) {
  const at = t => (key === 'sun' ? sunAltAz : moonAltAz)(
    skyContext({ date: t, lat: opts.lat, lon: opts.lon, elevM: opts.elevM }));
  const out = [];
  let prevUp = clearsRidge(block, samples[0][key]);
  for (let i = 1; i < samples.length; i++) {
    const up = clearsRidge(block, samples[i][key]);
    if (up !== prevUp) {
      const t = crossingTime(at, block, samples[i - 1].t, samples[i].t);
      const p = at(t);
      out.push({ at: t, alt: p.alt, az: p.az, rise: up });
    }
    prevUp = up;
  }
  return out;
}

const PAN_DAY_BODY = {
  sun: { rgb: '255,206,120', name: 'sun' },
  moon: { rgb: '214,222,247', name: 'moon' },
};

// a soft dark halo under pale text. the wash behind it runs from near-black
// in the north to a bright midday blue, and no single colour reads on both.
//
// a shadow rather than strokeText, which was the first try: a 3px stroke
// around 10px type closes up the counters and every label reads as a solid
// black box. the shadow leaves the letterforms alone.
function panDayLabel(ctx, text, x, y) {
  ctx.save();
  ctx.shadowColor = 'rgba(4,8,18,0.95)';
  ctx.shadowBlur = 4;
  ctx.fillText(text, x, y);
  // twice: one pass of a blurred shadow is too thin to carry pale text over
  // the midday blue
  ctx.fillText(text, x, y);
  ctx.restore();
}

// every label the strip wants to put down, placed one at a time in the order
// they get to claim space. each carries an ordered list of [dx, dy] offsets
// from its own marker; the first that lands clear of the canvas edges, clear
// of the compass row and clear of every label already down wins, and a label
// with nowhere to go is dropped.
//
// the offsets go sideways as well as up and down. vertical alone was not
// enough: a moonrise a few degrees from the sunrise, both low on the skyline,
// has the compass row under it and the sun's time over it, and its own time
// was being dropped for want of anywhere to sit. beside the marker is a
// perfectly good place to sit.
//
// this replaces three earlier rules that each fixed one collision and none of
// the rest: a fixed side per body, a flip when the side ran off the canvas,
// and dropping the moon's times outright under 560 px. order does that work
// now, and does it at every width: the crossings are what a reader came for,
// the names identify which track is which, and the hourly times are scale --
// the axis says the same thing, so they are the ones that can go.
function panDayPlaceLabels(ctx, labels, w, h) {
  const placed = [];
  ctx.textAlign = 'center';
  for (const L of labels) {
    ctx.font = L.font;
    const half = ctx.measureText(L.text).width / 2 + 3;
    let put = null;
    for (const off of L.tries) {
      const x = Math.min(Math.max(L.x + off[0], half + 2), w - half - 2);
      const y = L.y + off[1];
      const box = { left: x - half, right: x + half, top: y - 10, bottom: y + 4 };
      const clear = box.top > 2 && box.bottom < h - 13
        && !placed.some(q => box.left < q.right && box.right > q.left
          && box.top < q.bottom && box.bottom > q.top);
      if (clear) { put = { box: box, x: x, y: y }; break; }
    }
    if (!put) continue;
    placed.push(put.box);
    ctx.fillStyle = L.fill;
    panDayLabel(ctx, L.text, put.x, put.y);
  }
}

// draws one body's track, arrows and markers, and hands its labels back
// unplaced: where the text can go depends on what the other body already
// took, and neither body can know that on its own.
function drawDayBody(ctx, samples, key, block, w, h, opts) {
  const style = PAN_DAY_BODY[key];
  const tint = a => 'rgba(' + style.rgb + ',' + a + ')';
  const pts = samples.map(s => ({
    x: panXLin(s[key].az, w), y: panDayY(s[key].alt) * h,
    t: s.t, alt: s[key].alt, up: clearsRidge(block, s[key]),
  }));

  // where this spot cannot see it, dotted. still drawn: half the value of the
  // picture is seeing how much of the track the ridge takes away
  ctx.lineWidth = 1.2;
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = tint(0.38);
  panTrackRuns(pts, w, () => true).forEach(run => panDayStroke(ctx, run));
  // and where it can, solid
  ctx.setLineDash([]);
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = tint(0.95);
  panTrackRuns(pts, w, p => p.up).forEach(run => panDayStroke(ctx, run));

  // one arrow every six hours, offset half an hour so it never lands on an
  // hour tick, and skipped where it would straddle the seam
  const perHour = 60 / PAN_DAY_STEP_MIN;
  for (let i = Math.round(6.5 * perHour); i < pts.length - 1; i += 6 * perHour) {
    if (Math.abs(pts[i + 1].x - pts[i].x) > w / 2) continue;
    panDayArrow(ctx, pts[i], pts[i + 1], tint(0.95));
  }

  const hours = [];
  for (let i = 0; i < pts.length; i += perHour) {
    const p = pts[i];
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2);
    ctx.fillStyle = tint(0.75);
    ctx.fill();
    // only the sun's hours are labelled, and only every third: the moon's
    // exact hours are not something anyone plans around, and both tracks
    // labelled at once is twice the text for the same scale
    if (key !== 'sun' || i % (3 * perHour) || !i || i >= pts.length - 1) continue;
    hours.push({
      text: panTime(p.t).replace(':00', ''), x: p.x, y: p.y, fill: tint(0.75),
      font: '10px "IBM Plex Sans", system-ui, sans-serif',
      tries: [[0, -8], [0, 13], [0, -20], [0, 25], [-26, -3], [26, -3]],
    });
  }

  // midnight at both ends of the track, and labelled, because the two of them
  // together are the answer to "why does the moon have a gap". a lunar day
  // runs about 50 minutes longer than a solar one, so in 24 hours the moon
  // sweeps about 348 degrees of azimuth rather than a full circle, and the
  // 12 degrees it never reached that day is a real wedge of missing track.
  // unlabelled it reads as a drawing bug; with both ends called 12am it reads
  // as what it is. the sun's own two midnights are far below the horizon and
  // off the bottom of the strip, so they never draw.
  const midnights = [];
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = tint(0.9);
  for (const p of [pts[0], pts[pts.length - 1]]) {
    if (p.y < 2 || p.y > h - 2) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    ctx.stroke();
    midnights.push({
      text: '12am', x: p.x, y: p.y, fill: tint(0.7),
      font: '10px "IBM Plex Sans", system-ui, sans-serif',
      tries: [[0, -9], [0, 14], [-26, 3], [26, 3], [0, -21]],
    });
  }

  // every crossing gets a dot; the first rise and the last set get a time,
  // because those are the two a reader came for and a track through a notchy
  // ridge can have a dozen
  const events = panDayCrossings(samples, key, block, opts);
  const named = [events.find(e => e.rise), events.slice().reverse().find(e => !e.rise)]
    .filter(Boolean);
  const crossings = [];
  for (const e of events) {
    const hit = named.indexOf(e) >= 0;
    const x = panXLin(e.az, w), y = panDayY(e.alt) * h;
    ctx.beginPath();
    ctx.arc(x, y, hit ? 4 : 2.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(' + style.rgb + ')';
    ctx.fill();
    if (!hit) continue;
    ctx.strokeStyle = 'rgba(8,13,28,0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    crossings.push({
      text: panTime(e.at), x: x, y: y, fill: tint(0.95),
      font: '10px "IBM Plex Sans", system-ui, sans-serif',
      tries: [[0, 16], [0, -10], [0, 29], [0, -23], [-32, 3], [32, 3], [-32, -13], [32, -13]],
    });
  }

  // the name goes at the top of the track, which is where there is room
  const top = pts.reduce((a, b) => (b.alt > a.alt ? b : a));
  const name = {
    text: style.name, x: top.x, y: top.y, fill: tint(0.95),
    font: '11px "IBM Plex Sans", system-ui, sans-serif',
    tries: [[0, -20], [0, 18], [0, -32], [0, 30], [-34, -4], [34, -4]],
  };
  return { crossings: crossings, name: name, midnights: midnights, hours: hours };
}

function drawDayView(ctx, w, h, opts) {
  const samples = panDaySamples(opts.day, opts);
  const horizon = opts.horizon || new Float64Array(360);
  const canopy = opts.canopy || null;
  drawDayWash(ctx, samples, w, h);
  drawDayGrid(ctx, w, h);
  drawDaySilhouette(ctx, panBlocking(horizon, canopy), w, h);
  const block = panBlock(horizon, canopy);
  // the moon first, so the sun's track wins wherever the two cross
  const moon = drawDayBody(ctx, samples, 'moon', block, w, h, opts);
  const sun = drawDayBody(ctx, samples, 'sun', block, w, h, opts);
  // then all the text at once, in the order it gets to claim space
  panDayPlaceLabels(ctx, [].concat(
    sun.crossings, moon.crossings, [sun.name, moon.name],
    moon.midnights, sun.midnights, sun.hours), w, h);
  drawDayCompass(ctx, w, h);
}

// the line under the strip. the sentence under the viewer is about the moon
// and the core over one night; this one is about the sun over one day, which
// is the question the drawing was added to answer.
function daySummary(opts) {
  if (!opts.horizon || typeof Sky === 'undefined') return '';
  const samples = panDaySamples(opts.day, opts);
  const block = panBlock(opts.horizon, opts.canopy || null);
  const ev = panDayCrossings(samples, 'sun', block, opts);
  const rise = ev.find(e => e.rise), set = [...ev].reverse().find(e => !e.rise);
  const high = samples.reduce((a, b) => (b.sun.alt > a.sun.alt ? b : a)).sun;
  const parts = [];
  if (rise) parts.push('sun clears the skyline ' + panTime(rise.at) + ' in the ' + panDir(rise.az));
  else parts.push('the sun never clears this skyline today');
  if (set) parts.push('drops behind it ' + panTime(set.at) + ' in the ' + panDir(set.az));
  parts.push('highest ' + Math.round(high.alt) + '\u00b0 in the ' + panDir(high.az));
  return parts.join(', ');
}

// ---------- the sentence under the canvas ----------

// 9:04pm, the way the rest of the page talks. every spot is in North
// Carolina, so this is always Carolina time, not whatever the reader's
// device happens to be set to.
function panTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).toLowerCase().replace(/\s/g, '');
}

const PAN_DIR = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const panDir = az => PAN_DIR[Math.round((((az % 360) + 360) % 360) / 45) % 8];

// the sixteen-point compass, for the dialog's own "looking south-southwest"
// readout: the eight above read fine in a sentence about the ridge, but a
// heading the reader dragged to by hand deserves the finer word.
const PAN_DIR16 = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast',
  'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest',
  'west', 'west-northwest', 'northwest', 'north-northwest'];
const panDir16 = az => PAN_DIR16[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];

// ---------- eastern civil date, DST-safe and independent of the reader's own clock ----------
// every spot is in north carolina; "which evening" is always an eastern
// question, so the reader's device timezone cannot be part of the answer --
// a browser set to Tokyo has to land on the same night a browser set to
// Eastern does, for the same instant, and the same calendar date picked in
// either one has to open the same evening's dark hours.

// the eastern wall-clock date and time an instant reads as
function easternParts(instant) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const v = t => Number(p.find(x => x.type === t).value);
  return { y: v('year'), mo: v('month'), d: v('day'), h: v('hour'), mi: v('minute') };
}

// the calendar day before y-mo-d, as plain numbers rather than an instant:
// a Date built and read back with its own local getters never crosses a
// timezone boundary, so this is safe on any device regardless of DST.
function prevCivilDay(y, mo, d) {
  const t = new Date(y, mo - 1, d - 1);
  return { y: t.getFullYear(), mo: t.getMonth() + 1, d: t.getDate() };
}

// the UTC instant whose eastern civil clock reads hour:00 on y-mo-d, found
// by trying eastern's two possible whole-hour offsets from UTC and checking
// which one actually reads back that way, rather than assuming which one
// applies. arithmetic that assumed a fixed offset would land an hour off on
// the two days a year the offset changes; this does not, because it never
// assumes -- it asks the timezone database, through Intl, and checks.
function easternInstant(y, mo, d, hour, minute = 0) {
  for (const offset of [5, 4]) {   // standard time (UTC-5), then daylight (UTC-4)
    const guess = new Date(Date.UTC(y, mo - 1, d, hour + offset, minute, 0));
    const p = easternParts(guess);
    if (p.y === y && p.mo === mo && p.d === d && p.h === hour && p.mi === minute) return guess;
  }
  // every real date matches one of the two tries above; this is only reached
  // by a y-mo-d that does not exist, and standard time is as good a guess as any
  return new Date(Date.UTC(y, mo - 1, d, hour + 5, minute, 0));
}

// dusk to dawn, civil twilight either side. stepped rather than solved: this
// runs once per card, not per frame.
// ponytail: no crossing found means the sun never left civil twilight, which
// does not happen in the carolinas. the fallback keeps the card from going
// blank if the function is ever pointed somewhere arctic.
function nightWindow(opts) {
  // 1am (eastern) belongs to the evening before it, which is the night the
  // card is showing, so anchor on that day's eastern noon rather than on the
  // instant's own eastern calendar date
  const ep = easternParts(opts.date);
  const day = ep.h < 12 ? prevCivilDay(ep.y, ep.mo, ep.d) : ep;
  const noon = easternInstant(day.y, day.mo, day.d, 12);
  const alt = function (t) {
    const jd = Sky.julianDay(t);
    const s = Sky.sunPosition(jd);
    return Sky.equatorialToHorizontal(s.ra, s.dec, Sky.lmst(jd, opts.lon), opts.lat).alt;
  };
  let dusk = null, dawn = null, prev = alt(noon) > -6;
  for (let m = 10; m <= 24 * 60; m += 10) {
    const t = new Date(noon.getTime() + m * 60000);
    const up = alt(t) > -6;
    if (prev && !up && !dusk) dusk = t;
    else if (!prev && up && dusk && !dawn) dawn = t;
    prev = up;
  }
  if (!dusk) dusk = new Date(noon.getTime() + 8 * 3600000);
  if (!dawn) dawn = new Date(dusk.getTime() + 9 * 3600000);
  return { dusk: dusk, dawn: dawn };
}

// the whole point of the feature: clear of what stands at this azimuth, not
// clear of zero. a window lets a body through between its floor and the
// crowns above it. block is either a plain profile (a Float64Array, no
// window there) or { floor, hi, top } from panBlock.
function clearsRidge(block, p) {
  if (!block.top) return p.alt > horizonAt(block, p.az);
  return p.alt > horizonAt(block.top, p.az)
    || (p.alt > horizonAt(block.floor, p.az) && p.alt < horizonAt(block.hi, p.az));
}

// bisect the ten-minute bracket down to about a minute, so the sentence can
// say 11:24pm instead of 11:20pm
function crossingTime(at, horizon, t0, t1) {
  const up0 = clearsRidge(horizon, at(t0));
  let a = t0.getTime(), b = t1.getTime();
  for (let i = 0; i < 7; i++) {
    const mid = (a + b) / 2;
    if (clearsRidge(horizon, at(new Date(mid))) === up0) a = mid; else b = mid;
  }
  return new Date(Math.round((a + b) / 2 / 60000) * 60000);
}

// walk the night for one body and say honestly what it did.
// ponytail: the first rise and the first set only. a body that drops into a
// notch and comes back out gets one line rather than four, which is the right
// trade for a caption.
function trackBody(opts, at, profile) {
  const prof = profile || opts.horizon;
  const night = nightWindow(opts);
  const out = { rise: null, set: null, upAtDusk: false, everUp: false, stillUp: false };
  let prevT = night.dusk;
  let prevP = at(prevT);
  let prevUp = clearsRidge(prof, prevP);
  out.upAtDusk = prevUp;
  out.everUp = prevUp;
  out.duskAz = prevP.az;
  out.duskAlt = prevP.alt;
  for (let t = night.dusk.getTime() + 600000; t <= night.dawn.getTime(); t += 600000) {
    const now = new Date(t);
    const p = at(now);
    const up = clearsRidge(prof, p);
    if (up && !prevUp && !out.rise) {
      // the ten-minute sample can sit a couple of degrees past the crossing,
      // and panLayerAt's window check is a half-degree band, so the sample's
      // own altitude is not close enough: read the body again at the
      // bisected crossing time.
      const x = crossingTime(at, prof, prevT, now);
      out.rise = { at: x, az: p.az, alt: at(x).alt };
      out.everUp = true;
    } else if (!up && prevUp && !out.set && out.everUp) {
      const x = crossingTime(at, prof, prevT, now);
      out.set = { at: x, az: prevP.az, alt: at(x).alt };
    }
    prevT = now; prevP = p; prevUp = up;
  }
  out.stillUp = prevUp;
  return out;
}

const PAN_SAME_MS = 5 * 60000;

// "the southwest ridge", "the southwest trees", "the southwest structure".
// withRidge says whether a plain ridge gets its noun at all: today's "back
// behind the southwest 10:21pm" has none, and keeps none.
function panLayerPhrase(dir, layer, withRidge) {
  if (layer === 'ridge') return dir + (withRidge ? ' ridge' : '');
  return dir + ' ' + (layer === 'trees' ? 'trees' : 'structure');
}

// which layer a body crossed, and what the ridge alone would have said if
// that differs by more than five minutes: an empty note otherwise, so the
// no-canopy sentence stays exactly what it was. r is the ridge-only track,
// null when there is no canopy to disagree with.
function panCrossing(ridge, canopy, ev, r, kind) {
  const layer = panLayerAt(ridge, canopy, ev.az, ev.alt);
  if (!r || layer === 'ridge') return { layer, note: '' };
  let own;   // the ridge's own version of this event
  if (kind === 'set') own = r.set ? { at: r.set.at } : { text: 'clear of the ridge until first light' };
  else own = r.upAtDusk ? { text: 'above the ridge at dusk' } : r.rise ? { at: r.rise.at } : null;
  if (!own) return { layer, note: '' };
  if (own.at && Math.abs(own.at - ev.at) <= PAN_SAME_MS) return { layer, note: '' };
  return { layer, note: ' (' + (own.at ? 'the ridge ' + panTime(own.at) : own.text) + ')' };
}

// the body stayed behind everything all night. if the ridge alone would
// have let it through, say when, so the reader knows the trees are the
// whole story here.
function panNever(body, r, ridge, canopy) {
  const plain = body === 'moon' ? 'moon stays behind the ridge all night' : 'core never clears the ridge tonight';
  if (!r || !r.everUp) return plain;
  const from = r.upAtDusk ? 'dusk' : panTime(r.rise.at);
  const to = r.set ? panTime(r.set.at) : 'first light';
  const layer = panLayerAt(ridge, canopy, r.upAtDusk ? r.duskAz : r.rise.az, r.upAtDusk ? r.duskAlt : r.rise.alt);
  return body + ' never clears the ' + (layer === 'structure' ? 'structure' : 'trees')
    + ' tonight (above the ridge ' + from + ' to ' + to + ')';
}

function panMoonParts(a, r, ridge, canopy) {
  const parts = [];
  if (a.upAtDusk) {
    parts.push('moon already up in the ' + panDir(a.duskAz) + ' at dusk');
    if (a.set) {
      const c = panCrossing(ridge, canopy, a.set, r, 'set');
      parts.push('sets behind the ' + panLayerPhrase(panDir(a.set.az), c.layer, true) + ' ' + panTime(a.set.at) + c.note);
    } else parts.push('still up at first light');
  } else if (a.rise) {
    const c = panCrossing(ridge, canopy, a.rise, r, 'rise');
    parts.push('moon clears the ' + panLayerPhrase(panDir(a.rise.az), c.layer, true) + ' ' + panTime(a.rise.at) + c.note);
    if (a.set) {
      const d = panCrossing(ridge, canopy, a.set, r, 'set');
      parts.push('back behind the ' + panLayerPhrase(panDir(a.set.az), d.layer, false) + ' ' + panTime(a.set.at) + d.note);
    } else parts.push('still up at first light');
  } else parts.push(panNever('moon', r, ridge, canopy));
  return parts;
}

function panCoreParts(a, r, ridge, canopy) {
  const parts = [];
  const drop = () => {
    const c = panCrossing(ridge, canopy, a.set, r, 'set');
    return 'drops behind the ' + panLayerPhrase(panDir(a.set.az), c.layer, false) + ' ' + panTime(a.set.at) + c.note;
  };
  if (a.upAtDusk) {
    parts.push('core already clear of the ' + panLayerPhrase(panDir(a.duskAz), panLayerAt(ridge, canopy, a.duskAz, a.duskAlt), true) + ' at dusk');
    if (a.set) parts.push(drop());
  } else if (a.rise) {
    const c = panCrossing(ridge, canopy, a.rise, r, 'rise');
    parts.push('core clears the ' + panLayerPhrase(panDir(a.rise.az), c.layer, true) + ' ' + panTime(a.rise.at) + c.note);
    if (a.set) parts.push(drop());
  } else parts.push(panNever('core', r, ridge, canopy));
  return parts;
}

// both bodies against everything in the way, and against the ridge alone
// where a canopy could make the two disagree
function horizonSummary(opts) {
  if (!opts.horizon || typeof Sky === 'undefined') return '';
  const ridge = opts.horizon;
  const canopy = opts.canopy || null;
  const all = panBlock(ridge, canopy);
  const ctxAt = t => skyContext({ date: t, lat: opts.lat, lon: opts.lon, elevM: opts.elevM });
  const moonAt = t => moonAltAz(ctxAt(t));
  const coreAt = t => { const p = galAltAz(0, 0, ctxAt(t)); return { alt: Sky.refract(p.alt), az: p.az }; };
  const both = at => [trackBody(opts, at, all), all === ridge ? null : trackBody(opts, at, ridge)];
  const [ma, mr] = both(moonAt);
  const [ca, cr] = both(coreAt);
  return panMoonParts(ma, mr, ridge, canopy).concat(panCoreParts(ca, cr, ridge, canopy)).join(', ');
}
