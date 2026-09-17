"""measures a proposed coordinate before anybody commits to it.

a research note can say "the summit is the better view" and be wrong. this says
what the elevation model thinks: how high the skyline stands around that point,
how much of the sky is open, and which way it is blocked. run it on the spot's
current coordinate and on the candidate, and compare.

  python tools/check_viewpoint.py 35.4605 -83.1400
  python tools/check_viewpoint.py 35.4605 -83.1400 --against 35.4592 -83.1449
  python tools/check_viewpoint.py --spot "Waterrock Knob" --against 35.4592 -83.1449

mean horizon is the number to watch. a parking lot cut into a wooded slope sits
around 8 to 15 degrees; an open bald sits near 2 to 5. openness is the fraction
of the sky above the terrain, which is what actually decides whether you can see
anything, and it already accounts for the ridge being high in only one quarter.

the far field grid has to exist, so run build_horizons.py at least once first.
"""
import argparse
import math
import sys

import numpy as np

import build_horizons as bh


def measure(lat, lon):
    fine = bh.fine_lattice(lat, lon)
    h = float(fine.sample(np.array([lat]), np.array([lon]))[0])
    if h <= bh.NODATA:
        sys.exit('no dem coverage at %.5f, %.5f' % (lat, lon))
    alt, rng = bh.raycast(lat, lon, h + bh.EYE, fine, bh.coarse_lattice(False))
    return h, alt, rng


def openness(alt):
    """fraction of the hemisphere above the terrain. the solid angle above a
    horizon at altitude a is proportional to (1 - sin a), averaged over azimuth,
    so a high ridge in one quarter costs less sky than the same ridge all round.
    that is the honest way to compare a notch with a bowl."""
    return float(np.mean(1.0 - np.sin(np.radians(np.maximum(alt, 0.0)))))


def report(label, lat, lon):
    h, alt, rng = measure(lat, lon)
    quad = {}
    for name, lo, hi in (('N', 315, 45), ('E', 45, 135), ('S', 135, 225), ('W', 225, 315)):
        az = np.arange(360)
        sel = ((az >= lo) | (az < hi)) if lo > hi else ((az >= lo) & (az < hi))
        quad[name] = float(alt[sel].mean())
    print('%s  %.5f, %.5f' % (label, lat, lon))
    print('  dem elevation   %7.0f m  (%.0f ft)' % (h, h / 0.3048))
    print('  mean horizon    %7.1f deg' % alt.mean())
    print('  highest ridge   %7.1f deg at azimuth %d' % (alt.max(), int(alt.argmax())))
    print('  lowest horizon  %7.1f deg at azimuth %d' % (alt.min(), int(alt.argmin())))
    print('  open sky        %7.1f %% of the hemisphere' % (100 * openness(alt)))
    print('  by quarter      N %.1f  E %.1f  S %.1f  W %.1f deg' % (quad['N'], quad['E'], quad['S'], quad['W']))
    print('  skyline range   %7.0f m median' % np.median(rng))
    return h, alt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('lat', nargs='?', type=float)
    ap.add_argument('lon', nargs='?', type=float)
    ap.add_argument('--spot', help='use this spot\'s current coordinate as the baseline')
    ap.add_argument('--against', nargs=2, type=float, metavar=('LAT', 'LON'),
                    help='a candidate to compare against the baseline')
    a = ap.parse_args()

    if a.spot:
        html = open(bh.HTML, encoding='utf-8', newline='').read()
        hit = [s for s in bh.parse_spots(html) if a.spot.lower() in s['name'].lower()]
        if len(hit) != 1:
            sys.exit('--spot %r matched %d spots' % (a.spot, len(hit)))
        lat, lon = hit[0]['lat'], hit[0]['lon']
        print('baseline is %s as it stands in SPOTS' % hit[0]['name'])
    elif a.lat is not None and a.lon is not None:
        lat, lon = a.lat, a.lon
    else:
        sys.exit('give a lat and lon, or --spot NAME')

    h0, alt0 = report('baseline ', lat, lon)
    if not a.against:
        return
    print()
    h1, alt1 = report('candidate', a.against[0], a.against[1])

    # metres per degree at this latitude is close enough for a few kilometres
    dm = math.hypot((a.against[0] - lat) * 111320.0,
                    (a.against[1] - lon) * 111320.0 * math.cos(math.radians(lat)))
    print()
    print('candidate is %.0f m away and %+.0f m higher' % (dm, h1 - h0))
    print('mean horizon %+.1f deg, open sky %+.1f points'
          % (alt1.mean() - alt0.mean(), 100 * (openness(alt1) - openness(alt0))))
    better = alt1.mean() < alt0.mean()
    print('verdict: the candidate is the %s viewpoint by this measure'
          % ('more open' if better else 'LESS open'))
    if not better:
        print('  a candidate that is less open than the coordinate it replaces needs')
        print('  a reason in words, not just a source that names it.')


if __name__ == '__main__':
    main()
