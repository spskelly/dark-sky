// ---------- sky positions (meeus, astronomical algorithms ch. 12, 13, 21, 25, 40, 47, 48) ----------
// angles are degrees everywhere. azimuth is measured from north and increases
// clockwise, so it indexes the horizon profile directly. longitude is
// east-positive, matching the spot data, not meeus's west-positive convention.
// UT is used where meeus says TD: delta-t is about 70 s, which moves the moon
// 0.04 arcmin, and the ch.49 phase code already ignores it for the same reason.
// this block is self-contained so tools/test-astro.mjs can evaluate it in a vm
// with nothing but Math in scope.
//
// one wrinkle the renderer has to know: moonTopocentric's limbAngle is measured
// from the north celestial pole, which is where ch.48 puts it, but the panorama's
// vertical axis is altitude. to draw the bright limb correctly on it, rotate by
// the parallactic angle: limbAngle - parallacticAngle(...) is the bright limb
// measured from the zenith direction.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const deg360 = d => ((d % 360) + 360) % 360;
const sinD = d => Math.sin(d * D2R);
const cosD = d => Math.cos(d * D2R);
const tanD = d => Math.tan(d * D2R);
const asinD = x => Math.asin(x) * R2D;
const atan2D = (y, x) => Math.atan2(y, x) * R2D;

// mean obliquity of the ecliptic, ch.22 eq 22.2, T in julian centuries
const obliquity = T => 23.439291111 - 0.013004167 * T - 1.6389e-7 * T * T + 5.0361e-7 * T * T * T;

// longitude of the moon's ascending node, the one argument both the low-accuracy
// nutation shortcut (ch.25) and the apparent-obliquity correction need
const moonNode = T => 125.04 - 1934.136 * T;

// ch.47 table 47.A, first 25 terms: D, M, M', F, then the coefficient of the
// sine in longitude (1e-6 deg) and of the cosine in distance (1e-3 km). the
// tail of the table is dropped; see the truncation note in tools/test-astro.mjs.
const MOON_LR = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445]
];

// ch.47 table 47.B, first 25 terms: D, M, M', F, coefficient of the sine in
// latitude (1e-6 deg)
const MOON_B = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565],
  [1, 0, 0, 1, -1491],
  [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410]
];

const Sky = {
  // ch.7. a js Date is already UTC milliseconds since the unix epoch, and
  // 1970-01-01T00:00Z is JD 2440587.5, so the calendar rules are someone
  // else's problem
  julianDay: date => date.getTime() / 86400000 + 2440587.5,

  // ch.12 eq 12.4, mean sidereal time at greenwich, plus east longitude.
  // nutation in the equinoxes is under 1.2 arcsec and is skipped
  lmst(jd, lonDeg) {
    const T = (jd - 2451545) / 36525;
    return deg360(280.46061837 + 360.98564736629 * (jd - 2451545)
      + 0.000387933 * T * T - T * T * T / 38710000 + lonDeg);
  },

  // ch.25, the low-accuracy solar position: good to about 0.01 degree, which is
  // a fifth of the sun's own diameter and far better than the scrubber needs.
  // distKm is not in the spec's signature but ch.48 needs it for the phase angle
  sunPosition(jd) {
    const T = (jd - 2451545) / 36525;
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sinD(M)
      + (0.019993 - 0.000101 * T) * sinD(2 * M)
      + 0.000289 * sinD(3 * M);
    const nu = M + C;
    const R = 1.000001018 * (1 - e * e) / (1 + e * cosD(nu));   // AU, eq 25.5
    const om = moonNode(T);
    // apparent longitude: nutation and aberration folded into two terms
    const lam = L0 + C - 0.00569 - 0.00478 * sinD(om);
    const eps = obliquity(T) + 0.00256 * cosD(om);
    return {
      ra: deg360(atan2D(cosD(eps) * sinD(lam), cosD(lam))),
      dec: asinD(sinD(eps) * sinD(lam)),
      distKm: R * 149597870.7
    };
  },

  // ch.47, ELP-2000/82 truncated to 25 terms per table. apparent geocentric
  // position, so the ra/dec come back on the equinox of date
  moonPosition(jd) {
    const T = (jd - 2451545) / 36525, T2 = T * T, T3 = T2 * T, T4 = T3 * T;
    const Lp = deg360(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
    const D = deg360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
    const M = deg360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
    const Mp = deg360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
    const F = deg360(93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
    const A1 = 119.75 + 131.849 * T, A2 = 53.09 + 479264.290 * T, A3 = 313.45 + 481266.484 * T;
    // terms with the sun's anomaly in them scale with earth's eccentricity
    const E = 1 - 0.002516 * T - 0.0000074 * T2;
    const ecc = m => m === 0 ? 1 : (m === 1 || m === -1 ? E : E * E);
    let sl = 0, sr = 0, sb = 0;
    for (const t of MOON_LR) {
      const arg = t[0] * D + t[1] * M + t[2] * Mp + t[3] * F, k = ecc(t[1]);
      sl += t[4] * k * sinD(arg);
      sr += t[5] * k * cosD(arg);
    }
    for (const t of MOON_B) {
      sb += t[4] * ecc(t[1]) * sinD(t[0] * D + t[1] * M + t[2] * Mp + t[3] * F);
    }
    // additive terms: venus (A1), jupiter (A2) and the flattening of the earth
    sl += 3958 * sinD(A1) + 1962 * sinD(Lp - F) + 318 * sinD(A2);
    sb += -2235 * sinD(Lp) + 382 * sinD(A3) + 175 * sinD(A1 - F) + 175 * sinD(A1 + F)
      + 127 * sinD(Lp - Mp) - 115 * sinD(Lp + Mp);
    const om = moonNode(T);
    const lam = Lp + sl / 1e6 - 0.00478 * sinD(om);   // apparent, nutation only
    const bet = sb / 1e6;
    const eps = obliquity(T) + 0.00256 * cosD(om);
    // ch.13 eq 13.3 and 13.4
    return {
      ra: deg360(atan2D(sinD(lam) * cosD(eps) - tanD(bet) * sinD(eps), cosD(lam))),
      dec: asinD(sinD(bet) * cosD(eps) + cosD(bet) * sinD(eps) * sinD(lam)),
      distKm: 385000.56 + sr / 1000
    };
  },

  // ch.40. the observer stands up to one earth radius off the geocentre, which
  // shifts the moon by up to a degree. that is twice its diameter, so no rise
  // time against a ridgeline means anything without it. done as a vector
  // difference instead of meeus's eq 40.2, which gets the topocentric distance
  // for free and has no quadrant traps
  moonTopocentric(jd, latDeg, lonDeg, elevM) {
    const m = this.moonPosition(jd);
    const s = this.sunPosition(jd);
    const th = this.lmst(jd, lonDeg);
    // ch.11: rho sin phi' and rho cos phi', the observer on a flattened earth
    const u = Math.atan(0.99664719 * tanD(latDeg)) * R2D;
    const rs = 0.99664719 * sinD(u) + (elevM / 6378140) * sinD(latDeg);
    const rc = cosD(u) + (elevM / 6378140) * cosD(latDeg);
    const Re = 6378.14;
    const x = m.distKm * cosD(m.dec) * cosD(m.ra) - Re * rc * cosD(th);
    const y = m.distKm * cosD(m.dec) * sinD(m.ra) - Re * rc * sinD(th);
    const z = m.distKm * sinD(m.dec) - Re * rs;
    const d = Math.sqrt(x * x + y * y + z * z);
    // ch.48, computed from the geocentric places as meeus does. topocentric
    // elongation differs by under a degree, which moves k in the fourth decimal
    const cpsi = sinD(s.dec) * sinD(m.dec) + cosD(s.dec) * cosD(m.dec) * cosD(s.ra - m.ra);
    const psi = Math.acos(cpsi) * R2D;
    // eq 48.3. the denominator goes negative near new moon and atan2 carries
    // the phase angle past 90 degrees on its own
    const i = atan2D(s.distKm * sinD(psi), m.distKm - s.distKm * cpsi);
    return {
      ra: deg360(atan2D(y, x)),
      dec: asinD(z / d),
      distKm: d,
      illum: (1 + cosD(i)) / 2,
      // eq 48.5, position angle of the bright limb from the north celestial pole
      limbAngle: deg360(atan2D(cosD(s.dec) * sinD(s.ra - m.ra),
        sinD(s.dec) * cosD(m.dec) - cosD(s.dec) * sinD(m.dec) * cosD(s.ra - m.ra)))
    };
  },

  // ch.13 eq 13.5 and 13.6. meeus reckons azimuth from the south, so +180 puts
  // it on north increasing clockwise, the way the horizon array is indexed
  equatorialToHorizontal(ra, dec, lmstDeg, latDeg) {
    const H = lmstDeg - ra;
    return {
      alt: asinD(sinD(latDeg) * sinD(dec) + cosD(latDeg) * cosD(dec) * cosD(H)),
      az: deg360(180 + atan2D(sinD(H), cosD(H) * sinD(latDeg) - tanD(dec) * cosD(latDeg)))
    };
  },

  // ch.14 eq 14.1, the angle at the object between the direction to the celestial
  // pole and the direction to the zenith. this is the one angle that turns a
  // sky-frame drawing into a horizon-frame one, so the moon's lit side points the
  // right way on a panorama whose vertical axis is altitude.
  //
  // returned in -180..180 rather than 0..360 on purpose: the sign says which side
  // of the meridian the object is on, negative east and positive west, and the
  // renderer subtracts it, where a wrap to 0..360 would make no difference anyway.
  //
  // at the zenith itself both arguments go to zero and atan2 returns 0. the angle
  // is genuinely undefined there, but 0 is finite and the moon is never within a
  // degree of anyone's zenith from 35 north, so there is nothing to clamp.
  parallacticAngle(raDeg, decDeg, lmstDeg, latDeg) {
    const H = lmstDeg - raDeg;
    return atan2D(sinD(H), tanD(latDeg) * cosD(decDeg) - sinD(decDeg) * cosD(H));
  },

  // bennett's formula, refraction in arcminutes from the true altitude, added
  // back on. clamped at -1 degree: below that the tangent argument heads for
  // its pole and the result stops meaning anything, and the panorama draws
  // down to -10
  refract(altDeg) {
    // clamp: below about -2.5 deg the tangent argument crosses its pole and the
    // refraction flips sign. -1 is the last altitude bennett is still meant for
    const h = Math.max(altDeg, -1);
    return altDeg + (1 / tanD(h + 7.31 / (h + 4.4))) / 60;
  },

  // ch.21 eq 21.4, the rigorous rotation. the low-accuracy m and n form drifts
  // badly near the poles and polaris is on this map
  precess(ra, dec, fromJd, toJd) {
    const T = (fromJd - 2451545) / 36525, t = (toJd - fromJd) / 36525;
    const a = (2306.2181 + 1.39656 * T - 0.000139 * T * T) * t;
    const zeta = (a + (0.30188 - 0.000344 * T) * t * t + 0.017998 * t * t * t) / 3600;
    const z = (a + (1.09468 + 0.000066 * T) * t * t + 0.018203 * t * t * t) / 3600;
    const th = ((2004.3109 - 0.85330 * T - 0.000217 * T * T) * t
      - (0.42665 + 0.000217 * T) * t * t - 0.041833 * t * t * t) / 3600;
    const A = cosD(dec) * sinD(ra + zeta);
    const B = cosD(th) * cosD(dec) * cosD(ra + zeta) - sinD(th) * sinD(dec);
    const C = sinD(th) * cosD(dec) * cosD(ra + zeta) + cosD(th) * sinD(dec);
    return { ra: deg360(atan2D(A, B) + z), dec: asinD(C) };
  },

  // ch.13, run backwards, with the j2000 pole rather than meeus's b1950 one.
  // this is the whole milky way data file: the band is |b| < a few degrees and
  // the core is l = 0, b = 0
  galacticToEquatorial(l, b) {
    const raGP = 192.85948, decGP = 27.12825, lCP = 122.93192;
    const t = lCP - l;
    return {
      ra: deg360(raGP + atan2D(cosD(b) * sinD(t),
        cosD(decGP) * sinD(b) - sinD(decGP) * cosD(b) * cosD(t))),
      dec: asinD(sinD(decGP) * sinD(b) + cosD(decGP) * cosD(b) * cosD(t))
    };
  }
};
