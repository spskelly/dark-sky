"""writes a 360 sample skyline profile per spot into index.html, between the
horizons:start and horizons:end markers.

the page ships one file with no build step and no runtime dependencies, so the
terrain travels as 720 bytes of base64 per spot rather than as a mesh or a tile
service. that is enough to answer the question a stargazing planner actually
asks, which is not "what does it look like" but "how high is the ridge to the
southeast, and is the moon behind it at 10pm".

  python tools/build_horizons.py                 # resume, then rewrite index.html
  python tools/build_horizons.py --dry-run       # say what a run would do, compute nothing
  python tools/build_horizons.py --force         # discard the cache and recompute
  python tools/build_horizons.py --only cowee    # one spot, by name substring

the elevation model is USGS 3DEP 1/3 arc-second, public domain, already sitting
on S:. it is bare earth: no canopy. that makes every horizon here a best case,
which the page says in a footnote rather than pretending to correct for.

three things decide whether this is correct or merely plausible:

  earth curvature. at 100 km the ground falls about 780 m below the observer's
  tangent plane, more than most of these ridges stand above their valleys.

  refraction. light bends back toward the surface and recovers part of that
  drop. the standard dodge is an effective earth radius of 7/6 R, which nets
  about 670 m at 100 km. the 110 m difference decides which ridge is the
  skyline, so it is not optional.

  max pooling, never averaging, when the far field is downsampled. a skyline is
  an upper envelope. averaging 3x3 sinks every crest toward its flanks by tens
  of metres and quietly lowers every distant ridge in the output.

reads off S: are strictly sequential. that drive's controller has stalled twice
under sustained parallel i/o, and nothing here is worth a power cycle.
"""
import argparse
import json
import math
import os
import re
import sys
import time

import numpy as np
import rasterio
from rasterio.windows import Window

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, 'index.html')
CACHE = os.path.join(ROOT, 'tools', '.horizon-cache')
TILES = 'S:\\dem_tiles'

START = '// --- horizons:start (generated, do not edit by hand) ---'
END = '// --- horizons:end ---'

# 7/6 R_earth is the standard refraction dodge: pretend the planet is flatter
# than it is and light travels in straight lines again.
R_EFF = 7.0 / 6.0 * 6371000.0

# 3DEP's own nodata. it has to be masked deliberately: a max filter would
# happily let a real neighbour cover for a void cell, but a block that is
# entirely void must stay void rather than becoming a sea level plain.
NODATA = -999999.0

ALT_MIN = -10.0       # degrees, the bottom of the encoded range
ALT_RANGE = 90.0      # degrees of span, so -10 .. +80
EYE = 1.7             # metres of person above the dem
MAX_RANGE = 100000.0  # metres; past this a ridge is haze
NEAR = 5000.0         # metres; inside this, full resolution

# where the ray starts. this is a real tunable and it was measured, not picked.
#
# starting at one dem post, 10 m, makes the skyline a fiction: a neighbouring
# cell 2 m higher subtends 11 degrees, so every road cut, parking berm and
# half metre of vertical noise becomes a ridge. the first run had 23 per cent
# of all azimuths finding their skyline closer than 100 m, a median range of
# 428 m, and maxima of 38 to 43 degrees at open overlooks. that is not terrain,
# that is the ground the observer is standing on.
#
# measured across five spots at 10, 50, 150 and 400 m:
#
#   start   sub-100 m azimuths   black balsam max   devil's courthouse max
#    10 m          16 to 48%           12.3 deg              33.7 deg
#    50 m           9 to 35%           11.7 deg              33.7 deg
#   150 m                  0%            5.8 deg              32.0 deg
#   400 m                  0%            1.0 deg              17.4 deg
#
# 150 m is the knee. it clears every sub-100 m artifact while keeping the
# features that are really there: devil's courthouse holds its 32 degree rock
# face and big bald holds its 23 degree summit. by 400 m real ground is being
# deleted, black balsam falling to a 1 degree horizon it does not have.
#
# 150 m is about 15 dem cells. below that a 1/3 arc-second grid cannot tell a
# ridge from a road cut, and neither could you without stepping ten paces
# sideways. retune against a photograph taken from a known overlook.
MIN_RANGE = 150.0

SRC_CPD = 10800       # source cells per degree, ie 1/3 arc-second
COARSE_CPD = 3600     # far field cells per degree, ie 1 arc-second

# the far field grid. the spots span 35.01 to 36.42 N and -84.02 to -81.18 W,
# and a 100 km ray reaches about 0.9 degrees of latitude past that, so this is
# very nearly the smallest whole degree box that holds every ray. tiles exist
# for all of it. rays from doughton park, the northernmost spot, run about 0.3
# degrees off the top edge; there is no n38 tile at these longitudes and nothing
# that far north is on anybody's skyline from the parkway.
GRID_LAT0, GRID_LAT1, GRID_LON0, GRID_LON1 = 34, 37, -85, -80

B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


# ---------- reading the dem ----------

class Lattice:
    """a height grid on the global lattice of cpd cells per degree, anchored at
    90 N / 180 W so every whole degree lands on a cell boundary and two reads at
    different resolutions cannot disagree about where a cell is."""

    def __init__(self, arr, row0, col0, cpd):
        self.arr, self.row0, self.col0, self.cpd = arr, row0, col0, cpd

    def sample(self, lats, lons):
        r = np.floor((90.0 - lats) * self.cpd).astype(np.int64) - self.row0
        c = np.floor((lons + 180.0) * self.cpd).astype(np.int64) - self.col0
        ok = (r >= 0) & (r < self.arr.shape[0]) & (c >= 0) & (c < self.arr.shape[1])
        h = np.full(np.shape(lats), NODATA, np.float32)
        h[ok] = self.arr[r[ok], c[ok]]
        return h


def tile_path(tlat, tlon):
    """tlat and tlon are the south and west edges of a whole degree square. the
    usgs name carries the north edge and the west edge, both positive."""
    return os.path.join(TILES, 'USGS_13_n%02dw%03d.tif' % (tlat + 1, -tlon))


def pool_max(a, pool):
    """downsample by pool x pool, taking the maximum. never the mean: a skyline
    is an upper envelope, and averaging sinks every crest toward its flanks by
    tens of metres, which lowers every distant ridge in the output."""
    if pool == 1:
        return a
    h, w = a.shape
    return a.reshape(h // pool, pool, w // pool, pool).max(axis=(1, 3))


def read_lattice(cpd, row0, row1, col0, col1, block=600):
    """mosaic the source tiles onto the cpd lattice, max pooling on the way.

    each tile carries six pixels of overlap past its own degree square, so it is
    10812 across and not 10800. pasting tiles on a 10800 stride would shift
    every one of them by about 60 m, and the only symptom would be ridgelines
    that are quietly wrong. so each tile's destination is derived from its own
    affine transform and its own degree square, never from its index."""
    pool = SRC_CPD // cpd
    out = np.full((row1 - row0, col1 - col0), NODATA, np.float32)
    for tlat in range(math.floor(90 - row1 / cpd), math.ceil(90 - row0 / cpd)):
        for tlon in range(math.floor(col0 / cpd) - 180, math.ceil(col1 / cpd) - 180):
            path = tile_path(tlat, tlon)
            if not os.path.exists(path):
                continue
            grow0, gcol0 = (90 - tlat - 1) * cpd, (tlon + 180) * cpd
            a0, a1 = max(row0, grow0), min(row1, grow0 + cpd)
            b0, b1 = max(col0, gcol0), min(col1, gcol0 + cpd)
            if a0 >= a1 or b0 >= b1:
                continue
            with rasterio.open(path) as src:
                pc0, pr0 = (~src.transform) * (float(tlon), float(tlat + 1))
                pc0, pr0 = int(round(pc0)), int(round(pr0))
                for a in range(a0, a1, block):
                    n = min(block, a1 - a)
                    win = Window(pc0 + (b0 - gcol0) * pool, pr0 + (a - grow0) * pool,
                                 (b1 - b0) * pool, n * pool)
                    src_a = src.read(1, window=win).astype(np.float32)
                    src_a[src_a <= NODATA] = NODATA
                    out[a - row0:a - row0 + n, b0 - col0:b1 - col0] = pool_max(src_a, pool)
    return Lattice(out, row0, col0, cpd)


def coarse_lattice(force):
    """the far field grid, cached because building it reads about 7 GB off S:."""
    path = os.path.join(CACHE, 'coarse_1as.npy')
    row0, row1 = (90 - GRID_LAT1) * COARSE_CPD, (90 - GRID_LAT0) * COARSE_CPD
    col0, col1 = (GRID_LON0 + 180) * COARSE_CPD, (GRID_LON1 + 180) * COARSE_CPD
    if not force and os.path.exists(path):
        return Lattice(np.load(path, mmap_mode='r'), row0, col0, COARSE_CPD)
    t = time.time()
    n_tiles = (GRID_LAT1 - GRID_LAT0) * (GRID_LON1 - GRID_LON0)
    print('building the 1 arc-second far field grid, %d tiles off S:, sequential' % n_tiles,
          flush=True)
    lat = read_lattice(COARSE_CPD, row0, row1, col0, col1)

    # np.save appends .npy to a path that does not already end in it, so
    # np.save('x.npy.tmp', a) writes x.npy.tmp.npy and the rename that follows
    # looks for a file that was never created. handing it an open file object
    # instead makes it write exactly where it is told.
    def save_npy(p):
        with open(p, 'wb') as f:
            np.save(f, lat.arr)

    save_atomic(path, save_npy)
    print('far field grid %d x %d in %.0fs' % (lat.arr.shape + (time.time() - t,)), flush=True)
    return lat


def fine_lattice(lat, lon):
    """full resolution around one spot, just big enough for the near field ray."""
    half_lat = int(NEAR / 111320.0 * SRC_CPD) + 2
    half_lon = int(NEAR / (111320.0 * math.cos(math.radians(lat))) * SRC_CPD) + 2
    r = int((90.0 - lat) * SRC_CPD)
    c = int((lon + 180.0) * SRC_CPD)
    return read_lattice(SRC_CPD, r - half_lat, r + half_lat + 1,
                        c - half_lon, c + half_lon + 1, block=400)


# ---------- the raycast ----------

def ray_ranges():
    """the step grows with range: close in, the 10 m posts of the dem are the
    limit; far out, a 10 m step just reads the same cell over and over."""
    out, r = [], MIN_RANGE
    while r <= MAX_RANGE:
        out.append(r)
        r += max(10.0, r / 500.0)
    return np.array(out)


RANGES = ray_ranges()


def raycast(lat, lon, h_eye, fine, coarse):
    """360 azimuths, north at index 0, increasing clockwise. returns the maximum
    apparent altitude per azimuth and the range that produced it."""
    r = RANGES
    az = np.radians(np.arange(360.0))
    # a local tangent plane. over 100 km this is off by a few tenths of a
    # percent in range, far below the 0.022 degree encoding step.
    mlat = 111320.0
    mlon = 111320.0 * math.cos(math.radians(lat))
    lats = lat + r[None, :] * np.cos(az)[:, None] / mlat
    lons = lon + r[None, :] * np.sin(az)[:, None] / mlon

    near = r < NEAR
    h = np.empty(lats.shape, np.float32)
    h[:, near] = fine.sample(lats[:, near], lons[:, near])
    h[:, ~near] = coarse.sample(lats[:, ~near], lons[:, ~near])

    drop = r ** 2 / (2.0 * R_EFF)
    alt = np.degrees(np.arctan2(h - h_eye - drop[None, :], r[None, :]))
    i = alt.argmax(axis=1)
    return alt[np.arange(360), i], r[i]


# ---------- encoding ----------

def encode(alt):
    v = np.clip(np.rint((np.asarray(alt, float) - ALT_MIN) * 4095.0 / ALT_RANGE), 0, 4095)
    return ''.join(B64[x // 64] + B64[x % 64] for x in v.astype(int))


def decode(s):
    return [ALT_MIN + (B64.index(s[2 * i]) * 64 + B64.index(s[2 * i + 1])) * ALT_RANGE / 4095.0
            for i in range(len(s) // 2)]


# ---------- spots, cache, output ----------

SPOT_RE = re.compile(r"""\{ name: (['"])(.*?)\1, lat: (-?[\d.]+), lon: (-?[\d.]+), elev: (-?[\d.]+)""")


# an optional second coordinate, because for a hike-in spot the parking and the
# view are genuinely two different places and the page needs both. the pin and
# the driving directions want the parking; the skyline wants the summit. where
# there is no view:, the two are the same place and the spot coordinate is used.
VIEW_RE = re.compile(r"""\{ name: (['"])(.*?)\1,.*?view: \[(-?[\d.]+), *(-?[\d.]+)\]""")


def parse_spots(html):
    views = {m.group(2): (float(m.group(3)), float(m.group(4)))
             for m in VIEW_RE.finditer(html)}
    spots = []
    for m in SPOT_RE.finditer(html):
        name = m.group(2)
        lat, lon = float(m.group(3)), float(m.group(4))
        vlat, vlon = views.get(name, (lat, lon))
        spots.append({'name': name, 'lat': lat, 'lon': lon,
                      'view_lat': vlat, 'view_lon': vlon,
                      'has_view': name in views, 'elev_ft': float(m.group(5))})
    return spots


def parse_overlooks(html):
    """the generated OVERLOOKS block: one json object per line, written by
    tools/build-overlooks.mjs. a page that has not had it added yet has none."""
    if 'const OVERLOOKS = [' not in html:
        return []
    block = html.split('const OVERLOOKS = [', 1)[1].split('];', 1)[0]
    return [json.loads(line.strip().rstrip(','))
            for line in block.splitlines() if line.strip().startswith('{')]


def slug(name):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', name.lower())).strip('-')


def cache_name(s):
    """overlooks are keyed on their osm id: two can share a name, and one can
    share a name with a curated spot, whose cache is keyed on the name slug."""
    return ('ov-%s.json' % s['ov_id']) if s.get('ov_id') else slug(s['name']) + '.json'


def overlook_horizons_js(overlooks, results):
    body = ''.join('  %s: [%d, %s],\n' % (json.dumps(o['id']), round(results['ov:' + o['id']]['dem_m'] / 0.3048),
                                          json.dumps(encode(results['ov:' + o['id']]['alt'])))
                   for o in overlooks if 'ov:' + o['id'] in results)
    return 'const OVERLOOK_HORIZONS = {\n' + body + '};'


def save_atomic(path, write):
    """temp name, then rename. a killed run must never leave a half written file
    that the next run would take for finished and skip."""
    tmp = path + '.tmp'
    write(tmp)
    os.replace(tmp, path)


def write_json(rec):
    def go(p):
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(rec, f)
    return go


def view_elev_js(spots, results, lots):
    """[lot ft, view ft] for each spot with a walk, both off the dem, so the card
    can show the climb. the hand typed elev cannot do this: it means the view on
    most entries and the parking on a handful."""
    body = ''.join('  %s: [%d, %d],\n' % (json.dumps(s['name']), round(lots[s['name']] / 0.3048),
                                          round(results[s['name']]['dem_m'] / 0.3048))
                   for s in spots if s['has_view'] and s['name'] in results and s['name'] in lots)
    return 'const VIEW_ELEV = {\n' + body + '};'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='say what the real run would do, compute nothing')
    ap.add_argument('--force', action='store_true', help='discard the cache and recompute')
    ap.add_argument('--only', help='run one spot, by case-insensitive name substring')
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    # newline='' on both the read and the write: python would otherwise hand
    # back the file with every crlf translated to lf, the eol sniff below would
    # always say lf, and the rewrite would quietly reline the whole page
    with open(HTML, encoding='utf-8', newline='') as f:
        html = f.read()
    spots = parse_spots(html)
    if not spots:
        sys.exit('no spots found in index.html; the SPOTS block may have been reformatted')
    overlooks = parse_overlooks(html)
    for s in spots:
        s['key'] = s['name']
    ov_spots = [{'name': o['name'], 'key': 'ov:' + o['id'], 'ov_id': o['id'],
                 'lat': o['lat'], 'lon': o['lon'], 'view_lat': o['lat'], 'view_lon': o['lon'],
                 'has_view': False, 'elev_ft': None} for o in overlooks]
    todo = [s for s in spots + ov_spots if not args.only or args.only.lower() in s['name'].lower()]
    if not todo:
        sys.exit('--only %r matched nothing' % args.only)

    # a dry run says what the real run would do and then stops. it deliberately
    # computes nothing: a dry run that does the whole 4 to 6 minutes and throws
    # the answer away is not a preview of the work, it is the work with the
    # ending cut off, and the name lies about what it costs.
    if args.dry_run:
        cached = [s for s in todo if os.path.exists(os.path.join(CACHE, cache_name(s)))]
        fresh = [s for s in todo if s not in cached] if not args.force else todo
        if args.force:
            cached = []
        grid = os.path.join(CACHE, 'coarse_1as.npy')
        have_grid = os.path.exists(grid) and not args.force
        print('%d spots and %d overlooks in index.html, %d selected' % (len(spots), len(overlooks), len(todo)))
        print('  %d already cached, %d to compute' % (len(cached), len(fresh)))
        print('  far field grid: %s' % ('cached, %.0f MB' % (os.path.getsize(grid) / 1e6)
                                        if have_grid else 'not built, about 2 minutes and 777 MB'))
        secs = (0 if have_grid else 120) + 2 * len(fresh)
        print('  estimated %s' % ('nothing to do, index.html rewritten from cache'
                                  if not fresh and have_grid else 'about %d min %02d s' % (secs // 60, secs % 60)))
        for m, label in ((START, 'start'), (END, 'end')):
            if m not in html:
                print('  MISSING the horizons:%s marker; the real run would refuse to write' % label)
        print('  writes: %s' % ('nothing, --only never rewrites index.html' if args.only
                                else 'tools/.horizon-cache/, then the horizons block in index.html'))
        return

    # built on first use, so a resumed run that only has to rewrite index.html
    # never pays for the far field grid at all
    coarse = []

    results = {}
    for i, s in enumerate(todo, 1):
        path = os.path.join(CACHE, cache_name(s))
        if os.path.exists(path) and not args.force:
            with open(path, encoding='utf-8') as f:
                rec = json.load(f)
            # the cache is keyed on the name, so a spot that has since been given
            # a view: would otherwise keep its old parking-lot skyline for ever
            # and the edit would look like it did nothing. compare the coordinate
            # the profile was actually computed from.
            moved = (abs(rec.get('lat', 1e9) - s['view_lat']) > 1e-9
                     or abs(rec.get('lon', 1e9) - s['view_lon']) > 1e-9)
            if not moved:
                results[s['key']] = rec
                print('[%d/%d] %s ... cached' % (i, len(todo), s['name']), flush=True)
                continue
            print('[%d/%d] %s ... coordinate moved, recomputing' % (i, len(todo), s['name']), flush=True)
        t = time.time()
        if not coarse:
            coarse.append(coarse_lattice(args.force))
        fine = fine_lattice(s['view_lat'], s['view_lon'])
        h = float(fine.sample(np.array([s['view_lat']]), np.array([s['view_lon']]))[0])
        if h <= NODATA:
            print('[%d/%d] %s ... skipped, no dem coverage' % (i, len(todo), s['name']), flush=True)
            continue
        alt, rng = raycast(s['view_lat'], s['view_lon'], h + EYE, fine, coarse[0])
        # the cache keeps range to skyline as well as altitude, and only altitude
        # is inlined into index.html. that is deliberate: distance graded haze and
        # peak labels both want the range, and holding it here means adding them
        # later costs an inlining step rather than another 7 GB read off S:.
        rec = {'name': s['name'], 'ov_id': s.get('ov_id'), 'lat': s['view_lat'], 'lon': s['view_lon'],
               'from_view': s['has_view'], 'dem_m': h,
               'alt': [round(float(a), 4) for a in alt],
               'range_m': [float(x) for x in rng]}
        save_atomic(path, write_json(rec))
        results[s['key']] = rec
        print('[%d/%d] %s ... %.1fs' % (i, len(todo), s['name'], time.time() - t), flush=True)

    # 40 hand typed elevations in feet, against the model. a big disagreement
    # usually means the coordinate is the pull-off and the number is the summit,
    # not that the dem is wrong, so this reports and does not correct.
    print()
    bad = 0
    curated = 0
    lots = {}
    for s in todo:
        if s['elev_ft'] is None:
            continue
        rec = results.get(s['key'])
        if not rec:
            continue
        curated += 1
        # compare the listed elev against the coordinate it describes. where a
        # spot carries a view:, elev is the parking, and measuring it against
        # the summit the panorama is drawn from would report a gap that is the
        # walk itself rather than an error.
        if s['has_view']:
            fine = fine_lattice(s['lat'], s['lon'])
            here = float(fine.sample(np.array([s['lat']]), np.array([s['lon']]))[0])
            lots[s['name']] = here
        else:
            here = rec['dem_m']
        d = here - s['elev_ft'] * 0.3048
        if abs(d) > 30:
            bad += 1
            print('elev check: %-36s dem %5.0f ft, listed %5.0f ft, %+5.0f m'
                  % (s['name'], here / 0.3048, s['elev_ft'], d))
    print('elev check: %d of %d spots disagree by more than 30 m' % (bad, curated))
    if bad:
        print('  a large gap usually means the listed coordinate is not the listed viewpoint.')
        print('  the observer stays at the dem height of the coordinate, which is where')
        print('  somebody actually stands; fix SPOTS by hand if a coordinate is wrong.')

    body = '\n'.join('  %s: %s,' % (json.dumps(s['name']), json.dumps(encode(results[s['name']]['alt'])))
                     for s in spots if s['name'] in results)
    block = (START
             + '\nconst HORIZON_ALT_MIN = %g;   // degrees' % ALT_MIN
             + '\nconst HORIZON_ALT_RANGE = %g;  // degrees, so %g .. %g'
             % (ALT_RANGE, ALT_MIN, ALT_MIN + ALT_RANGE)
             + '\nconst HORIZONS = {\n' + body + '\n};\n'
             + view_elev_js(spots, results, lots) + '\n' + overlook_horizons_js(overlooks, results) + '\n' + END)

    print('\n%d spots and %d overlooks, %.1f kB of index.html'
          % (len([s for s in spots if s['key'] in results]),
             len([o for o in overlooks if 'ov:' + o['id'] in results]), len(block.encode()) / 1024))
    if args.only:
        print('--only run, index.html left alone so a partial set cannot replace the full one')
        return

    a, b = html.find(START), html.find(END)
    if a < 0 or b < 0:
        sys.exit('markers missing from index.html')
    # a windows checkout with core.autocrlf on holds the file as crlf; writing an
    # lf-only block into it would leave the page mixed and the diff noisy
    eol = '\r\n' if '\r\n' in html else '\n'
    nxt = html[:a] + block.replace('\n', eol) + html[b + len(END):]
    if nxt == html:
        print('unchanged')
        return
    with open(HTML, 'w', encoding='utf-8', newline='') as f:
        f.write(nxt)
    print('index.html updated')


if __name__ == '__main__':
    main()
