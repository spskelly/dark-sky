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
