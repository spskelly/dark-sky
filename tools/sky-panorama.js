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

   public: decodeHorizon(s), drawPanorama(canvas, opts), horizonSummary(opts)
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
// cylindrical: azimuth linear across the full turn, altitude linear.
// the full view is -10 to +80. the thumbnail keeps a fixed window of its own,
// -3 to +24: on the full scale a sixty pixel strip gives a typical ridge nine
// pixels and it reads as a smudge. every thumbnail shares the one window, so
// two spots side by side still compare honestly.
// ponytail: module-level rather than threaded through every draw call. one
// canvas is drawn at a time and nothing here is reentrant.
let PAN_TOP = 80;
let PAN_BOT = -10;

const panX = (az, w) => (((az % 360) + 360) % 360) / 360 * w;
const panY = (alt, h) => (PAN_TOP - alt) / (PAN_TOP - PAN_BOT) * h;

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
  if (!ctx || !opts.horizon) return false;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const thumb = opts.mode === 'thumb';
  PAN_TOP = thumb ? 24 : 80;
  PAN_BOT = thumb ? -3 : -10;
  if (thumb) {
    drawRidge(ctx, opts.horizon, w, h, true);
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
        return { x: az / 360 * w, y: panY(p.alt, h) };
      });
      for (let k = -1; k <= 1; k++) {
        const dx = k * w;
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
    for (let k = -1; k <= 1; k++) {
      const g = ctx.createRadialGradient(x + k * w, y, 0, x + k * w, y, r);
      g.addColorStop(0, 'rgba(236,231,212,0.14)');
      g.addColorStop(1, 'rgba(236,231,212,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x + k * w - r, y - r, r * 2, r * 2);
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
        ctx.moveTo(panX(a.az, w) + k * w, panY(a.alt, h));
        ctx.lineTo(az / 360 * w + k * w, panY(b.alt, h));
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
  [20, 40, 60].forEach(function (a) {
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

function drawRidge(ctx, horizon, w, h, thumb) {
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i <= 360; i++) {
    ctx.lineTo(i / 360 * w, panY(horizon[i % 360], h));
  }
  ctx.lineTo(w, h);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, panY(PAN_TOP * 0.3, h), 0, h);
  g.addColorStop(0, thumb ? '#121c38' : '#0b1226');
  g.addColorStop(1, thumb ? '#070c1a' : '#03060f');
  ctx.fillStyle = g;
  ctx.fill();

  // a rim of sky light along the crest. without it the silhouette reads as a
  // hole punched in the canvas rather than as a ridge with sky behind it.
  ctx.beginPath();
  for (let i = 0; i <= 360; i++) {
    const x = i / 360 * w;
    const y = panY(horizon[i % 360], h);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i === 0 ? 'rgba(236,231,212,0.8)' : 'rgba(169,165,143,0.7)';
    if (i === 0) {
      // north is both ends of a full turn, so it is labelled at both ends,
      // nudged in far enough not to be clipped
      ctx.fillText('N', 11, h - 6);
      ctx.fillText('N', w - 11, h - 6);
    } else {
      ctx.fillText(PAN_COMPASS[i], panX(i * 45, w), h - 6);
    }
  }
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.font = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(139,150,179,0.7)';
  [20, 40, 60].forEach(function (a) {
    ctx.fillText(a + '°', 6, panY(a, h) - 4);
  });
}

// ---------- the sentence under the canvas ----------

// 9:04pm, the way the rest of the page talks
function panTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s/g, '');
}

const PAN_DIR = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const panDir = az => PAN_DIR[Math.round((((az % 360) + 360) % 360) / 45) % 8];

// dusk to dawn, civil twilight either side. stepped rather than solved: this
// runs once per card, not per frame.
// ponytail: no crossing found means the sun never left civil twilight, which
// does not happen in the carolinas. the fallback keeps the card from going
// blank if the function is ever pointed somewhere arctic.
function nightWindow(opts) {
  const noon = new Date(opts.date);
  // 1am belongs to the evening before it, which is the night the card is
  // showing, so anchor on that day's noon rather than on the calendar date
  if (noon.getHours() < 12) noon.setDate(noon.getDate() - 1);
  noon.setHours(12, 0, 0, 0);
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
