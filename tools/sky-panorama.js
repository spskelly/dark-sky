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

   public: decodeHorizon(s), drawPanorama(canvas, opts), horizonSummary(opts),
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

// ---------- projection ----------
// cylindrical: azimuth linear, altitude linear. the open view is a window onto
// the cylinder, PAN_FOV degrees of azimuth centred on a heading the reader can
// turn, altitude -5 to +40 so a degree of azimuth and a degree of altitude cost
// about the same pixels on screen. the thumbnail keeps the full turn and its
// own fixed altitude window, -3 to +24: on that scale a sixty pixel strip gives
// a typical ridge nine pixels and it reads as a smudge. every thumbnail shares
// the one window, so two spots side by side still compare honestly.
// ponytail: module-level rather than threaded through every draw call. one
// canvas is drawn at a time and nothing here is reentrant.
const PAN_FOV = 120;   // degrees of azimuth across the open view. the full turn
                       // read as a smear once it had to share the canvas with
                       // stars and labels; 120 keeps a degree of azimuth close
                       // to a degree of altitude (the window below is 45 tall)
                       // so turning to face something feels like turning.
let PAN_TOP = 40;
let PAN_BOT = -5;
let PAN_AZ0 = 180;     // heading at the centre of the view being drawn. thumb
                       // mode (a full turn) leaves this at 180, which is where
                       // the old fixed mapping put the left edge; nothing in a
                       // full turn depends on where that edge falls.
let PAN_FOV_DEG = 360; // the current draw's azimuth window: 360 for a thumb's
                       // full turn, PAN_FOV for the open view.

// azimuth to x, no wrapping: az is trusted to already be in the frame the
// caller wants, either a raw sweep index or an azimuth already folded near
// PAN_AZ0 by wrapNear below. pure, so it is what tools/test-panorama.mjs
// exercises directly.
function azToX(az, az0, fovDeg, w) {
  return (az - az0 + fovDeg / 2) / fovDeg * w;
}
// the copy of az, mod 360, nearest centre: a point off to the side of the
// window lands a bounded, predictable distance off-canvas instead of wherever
// its raw degree value happens to fall. not safe on a value a sweep or a
// chain has already unwrapped relative to a neighbour -- that value is
// deliberately allowed outside +/-180 of centre, which is the whole point of
// unwrapping it, and folding it back here would undo that.
function wrapNear(az, center) {
  const d = ((az - center) % 360 + 540) % 360 - 180;
  return center + d;
}
// the point mapping: az resolved to its nearest copy of centre, then placed.
// at the thumb defaults (centre 180, a 360 degree window) wrapNear is the
// identity for any az already in [0, 360), so this is byte-for-byte the old
// unwrapped formula for every input the old code ever saw.
const panX = (az, w) => azToX(wrapNear(az, PAN_AZ0), PAN_AZ0, PAN_FOV_DEG, w);
// the raw mapping, for a sweep or a chain that has already placed az in the
// frame it wants (the ridge's two ends have to land on 0 and w, not the same
// point, which wrapNear would do to them).
const panXLin = (az, w) => azToX(az, PAN_AZ0, PAN_FOV_DEG, w);
// pixels per full physical turn: the wrap-repeat copies below try a point one
// turn either side of its raw position, in case that is the copy nearest the
// window. one turn is the whole canvas in thumb mode, three canvas widths in
// the open window, which is also why the open window never needs more than
// the one nearby copy: the other two land two turns away, off-canvas by a lot.
const panTurnPx = w => 360 / PAN_FOV_DEG * w;
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
  // the older modes, which have nothing to fall back to, require one
  if (!ctx || (!opts.horizon && opts.mode !== 'view')) return false;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const thumb = opts.mode === 'thumb';
  PAN_TOP = thumb ? 24 : 40;
  PAN_BOT = thumb ? -3 : -5;
  PAN_FOV_DEG = thumb ? 360 : PAN_FOV;
  // a heading off the end of a turn, or not a number at all (nothing stored
  // yet, or a garbage value), falls back to the same south the page opens on
  PAN_AZ0 = thumb ? 180 : (isFinite(opts.az0) ? ((opts.az0 % 360) + 360) % 360 : 180);
  if (thumb) {
    drawRidge(ctx, opts.horizon, w, h, true);
    return true;
  }
  if (opts.mode === 'view') {
    drawSkyView(ctx, w, h, opts);
    return true;
  }

  const sky = skyContext(opts);
  drawSkyWash(ctx, w, h);
  drawMilkyWay(ctx, sky, w, h);
  drawStars(ctx, sky, w, h);
  drawMoon(ctx, sky, w, h);
  drawGrid(ctx, w, h);
  drawRidge(ctx, opts.horizon, w, h, false);
  drawLabels(ctx, w, h);
  return true;
}

function drawSkyWash(ctx, w, h) {
  // brightest at the true horizon rather than at the bottom edge, because the
  // bottom edge is behind the ridge and never seen
  const g = ctx.createLinearGradient(0, 0, 0, panY(0, h));
  g.addColorStop(0, '#060b19');
  g.addColorStop(0.7, '#0e1834');
  g.addColorStop(1, '#17254a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// The band is |galactic latitude| < b, so its outline is two lines of constant
// b converted to alt/az. Drawn as one path of quads: a quad per 2 degrees of
// galactic longitude, each quad also repeated a full turn left and right, so
// the piece that straddles azimuth 0 comes back round instead of being
// stretched into a stripe across the whole canvas. One fill, so the overlaps
// inside the path cost nothing and the alpha stays even.
function milkyWayPath(ctx, sky, halfWidth, w, h) {
  ctx.beginPath();
  let prev = null;
  const turn = panTurnPx(w);
  for (let l = 0; l <= 360; l += 2) {
    // fat and bright toward sagittarius, thin toward the anticentre, which is
    // what the eye actually recognises as the milky way
    const b = halfWidth * (0.42 + 0.58 * (0.5 + 0.5 * Math.cos(l * PAN_D2R)));
    const cur = { top: galAltAz(l, b, sky), bot: galAltAz(l, -b, sky) };
    if (prev) {
      const ref = prev.top.az;
      const pts = [prev.top, prev.bot, cur.bot, cur.top].map(function (p) {
        let az = p.az;
        while (az - ref > 180) az -= 360;
        while (az - ref < -180) az += 360;
        return { x: panXLin(az, w), y: panY(p.alt, h) };
      });
      for (let k = -1; k <= 1; k++) {
        const dx = k * turn;
        ctx.moveTo(pts[0].x + dx, pts[0].y);
        ctx.lineTo(pts[1].x + dx, pts[1].y);
        ctx.lineTo(pts[2].x + dx, pts[2].y);
        ctx.lineTo(pts[3].x + dx, pts[3].y);
        ctx.closePath();
      }
    }
    prev = cur;
  }
}

function drawMilkyWay(ctx, sky, w, h) {
  // five nested widths, faintest and widest first, so the band fades out at its
  // edges instead of ending. the blur closes the steps between them; it costs a
  // few pixels of fade at the left and right edges, which at two per cent alpha
  // nobody sees, and the wrap check in the harness measures what it costs.
  const bands = [[22, 0.015], [17, 0.018], [12, 0.020], [7.5, 0.023], [3.5, 0.027]];
  const blurred = 'filter' in ctx;
  if (blurred) ctx.filter = 'blur(9px)';
  for (let i = 0; i < bands.length; i++) {
    milkyWayPath(ctx, sky, bands[i][0], w, h);
    ctx.fillStyle = 'rgba(198,208,238,' + bands[i][1] + ')';
    ctx.fill();
  }
  if (blurred) ctx.filter = 'none';

  const core = galAltAz(0, 0, sky);
  if (core.alt > PAN_BOT) {
    const x = panX(core.az, w);
    const y = panY(core.alt, h);
    const r = Math.max(34, w * 0.055);
    const turn = panTurnPx(w);
    for (let k = -1; k <= 1; k++) {
      const g = ctx.createRadialGradient(x + k * turn, y, 0, x + k * turn, y, r);
      g.addColorStop(0, 'rgba(236,231,212,0.14)');
      g.addColorStop(1, 'rgba(236,231,212,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x + k * turn - r, y - r, r * 2, r * 2);
    }
    if (core.alt > 2) {
      ctx.fillStyle = 'rgba(169,165,143,0.85)';
      ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('galactic core', x, y - r * 0.52);
    }
  }
}

// STARS is an array of arrays, [ra, dec, mag] with a name appended only for the
// ones worth labelling, so anything past index 2 is optional.
// the catalogue runs past a thousand stars including figure-only faint ones.
// narrow canvases get a magnitude cut rather than a shorter catalogue, because
// the constellation lines index into the full list.
const starMagLimit = w => (w < 520 ? 4.2 : 6);

function drawStars(ctx, sky, w, h) {
  const list = (typeof STARS !== 'undefined' && STARS) || [];
  const limit = starMagLimit(w);
  // where each star landed, so the figure lines can reuse it
  const seen = new Array(list.length);
  ctx.fillStyle = '#e9edf8';
  for (let i = 0; i < list.length; i++) {
    const p = panAltAz(list[i][0], list[i][1], sky);
    seen[i] = p;
    const mag = list[i][2];
    if (mag > limit || p.alt < PAN_BOT || p.alt > PAN_TOP) continue;
    const x = panX(p.az, w), y = panY(p.alt, h);
    const r = Math.max(0.4, 1.7 - 0.30 * mag);
    ctx.globalAlpha = Math.max(0.2, Math.min(1, 1.02 - 0.16 * mag));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // the handful of genuinely bright ones get a little bloom
    if (mag < 1.0) {
      ctx.globalAlpha = 0.13;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  drawFigures(ctx, seen, w, h);
}

// CONSTELLATION_LINES is runs of indices into STARS. one path, each segment
// also laid down a turn either side so a figure straddling north is not
// dragged across the whole canvas.
function drawFigures(ctx, seen, w, h) {
  if (typeof CONSTELLATION_LINES === 'undefined' || !CONSTELLATION_LINES) return;
  ctx.beginPath();
  const turn = panTurnPx(w);
  for (let r = 0; r < CONSTELLATION_LINES.length; r++) {
    const run = CONSTELLATION_LINES[r];
    for (let i = 1; i < run.length; i++) {
      const a = seen[run[i - 1]], b = seen[run[i]];
      if (!a || !b || a.alt < PAN_BOT || b.alt < PAN_BOT) continue;
      let az = b.az;
      while (az - a.az > 180) az -= 360;
      while (az - a.az < -180) az += 360;
      // ponytail: a straight line in this projection is wrong for a pair
      // sitting either side of the zenith. they are rare and the cheap fix is
      // to leave that segment out rather than to draw a great circle.
      if (Math.abs(az - a.az) > 60) continue;
      for (let k = -1; k <= 1; k++) {
        ctx.moveTo(panXLin(a.az, w) + k * turn, panY(a.alt, h));
        ctx.lineTo(panXLin(az, w) + k * turn, panY(b.alt, h));
      }
    }
  }
  ctx.strokeStyle = 'rgba(152,172,224,0.17)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawMoon(ctx, sky, w, h) {
  const m = moonAltAz(sky);
  if (m.alt < PAN_BOT - 2) return;
  const x = panX(m.az, w);
  const y = panY(m.alt, h);
  // ponytail: fixed 9 px disc, roughly twenty times life size. at three pixels
  // to the degree a true half-degree moon is under two pixels and the phase is
  // invisible, which is the one thing the drawing is for. scale it properly if
  // a zoom ever lands.
  const r = 9;

  const g = ctx.createRadialGradient(x, y, r, x, y, r * 5);
  g.addColorStop(0, 'rgba(236,231,212,0.17)');
  g.addColorStop(1, 'rgba(236,231,212,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);

  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = '#101c3a';
  ctx.fill();
  ctx.strokeStyle = 'rgba(95,116,173,0.5)';
  ctx.lineWidth = 0.75;
  ctx.stroke();

  // the lit limb: outer half circle down the sunward side, terminator ellipse
  // back up. same geometry as the page's moonPath, in canvas arcs.
  const k = Math.max(0, Math.min(1, m.illum));
  if (k > 0.02) {
    // the unrotated path is lit on the +x side. bring +x up to the zenith,
    // then round toward east, which is leftward here because azimuth runs
    // left to right across the canvas.
    ctx.rotate(-(90 + (m.limbPA || 0)) * PAN_D2R);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r, 0, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, r * Math.abs(1 - 2 * k), r, 0, Math.PI / 2, -Math.PI / 2, k < 0.5);
    ctx.closePath();
    ctx.fillStyle = '#ece7d4';
    ctx.fill();
  }
  ctx.restore();
}

function drawGrid(ctx, w, h) {
  ctx.strokeStyle = 'rgba(95,116,173,0.20)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 5]);
  [10, 20, 30].forEach(function (a) {
    const y = Math.round(panY(a, h)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  });
  // the eight compass azimuths, so the horizontal scale is readable at all
  ctx.setLineDash([2, 7]);
  ctx.strokeStyle = 'rgba(95,116,173,0.13)';
  for (let a = 0; a < 360; a += 45) {
    const x = Math.round(panX(a, w)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// the ridge sweeps degree by degree, thumb mode always the full turn, the
// open view only the window plus one degree of pad either side so the crest
// stroke does not stop short of the edge. leftAz/rightAz can land off a whole
// degree when the reader has dragged the heading, which is why the sweep
// itself runs from the whole degrees either side while the two bottom
// corners of the fill close on the exact edges.
function drawRidge(ctx, horizon, w, h, thumb) {
  const leftAz = thumb ? 0 : PAN_AZ0 - PAN_FOV_DEG / 2;
  const rightAz = thumb ? 360 : PAN_AZ0 + PAN_FOV_DEG / 2;
  const from = Math.floor(leftAz), to = Math.ceil(rightAz);
  const altAt = i => horizon[((Math.round(i) % 360) + 360) % 360];

  ctx.beginPath();
  ctx.moveTo(panXLin(leftAz, w), h);
  for (let i = from; i <= to; i++) {
    ctx.lineTo(panXLin(i, w), panY(altAt(i), h));
  }
  ctx.lineTo(panXLin(rightAz, w), h);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, panY(PAN_TOP * 0.3, h), 0, h);
  g.addColorStop(0, thumb ? '#121c38' : '#0b1226');
  g.addColorStop(1, thumb ? '#070c1a' : '#03060f');
  ctx.fillStyle = g;
  ctx.fill();

  // a rim of sky light along the crest. without it the silhouette reads as a
  // hole punched in the canvas rather than as a ridge with sky behind it.
  ctx.beginPath();
  for (let i = from; i <= to; i++) {
    const x = panXLin(i, w);
    const y = panY(altAt(i), h);
    if (i === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  if (!thumb) {
    ctx.save();
    ctx.strokeStyle = 'rgba(140,164,220,0.10)';
    ctx.lineWidth = 11;
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = thumb ? 'rgba(122,140,186,0.75)' : 'rgba(132,152,204,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

const PAN_COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function drawLabels(ctx, w, h) {
  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.14em';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // this only ever draws the open window, never a full turn, so each compass
  // point has exactly one position; whichever of the 8 fall outside the
  // window land off-canvas and are simply not seen, same as a star would be.
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i === 0 ? 'rgba(236,231,212,0.8)' : 'rgba(169,165,143,0.7)';
    ctx.fillText(PAN_COMPASS[i], panX(i * 45, w), h - 6);
  }
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(139,150,179,0.7)';
  [10, 20, 30].forEach(function (a) {
    ctx.fillText(a + '°', 6, panY(a, h) - 4);
  });
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

  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.14em';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let i = 0; i < 8; i++) {
    const p = panProject(0, i * 45, view);
    if (!p) continue;
    ctx.fillStyle = i === 0 ? 'rgba(236,231,212,0.8)' : 'rgba(169,165,143,0.7)';
    ctx.fillText(PAN_COMPASS[i], p.x, p.y - 6);
  }
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

// the ridge, closed down to a wall well below anything ever drawn: 360
// samples of the horizon (or a flat line at 0 when none is modelled, which is
// what a picked point gets before terrain from phase 2 exists) projected
// twice, once at the crest and once 30 degrees under it, split into the runs
// still in front of the viewer and filled between the two.
function drawRidgeView(ctx, horizon, view, w, h) {
  const altAt = horizon ? (az => horizonAt(horizon, az)) : (() => 0);
  const top = [], bot = [];
  for (let az = 0; az < 360; az++) {
    top.push(panProject(altAt(az), az, view));
    bot.push(panProject(-30, az, view));
  }
  const usable = top.map((t, i) => (t && bot[i]) ? t : null);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0b1226');
  g.addColorStop(1, '#03060f');
  for (const run of panRuns(usable, true)) {
    if (run.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(top[run[0]].x, top[run[0]].y);
    for (let k = 1; k < run.length; k++) ctx.lineTo(top[run[k]].x, top[run[k]].y);
    for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(bot[run[k]].x, bot[run[k]].y);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    // the rim of sky light along the crest, same as the flat ridge
    ctx.beginPath();
    ctx.moveTo(top[run[0]].x, top[run[0]].y);
    for (let k = 1; k < run.length; k++) ctx.lineTo(top[run[k]].x, top[run[k]].y);
    ctx.save();
    ctx.strokeStyle = 'rgba(140,164,220,0.10)';
    ctx.lineWidth = 11;
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(132,152,204,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
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
  drawRidgeView(ctx, opts.horizon, view, w, h);
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
