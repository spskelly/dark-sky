"""checks that a spot's coordinate, its elevation and its drawn skyline agree.

the skyline in index.html is computed from the coordinate in index.html, so
comparing the drawing against the coordinate proves nothing: move the pin and
you get a different skyline that is just as self consistent. this checks the
things that are actually independent.

  python tools/check_alignment.py            # report, exit 1 if anything is broken
  python tools/check_alignment.py --quiet     # only the failures

what it checks, in the order that matters:

  1. every spot has a horizon, and every horizon belongs to a spot.
  2. the horizon was raycast from the coordinate the page uses NOW. this is the
     one that rots: revise a coordinate without rebuilding and the page draws
     last week's skyline from this week's pin, with nothing to show for it.
  3. the encoded string in the page still matches the cached raycast.
  4. the model's ground elevation against the listed elevation, which is the
     only independent word on whether the coordinate is where it claims.
  5. every CANOPY entry belongs to a live spot or overlook, was computed from
     the page's current coordinate and deck, decodes to its cache file, and
     its pin ground agrees with 3DEP within 5 m.

road placement is not here. tools/check-spots.mjs already measures every pin
against the parkway centreline and against OpenStreetMap, and can snap the
roadside ones; run that for where a spot sits, and this for whether its skyline
still belongs to it.

check 4 reads differently for the two kinds of spot, and conflating them is how
this check cries wolf:

  a drive-up spot has one coordinate, so the model and the listing should agree
  within the grid's own resolution. call it 20 m.

  a walk-in spot carries a separate view coordinate, and the gap is then the
  climb from the parking elevation to the viewpoint. positive and roughly the
  size the note describes is right. NEGATIVE is the interesting failure: it
  means the viewpoint sits below the parking, which for a spot named after a
  summit usually means the coordinate never left the trailhead.

needs no dem and no rasterio: it reads the cache build_horizons.py left behind.
"""
import argparse
import glob
import json
import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, 'index.html')
CACHE = os.path.join(ROOT, 'tools', '.horizon-cache')
B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
ALT_MIN, ALT_RANGE = -10.0, 90.0
DRIVE_TOL_M = 20.0      # the 1/3 arc-second grid is about 10 m
# gaps that have already been researched and written up, so they read as
# "known" rather than as a warning. a check that repeats four findings you
# already understand is a check you stop reading. the write-up is the authority;
# this list only keeps the output quiet, so delete an entry when the listing or
# the pin is corrected rather than editing the reason here.
KNOWN = {
    'Doughton Park': 'pin moved to the Bluff Ridge trail access',
}

# a name can hold an apostrophe, in which case the record is double quoted.
# matching only the single-quoted form silently drops those spots and makes 40
# look like 38, which is a worse failure than the one this file checks for.
SPOT_RE = re.compile(r"""\{ name: (['"])(.*?)\1, lat: (-?[\d.]+), lon: (-?[\d.]+), elev: (-?[\d.]+)(.*?)\n""", re.S)


def spots(html):
    block = html.split('const SPOTS = [', 1)[1].split('\n];', 1)[0]
    out = {}
    for q, name, lat, lon, elev, rest in SPOT_RE.findall(block):
        view = re.search(r'view: \[(-?[\d.]+), (-?[\d.]+)\]', rest)
        deck = re.search(r'deck: (-?[\d.]+)', rest)
        out[name] = dict(lat=float(lat), lon=float(lon), elev_ft=float(elev),
                         view=(float(view.group(1)), float(view.group(2))) if view else None,
                         deck=float(deck.group(1)) if deck else None)
    return out



def page_horizons(html):
    if 'const HORIZONS = {' not in html:
        return {}
    block = html.split('const HORIZONS = {', 1)[1].split('\n};', 1)[0]
    return dict(re.findall(r'"([^"]+)": "([A-Za-z0-9+/]+)"', block))


def decode(s):
    return [ALT_MIN + (B64.index(s[2 * i]) * 64 + B64.index(s[2 * i + 1])) * ALT_RANGE / 4095.0
            for i in range(len(s) // 2)]


CANOPY_CACHE = os.path.join(ROOT, 'tools', '.canopy-cache')
GROUND_TOL_M = 5.0      # lidar ground against 3DEP at the pin; more is two surveys disagreeing


def page_canopy(html):
    """the CANOPY block: one json object per line, keyed by spot name or osm id"""
    if 'const CANOPY = {' not in html:
        return {}
    block = html.split('const CANOPY = {', 1)[1].split('\n};', 1)[0]
    out = {}
    for line in block.splitlines():
        m = re.match(r'\s*("(?:[^"\\]|\\.)*"): (\{.*\}),?\s*$', line)
        if m:
            out[json.loads(m.group(1))] = json.loads(m.group(2))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--quiet', action='store_true', help='only the failures')
    ap.add_argument('--html', default=HTML, help='check a copy of the page instead')
    a = ap.parse_args()

    html = open(a.html, encoding='utf-8', newline='').read()
    sp, drawn = spots(html), page_horizons(html)
    cache, ov_cache = {}, {}
    for path in glob.glob(os.path.join(CACHE, '*.json')):
        d = json.load(open(path, encoding='utf-8'))
        if d.get('ov_id'):
            ov_cache[d['ov_id']] = d
        elif 'name' in d:
            cache[d['name']] = d

    fail, warn = [], []
    say = (lambda *x: None) if a.quiet else print
    say('%d spots, %d cached horizons, %d drawn in the page'
        % (len(sp), len(cache), len(drawn)))

    for name in sorted(set(sp) | set(cache) | set(drawn)):
        if name not in sp:
            fail.append('%s: cached or drawn but not in SPOTS' % name)
            continue
        s = sp[name]
        if name not in cache:
            fail.append('%s: no cached horizon' % name)
            continue
        d = cache[name]
        want = s['view'] or (s['lat'], s['lon'])
        if abs(d['lat'] - want[0]) > 1e-9 or abs(d['lon'] - want[1]) > 1e-9:
            fail.append('%s: horizon raycast from %.4f,%.4f but the page now says %.4f,%.4f'
                        ' - rerun tools/build_horizons.py' % (name, d['lat'], d['lon'], want[0], want[1]))
        if name in drawn:
            got = decode(drawn[name])
            if len(got) != len(d['alt']) or max(abs(x - y) for x, y in zip(got, d['alt'])) > ALT_RANGE / 4095 * 1.5:
                fail.append('%s: the string in the page is not this cached raycast' % name)
        else:
            fail.append('%s: no horizon in the page' % name)

    say('\nelevation, model against listing')
    for name, s in sorted(sp.items()):
        d = cache.get(name)
        if not d:
            continue
        gap = d['dem_m'] - s['elev_ft'] * 0.3048
        if s['view']:
            if gap < -20 and name not in KNOWN:
                warn.append('%s: the view coordinate sits %.0f m BELOW the listed elevation,'
                            ' so it is probably still at the trailhead' % (name, -gap))
            elif not a.quiet and gap > 60:
                say('  %-34s +%4.0f m climb to the viewpoint' % (name[:34], gap))
        elif abs(gap) > DRIVE_TOL_M:
            msg = ('%s: drive-up, but the model says %.0f m %s than the listed %.0f ft'
                   % (name, abs(gap), 'lower' if gap < 0 else 'higher', s['elev_ft']))
            if name in KNOWN:
                say('  %-34s %+5.0f m, known: %s' % (name[:34], gap, KNOWN[name]))
            else:
                warn.append(msg)

    # the overlooks: every one in the page has a horizon, raycast from the
    # coordinate the page has now, and the string in the page is that raycast
    ov_block = html.split('const OVERLOOKS = [', 1)[1].split('];', 1)[0] if 'const OVERLOOKS = [' in html else ''
    ovs = [json.loads(l.strip().rstrip(',')) for l in ov_block.splitlines() if l.strip().startswith('{')]
    ov_drawn = {}
    if 'const OVERLOOK_HORIZONS = {' in html:
        blk = html.split('const OVERLOOK_HORIZONS = {', 1)[1].split('\n};', 1)[0]
        ov_drawn = dict(re.findall(r'"([^"]+)": \[\d+, "([A-Za-z0-9+/]+)"\]', blk))
    for o in ovs:
        rec, enc = ov_cache.get(o['id']), ov_drawn.get(o['id'])
        if rec is None or enc is None:
            fail.append('%s (%s): no horizon' % (o['name'], o['id']))
        elif abs(rec['lat'] - o['lat']) > 1e-9 or abs(rec['lon'] - o['lon']) > 1e-9:
            fail.append('%s (%s): horizon was raycast from a different coordinate' % (o['name'], o['id']))
        elif max(abs(a - b) for a, b in zip(decode(enc), rec['alt'])) > ALT_RANGE / 4095.0:
            fail.append('%s (%s): the page string is not this raycast' % (o['name'], o['id']))
    say('%d overlooks checked' % len(ovs))

    # the canopy: every entry a live place, computed from the coordinate and
    # deck the page has now, the strings this cache's, and the pin ground
    # within GROUND_TOL_M of the 3DEP post the ridge was raycast from
    can = page_canopy(html)
    ccache = {}
    for path in glob.glob(os.path.join(CANOPY_CACHE, '*.json')):
        d = json.load(open(path, encoding='utf-8'))
        ccache[d.get('ov_id') or d.get('name')] = d
    ov_by_id = {o['id']: o for o in ovs}
    for key, e in sorted(can.items()):
        if key in sp:
            want, deck = sp[key]['view'] or (sp[key]['lat'], sp[key]['lon']), sp[key]['deck']
        elif key in ov_by_id:
            want, deck = (ov_by_id[key]['lat'], ov_by_id[key]['lon']), None
        else:
            fail.append('%s: canopy for a place that is not in the page' % key)
            continue
        d = ccache.get(key)
        if not d:
            fail.append('%s: canopy in the page but not in tools/.canopy-cache' % key)
            continue
        if abs(d['lat'] - want[0]) > 1e-9 or abs(d['lon'] - want[1]) > 1e-9:
            fail.append('%s: canopy computed from %.4f,%.4f but the page now says %.4f,%.4f'
                        ' - rerun tools/build_canopy.py' % (key, d['lat'], d['lon'], want[0], want[1]))
        if d.get('deck_m') != deck:
            fail.append('%s: canopy deck %s but the page says %s - rerun tools/build_canopy.py' % (key, d.get('deck_m'), deck))
        if ('deck' in e) != bool(deck):
            fail.append('%s: the page %s a deck profile but the spot %s deck:' % (key, 'has' if 'deck' in e else 'lacks', 'has' if deck else 'lacks'))
        pairs = [(e.get('t'), d.get('t')), (e.get('s'), d.get('s'))]
        if 'deck' in e and d.get('deck'):
            pairs += [(e['deck'].get('t'), d['deck']['t']), (e['deck'].get('s'), d['deck']['s'])]
        for enc, alt in pairs:
            # the encoding stops at ALT_MIN + ALT_RANGE: a canopy overhead is
            # cached at 80 to 85 degrees and ships as 80, which is the page
            # being right, not the string being stale
            if enc and alt and max(abs(a - min(max(b, ALT_MIN), ALT_MIN + ALT_RANGE))
                                   for a, b in zip(decode(enc), alt)) > ALT_RANGE / 4095 * 1.5:
                fail.append('%s: a canopy string in the page is not this cached raycast' % key)
                break
        tc = cache.get(key) or ov_cache.get(key)
        if tc and d.get('ground_m') is not None and abs(d['ground_m'] - tc['dem_m']) > GROUND_TOL_M:
            warn.append('%s: lidar ground %.1f m, 3DEP %.1f m at the pin, %.1f m apart'
                        % (key, d['ground_m'], tc['dem_m'], d['ground_m'] - tc['dem_m']))
    for key, d in ccache.items():
        if d.get('t') is not None and key not in can and (key in sp or key in ov_by_id):
            fail.append('%s: canopy cached but not in the page - rerun tools/build_canopy.py' % key)
    say('%d canopy entries checked' % len(can))

    for w in warn:
        print('WARN  %s' % w)
    for f in fail:
        print('FAIL  %s' % f)
    print('\n%d broken, %d worth a look' % (len(fail), len(warn)))
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
