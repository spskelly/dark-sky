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
TREE_MAX_M = 50.0   # metres above local ground. no tree near these sites is this tall; the 2017 classifier put the pisgah broadcast tower in the vegetation classes (2026-09-17 live check), and this is what moves it
GROUND_CELL = 5.0    # metres. the ground grid unclassified returns are measured against
CLUSTER_CELL = 2.0   # metres. an unclassified return needs company in its cell
CLUSTER_MIN = 3      # returns. fewer than this in a cell is a bird or a stray, not a tower
S_MIN_DEG = 0.5      # degrees. structures get a layer only where they stand this far above ridge and trees
CLOSED_DEG = 30.0    # degrees. a median tree altitude over this puts the pin in or against the canopy (2026-09-18: 40 of 150 sites). placeholder, from two probed sites
SEARCH_R = 60.0      # metres. how far from the pin a standing spot may be proposed; 30 found nothing at three of four probed sites and devil's courthouse's best sat on its edge (2026-09-18). placeholder
LEVEL_M = 10.0       # metres. the spot's ground within this of the pin's; 3 shut out devil's courthouse's spot 6 m up, and 10 still keeps a cliff lip from being swapped for its 20 m foot (2026-09-18). placeholder
CAND_STEP = 2.0      # metres between candidate spots, the spacing the 2026-09-18 probe used. placeholder
SKY_R = 100.0        # metres past SEARCH_R that trees are gridded; SEARCH_R + SKY_R stays inside RADIUS, the box that was fetched. placeholder
CONFIRM_DEG = 15.0   # degrees over CLOSED_DEG a candidate's grid median may read and still be raycast through the raw points; the grid read 10.7 high on average at wayah bald (20 candidates, 2026-09-18), so this leaves margin. placeholder
CONFIRM_MAX = 40     # candidates raycast through the raw points at most, so a closed site costs a bounded time. placeholder
OPEN_DEG = 20.0      # degrees. an azimuth whose tree line is under this counts as open sky, the cut the 2026-09-18 probe counted. placeholder
CLEAR_H = 3.0        # metres of vegetation over the ground before it is in the way, over the walk and over a candidate spot's own cell; shrubs under this are not. placeholder
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


def skyline(dx, dy, z, eye_z, min_r, cell=0.0):
    """the highest apparent altitude per whole degree of azimuth, ALT_MIN where
    nothing was returned. every point is a candidate for its own degree, and
    the maximum is the skyline, which is the same upper-envelope rule the
    terrain raycast follows with max pooling. with cell set, each point is
    the centre of a square that wide and fills every degree it spans: a 1 m
    cell 12 m off spans 5 degrees, and one degree per cell left a third of
    the sky inside a solid ring of trees reading as open."""
    r = np.hypot(dx, dy)
    keep = r >= min_r
    dx, dy, z, r = dx[keep], dy[keep], z[keep], r[keep]
    out = np.full(360, bh.ALT_MIN)
    if not r.size:
        return out
    deg = np.degrees(np.arctan2(dx, dy))
    az = np.floor(deg).astype(np.int64)
    alt = np.degrees(np.arctan2(z - eye_z - r ** 2 / (2.0 * bh.R_EFF), r))
    np.maximum.at(out, az % 360, alt)
    if cell:
        w = np.degrees(np.arctan2(cell / 2.0, r))
        lo, hi = np.floor(deg - w).astype(np.int64), np.floor(deg + w).astype(np.int64)
        # ponytail: one pass per degree of the widest cell (about 14 at MIN_R), over every cell each pass
        for s in range(1, int(max((hi - az).max(), (az - lo).max())) + 1):
            m = az + s <= hi
            np.maximum.at(out, (az[m] + s) % 360, alt[m])
            m = az - s >= lo
            np.maximum.at(out, (az[m] - s) % 360, alt[m])
    return out


def cell_index(dx, dy, size):
    """one integer per point naming its size x size cell, dense from zero"""
    i = np.floor(dx / size).astype(np.int64)
    j = np.floor(dy / size).astype(np.int64)
    i -= i.min()
    j -= j.min()
    return i * (j.max() + 1) + j


def structure_mask(dx, dy, z, cls):
    """what counts as built: class 6, plus two returns the classifier missed.
    an unclassified return that stands TALL_M or more above the ground
    returns in its GROUND_CELL and has at least CLUSTER_MIN neighbours in its
    CLUSTER_CELL is built; company is what tells that return apart from a
    bird, since both are class 1. a vegetation-classed (TREES) return that
    stands TREE_MAX_M or more above that same ground mean is built too, with
    no company requirement, since a 50 m return is never a bird: the 2017
    classifier put the whole pisgah broadcast tower in classes 3/4/5, not
    class 1 as once assumed (2026-09-17 live check), so height alone has to
    carry that rule."""
    built = cls == BUILDING
    unclass = cls == UNCLASS
    tree = np.isin(cls, TREES)
    grd = cls == GROUND
    if not grd.any() or not (unclass.any() or tree.any()):
        return built
    cell = cell_index(dx, dy, GROUND_CELL)
    n = np.bincount(cell[grd], minlength=cell.max() + 1)
    s = np.bincount(cell[grd], weights=z[grd], minlength=cell.max() + 1)
    with np.errstate(invalid='ignore', divide='ignore'):
        ground = s / n                        # nan where the cell has no ground
        above = z - ground[cell]              # nan where the cell has no ground
        tall = unclass & (above >= TALL_M)    # nan compares false
        very_tall = tree & (above >= TREE_MAX_M)   # same rule, no company needed
    if tall.any():
        cc = cell_index(dx, dy, CLUSTER_CELL)
        k = np.bincount(cc[tall], minlength=cc.max() + 1)
        built = built | (tall & (k[cc] >= CLUSTER_MIN))
    return built | very_tall


def profiles_for(x, y, z, cls, lat, lon, deck_m=None):
    """both layers from one site's points, and the deck pair when deck_m is
    set. None when no ground return sits near enough to the pin to put an eye
    on. classes are counted before anything is dropped, so the cache says what
    the survey held, not what this tool kept. a TREES return that structure_mask
    has routed to built is a structure, not also a tree, so every return ends
    up in exactly one of the two layers."""
    x0, y0 = mercator(lat, lon)
    dx, dy = local_xy(x, y, x0, y0, lat)
    ground = ground_at_pin(dx, dy, z, cls)
    if ground is None:
        return None
    counts = {int(k): int(v) for k, v in zip(*np.unique(cls, return_counts=True))}
    keep = ~np.isin(cls, NOISE)
    dx, dy, z, cls = dx[keep], dy[keep], z[keep], cls[keep]
    built = structure_mask(dx, dy, z, cls)
    trees = np.isin(cls, TREES) & ~built

    def pair(eye_z, min_r):
        return {'t': [round(float(a), 4) for a in skyline(dx[trees], dy[trees], z[trees], eye_z, min_r)],
                's': [round(float(a), 4) for a in skyline(dx[built], dy[built], z[built], eye_z, min_r)]}

    out = {'ground_m': ground, 'eye_m': ground + bh.EYE, 'classes': counts}
    out.update(pair(ground + bh.EYE, MIN_R))
    out['deck'] = pair(ground + deck_m + bh.EYE, DECK_MIN_R) if deck_m else None
    return out


# ---------- where a person would stand ----------

def closed_in(rec):
    """the pin is in or against the canopy: its median tree altitude, read the
    way the page reads it (capped at the top of the encoding), is over
    CLOSED_DEG"""
    if rec.get('t') is None:
        return False
    return float(np.median(np.minimum(rec['t'], bh.ALT_MIN + bh.ALT_RANGE))) > CLOSED_DEG


def open_pct(t):
    """percent of the 360 azimuths whose tree line is under OPEN_DEG"""
    return float(np.mean(np.asarray(t, float) < OPEN_DEG) * 100.0)


def sky_grid(dx, dy, z, cls):
    """1 m cells over the square SEARCH_R + SKY_R either side of the pin: the
    lowest ground return in each (the surface you stand on, nan when none)
    and the highest vegetation return (-inf when none), plus the cell centres
    along one axis. a grid rather than the points: the box is millions of
    returns and every candidate raycasts all of it."""
    half = SEARCH_R + SKY_R
    near = (np.abs(dx) < half) & (np.abs(dy) < half)
    dx, dy, z, cls = dx[near], dy[near], z[near], cls[near]
    n = int(2 * half)
    i = np.clip(np.floor(dx + half).astype(np.int64), 0, n - 1)
    j = np.clip(np.floor(dy + half).astype(np.int64), 0, n - 1)
    g = np.full((n, n), np.nan)
    gm = cls == GROUND
    np.fmin.at(g, (i[gm], j[gm]), z[gm])
    top = np.full((n, n), -np.inf)
    tm = np.isin(cls, TREES)
    np.maximum.at(top, (i[tm], j[tm]), z[tm])
    return g, top, np.arange(n) - half + 0.5


def sky_candidates(dx, dy, z, cls, ground):
    """every CAND_STEP lattice point within SEARCH_R of the pin, the pin among
    them, whose cell has ground within LEVEL_M of the pin's, with the tree
    skyline raycast from a standing eye in that cell over every vegetated
    cell's top. measuring the sky is the point: a clearance test around the
    cell refused every slope (a shrub on ground uphill reads as a tree) and
    took small gaps whose sky was still the trees a few metres off.
    cx, cy (cell centre, metres from the pin), dz (its ground minus the
    pin's), median tree altitude capped as closed_in caps it, and open_pct."""
    g, top, c = sky_grid(dx, dy, z, cls)
    veg = np.isfinite(top)
    X, Y = np.meshgrid(c, c, indexing='ij')
    vx, vy, vz = X[veg], Y[veg], top[veg]
    k = int(SEARCH_R // CAND_STEP)
    at = np.arange(-k, k + 1) * CAND_STEP
    idx = np.floor(at + SEARCH_R + SKY_R).astype(np.int64)
    cap = bh.ALT_MIN + bh.ALT_RANGE
    out = []
    for a, i in zip(at, idx):
        for b, j in zip(at, idx):
            if math.hypot(a, b) > SEARCH_R or not abs(g[i, j] - ground) <= LEVEL_M:   # nan fails too
                continue
            # a crown over the cell itself is inside MIN_R, so the raycast
            # would not see it and the spot came out as the last tree of a
            # stand, looking out past its own branches. from under a crown
            # the sky is the crown.
            if top[i, j] - g[i, j] >= CLEAR_H:
                t = np.full(360, cap)
            else:
                t = skyline(vx - c[i], vy - c[j], vz, g[i, j] + bh.EYE, MIN_R, cell=1.0)
            out.append((c[i], c[j], g[i, j] - ground, float(np.median(np.minimum(t, cap))), open_pct(t)))
    return tuple(np.array(col, float) for col in zip(*out)) if out else tuple(np.zeros(0) for _ in range(5))


def pick_spot(cx, cy, median):
    """index of the nearest candidate whose median is at or under CLOSED_DEG,
    or None"""
    ok = np.asarray(median) <= CLOSED_DEG
    if not ok.any():
        return None
    return int(np.argmin(np.where(ok, np.hypot(cx, cy), np.inf)))


def confirm_spot(dx, dy, z, cls, ground, cx, cy, dz, med):
    """the grid screens, the raw points decide. the grid's cell tops read
    about 10 degrees high on leaf-off crowns, so every candidate within
    CONFIRM_DEG of CLOSED_DEG on the grid, nearest first and at most
    CONFIRM_MAX of them, is raycast again through the raw vegetation returns
    within SKY_R of it, stopping at the first at or under CLOSED_DEG.
    returns that candidate's index (or None) and the raw medians, inf where
    none was run. a candidate under its own crown reads the cap on the grid,
    so it never reaches this check."""
    raw = np.full(len(med), np.inf)
    tm = np.isin(cls, TREES)
    tx, ty, tz = dx[tm], dy[tm], z[tm]
    cap = bh.ALT_MIN + bh.ALT_RANGE
    order = [k for k in np.argsort(np.hypot(cx, cy), kind='stable') if med[k] <= CLOSED_DEG + CONFIRM_DEG]
    for k in order[:CONFIRM_MAX]:
        near = (np.abs(tx - cx[k]) < SKY_R) & (np.abs(ty - cy[k]) < SKY_R)
        t = skyline(tx[near] - cx[k], ty[near] - cy[k], tz[near], ground + dz[k] + bh.EYE, MIN_R)
        raw[k] = float(np.median(np.minimum(t, cap)))
        if raw[k] <= CLOSED_DEG:
            break
    return pick_spot(cx, cy, raw), raw


def from_local(dx, dy, lat, lon):
    """local_xy the other way: the point dx, dy metres east and north of
    lat, lon, back to degrees through the same mercator"""
    x0, y0 = mercator(lat, lon)
    k = math.cos(math.radians(lat))
    x, y = x0 + dx / k, y0 + dy / k
    return math.degrees(2.0 * math.atan(math.exp(y / R_MERC)) - math.pi / 2.0), math.degrees(x / R_MERC)


def walk_under_trees(dx, dy, z, cls, ground, spot):
    """metres of the straight walk from the pin to the spot that pass within a
    metre of vegetation standing CLEAR_H over the pin's ground. 0 is an open
    line; anything else is a walk the card may need to mention"""
    d = math.hypot(*spot)
    tm = np.isin(cls, TREES) & (z - ground > CLEAR_H)
    tx, ty = dx[tm], dy[tm]
    covered = 0
    for s in np.arange(0.5, d, 1.0):
        px, py = spot[0] * s / d, spot[1] * s / d
        if np.any((np.abs(tx - px) < 1.0) & (np.abs(ty - py) < 1.0)):
            covered += 1
    return covered


def suggest(site, rec):
    """one review row for a closed-in site. the after number is raycast from
    the spot through the pin's own box, which is up to SEARCH_R (60 m) short
    on the far side; the real rebuild fetches the spot's own box."""
    lat, lon = site['view_lat'], site['view_lon']
    x, y, z, c, _, _, _ = fetch_site(lat, lon)
    x0, y0 = mercator(lat, lon)
    dx, dy = local_xy(x, y, x0, y0, lat)
    ground = ground_at_pin(dx, dy, z, c)
    top = bh.ALT_MIN + bh.ALT_RANGE
    row = {'name': site['name'], 'key': site['key'], 'lat': lat, 'lon': lon,
           'before': float(np.median(np.minimum(rec['t'], top))), 'open_before': open_pct(rec['t']), 'spot': None}
    cx, cy, dz, med, _ = sky_candidates(dx, dy, z, c, ground) if ground is not None else [np.zeros(0)] * 5
    k, raw = confirm_spot(dx, dy, z, c, ground, cx, cy, dz, med)
    if k is not None:
        spot = (float(cx[k]), float(cy[k]))
        slat, slon = from_local(spot[0], spot[1], lat, lon)
        p = profiles_for(x, y, z, c, slat, slon)
        row.update(spot=(round(slat, 6), round(slon, 6)), moved_m=math.hypot(*spot),
                   bearing=math.degrees(math.atan2(spot[0], spot[1])) % 360, dz_m=float(dz[k]),
                   after=float(np.median(np.minimum(p['t'], top))) if p else None,
                   open_after=open_pct(p['t']) if p else None,
                   under_trees_m=walk_under_trees(dx, dy, z, c, ground, spot))
    elif len(med):
        # the lowest candidate, nearest first on a tie (every one under a
        # crown reads the cap), so the table can say how far off it is. the
        # raw figure when any raw check ran, the grid's when none did
        by = 'raw' if np.isfinite(raw).any() else 'grid'
        m = raw if by == 'raw' else med
        b = int(np.lexsort((np.hypot(cx, cy), m))[0])
        row.update(best_m=math.hypot(cx[b], cy[b]), best_median=float(m[b]), best_dz_m=float(dz[b]), best_by=by)
    row['params'] = suggest_params()
    return row


def suggest_params():
    """the tunables a saved row was computed with; a retuned constant is a
    reason to recompute, the same as a moved pin"""
    return [CLOSED_DEG, SEARCH_R, LEVEL_M, CAND_STEP, SKY_R, OPEN_DEG, CLEAR_H, CONFIRM_DEG, CONFIRM_MAX]


def suggest_path(site):
    return os.path.join(CACHE, 'suggest', bh.cache_name({'name': site['name'], 'ov_id': site.get('ov_id')}))


def suggest_ok(row, site):
    """a saved row is taken only when the coordinate it was computed for and
    the tunables it used still match, the same test cache_ok runs for the
    canopy cache itself."""
    return (abs(row.get('lat', 1e9) - site['view_lat']) < 1e-9
            and abs(row.get('lon', 1e9) - site['view_lon']) < 1e-9
            and row.get('params') == suggest_params())


def load_suggested(site):
    """the saved review row for a site, or None. only the final name counts:
    a .tmp left by a killed run was never renamed, and so never finished."""
    path = suggest_path(site)
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        row = json.load(f)
    return row if suggest_ok(row, site) else None


def no_spot(r):
    """what the table and the run say for a site with no spot: how close the
    best candidate came, when there was one"""
    out = 'none under %g within %g m' % (CLOSED_DEG, SEARCH_R)
    if r.get('best_m') is not None:
        out += '; best %.0f at %.0f m, %.0f m %s%s' % (r['best_median'], r['best_m'], abs(r['best_dz_m']),
                                                      'up' if r['best_dz_m'] >= 0 else 'down',
                                                      ' (grid)' if r.get('best_by') == 'grid' else '')
    return out


def review_md(rows):
    """the table shawn reviews: one row per closed-in site, most closed first,
    with satellite links for the pin and the proposed spot"""
    sat = 'https://www.google.com/maps/@%.6f,%.6f,40m/data=!3m1!1e3'
    out = ['# Canopy standing spots for review', '',
           'Sites whose median tree altitude from the pin is over %g degrees. For each: approve the '
           'proposed spot, reject it (the site really is under trees), or give a better coordinate, and '
           'say whether the walk to it needs a line on the card. "now" and "open now" are from the '
           'pin, "then" and "open then" from the spot: the median tree altitude, and the percent of '
           'azimuths whose tree line is under %g degrees. "up/down" is the spot\'s ground against the '
           'pin\'s; "walk under trees" is metres of the straight line from the pin that pass under a '
           'crown.' % (CLOSED_DEG, OPEN_DEG), '',
           '| site | key | now | open now | proposed | moved | bearing | up/down | then | open then | walk under trees | pin | spot |',
           '|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---|---|']
    for r in sorted(rows, key=lambda r: -r['before']):
        pin = '[pin](%s)' % (sat % (r['lat'], r['lon']))
        if r['spot'] is None:
            out.append('| %s | %s | %.0f | %.0f%% | %s | | | | | | | %s | |' % (
                r['name'], r['key'], r['before'], r['open_before'], no_spot(r), pin))
            continue
        out.append('| %s | %s | %.0f | %.0f%% | %.6f, %.6f | %.0f m | %03d | %+.1f m | %s | %s | %d m | %s | [spot](%s) |' % (
            r['name'], r['key'], r['before'], r['open_before'], r['spot'][0], r['spot'][1], r['moved_m'],
            round(r['bearing']) % 360, r['dz_m'], 'n/a' if r['after'] is None else '%.0f' % r['after'],
            'n/a' if r['open_after'] is None else '%.0f%%' % r['open_after'], r['under_trees_m'], pin,
            sat % tuple(r['spot'])))
    return '\n'.join(out) + '\n'


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


# the raw ept files, kept. every file a site box touches is written here once
# and read from here after, so a probe, a moved pin or the 2025 comparison never
# downloads the same node twice (shawn, 2026-09-18: the first full run held
# 12.6 GB in memory and kept none of it). one writer thread: H: is a usb
# spinning disk, and interleaved small writes ran it at a third of its
# sequential speed (TALON, 2026-09-15). CANOPY_STORE= (empty) turns it off.
STORE = os.environ.get('CANOPY_STORE', 'H:/dark-sky/ept')
_writer = ThreadPoolExecutor(1)
_pending = []


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def stored(rel, fetch):
    """the bytes at STORE/rel, or fetch() and queue them for the writer. only a
    renamed file counts: a .tmp left by a killed run is fetched again."""
    if not STORE:
        return fetch()
    path = os.path.join(STORE, rel)
    if os.path.exists(path):
        with open(path, 'rb') as f:
            return f.read()
    data = fetch()
    _pending.append(_writer.submit(_write, path, data))
    return data


def flush_store():
    """wait for the writer and raise the first write that failed, so a run that
    says it finished has every file it fetched on disk"""
    done = list(_pending)
    _pending.clear()
    for f in done:
        f.result()


@lru_cache(maxsize=None)
def ept_root(dataset):
    """ept.json's bounds, or None when the bucket has no such dataset"""
    rel = dataset + '/ept.json'
    try:
        return json.loads(stored(rel, lambda: http_get(EPT + rel)))['bounds']
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


@lru_cache(maxsize=None)
def hierarchy_page(dataset, key):
    rel = dataset + '/ept-hierarchy/' + key + '.json'
    return json.loads(stored(rel, lambda: http_get(EPT + rel)))


# the raw laz bytes, not the decoded arrays: 512 nodes is about 300 MB of
# bytes and would be several GB of float64. decoding again costs tens of
# milliseconds, the disk read it saves costs a few.
@lru_cache(maxsize=512)
def node_bytes(dataset, key):
    rel = dataset + '/ept-data/' + key + '.laz'
    return stored(rel, lambda: http_get(EPT + rel))


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
    ap.add_argument('--suggest-views', action='store_true',
                    help='propose open standing spots for closed-in pins; writes a review table, not index.html')
    args = ap.parse_args()

    global STORE
    drive = os.path.splitdrive(os.path.abspath(STORE))[0] if STORE else ''
    if STORE and drive and not os.path.exists(drive + os.sep):
        print('no %s drive here, so no raw ept files are kept this run' % drive)
        STORE = ''

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

    if args.suggest_views:
        closed = [(s, load_cached(s)) for s in todo]
        closed = [(s, r) for s, r in closed if r and closed_in(r)]
        os.makedirs(os.path.join(CACHE, 'suggest'), exist_ok=True)
        rows = []
        failed = []
        net0 = net_bytes()
        for i, (s, r) in enumerate(closed, 1):
            row = None if args.force else load_suggested(s)
            if row:
                rows.append(row)
                print('[%d/%d] %s ... cached' % (i, len(closed), s['name']), flush=True)
                continue
            # a fetch or H: read that exhausts its retries is one site's bad
            # luck, not the whole run's: no row file is written for it, so the
            # next run of the same command picks it back up where this one left it.
            try:
                row = suggest(s, r)
            except (urllib.error.URLError, urllib.error.HTTPError, OSError, TimeoutError) as e:
                failed.append(s)
                print('[%s] %s ... fetch failed: %s' % (time.strftime('%H:%M:%S'), s['name'], e), flush=True)
                continue
            bh.save_atomic(suggest_path(s), bh.write_json(row))
            rows.append(row)
            print('[%s] [%d/%d] %s ... %s' % (time.strftime('%H:%M:%S'), i, len(closed), s['name'],
                  no_spot(row) if row['spot'] is None else
                  'moved %.0f m (%+.1f m), %.0f to %s degrees' % (row['moved_m'], row['dz_m'], row['before'],
                  'n/a' if row['after'] is None else '%.0f' % row['after'])), flush=True)
        flush_store()
        path = os.path.join(CACHE, 'view-review.md')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(review_md(rows))
        # net_bytes() the same way the main loop reports it, so a run over a
        # full store can be seen to use 0 MB
        print('%d closed-in sites, net %.0f MB, review table at %s' % (len(rows), (net_bytes() - net0) / 1e6, path))
        if failed:
            print('%d site(s) failed to fetch and were left uncached; re-run the same command to retry them:' % len(failed))
            for s in failed:
                print('    %s' % s['name'])
        return

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
        print('  raw ept files kept in: %s' % (STORE or 'nowhere (CANOPY_STORE is empty)'))
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
        # flushed here, not just at the end, so a failed H: write stops the run
        # at the next site rather than 50 minutes later, and the pending list
        # stays bounded. if it raises, let it propagate: the cache file above
        # is already written, so only the missing raw file is refetched next run.
        flush_store()
        # nbytes is this site's box, cache hits included; net/mbps is what the
        # run has actually pulled over the wire since it started, since the two
        # can differ a lot once neighbouring sites start sharing octree nodes.
        elapsed = time.time() - t0
        net = net_bytes() - net0
        mbps = (net / 1e6) / elapsed if elapsed > 0 else 0.0
        print('[%s] [%d/%d] %s ... %d datasets, %d nodes, %.0f MB, %.1fs, net %.0f MB at %.1f MB/s'
              % (time.strftime('%H:%M:%S'), i, len(todo), s['name'], len(used), nodes, nbytes / 1e6,
                 time.time() - t, net / 1e6, mbps), flush=True)

    flush_store()

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
