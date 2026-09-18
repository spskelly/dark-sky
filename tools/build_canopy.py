"""trees and structures on every skyline, from the 2017 NC Phase 5 lidar.

the terrain line the page ships starts 150 m out and is bare earth, so the
trees at the edge of a parking lot are not in it at all. this tool fetches
the classified point cloud in a 200 m box around each spot and overlook,
raycasts the vegetation and the built returns directly, and writes two more
profiles per site into index.html between the canopy:start and canopy:end
markers, in the same 12-bit encoding the terrain uses. the page draws them as
their own layers and the sentence names whichever one is in the way.

  python tools/build_canopy.py --dry-run        # sites, cached vs to fetch, est. MB and minutes
  python tools/build_canopy.py                  # resume, then rewrite the canopy block
  python tools/build_canopy.py --only doubletop # one site, index.html left alone
  python tools/build_canopy.py --force          # discard the cache and recompute

the data is the public USGS EPT mirror of the state's 2017 acquisition, one
octree per county in web mercator. only the nodes overlapping the site box
are downloaded, never whole tiles: about 63 MB per county per site. it is
leaf-off and nine growing seasons old, so every tree line here is a floor;
the vintage is written into the page as one constant so a rebuild from the
2025 point clouds, when they arrive, is a re-run and not a redesign.

no rasters and no dem. build_horizons is imported for the refraction radius,
the eye height, the encoder, the spot parser and the block writer.
"""
import argparse
import io
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np

import build_horizons as bh

CACHE = os.path.join(bh.ROOT, 'tools', '.canopy-cache')

START = '// --- canopy:start (generated, do not edit by hand) ---'
END = '// --- canopy:end ---'

VINTAGE = '2017, leaf-off'

EPT = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/'
# the western counties. a dataset is used for a site when its octree has
# points inside the box, so a county-line site needs no lookup; a name the
# bucket does not have (checked 2026-09-17: Alleghany, Wilkes, Surry) is
# skipped with a note. Caldwell and Polk are candidates for boxes that cross
# their lines, not counties with sites of their own.
COUNTIES = ['Ashe', 'Avery', 'Buncombe', 'Burke', 'Caldwell', 'Cherokee', 'Clay', 'Graham',
            'Haywood', 'Henderson', 'Jackson', 'Macon', 'Madison', 'McDowell', 'Mitchell',
            'Polk', 'Rutherford', 'Swain', 'Transylvania', 'Watauga', 'Yancey']
DATASETS = ['NC_Phase5_%s_2017' % c for c in COUNTIES]

RADIUS = 200.0       # metres. canopy past 150 m added 0.7 degrees at cove field, 0.1 at doubletop
MIN_R = 2.0          # metres. closer than this is the observer and the car
DECK_MIN_R = 6.0     # metres. from the deck, the tower's own cab and roof are not a wall
MAX_DEPTH = 10       # octree depth. about 24 points per square metre on haywood, what every spike used
PIN_R = 3.0          # metres. ground returns this close to the pin set the eye height
PIN_R_WIDE = 10.0    # metres. the fallback when the pin sits on a car or a cut
TALL_M = 2.0         # metres above local ground before an unclassified return can be built
GROUND_CELL = 5.0    # metres. the ground grid unclassified returns are measured against
CLUSTER_CELL = 2.0   # metres. an unclassified return needs company in its cell
CLUSTER_MIN = 3      # returns. fewer than this in a cell is a bird or a stray, not a tower
S_MIN_DEG = 0.5      # degrees. structures get a layer only where they stand this far above ridge and trees
WORKERS = 32         # concurrent node downloads. each connection runs at 0.2 to 0.3 MB/s from us-west-2, so throughput scales with connections: 8 gave 1.6 MB/s, 64 about 10 (2026-09-17)
TREES = (3, 4, 5)
GROUND, UNCLASS, BUILDING = 2, 1, 6
NOISE = (7, 18)

R_MERC = 6378137.0


# ---------- the box, in the octree's own projection ----------

def mercator(lat, lon):
    """EPSG:3857, the SRS every EPT dataset here declares. conformal, so grid
    north is true north and azimuths need no convergence correction."""
    return (R_MERC * math.radians(lon),
            R_MERC * math.log(math.tan(math.pi / 4.0 + math.radians(lat) / 2.0)))


def site_box(lat, lon, radius_m=RADIUS):
    """minx, miny, maxx, maxy. 3857 is not metres on the ground: it stretches
    by 1/cos(lat), so a 200 m box is 200/cos(lat) of projected units."""
    x, y = mercator(lat, lon)
    half = radius_m / math.cos(math.radians(lat))
    return (x - half, y - half, x + half, y + half)


# ---------- the octree ----------

def node_bounds(root, key):
    """xy footprint of a node. root is ept.json's bounds, a cube; at depth d
    each axis is split into 2**d equal parts."""
    d, ix, iy, _ = (int(p) for p in key.split('-'))
    sx = (root[3] - root[0]) / 2 ** d
    sy = (root[4] - root[1]) / 2 ** d
    return (root[0] + ix * sx, root[1] + iy * sy, root[0] + (ix + 1) * sx, root[1] + (iy + 1) * sy)


def overlaps(a, b):
    """strict: a shared edge is not an overlap, so a box that ends exactly on
    a node boundary does not drag the node beyond it along."""
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def children(key):
    d, x, y, z = (int(p) for p in key.split('-'))
    return ['%d-%d-%d-%d' % (d + 1, 2 * x + i, 2 * y + j, 2 * z + k)
            for i in (0, 1) for j in (0, 1) for k in (0, 1)]


def nodes_in_box(root, box, page_of, max_depth=MAX_DEPTH):
    """keys of every node with points whose footprint overlaps the box, from
    the root down to max_depth. a hierarchy page maps keys to point counts and
    ends where an entry reads -1: that key's subtree is in its own page, which
    page_of(key) fetches. pages are merged as the walk reaches them, so only
    the pages under the box are ever asked for."""
    counts = dict(page_of('0-0-0-0'))
    out, queue = [], deque(['0-0-0-0'])
    while queue:
        key = queue.popleft()
        n = counts.get(key, 0)
        if n == -1:
            counts.update(page_of(key))
            n = counts.get(key, 0)
        if n <= 0 or not overlaps(node_bounds(root, key), box):
            continue
        out.append(key)
        if int(key.split('-', 1)[0]) < max_depth:
            queue.extend(children(key))
    return out


# ---------- the raycast, straight from the points ----------

def local_xy(x, y, x0, y0, lat):
    """metres east and north of the pin. the mercator offset shrinks by
    cos(lat) to reach the ground; over 200 m the change in that factor is
    nothing."""
    k = math.cos(math.radians(lat))
    return (x - x0) * k, (y - y0) * k


def ground_at_pin(dx, dy, z, cls):
    """the median ground return within PIN_R of the pin, widening to
    PIN_R_WIDE when the pin sits on something that hid the ground. the median
    rather than the mean or the minimum, so one return down a drain does not
    lower the eye."""
    r = np.hypot(dx, dy)
    for pr in (PIN_R, PIN_R_WIDE):
        g = z[(cls == GROUND) & (r <= pr)]
        if g.size:
            return float(np.median(g))
    return None


def skyline(dx, dy, z, eye_z, min_r):
    """the highest apparent altitude per whole degree of azimuth, ALT_MIN where
    nothing was returned. every point is a candidate for its own degree, and
    the maximum is the skyline, which is the same upper-envelope rule the
    terrain raycast follows with max pooling."""
    r = np.hypot(dx, dy)
    keep = r >= min_r
    dx, dy, z, r = dx[keep], dy[keep], z[keep], r[keep]
    out = np.full(360, bh.ALT_MIN)
    if not r.size:
        return out
    az = np.floor(np.degrees(np.arctan2(dx, dy))).astype(np.int64) % 360
    alt = np.degrees(np.arctan2(z - eye_z - r ** 2 / (2.0 * bh.R_EFF), r))
    np.maximum.at(out, az, alt)
    return out


def cell_index(dx, dy, size):
    """one integer per point naming its size x size cell, dense from zero"""
    i = np.floor(dx / size).astype(np.int64)
    j = np.floor(dy / size).astype(np.int64)
    i -= i.min()
    j -= j.min()
    return i * (j.max() + 1) + j


def structure_mask(dx, dy, z, cls):
    """what counts as built: class 6, plus unclassified returns that stand
    TALL_M or more above the ground returns in their GROUND_CELL and have at
    least CLUSTER_MIN neighbours in their CLUSTER_CELL. the 2017 classifier
    left the pisgah tower partly in class 1; a bird is in class 1 too, and the
    difference between them is company."""
    built = cls == BUILDING
    cand = cls == UNCLASS
    grd = cls == GROUND
    if not cand.any() or not grd.any():
        return built
    cell = cell_index(dx, dy, GROUND_CELL)
    n = np.bincount(cell[grd], minlength=cell.max() + 1)
    s = np.bincount(cell[grd], weights=z[grd], minlength=cell.max() + 1)
    with np.errstate(invalid='ignore', divide='ignore'):
        ground = s / n                       # nan where the cell has no ground
        tall = cand & ((z - ground[cell]) >= TALL_M)   # nan compares false
    if not tall.any():
        return built
    cc = cell_index(dx, dy, CLUSTER_CELL)
    k = np.bincount(cc[tall], minlength=cc.max() + 1)
    return built | (tall & (k[cc] >= CLUSTER_MIN))


def profiles_for(x, y, z, cls, lat, lon, deck_m=None):
    """both layers from one site's points, and the deck pair when deck_m is
    set. None when no ground return sits near enough to the pin to put an eye
    on. classes are counted before anything is dropped, so the cache says what
    the survey held, not what this tool kept."""
    x0, y0 = mercator(lat, lon)
    dx, dy = local_xy(x, y, x0, y0, lat)
    ground = ground_at_pin(dx, dy, z, cls)
    if ground is None:
        return None
    counts = {int(k): int(v) for k, v in zip(*np.unique(cls, return_counts=True))}
    keep = ~np.isin(cls, NOISE)
    dx, dy, z, cls = dx[keep], dy[keep], z[keep], cls[keep]
    trees = np.isin(cls, TREES)
    built = structure_mask(dx, dy, z, cls)

    def pair(eye_z, min_r):
        return {'t': [round(float(a), 4) for a in skyline(dx[trees], dy[trees], z[trees], eye_z, min_r)],
                's': [round(float(a), 4) for a in skyline(dx[built], dy[built], z[built], eye_z, min_r)]}

    out = {'ground_m': ground, 'eye_m': ground + bh.EYE, 'classes': counts}
    out.update(pair(ground + bh.EYE, MIN_R))
    out['deck'] = pair(ground + deck_m + bh.EYE, DECK_MIN_R) if deck_m else None
    return out


# ---------- sites, cache, the block ----------

def site_list(html):
    """every spot and overlook in the page, in an order that keeps geographic
    neighbours together: the octree nodes a parkway overlook needs are mostly
    the ones the next pull-off needs, and the in-memory node cache only helps
    when those two run back to back."""
    spots = [{'name': s['name'], 'key': s['name'], 'ov_id': None,
              'view_lat': s['view_lat'], 'view_lon': s['view_lon'], 'deck': s['deck']}
             for s in bh.parse_spots(html)]
    ovs = [{'name': o['name'], 'key': 'ov:' + o['id'], 'ov_id': o['id'],
            'view_lat': o['lat'], 'view_lon': o['lon'], 'deck': None}
           for o in bh.parse_overlooks(html)]
    # 0.05 degree bands of latitude, west to east within a band
    return sorted(spots + ovs, key=lambda s: (round(s['view_lat'] / 0.05), s['view_lon']))


def page_key(site):
    """the key the page already uses: the osm id for an overlook, the name
    for a spot. an overlook name can repeat; an id cannot."""
    return site['ov_id'] or site['name']


def cache_path(site):
    return os.path.join(CACHE, bh.cache_name({'name': site['name'], 'ov_id': site['ov_id']}))


def cache_ok(rec, site):
    """a finished record is taken only when everything it was computed from
    still holds: the coordinate, the radius, the deck height and the list of
    datasets it was allowed to look in. a new county in DATASETS recomputes
    every site, which is the point of recording the list."""
    return (abs(rec.get('lat', 1e9) - site['view_lat']) < 1e-9
            and abs(rec.get('lon', 1e9) - site['view_lon']) < 1e-9
            and rec.get('radius_m') == RADIUS
            and rec.get('deck_m') == site.get('deck')
            and rec.get('candidates') == DATASETS)


def load_cached(site):
    """the finished record, or None. only the final name counts: a .tmp left
    by a killed run is a file that was never renamed, and so never finished."""
    path = cache_path(site)
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        rec = json.load(f)
    return rec if cache_ok(rec, site) else None


def terrain_for(site):
    """what build_horizons cached for the same place, so the block can decide
    whether structures clear the ridge. {} when the terrain has not been built."""
    path = os.path.join(bh.CACHE, bh.cache_name({'name': site['name'], 'ov_id': site['ov_id']}))
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def needs_s(s_alt, t_alt, terrain_alt):
    """structures earn a layer only where they stand S_MIN_DEG above both the
    ridge and the trees somewhere: a shed under the canopy is not a layer."""
    base = np.maximum(np.asarray(t_alt, float),
                      np.asarray(terrain_alt, float) if terrain_alt is not None else bh.ALT_MIN)
    return bool(np.any(np.asarray(s_alt, float) - base >= S_MIN_DEG))


def canopy_entry(rec, terrain):
    e = {'t': bh.encode(rec['t'])}
    if needs_s(rec['s'], rec['t'], terrain.get('alt')):
        e['s'] = bh.encode(rec['s'])
    if rec.get('deck'):
        d = {'m': rec['deck_m'], 't': bh.encode(rec['deck']['t'])}
        if needs_s(rec['deck']['s'], rec['deck']['t'], terrain.get('deck_alt')):
            d['s'] = bh.encode(rec['deck']['s'])
        e['deck'] = d
    return e


def canopy_js(sites, results, terrain):
    """the generated block. one json object per line so check_alignment.py
    can read an entry without evaluating the page."""
    lines = []
    for s in sites:
        rec = results.get(s['key'])
        if not rec or rec.get('t') is None:
            continue
        e = canopy_entry(rec, terrain.get(s['key'], {}))
        lines.append('  %s: %s,' % (json.dumps(page_key(s)), json.dumps(e, separators=(',', ':'))))
    return (START + "\nconst CANOPY_VINTAGE = '%s';\nconst CANOPY = {\n" % VINTAGE
            + '\n'.join(lines) + '\n};\n' + END)


# ---------- fetching ----------

# bytes urlopen has actually returned, across every worker thread. a site's
# own 'bytes' field counts what its box needed even on a cache hit, since
# that is the site's data size; this counter is only what came over the
# wire, for main() to report the run's real throughput against.
_net_lock = threading.Lock()
_net_bytes = 0


def net_bytes():
    return _net_bytes


def http_get(url, tries=4):
    """stdlib, with backoff. a 404 is an answer, not a failure to retry."""
    global _net_bytes
    err = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            with _net_lock:
                _net_bytes += len(data)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            err = e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            err = e
        if i < tries - 1:
            time.sleep(2 ** i)
    raise err


@lru_cache(maxsize=None)
def ept_root(dataset):
    """ept.json's bounds, or None when the bucket has no such dataset"""
    try:
        return json.loads(http_get(EPT + dataset + '/ept.json'))['bounds']
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


@lru_cache(maxsize=None)
def hierarchy_page(dataset, key):
    return json.loads(http_get(EPT + dataset + '/ept-hierarchy/' + key + '.json'))


# the raw laz bytes, not the decoded arrays: 512 nodes is about 300 MB of
# bytes and would be several GB of float64. decoding again costs tens of
# milliseconds, the download it saves costs seconds.
@lru_cache(maxsize=512)
def node_bytes(dataset, key):
    return http_get(EPT + dataset + '/ept-data/' + key + '.laz')


def read_points(blob):
    import laspy
    las = laspy.read(io.BytesIO(blob))
    return (np.asarray(las.x, float), np.asarray(las.y, float), np.asarray(las.z, float),
            np.asarray(las.classification, np.int64))


def fetch_site(lat, lon, radius_m=RADIUS):
    """every point inside the box, from every dataset that has any. returns
    x, y, z, cls, the datasets that contributed points, the node count and
    the bytes fetched (cache hits included, since they were fetched once)."""
    box = site_box(lat, lon, radius_m)
    jobs = []
    for ds in DATASETS:
        root = ept_root(ds)
        if root is None or not overlaps((root[0], root[1], root[3], root[4]), box):
            continue
        keys = nodes_in_box(root, box, lambda k, ds=ds: hierarchy_page(ds, k))
        jobs += [(ds, k) for k in keys]
    with ThreadPoolExecutor(WORKERS) as pool:
        blobs = list(pool.map(lambda j: node_bytes(*j), jobs))
    parts, per_ds = [], {}
    for (ds, _), blob in zip(jobs, blobs):
        x, y, z, c = read_points(blob)
        m = (x >= box[0]) & (x <= box[2]) & (y >= box[1]) & (y <= box[3])
        if m.any():
            parts.append((x[m], y[m], z[m], c[m]))
            per_ds[ds] = per_ds.get(ds, 0) + int(m.sum())
    if not parts:
        e = np.zeros(0)
        return e, e, e, e.astype(np.int64), [], len(jobs), sum(len(b) for b in blobs)
    cols = [np.concatenate([p[i] for p in parts]) for i in range(4)]
    return cols[0], cols[1], cols[2], cols[3].astype(np.int64), sorted(per_ds), len(jobs), sum(len(b) for b in blobs)


# ---------- the run ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='say what the real run would do, fetch nothing')
    ap.add_argument('--force', action='store_true', help='discard the cache and recompute')
    ap.add_argument('--only', help='run one site, by case-insensitive name substring')
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    html = bh.read_html()
    sites = site_list(html)
    if not sites:
        sys.exit('no spots found in index.html; the SPOTS block may have been reformatted')
    todo = [s for s in sites if not args.only or args.only.lower() in s['name'].lower()]
    if not todo:
        sys.exit('--only %r matched nothing' % args.only)

    cached = [] if args.force else [s for s in todo if load_cached(s)]
    fresh = [s for s in todo if s not in cached]

    # a dry run says what the real run would do and stops. it fetches nothing,
    # not even hierarchy pages: the estimate below is from the 2026-09-17
    # timing run (sites 83 to 111 MB, 25 to 40 s a site at 32 to 64 workers,
    # with only 10 to 25 percent of a site's nodes reused from its neighbour)
    # and the real run prints the real numbers as it goes.
    if args.dry_run:
        print('%d sites in index.html, %d selected' % (len(sites), len(todo)))
        print('  %d already cached, %d to fetch' % (len(cached), len(fresh)))
        print('  estimated %.1f GB over the network, about %d min' % (len(fresh) * 95 / 1000, len(fresh) * 30 // 60 + 1))
        print('  datasets tried: %d (%s ... %s)' % (len(DATASETS), DATASETS[0], DATASETS[-1]))
        for m, label in ((START, 'start'), (END, 'end')):
            if m not in html:
                print('  MISSING the canopy:%s marker; the real run would refuse to write' % label)
        print('  writes: %s' % ('nothing, --only never rewrites index.html' if args.only
                                else 'tools/.canopy-cache/, then the canopy block in index.html'))
        return

    results = {}
    failed = []
    t0 = time.time()
    net0 = net_bytes()
    for i, s in enumerate(todo, 1):
        rec = None if args.force else load_cached(s)
        if rec:
            results[s['key']] = rec
            print('[%d/%d] %s ... cached' % (i, len(todo), s['name']), flush=True)
            continue
        t = time.time()
        # a node fetch that exhausts its retries is one site's bad luck, not the
        # whole run's: no cache file is written for it, so the next run of the
        # same command picks it back up where this one left it.
        try:
            x, y, z, c, used, nodes, nbytes = fetch_site(s['view_lat'], s['view_lon'])
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, TimeoutError) as e:
            failed.append(s)
            print('[%s] %s ... fetch failed: %s' % (time.strftime('%H:%M:%S'), s['name'], e), flush=True)
            continue
        rec = {'name': s['name'], 'ov_id': s['ov_id'], 'lat': s['view_lat'], 'lon': s['view_lon'],
               'radius_m': RADIUS, 'deck_m': s['deck'], 'candidates': DATASETS, 'datasets': used,
               'nodes': nodes, 'bytes': nbytes, 'vintage': VINTAGE, 't': None, 's': None, 'deck': None}
        prof = profiles_for(x, y, z, c, s['view_lat'], s['view_lon'], s['deck']) if used else None
        if prof is None:
            rec['reason'] = 'no lidar in any dataset' if not used else 'no ground return within %g m of the pin' % PIN_R_WIDE
            print('[%s] %s ... %s, left out' % (time.strftime('%H:%M:%S'), s['name'], rec['reason']), flush=True)
        else:
            rec.update(prof)
            terrain = terrain_for(s)
            if terrain and abs(terrain['dem_m'] - prof['ground_m']) > 5:
                print('  elev check: %s lidar ground %.1f m, 3dep %.1f m' % (s['name'], prof['ground_m'], terrain['dem_m']))
        bh.save_atomic(cache_path(s), bh.write_json(rec))
        results[s['key']] = rec
        # nbytes is this site's box, cache hits included; net/mbps is what the
        # run has actually pulled over the wire since it started, since the two
        # can differ a lot once neighbouring sites start sharing octree nodes.
        elapsed = time.time() - t0
        net = net_bytes() - net0
        mbps = (net / 1e6) / elapsed if elapsed > 0 else 0.0
        print('[%s] [%d/%d] %s ... %d datasets, %d nodes, %.0f MB, %.1fs, net %.0f MB at %.1f MB/s'
              % (time.strftime('%H:%M:%S'), i, len(todo), s['name'], len(used), nodes, nbytes / 1e6,
                 time.time() - t, net / 1e6, mbps), flush=True)

    have = [s for s in todo if results.get(s['key'], {}).get('t') is not None]
    print('\n%d of %d sites have canopy, %.0f s' % (len(have), len(todo), time.time() - t0))
    for s in todo:
        if s in failed:
            continue
        r = results.get(s['key'], {})
        if r.get('t') is None:
            print('  no canopy: %s (%s)' % (s['name'], r.get('reason', 'not computed')))
    if failed:
        print('  %d site(s) failed to fetch and were left uncached; re-run the same command to retry them:' % len(failed))
        for s in failed:
            print('    %s' % s['name'])

    block = canopy_js(sites, results, {s['key']: terrain_for(s) for s in have})
    print('%.1f kB of index.html' % (len(block.encode()) / 1024))
    if args.only:
        print('--only run, index.html left alone so a partial set cannot replace the full one')
        return
    if failed:
        print('%d site(s) failed; index.html left alone so a partial run never drops their entries' % len(failed))
        return
    nxt = bh.replace_block(html, START, END, block)
    if nxt == html:
        print('unchanged')
        return
    bh.write_html(nxt)
    print('index.html updated')


if __name__ == '__main__':
    main()
