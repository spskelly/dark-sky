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
     CANOPY             from the generated canopy block: decoded here, drawn
                        as layers under the ridge, never combined in the page

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

// ridge altitude at any azimuth, linear between the two whole degrees either side
function horizonAt(horizon, azDeg) {
  const a = ((azDeg % 360) + 360) % 360;
  const i = Math.floor(a);
  const f = a - i;
  return horizon[i] * (1 - f) + horizon[(i + 1) % 360] * f;
}

// the canopy block's entry for a place, decoded: { t, s } with a Float64Array
// per layer that is there and null for one that is not, or null for no
// entry at all. the two stay separate from the ridge: what is drawn and what
// is named both need to know which layer a degree belongs to.
function decodeCanopy(e) {
  if (!e) return null;
  return { t: e.t ? decodeHorizon(e.t) : null, s: e.s ? decodeHorizon(e.s) : null };
}

// per-azimuth maximum of two profiles; a null second returns the first as is
function panMaxProfile(a, b) {
  if (!b) return a;
  const out = new Float64Array(360);
  for (let i = 0; i < 360; i++) out[i] = Math.max(a[i], b[i]);
  return out;
}

// the profile a body actually has to clear: the highest of ridge, trees and
// structures. with nothing above the ridge it is the ridge itself, the same
// object, which is what keeps the no-canopy sentence exactly what it was.
function panBlocking(horizon, canopy) {
  if (!canopy || (!canopy.t && !canopy.s)) return horizon;
  return panMaxProfile(panMaxProfile(horizon, canopy.t), canopy.s);
}

// which layer sits highest at an azimuth. ties go to the ridge, so a tree
// line flush with the crest is still "the ridge".
function panLayerAt(horizon, canopy, az) {
  let word = 'ridge', best = horizonAt(horizon, az);
  if (canopy && canopy.t && horizonAt(canopy.t, az) > best) { word = 'trees'; best = horizonAt(canopy.t, az); }
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
const PAN_BOT = -3;
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

// ---------- stereographic projection, for the dialog viewer ----------
// the open view above is a flat cylinder: fast, and right for a strip meant
// to compare spots, but it tears apart anything wider than about 60 degrees.
// the dialog looks around freely, so it needs a projection that keeps angles
// honest wherever the reader turns: stereographic, centred on the view
// direction, conformal (a circle on the sky is still a circle on screen),
// and the one real all-sky cameras use for the same reason.

// alt/az to a unit vector, east-north-up
function panWorldVec(altDeg, azDeg) {
  const alt = altDeg * PAN_D2R, az = azDeg * PAN_D2R;
  return { x: Math.cos(alt) * Math.sin(az), y: Math.cos(alt) * Math.cos(az), z: Math.sin(alt) };
}

// rotates a world vector into the view frame: first the heading (a rotation
// about the up axis, which only ever shifts azimuth), then the altitude (a
// rotation about the resulting east axis) so the view centre lands on the
// frame's own z axis. z2 is then the cosine of the angular distance from the
// view centre for every point, x2/y2 its right/up components. the altitude
// step's angle is 90 - alt0, which passes through zero rather than blowing up
// as alt0 reaches 90 -- looking straight up needs no special case here.
function panViewFrame(v, az0, alt0) {
  const a0 = az0 * PAN_D2R;
  const x1 = v.x * Math.cos(a0) - v.y * Math.sin(a0);
  const y1 = v.x * Math.sin(a0) + v.y * Math.cos(a0);
  const phi = (90 - alt0) * PAN_D2R;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  return { x2: x1, y2: y1 * cp - v.z * sp, z2: y1 * sp + v.z * cp };
}

// pixels per unit of the stereographic radius, 2*tan(half the angular
// distance from the view centre). that radius depends only on the angular
// distance, never on which direction it is measured in -- x2/y2 above sit on
// a circle of radius sin(c) at every c, whichever way x2 and y2 split it --
// so calibrating against fov/2 of pure altitude gives the same scale as
// calibrating fov/2 of pure azimuth would, without the azimuth version's
// failure mode: an azimuth offset from a view centre near the zenith is
// still almost the zenith itself, and the reference point collapses toward
// the pole instead of landing fov/2 away from it.
function panViewScale(fov, w) {
  const half = (fov / 2) * PAN_D2R;
  return (w / 2) / (2 * Math.tan(half / 2));
}

// beyond this, 1+z2 is still comfortably away from zero (that only happens
// 180 degrees out, directly behind the viewer) but the point is not worth
// drawing, and the caller can skip the segment instead of stretching it
const PAN_CULL_COS = Math.cos(100 * PAN_D2R);

// the pure function every draw routine in the dialog goes through: alt/az to
// canvas pixel, or null when the point is more than 100 degrees from the view
// centre. view is { az0, alt0, fov, w, h }.
// ponytail: recomputes the view scale on every call rather than caching it on
// the view object. a full redraw is a few thousand calls, comfortably under a
// millisecond of trig; cache it if a profiler ever says otherwise.
function panProject(alt, az, view) {
  const v = panWorldVec(alt, az);
  const p = panViewFrame(v, view.az0, view.alt0);
  if (p.z2 < PAN_CULL_COS) return null;
  const scale = panViewScale(view.fov, view.w);
  const factor = 2 / (1 + p.z2);
  // y2 falls as altitude rises (the frame's own "up" is toward the view
  // centre, not the canvas edge), and canvas y already runs the other way
  // from screen "up", so the two flips cancel: higher altitude wants a
  // smaller y, which is scale * y2 added, not subtracted.
  return { x: view.w / 2 + scale * p.x2 * factor, y: view.h / 2 + scale * p.y2 * factor };
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
  if (!ctx || (!opts.horizon && opts.mode !== 'view')) return false;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (opts.mode === 'view') { drawSkyView(ctx, w, h, opts); return true; }
  if (opts.mode === 'thumb') { drawRidge(ctx, opts.horizon, w, h, opts.canopy); return true; }
  return false;
}

const PAN_COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

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
// drawing is three of these back to front.
function panRidgeStrip(ctx, prof, w, h, style) {
  const altAt = i => prof[((Math.round(i) % 360) + 360) % 360];
  ctx.beginPath();
  ctx.moveTo(panXLin(0, w), h);
  for (let i = 0; i <= 360; i++) ctx.lineTo(panXLin(i, w), panY(altAt(i), h));
  ctx.lineTo(panXLin(360, w), h);
  ctx.closePath();
  ctx.fillStyle = style.fill;
  ctx.fill();

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
  ctx.setLineDash([]);
}

// the layers, back to front. structures opaque slate with a dashed crest;
// trees a dark green at 70 per cent, so a moon or the core sliding behind the
// tree band stays visible while the reader scrubs the night; the ridge last
// and as it always was. each ring is the highest of itself and what is
// below it, so a tree line under the ridge never pokes through.
const PAN_LAYERS = {
  structures: { fill: '#343946', crest: 'rgba(196,200,210,0.75)', dash: [4, 3], rim: null },
  trees: { fill: 'rgba(8,28,16,0.7)', crest: 'rgba(118,168,118,0.6)', dash: [], rim: 'rgba(130,190,130,0.10)' },
};

function drawRidge(ctx, horizon, w, h, canopy) {
  if (canopy && canopy.s) panRidgeStrip(ctx, panBlocking(horizon, canopy), w, h, PAN_LAYERS.structures);
  if (canopy && canopy.t) panRidgeStrip(ctx, panMaxProfile(horizon, canopy.t), w, h, PAN_LAYERS.trees);
  const g = ctx.createLinearGradient(0, panY(PAN_TOP * 0.3, h), 0, h);
  g.addColorStop(0, '#121c38');
  g.addColorStop(1, '#070c1a');
  panRidgeStrip(ctx, horizon, w, h, { fill: g, crest: 'rgba(122,140,186,0.75)', dash: [] });
}

// ---------- the dialog viewer (stereographic) ----------
// same drawing job as the flat open view above -- wash, milky way, stars,
// figures, moon, grid, ridge -- but every point goes through panProject
// instead of panX/panY. a null from panProject means "not in front of the
// viewer", so a line or a quad with a null end is just skipped: there is no
// wrap-copy loop to write here, because a stereographic view never has to
// repeat itself to cover the seam the way the cylinder does.

function drawSkyWashView(ctx, w, h, view) {
  // brightest at the true horizon below the view centre, same reasoning as
  // the flat wash: the very bottom of the canvas is behind the ridge
  const horizon = panProject(0, view.az0, view) || { y: h * 0.7 };
  const g = ctx.createLinearGradient(0, 0, 0, horizon.y);
  g.addColorStop(0, '#060b19');
  g.addColorStop(0.7, '#0e1834');
  g.addColorStop(1, '#17254a');
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
}

function drawStarsView(ctx, sky, view, w, h) {
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
    ctx.globalAlpha = Math.max(0.2, Math.min(1, 1.02 - 0.16 * mag));
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (mag < 1.0) {
      ctx.globalAlpha = 0.13;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r * 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  drawFiguresView(ctx, seen);
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
  ctx.fillStyle = '#101c3a';
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

// true level, drawn after the ridge and so over the ground: the gap between
// this line and the crest is how much sky the terrain takes, which is the
// number the whole drawing exists to show. the compass letters ride on it,
// because on an enclosed site the ridge used to bury them.
function drawLevelView(ctx, view) {
  const pts = [];
  for (let az = 0; az <= 360; az += 5) pts.push(panProject(0, az, view));
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(236,200,120,0.55)';
  ctx.lineWidth = 1;
  panStrokeRuns(ctx, pts, true);
  ctx.setLineDash([]);

  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(236,200,120,0.8)';
  const zero = panProject(0, view.az0 + 12, view);
  if (zero) ctx.fillText('0\u00b0 level', zero.x, zero.y + 12);

  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.14em';
  ctx.textAlign = 'center';
  for (let i = 0; i < 8; i++) {
    const p = panProject(0, i * 45, view);
    if (!p) continue;
    ctx.fillStyle = i === 0 ? 'rgba(236,231,212,0.9)' : 'rgba(200,196,175,0.8)';
    ctx.fillText(PAN_COMPASS[i], p.x, p.y - 6);
  }
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

// the same projection with nothing culled, for the one shape that has to go
// all the way round: the ridge ring. stereographic is finite everywhere but
// the point directly behind the viewer, so the depth is held just short of it.
function panProjectAll(alt, az, view) {
  const p = panViewFrame(panWorldVec(alt, az), view.az0, view.alt0);
  const factor = 2 / (1 + Math.max(p.z2, -0.996));
  const scale = panViewScale(view.fov, view.w);
  return { x: view.w / 2 + scale * p.x2 * factor, y: view.h / 2 + scale * p.y2 * factor };
}

// the ridge: 360 samples of the horizon (or a flat line at 0 when none is
// modelled, which is what a picked point gets without terrain). the ground is
// everything on the far side of that ring from the zenith, however far down
// the canvas reaches: a portrait phone sees 60 degrees below the horizon, and
// a wall 30 degrees deep let the sky come back underneath it. in this
// projection the point behind the viewer is at infinity, so whichever side of
// the ring holds it is the unbounded side.
// ponytail: ring sampled per degree with straight chords. if the ridge passes
// within a degree of the point directly behind the viewer a chord can cut the
// canvas; only reachable looking at or below the horizon. sample finer there
// if it ever shows.
function panRingView(ctx, prof, view, w, h, style) {
  const altAt = az => horizonAt(prof, az);
  const top = [];
  for (let az = 0; az < 360; az++) top.push(panProject(altAt(az), az, view));
  ctx.beginPath();
  for (let az = 0; az < 360; az++) {
    const p = panProjectAll(altAt(az), az, view);
    if (az === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  const behindIsGround = -view.alt0 < altAt(view.az0 + 180);
  if (behindIsGround) ctx.rect(-1, -1, w + 2, h + 2);
  ctx.fillStyle = style.fill;
  ctx.fill('evenodd');

  for (const run of panRuns(top, true)) {
    if (run.length < 2) continue;
    // the rim of sky light along the crest, same as the flat ridge
    ctx.beginPath();
    ctx.moveTo(top[run[0]].x, top[run[0]].y);
    for (let k = 1; k < run.length; k++) ctx.lineTo(top[run[k]].x, top[run[k]].y);
    if (style.rim) {
      ctx.save();
      ctx.strokeStyle = style.rim;
      ctx.lineWidth = 11;
      ctx.stroke();
      ctx.restore();
    }
    ctx.setLineDash(style.dash);
    ctx.strokeStyle = style.crest;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawRidgeView(ctx, horizon, view, w, h, canopy) {
  const terrain = horizon || new Float64Array(360);   // a picked point: flat at 0
  if (canopy && canopy.s) panRingView(ctx, panBlocking(terrain, canopy), view, w, h, PAN_LAYERS.structures);
  if (canopy && canopy.t) panRingView(ctx, panMaxProfile(terrain, canopy.t), view, w, h, PAN_LAYERS.trees);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0b1226');
  g.addColorStop(1, '#03060f');
  panRingView(ctx, terrain, view, w, h, { fill: g, crest: 'rgba(132,152,204,0.5)', dash: [], rim: 'rgba(140,164,220,0.10)' });
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
  const view = { az0: opts.az0, alt0: opts.alt0, fov: opts.fov, w: w, h: h };
  const sky = skyContext(opts);
  drawSkyWashView(ctx, w, h, view);
  drawMilkyWayView(ctx, sky, view, w, h);
  drawStarsView(ctx, sky, view, w, h);
  drawMoonView(ctx, sky, view);
  drawGridView(ctx, view, w, h);
  drawRidgeView(ctx, opts.horizon, view, w, h, opts.canopy);
  drawLevelView(ctx, view);
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

// the whole point of the feature: clear of the ridge at this azimuth, not
// clear of zero.
function clearsRidge(horizon, p) {
  return p.alt > horizonAt(horizon, p.az);
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
function trackBody(opts, at) {
  const night = nightWindow(opts);
  const out = { rise: null, set: null, upAtDusk: false, everUp: false, stillUp: false };
  let prevT = night.dusk;
  let prevP = at(prevT);
  let prevUp = clearsRidge(opts.horizon, prevP);
  out.upAtDusk = prevUp;
  out.everUp = prevUp;
  out.duskAz = prevP.az;
  for (let t = night.dusk.getTime() + 600000; t <= night.dawn.getTime(); t += 600000) {
    const now = new Date(t);
    const p = at(now);
    const up = clearsRidge(opts.horizon, p);
    if (up && !prevUp && !out.rise) {
      out.rise = { at: crossingTime(at, opts.horizon, prevT, now), az: p.az };
      out.everUp = true;
    } else if (!up && prevUp && !out.set && out.everUp) {
      out.set = { at: crossingTime(at, opts.horizon, prevT, now), az: prevP.az };
    }
    prevT = now; prevP = p; prevUp = up;
  }
  out.stillUp = prevUp;
  return out;
}

function horizonSummary(opts) {
  if (!opts.horizon || typeof Sky === 'undefined') return '';
  const parts = [];

  const moon = trackBody(opts, function (t) {
    return moonAltAz(skyContext({ date: t, lat: opts.lat, lon: opts.lon, elevM: opts.elevM }));
  });
  if (moon.upAtDusk) {
    parts.push('moon already up in the ' + panDir(moon.duskAz) + ' at dusk');
    parts.push(moon.set ? 'sets behind the ' + panDir(moon.set.az) + ' ridge ' + panTime(moon.set.at)
      : 'still up at first light');
  } else if (moon.rise) {
    parts.push('moon clears the ' + panDir(moon.rise.az) + ' ridge ' + panTime(moon.rise.at));
    parts.push(moon.set ? 'back behind the ' + panDir(moon.set.az) + ' ' + panTime(moon.set.at)
      : 'still up at first light');
  } else {
    parts.push('moon stays behind the ridge all night');
  }

  const core = trackBody(opts, function (t) {
    const sky = skyContext({ date: t, lat: opts.lat, lon: opts.lon, elevM: opts.elevM });
    const p = galAltAz(0, 0, sky);
    return { alt: Sky.refract(p.alt), az: p.az };
  });
  if (core.upAtDusk) {
    parts.push('core already clear of the ' + panDir(core.duskAz) + ' ridge at dusk');
    if (core.set) parts.push('drops behind the ' + panDir(core.set.az) + ' ' + panTime(core.set.at));
  } else if (core.rise) {
    parts.push('core clears the ' + panDir(core.rise.az) + ' ridge ' + panTime(core.rise.at));
    if (core.set) parts.push('drops behind the ' + panDir(core.set.az) + ' ' + panTime(core.set.at));
  } else {
    parts.push('core never clears the ridge tonight');
  }

  return parts.join(', ');
}
