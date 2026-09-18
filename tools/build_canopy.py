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
WORKERS = 8          # concurrent node downloads
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
