"""measures every pull-off-sized step of road near a spot, so the coordinate
can be chosen from the elevation model rather than from memory.

check_viewpoint.py answers "is this candidate better than that one" for two
points you already have. this answers the question before that: which point on
the road nearby is the one worth standing on. it walks the PARKWAY polyline in
index.html, takes every vertex within a radius of the spot, and measures each.

  python tools/sweep_road.py --spot "Cove Field"
  python tools/sweep_road.py --spot "Cove Field" --south --radius 1500
  python tools/sweep_road.py 35.4309 -83.0357 --sector 135 225

the parkway line is simplified to about 120 m, which is roughly a pull-off
apart and finer than the 1/3 arc-second grid can resolve anyway, so the
vertices are the natural sample points.

what the columns mean, and what they cannot say:

  mean      mean skyline altitude all round. a wooded road cut sits 10 to 15
            degrees, an open bald near 2 to 5.
  sector    mean altitude across the sector you asked about, default the south
            135 to 225, which is where the galactic core sits from here.
  lowest    the lowest point in that sector and its bearing: the notch a core
            or a moon actually sets through.
  open      fraction of the hemisphere above the terrain.

the model is bare earth. it does not know about trees, and the raycast starts
150 m out, so a pull-off's own bank and treeline are invisible to it. a spot
this tool likes can still be walled in by rhododendron. confirm on imagery,
then on the ground.
"""
import argparse
import json
import math
import re
import sys

import numpy as np

import build_horizons as bh
import check_viewpoint as cv


def parkway(html):
    """the PARKWAY polyline, as a flat list of (lat, lon)."""
    m = re.search(r'const PARKWAY = (\[.*?\n\]);', html, re.S)
    if not m:
        sys.exit('no PARKWAY block in index.html')
    # javascript allows the trailing comma that json refuses
    ways = json.loads(re.sub(r',(\s*[\]\}])', r'\1', m.group(1)))
    return [tuple(p) for w in ways for p in w]


def metres(a, b):
    kx = 111320 * math.cos(math.radians(a[0]))
    return math.hypot((b[1] - a[1]) * kx, (b[0] - a[0]) * 110540)


def bearing(a, b):
    kx = math.cos(math.radians(a[0]))
    return math.degrees(math.atan2((b[1] - a[1]) * kx, b[0] - a[0])) % 360


def sector_stats(alt, lo, hi):
    az = np.arange(360)
    sel = ((az >= lo) | (az < hi)) if lo > hi else ((az >= lo) & (az < hi))
    a = alt[sel]
    return float(a.mean()), float(a.min()), int(az[sel][int(a.argmin())])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('lat', nargs='?', type=float)
    ap.add_argument('lon', nargs='?', type=float)
    ap.add_argument('--spot', help='centre the sweep on this spot in SPOTS')
    ap.add_argument('--radius', type=float, default=2000, help='metres, default 2000')
    ap.add_argument('--sector', nargs=2, type=int, default=(135, 225),
                    metavar=('FROM', 'TO'), help='bearings to score, default the south')
    ap.add_argument('--south', action='store_true', help='only vertices south of the centre')
    a = ap.parse_args()

    html = open(bh.HTML, encoding='utf-8', newline='').read()
    if a.spot:
        hit = [s for s in bh.parse_spots(html) if a.spot.lower() in s['name'].lower()]
        if len(hit) != 1:
            sys.exit('--spot %r matched %d spots' % (a.spot, len(hit)))
        centre = (hit[0]['lat'], hit[0]['lon'])
        label = hit[0]['name']
    elif a.lat is not None and a.lon is not None:
        centre, label = (a.lat, a.lon), 'given point'
    else:
        sys.exit('give a lat and lon, or --spot NAME')

    pts = [p for p in parkway(html) if metres(centre, p) <= a.radius]
    if a.south:
        pts = [p for p in pts if p[0] < centre[0]]
    # nearest first, and the centre itself leads so every row reads against it
    pts.sort(key=lambda p: metres(centre, p))
    # ways that meet repeat a vertex, and measuring the same point twice is
    # noise in a table meant to be read
    seen, uniq = set(), []
    for p in pts:
        key = (round(p[0], 6), round(p[1], 6))
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    pts = uniq
    if not pts:
        sys.exit('no parkway vertices within %.0f m' % a.radius)

    lo, hi = a.sector
    print('%s, sweeping %d parkway vertices within %.0f m%s'
          % (label, len(pts), a.radius, ', south only' if a.south else ''))
    print('sector scored: %d to %d degrees\n' % (lo, hi))
    print('%-11s %5s %4s %6s %6s %7s %14s %5s'
          % ('coordinate', 'away', 'brg', 'dem', 'mean', 'sector', 'lowest there', 'open'))

    rows = []
    for lat, lon in [centre] + pts:
        try:
            h, alt, rng = cv.measure(lat, lon)
        except SystemExit:
            print('%.4f,%.4f   no dem coverage' % (lat, lon))
            continue
        mean_s, min_s, min_az = sector_stats(alt, lo, hi)
        d = metres(centre, (lat, lon))
        rows.append(dict(lat=lat, lon=lon, d=d, h=h, mean=float(alt.mean()),
                         sector=mean_s, low=min_s, low_az=min_az,
                         open=100 * cv.openness(alt)))
        r = rows[-1]
        print('%.4f,%.4f %5.0fm %4.0f %5.0fm %5.1f%s %6.1f%s %8.1f%s at %03d %4.0f%%'
              % (r['lat'], r['lon'], r['d'], bearing(centre, (r['lat'], r['lon'])) if d else 0,
                 r['h'], r['mean'], '°', r['sector'], '°', r['low'], '°',
                 r['low_az'], r['open']))

    base = rows[0]
    best = min(rows, key=lambda r: r['sector'])
    print()
    if best is base:
        print('the spot as it stands is already the most open point in that sector.')
    else:
        print('most open in that sector: %.4f, %.4f, %.0f m away on a bearing of %.0f'
              % (best['lat'], best['lon'], best['d'], bearing(centre, (best['lat'], best['lon']))))
        print('  sector mean %.1f vs %.1f at the spot, a %.1f degree improvement'
              % (best['sector'], base['sector'], base['sector'] - best['sector']))
        print('  its lowest point in the sector is %.1f degrees at bearing %03d'
              % (best['low'], best['low_az']))
        print('\nbare earth only: confirm on imagery that a pull-off exists there before moving anything.')


if __name__ == '__main__':
    main()
