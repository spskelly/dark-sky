(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DarkSkyMapAnalysis = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clampBearing = value => ((value % 360) + 360) % 360;

  function percentile(values, fraction) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
  }

  // Find the broad sector with the lowest combined mean and high obstruction.
  // A low mean rewards a generally open view; the p90 term prevents one ridge
  // wall inside the sector from disappearing into the average.
  function bestViewingSector(profile, options) {
    const opts = options || {};
    const width = Math.max(10, Math.min(180, Math.round(opts.width || 60)));
    if (!profile || profile.length !== 360) throw new Error('view profile must have 360 azimuth samples');
    const values = Array.from(profile, v => Number.isFinite(Number(v)) ? Number(v) : 90);
    let best = null;
    let tiedBearings = [];
    let worstMean = -Infinity;
    const before = Math.floor(width / 2);

    for (let bearing = 0; bearing < 360; bearing++) {
      const sector = [];
      for (let offset = -before; offset < width - before; offset++) {
        sector.push(values[clampBearing(bearing + offset)]);
      }
      const mean = sector.reduce((sum, value) => sum + value, 0) / sector.length;
      const p90 = percentile(sector, 0.9);
      const score = mean + p90 * 0.35;
      if (!best || score < best.score - 1e-9) {
        best = { bearing, mean, p90, score };
        tiedBearings = [bearing];
      } else if (Math.abs(score - best.score) <= 1e-9) {
        tiedBearings.push(bearing);
      }
      if (mean > worstMean) worstMean = mean;
    }

    if (tiedBearings.length > 1) {
      const vector = tiedBearings.reduce((sum, bearing) => {
        const angle = bearing * Math.PI / 180;
        return [sum[0] + Math.sin(angle), sum[1] + Math.cos(angle)];
      }, [0, 0]);
      if (Math.hypot(vector[0], vector[1]) > 1e-6) {
        best.bearing = Math.round(clampBearing(Math.atan2(vector[0], vector[1]) * 180 / Math.PI)) % 360;
      }
    }

    const overallP90 = percentile(values, 0.9);
    return {
      bearing: best.bearing,
      width,
      start: clampBearing(best.bearing - width / 2),
      end: clampBearing(best.bearing + width / 2),
      mean: best.mean,
      p90: best.p90,
      allAround: overallP90 <= 10 && worstMean - best.mean <= 3,
    };
  }

  function sectorSvgPath(bearing, width, radius) {
    const r = radius || 27;
    const point = azimuth => {
      const angle = clampBearing(azimuth) * Math.PI / 180;
      return [32 + Math.sin(angle) * r, 32 - Math.cos(angle) * r];
    };
    const start = point(bearing - width / 2);
    const end = point(bearing + width / 2);
    return `M 32 32 L ${start[0].toFixed(2)} ${start[1].toFixed(2)} A ${r} ${r} 0 0 1 ${end[0].toFixed(2)} ${end[1].toFixed(2)} Z`;
  }

  function compass16(bearing) {
    const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return names[Math.round(clampBearing(bearing) / 22.5) % 16];
  }

  return { bestViewingSector, clampBearing, compass16, sectorSvgPath };
}));
