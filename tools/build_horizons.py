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
try:
    import rasterio
    from rasterio.windows import Window
except ModuleNotFoundError:
    # A cache-only run is still useful: it can inline already computed terrain
    # (including the first distance-band migration) on a machine that does not
    # have the raster reader installed. A fresh raycast below names the missing
    # dependency plainly instead of failing before --dry-run can explain work.
    rasterio = None
    Window = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, 'index.html')
CACHE = os.path.join(ROOT, 'tools', '.horizon-cache')
TILES = 'S:\\dem_tiles'
VIEWPOINT_CALIBRATIONS = os.path.join(ROOT, 'tools', 'viewpoint-calibrations.json')

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
EYE = 1.8             # metres: ordinary standing-eye baseline above the DEM
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
# 50 m deliberately keeps the immediate terrain now that the viewer separates
# nearby lidar vegetation from bare earth. It can include a pull-off cut or a
# shoulder of the ridge, which is the point: many parkway overlooks begin
# looking out well inside 150 m. The remaining sub-100 m sensitivity is an
# honest consequence of standing beside that terrain, rather than a reason to
# erase it from every profile.
MIN_RANGE = 50.0

# Retained only to read old caches. New profiles are not distance buckets: a
# deep view gets an adaptive stack of every locally crested, genuinely exposed
# ridgeline that the DEM ray contains.
RIDGE_BANDS = ((MIN_RANGE, 1000.0), (1000.0, 4000.0), (4000.0, 12000.0),
               (12000.0, 35000.0), (35000.0, MAX_RANGE + 1.0))
RIDGE_PROMINENCE = 0.75  # degrees above the nearer visible crest
RIDGE_SAMPLE_M = 50.0    # uniform radial resampling for visual crest finding
RIDGE_SMOOTH_M = 250.0   # merge sub-ridge DEM undulations, not mountains
RIDGE_TRACK_LOG_GAP = 0.22  # adjacent samples of one ridge may move 25% in range
RIDGE_TRACK_MIN_DEG = 12    # a physical ridgeline persists across bearings
RIDGE_LAYER_MODEL = 'terrain-ridge-stack-v7-tracked-continuous'
# 12 bits, the same compact two-character codec as altitude. 25 m steps cover
# the whole 100 km ray, and are much finer than a subtle on-screen label needs.
RANGE_UNIT_M = 25.0

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
    if rasterio is None:
        raise RuntimeError('rasterio is required to read DEM tiles; install tools/requirements.txt')
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


def raycast(lat, lon, h_eye, fine, coarse, layers=False):
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
    skyline = alt[np.arange(360), i]
    if not layers:
        return skyline, r[i]
    stacks, stack_ranges = ridge_stack(alt, r)
    return skyline, r[i], stacks, stack_ranges


def ridge_stack(alt, ranges):
    """The visible terrain crests in every azimuth ray, near to far.

    A farther mountain is seen only if its summit's apparent altitude exceeds
    the nearest already-visible crest.  Instead of asking five arbitrary
    distance bands for their maxima, find real local summits in the sampled
    high-resolution ray and retain every new angular record with meaningful
    prominence.  The number of returned profiles is site-dependent: no fixed
    layer count is imposed.
    """
    sample_ranges = np.arange(ranges[0], ranges[-1] + RIDGE_SAMPLE_M * 0.5, RIDGE_SAMPLE_M)
    half = max(1, round(RIDGE_SMOOTH_M / RIDGE_SAMPLE_M / 2))
    kernel = np.full(2 * half + 1, 1.0 / (2 * half + 1))
    candidates = []
    for row in alt:
        # Terrain cells are much smaller than a named ridge. Resample each
        # non-uniform ray to 50 m and smooth it over 250 m before identifying
        # turning points; the original all-range skyline remains untouched for
        # astronomy below.
        trace = np.interp(sample_ranges, ranges, row)
        smooth = np.convolve(np.pad(trace, half, mode='edge'), kernel, mode='valid')
        # A summit is a turning point in the smoothed apparent elevation. The
        # outer skyline is added explicitly: an unfinished rising slope at the
        # map limit is still a real outer horizon.
        peaks = np.flatnonzero((smooth[1:-1] >= smooth[:-2]) & (smooth[1:-1] > smooth[2:])) + 1
        skyline_i = int(smooth.argmax())
        if skyline_i not in peaks:
            peaks = np.sort(np.append(peaks, skyline_i))
        visible, crest = [], -np.inf
        for at in peaks:
            value = float(smooth[at])
            if value > crest + RIDGE_PROMINENCE:
                visible.append((value, float(sample_ranges[at])))
                crest = value
        # A ray that begins on its highest local shoulder has no interior peak
        # above it, but that shoulder is still its foreground terrain.
        if not visible:
            visible = [(float(smooth[skyline_i]), float(sample_ranges[skyline_i]))]
        candidates.append(visible)

    # A physical ridge changes distance smoothly as it crosses neighbouring
    # bearings.  Tracking candidates that way avoids the false "third crest"
    # fragments made when independent per-ray ranks swap places.
    tracks = []
    for az, row in enumerate(candidates):
        available = [t for t in tracks if az - t['last_az'] <= 2]
        used = set()
        for value, distance in row:
            choices = [(abs(math.log(distance / t['last_range'])), k, t)
                       for k, t in enumerate(available) if k not in used]
            choices = [item for item in choices if item[0] <= RIDGE_TRACK_LOG_GAP]
            if choices:
                _, k, track = min(choices, key=lambda item: item[0])
                used.add(k)
            else:
                track = {'points': []}
                tracks.append(track)
                available.append(track)
                used.add(len(available) - 1)
            track['points'].append((az, value, distance))
            track['last_az'], track['last_range'] = az, distance

    tracks = [t for t in tracks if len(t['points']) >= RIDGE_TRACK_MIN_DEG]
    tracks.sort(key=lambda t: np.median([p[2] for p in t['points']]))
    profiles = [np.full(360, ALT_MIN, dtype=float) for _ in tracks]
    profile_ranges = [np.zeros(360, dtype=float) for _ in tracks]
    for depth, track in enumerate(tracks):
        for az, value, distance in track['points']:
            profiles[depth][az] = max(value, ALT_MIN)
            profile_ranges[depth][az] = distance
    return profiles, profile_ranges


# ---------- encoding ----------

def encode(alt):
    v = np.clip(np.rint((np.asarray(alt, float) - ALT_MIN) * 4095.0 / ALT_RANGE), 0, 4095)
    return ''.join(B64[x // 64] + B64[x % 64] for x in v.astype(int))


def encode_range(ranges):
    v = np.clip(np.rint(np.asarray(ranges, float) / RANGE_UNIT_M), 0, 4095).astype(int)
    return ''.join(B64[x // 64] + B64[x % 64] for x in v)


def legacy_ridge_layers(alt, ranges):
    """A no-new-DEM migration path for existing caches.

    Old records retained the range which supplied each skyline degree. That
    cannot reveal a ridge hidden behind that skyline, but it does faithfully
    separate the existing visible silhouette into near/middle/far bands until
    a --force rebuild can retain the true per-shell maxima.
    """
    out = [np.full(360, ALT_MIN, dtype=float) for _ in RIDGE_BANDS]
    for i, (a, r) in enumerate(zip(alt, ranges)):
        for j, (lo, hi) in enumerate(RIDGE_BANDS):
            if lo <= r < hi:
                out[j][i] = a
                break
    return out


def legacy_ridge_ranges(ranges):
    out = [np.zeros(360, dtype=float) for _ in RIDGE_BANDS]
    for i, r in enumerate(ranges):
        for j, (lo, hi) in enumerate(RIDGE_BANDS):
            if lo <= r < hi:
                out[j][i] = r
                break
    return out


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


# a tower spot: deck: [lat, lon, m], the tower's own coordinate and the
# platform floor in metres above the ground there, on the first line of the
# record like view:. the tower is not where the view: spot is (a clearing 22 to
# 27 m off at both towers, 2026-09-18), so the terrain line is raycast a second
# time from the tower into DECK_HORIZONS, and build_canopy.py reads the same
# field for its own deck profiles.
DECK_RE = re.compile(r"""\{ name: (['"])(.*?)\1,.*?deck: \[(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\]""")


def parse_spots(html):
    views = {m.group(2): (float(m.group(3)), float(m.group(4)))
             for m in VIEW_RE.finditer(html)}
    decks = {m.group(2): [float(m.group(k)) for k in (3, 4, 5)] for m in DECK_RE.finditer(html)}
    spots = []
    for m in SPOT_RE.finditer(html):
        name = m.group(2)
        lat, lon = float(m.group(3)), float(m.group(4))
        vlat, vlon = views.get(name, (lat, lon))
        spots.append({'name': name, 'lat': lat, 'lon': lon,
                      'view_lat': vlat, 'view_lon': vlon,
                      'has_view': name in views, 'elev_ft': float(m.group(5)),
                      'deck': decks.get(name)})
    return spots


def parse_overlooks(html):
    """the generated OVERLOOKS block: one json object per line, written by
    tools/build-overlooks.mjs. a page that has not had it added yet has none."""
    if 'const OVERLOOKS = [' not in html:
        return []
    block = html.split('const OVERLOOKS = [', 1)[1].split('];', 1)[0]
    return [json.loads(line.strip().rstrip(','))
            for line in block.splitlines() if line.strip().startswith('{')]


def viewpoint_calibrations():
    """Small, reviewable corrections for real observation positions.

    An OSM overlook node commonly identifies a pull-off rather than the spot
    where someone puts a chair. Keep rare, measured corrections out of the
    generated OVERLOOKS block so an OSM refresh cannot erase them. ``lat`` and
    ``lon`` are optional; an eye-height correction can use the mapped pin.
    """
    if not os.path.exists(VIEWPOINT_CALIBRATIONS):
        return {}
    with open(VIEWPOINT_CALIBRATIONS, encoding='utf-8') as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError('%s must contain an object keyed by overlook id' % VIEWPOINT_CALIBRATIONS)
    out = {}
    for ov_id, value in raw.items():
        if not isinstance(value, dict):
            raise ValueError('calibration %r must be an object' % ov_id)
        eye = value.get('eye_m', EYE)
        if not isinstance(eye, (int, float)) or not 0.3 <= eye <= 3.0:
            raise ValueError('calibration %r eye_m must be between 0.3 and 3 m' % ov_id)
        point = {}
        for field in ('lat', 'lon'):
            if field in value:
                if not isinstance(value[field], (int, float)):
                    raise ValueError('calibration %r %s must be numeric' % (ov_id, field))
                point[field] = float(value[field])
        if ('lat' in point) != ('lon' in point):
            raise ValueError('calibration %r must give both lat and lon' % ov_id)
        point['eye_m'] = float(eye)
        out[str(ov_id)] = point
    return out


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


def ridge_layers_js(name, items, results, key):
    # Result keys use ``ov:<osm id>`` to avoid collisions with spot names;
    # the page's overlook map is keyed by the bare OSM id.
    page_key = lambda item: key(item)[3:] if key(item).startswith('ov:') else key(item)
    body = ''.join('  %s: [%s],\n' % (json.dumps(page_key(item)),
                                        ', '.join(json.dumps(encode(p)) for p in results[key(item)]['layers']))
                   for item in items if key(item) in results and results[key(item)].get('layers'))
    return 'const %s = {\n%s};' % (name, body)


def ridge_ranges_js(name, items, results, key):
    page_key = lambda item: key(item)[3:] if key(item).startswith('ov:') else key(item)
    body = ''.join('  %s: [%s],\n' % (json.dumps(page_key(item)),
                                        ', '.join(json.dumps(encode_range(p)) for p in results[key(item)]['layer_range_m']))
                   for item in items if key(item) in results and results[key(item)].get('layer_range_m'))
    return 'const %s = {\n%s};' % (name, body)


def horizon_ranges_js(name, items, results, key):
    """The range of the full per-bearing DEM skyline, not only tracked layers."""
    page_key = lambda item: key(item)[3:] if key(item).startswith('ov:') else key(item)
    body = ''.join('  %s: %s,\n' % (json.dumps(page_key(item)),
                                      json.dumps(encode_range(results[key(item)]['range_m'])))
                   for item in items if key(item) in results and results[key(item)].get('range_m'))
    return 'const %s = {\n%s};' % (name, body)


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


def deck_horizons_js(spots, results):
    """the terrain line from the tower deck, for the spots that have one."""
    body = '\n'.join('  %s: %s,' % (json.dumps(s['name']), json.dumps(encode(results[s['name']]['deck_alt'])))
                     for s in spots if results.get(s['name'], {}).get('deck_alt'))
    return 'const DECK_HORIZONS = {\n' + body + '\n};'


# ---------- index.html in and out, shared with build_canopy.py ----------

def read_html():
    # newline='' on both the read and the write: python would otherwise hand
    # back the file with every crlf translated to lf, the eol sniff below would
    # always say lf, and the rewrite would quietly reline the whole page
    with open(HTML, encoding='utf-8', newline='') as f:
        return f.read()


def replace_block(html, start, end, block):
    """the generated block between two markers, replaced. refuses rather than
    guesses when a marker is missing: a page without markers is a page somebody
    reformatted, and appending a block to it would ship two."""
    a, b = html.find(start), html.find(end)
    if a < 0 or b < 0:
        sys.exit('markers %r / %r missing from index.html' % (start, end))
    # a windows checkout with core.autocrlf on holds the file as crlf; writing an
    # lf-only block into it would leave the page mixed and the diff noisy
    eol = '\r\n' if '\r\n' in html else '\n'
    return html[:a] + block.replace('\n', eol) + html[b + len(end):]


def write_html(html):
    with open(HTML, 'w', encoding='utf-8', newline='') as f:
        f.write(html)


def view_elev_js(spots, results, lots):
    """[lot ft, view ft] for each spot with a walk, both off the dem, so the card
    can show the climb. the hand typed elev cannot do this: it means the view on
    most entries and the parking on a handful."""
    body = ''.join('  %s: [%d, %d],\n' % (json.dumps(s['name']), round(lots[s['name']] / 0.3048),
                                          round(results[s['name']]['dem_m'] / 0.3048))
                   for s in spots if s['has_view'] and s['name'] in results and s['name'] in lots)
    return 'const VIEW_ELEV = {\n' + body + '};'


def parse_view_elev(html):
    """Read existing generated walk pairs for a cache-only rewrite."""
    m = re.search(r'const VIEW_ELEV = \{(.*?)\n\};', html, re.S)
    if not m:
        return {}
    return {json.loads(k): json.loads(v)
            for k, v in re.findall(r'^\s*("(?:[^"\\]|\\.)*"):\s*(\[[^\]]+\]),?\s*$', m.group(1), re.M)}


def view_elev_values_js(spots, values):
    body = ''.join('  %s: [%d, %d],\n' % (json.dumps(s['name']), values[s['name']][0], values[s['name']][1])
                   for s in spots if s['has_view'] and s['name'] in values)
    return 'const VIEW_ELEV = {\n' + body + '};'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='say what the real run would do, compute nothing')
    ap.add_argument('--force', action='store_true', help='discard the cache and recompute')
    ap.add_argument('--only', help='run one spot, by case-insensitive name substring')
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    html = read_html()
    spots = parse_spots(html)
    if not spots:
        sys.exit('no spots found in index.html; the SPOTS block may have been reformatted')
    overlooks = parse_overlooks(html)
    preserved_view_elev = parse_view_elev(html)
    for s in spots:
        s['key'] = s['name']
    calibrations = viewpoint_calibrations()
    ov_spots = []
    for o in overlooks:
        calibration = calibrations.get(o['id'], {})
        ov_spots.append({'name': o['name'], 'key': 'ov:' + o['id'], 'ov_id': o['id'],
                         'lat': o['lat'], 'lon': o['lon'],
                         'view_lat': calibration.get('lat', o['lat']),
                         'view_lon': calibration.get('lon', o['lon']),
                         'eye_m': calibration.get('eye_m', EYE),
                         'has_view': bool(calibration), 'elev_ft': None})
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
            # a deck added, removed or retuned recomputes the spot: the deck
            # line is a second raycast, and two seconds beats a stale profile
            redeck = rec.get('deck_at') != s.get('deck')
            reeye = abs(float(rec.get('eye_m', EYE)) - s.get('eye_m', EYE)) > 1e-9
            relayer = (rec.get('layer_model') != RIDGE_LAYER_MODEL
                        or not rec.get('layers') or not rec.get('layer_range_m'))
            if not moved and not redeck and not reeye and not relayer:
                results[s['key']] = rec
                print('[%d/%d] %s ... cached' % (i, len(todo), s['name']), flush=True)
                continue
            if not moved and not redeck and not reeye and relayer and rasterio is None:
                # A cache-only machine still gets an honest, if sparse,
                # migration based on the stored winning skyline ranges.
                if not rec.get('layer_range_m'):
                    rec['layers'] = [[round(float(a), 4) for a in p]
                                     for p in legacy_ridge_layers(rec['alt'], rec.get('range_m', []))]
                    rec['layer_range_m'] = [[float(a) for a in p]
                                            for p in legacy_ridge_ranges(rec.get('range_m', []))]
                rec['layer_model'] = 'skyline-range-fallback-v2'
                save_atomic(path, write_json(rec))
                results[s['key']] = rec
                print('[%d/%d] %s ... cached' % (i, len(todo), s['name']), flush=True)
                continue
            why = ('coordinate moved' if moved else 'deck changed' if redeck else
                   'eye height calibrated' if reeye else 'ridge bands updated')
            print('[%d/%d] %s ... %s, recomputing' % (i, len(todo), s['name'], why), flush=True)
        t = time.time()
        if not coarse:
            coarse.append(coarse_lattice(args.force))
        fine = fine_lattice(s['view_lat'], s['view_lon'])
        h = float(fine.sample(np.array([s['view_lat']]), np.array([s['view_lon']]))[0])
        if h <= NODATA:
            print('[%d/%d] %s ... skipped, no dem coverage' % (i, len(todo), s['name']), flush=True)
            continue
        eye_m = s.get('eye_m', EYE)
        alt, rng, layers, layer_ranges = raycast(s['view_lat'], s['view_lon'], h + eye_m, fine, coarse[0], layers=True)
        deck_alt = None
        if s.get('deck'):
            dlat, dlon, dm = s['deck']
            hd = float(fine.sample(np.array([dlat]), np.array([dlon]))[0])
            deck_alt, _ = raycast(dlat, dlon, hd + EYE + dm, fine, coarse[0])
            deck_alt = [round(float(a), 4) for a in deck_alt]
        # the cache keeps range to skyline as well as altitude, and only altitude
        # is inlined into index.html. that is deliberate: distance graded haze and
        # peak labels both want the range, and holding it here means adding them
        # later costs an inlining step rather than another 7 GB read off S:.
        rec = {'name': s['name'], 'ov_id': s.get('ov_id'), 'lat': s['view_lat'], 'lon': s['view_lon'],
               'from_view': s['has_view'], 'eye_m': eye_m, 'dem_m': h,
               'alt': [round(float(a), 4) for a in alt],
               'range_m': [float(x) for x in rng],
               'layers': [[round(float(a), 4) for a in p] for p in layers],
               'layer_range_m': [[float(a) for a in p] for p in layer_ranges], 'layer_model': RIDGE_LAYER_MODEL,
               'deck_m': s['deck'][2] if s.get('deck') else None, 'deck_at': s.get('deck'), 'deck_alt': deck_alt}
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
    if rasterio is None:
        print('elev check: skipped (rasterio is not installed; cached horizons are still usable)')
    else:
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
             + horizon_ranges_js('HORIZON_RANGES', spots, results, lambda s: s['name']) + '\n'
             + ridge_layers_js('HORIZON_LAYERS', spots, results, lambda s: s['name']) + '\n'
             + ridge_ranges_js('HORIZON_LAYER_RANGES', spots, results, lambda s: s['name']) + '\n'
             + (view_elev_js(spots, results, lots) if rasterio is not None
                else view_elev_values_js(spots, preserved_view_elev)) + '\n'
             + overlook_horizons_js(overlooks, results) + '\n'
             + horizon_ranges_js('OVERLOOK_HORIZON_RANGES', overlooks, results, lambda o: 'ov:' + o['id']) + '\n'
             + ridge_layers_js('OVERLOOK_HORIZON_LAYERS', overlooks, results, lambda o: 'ov:' + o['id']) + '\n'
             + ridge_ranges_js('OVERLOOK_HORIZON_LAYER_RANGES', overlooks, results, lambda o: 'ov:' + o['id']) + '\n'
             + deck_horizons_js(spots, results) + '\n' + END)

    print('\n%d spots and %d overlooks, %.1f kB of index.html'
          % (len([s for s in spots if s['key'] in results]),
             len([o for o in overlooks if 'ov:' + o['id'] in results]), len(block.encode()) / 1024))
    if args.only:
        print('--only run, index.html left alone so a partial set cannot replace the full one')
        return

    nxt = replace_block(html, START, END, block)
    if nxt == html:
        print('unchanged')
        return
    write_html(nxt)
    print('index.html updated')


if __name__ == '__main__':
    main()
