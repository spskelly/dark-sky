"""cuts the USGS 3DEP tiles into a static elevation tile set a browser can fetch,
so the page can raycast a skyline for any point somebody picks on the map.

  python tools/build_terrain_tiles.py --out <dir> --dry-run   # say what a run would do, touch nothing
  python tools/build_terrain_tiles.py --out <dir>             # build, or resume where a run stopped
  python tools/build_terrain_tiles.py --out <dir> --force     # rebuild every file

<dir> is a checkout of the separate public repository the tiles are served
from. it is never inside this one: the set is a few hundred MB.

what is written, all of it little-endian int16 metres, row 0 at the NORTH edge,
columns west to east, nodata -32768, so the browser side is
`new Int16Array(buffer)` and nothing else:

  near/n35.25_w083.50.i16   1 arc-second, one file per 0.25 degree square, named
                            by its south west corner, 900 x 900 cells
  far.i16                   6 arc-second, one grid for the whole far field
  manifest.json             bounds, naming, the tiles present, and the raycast
                            constants the browser has to mirror. written last.

the mosaicking, the max pooling and the reason for both live in
build_horizons.py and are imported from there, not repeated. max, never mean: a
skyline is an upper envelope and averaging sinks every crest toward its flanks.

every near tile is its own checkpoint: temp name, rename, and a file that is
already there is skipped, so the same command resumes a killed run. one worker,
sequential reads. the dem drive has stalled under parallel i/o before.
"""
import argparse
import datetime
import json
import math
import os
import sys
import time

import numpy as np

import build_horizons as bh

NEAR_CPD = 3600        # 1 arc-second
FAR_CPD = 600          # 6 arc-second
TILE_CELLS = 900       # a quarter of a degree at 1 arc-second
NODATA_I16 = -32768
NEAR_M = 10000.0       # metres; the browser uses near tiles inside this, far.i16 beyond

# the area the map shows. quarter degrees, inside build_horizons' grid.
DEFAULT_BBOX = (34.75, -84.50, 36.75, -80.75)
# rays run 100 km past any pick, so the far grid is the whole of build_horizons'
# grid, not only the part with near tiles under it
FAR_BOUNDS = (bh.GRID_LAT0, bh.GRID_LON0, bh.GRID_LAT1, bh.GRID_LON1)

NAMING = ("near/{n|s}DD.DD_{w|e}DDD.DD.i16, the south west corner of a 0.25 degree square, absolute "
          "degrees zero padded to two decimals. for a point, on the global 1 arc-second lattice: "
          "R = floor((90 - lat) * 3600), C = floor((lon + 180) * 3600), south = 90 - (floor(R / 900) + 1) / 4, "
          "west = floor(C / 900) / 4 - 180, and in the tile row = R % 900, col = C % 900, "
          "index = row * 900 + col.")


# ---------- naming ----------

def tile_name(south, west):
    sq, wq = round(south * 4), round(west * 4)
    return '%s%02d.%02d_%s%03d.%02d' % (('s' if sq < 0 else 'n',) + divmod(abs(sq) * 25, 100)
                                        + ('w' if wq < 0 else 'e',) + divmod(abs(wq) * 25, 100))


def tile_corner(name):
    south, west = float(name[1:6]), float(name[8:14])
    return (-south if name[0] == 's' else south, -west if name[7] == 'w' else west)


def tile_of(lat, lon):
    """the corner of the tile that holds a point, by the same floor on the global
    lattice that Lattice.sample uses, so the two can never disagree about a
    point that sits exactly on a tile edge: rows count down from the north, so
    a point on a tile's south edge belongs to the tile below it."""
    r = math.floor((90.0 - lat) * NEAR_CPD) // TILE_CELLS
    c = math.floor((lon + 180.0) * NEAR_CPD) // TILE_CELLS
    return (90 - (r + 1) / 4, c / 4 - 180)


# ---------- encoding ----------

def to_i16(a):
    out = np.clip(np.rint(a), -32767, 32767).astype('<i2')
    out[a <= bh.NODATA] = NODATA_I16
    return out


def lattice_reader(lat):
    """a reader with read_lattice's signature over a grid already in memory (or
    memory mapped): the cached 1 arc-second far field grid of build_horizons."""
    def read(cpd, row0, row1, col0, col1):
        if cpd != lat.cpd:
            raise ValueError('this grid is %d cells per degree, not %d' % (lat.cpd, cpd))
        out = np.full((row1 - row0, col1 - col0), bh.NODATA, np.float32)
        a0, a1 = max(row0, lat.row0), min(row1, lat.row0 + lat.arr.shape[0])
        b0, b1 = max(col0, lat.col0), min(col1, lat.col0 + lat.arr.shape[1])
        if a0 < a1 and b0 < b1:
            out[a0 - row0:a1 - row0, b0 - col0:b1 - col0] = \
                lat.arr[a0 - lat.row0:a1 - lat.row0, b0 - lat.col0:b1 - lat.col0]
        return bh.Lattice(out, row0, col0, cpd)
    return read


# ---------- the build ----------

def check_bbox(bbox):
    south, west, north, east = bbox
    if any(abs(v * 4 - round(v * 4)) > 1e-9 for v in bbox):
        raise ValueError('--bbox must be in whole or quarter degrees')
    if not (south < north and west < east):
        raise ValueError('--bbox is south west north east, with south < north and west < east')
    if south < bh.GRID_LAT0 or north > bh.GRID_LAT1 or west < bh.GRID_LON0 or east > bh.GRID_LON1:
        raise ValueError('--bbox must lie inside %d..%d N, %d..%d E, the grid build_horizons.py reads'
                         % (bh.GRID_LAT0, bh.GRID_LAT1, bh.GRID_LON0, bh.GRID_LON1))


def write_bytes(data):
    def go(p):
        with open(p, 'wb') as f:
            f.write(data)
    return go


def build(out, bbox, read, read_far=None, far_bounds=FAR_BOUNDS, force=False, dry_run=False, log=print):
    """read and read_far have read_lattice's signature. tiles are grouped by the
    whole degree square they sit in, so each source GeoTIFF is opened once and
    only for the window its missing tiles need."""
    t_all = time.time()
    check_bbox(bbox)
    read_far = read_far or read
    sq0, wq0, sq1, wq1 = (round(v * 4) for v in bbox)
    near_dir = os.path.join(out, 'near')
    far_path = os.path.join(out, 'far.i16')

    def path_of(sq, wq):
        return os.path.join(near_dir, tile_name(sq / 4, wq / 4) + '.i16')

    squares = {}
    for sq in range(sq0, sq1):
        for wq in range(wq0, wq1):
            squares.setdefault((sq // 4, wq // 4), []).append((sq, wq))
    total = (sq1 - sq0) * (wq1 - wq0)
    fs, fw, fn, fe = (int(v) for v in far_bounds)    # whole degrees
    far_shape = ((fn - fs) * FAR_CPD, (fe - fw) * FAR_CPD)
    far_needed = force or not os.path.exists(far_path)

    if dry_run:
        todo = [t for ts in squares.values() for t in ts if force or not os.path.exists(path_of(*t))]
        reads = sum(1 for ts in squares.values() if any(t in todo for t in ts))
        far_bytes = far_shape[0] * far_shape[1] * 2 if far_needed else 0
        log('%d near tiles in %s: %d present, %d to build, from %d degree squares'
            % (total, ' '.join('%g' % v for v in bbox), total - len(todo), len(todo), reads))
        log('far.i16 %d x %d: %s' % (far_shape + ('to build' if far_needed else 'present',)))
        log('would write at most %.1f MB under %s (tiles that are all nodata are not written)'
            % ((len(todo) * TILE_CELLS * TILE_CELLS * 2 + far_bytes) / 1e6, out))
        log('dry run, nothing touched')
        return

    os.makedirs(near_dir, exist_ok=True)
    written = cached = void = nbytes = 0
    i = 0
    for (dlat, dlon), tiles in sorted(squares.items()):
        missing = [t for t in tiles if force or not os.path.exists(path_of(*t))]
        lat = None
        if missing:
            t = time.time()
            # the window that holds every missing tile of this square, and no more
            row0 = (360 - max(sq for sq, _ in missing) - 1) * TILE_CELLS
            row1 = (360 - min(sq for sq, _ in missing)) * TILE_CELLS
            col0 = (min(wq for _, wq in missing) + 720) * TILE_CELLS
            col1 = (max(wq for _, wq in missing) + 720 + 1) * TILE_CELLS
            lat = read(NEAR_CPD, row0, row1, col0, col1)
            log('read %s %d x %d cells for %d tiles %.1fs'
                % (tile_name(dlat, dlon), row1 - row0, col1 - col0, len(missing), time.time() - t))
        for sq, wq in tiles:
            i += 1
            path = path_of(sq, wq)
            label = 'tile %d/%d near/%s' % (i, total, os.path.basename(path))
            if (sq, wq) not in missing:
                cached += 1
                log('%s cached' % label)
                continue
            t = time.time()
            r, c = (360 - sq - 1) * TILE_CELLS - lat.row0, (wq + 720) * TILE_CELLS - lat.col0
            data = to_i16(lat.arr[r:r + TILE_CELLS, c:c + TILE_CELLS])
            if (data == NODATA_I16).all():
                # ponytail: nothing marks a void tile as done, so a resume reads its
                # window again. there is none in the mountain bbox; add a marker file
                # if a bbox ever takes in open sea.
                void += 1
                if os.path.exists(path):
                    os.remove(path)
                log('%s all nodata, not written' % label)
                continue
            bh.save_atomic(path, write_bytes(data.tobytes()))
            written += 1
            nbytes += data.nbytes
            log('%s written %.1f MB %.1fs' % (label, data.nbytes / 1e6, time.time() - t))

    if far_needed:
        t = time.time()
        far = np.full(far_shape, NODATA_I16, '<i2')
        for dlat in range(fs, fn):
            for dlon in range(fw, fe):
                sq_lat = read_far(NEAR_CPD, (90 - dlat - 1) * NEAR_CPD, (90 - dlat) * NEAR_CPD,
                                  (dlon + 180) * NEAR_CPD, (dlon + 181) * NEAR_CPD)
                r, c = (fn - dlat - 1) * FAR_CPD, (dlon - fw) * FAR_CPD
                far[r:r + FAR_CPD, c:c + FAR_CPD] = to_i16(bh.pool_max(sq_lat.arr, NEAR_CPD // FAR_CPD))
                log('far %s pooled' % tile_name(dlat, dlon))
        bh.save_atomic(far_path, write_bytes(far.tobytes()))
        nbytes += far.nbytes
        log('far.i16 written %.1f MB %.1fs' % (far.nbytes / 1e6, time.time() - t))
    else:
        log('far.i16 cached')

    present = sorted(tile_name(sq / 4, wq / 4) for ts in squares.values() for sq, wq in ts
                     if os.path.exists(path_of(sq, wq)))
    manifest = {
        'source': 'USGS 3DEP 1/3 arc-second, max-pooled',
        'built': datetime.date.today().isoformat(),
        'encoding': 'little-endian int16 metres, rounded after pooling, row 0 at the north edge, '
                    'columns west to east, no header',
        'nodata': NODATA_I16,
        'near': {'cells_per_degree': NEAR_CPD, 'tile_degrees': 0.25, 'tile_cells': TILE_CELLS,
                 'bounds': dict(zip(('south', 'west', 'north', 'east'), bbox)),
                 'naming': NAMING, 'tiles': present},
        'far': {'file': 'far.i16', 'cells_per_degree': FAR_CPD, 'rows': far_shape[0], 'cols': far_shape[1],
                'bounds': {'south': fs, 'west': fw, 'north': fn, 'east': fe}},
        'raycast': {'R_EFF': bh.R_EFF, 'EYE': bh.EYE, 'MIN_RANGE': bh.MIN_RANGE,
                    'MAX_RANGE': bh.MAX_RANGE, 'NEAR_M': NEAR_M},
    }
    bh.save_atomic(os.path.join(out, 'manifest.json'), bh.write_json(manifest))
    log('%d tiles: %d written, %d cached, %d all nodata. %d listed in manifest.json. %.1f MB written in %.0fs'
        % (total, written, cached, void, len(present), nbytes / 1e6, time.time() - t_all))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', required=True, help='output directory, outside this repository')
    ap.add_argument('--bbox', nargs=4, type=float, default=DEFAULT_BBOX,
                    metavar=('SOUTH', 'WEST', 'NORTH', 'EAST'), help='near tile area, quarter degrees')
    ap.add_argument('--coarse', help='the 1 arc-second grid build_horizons.py caches (coarse_1as.npy); '
                                     'far.i16 is pooled from it instead of from the source tiles')
    ap.add_argument('--near-from-coarse', action='store_true',
                    help='cut the near tiles from that grid too, so the dem drive is never read')
    ap.add_argument('--force', action='store_true', help='rebuild files that already exist')
    ap.add_argument('--dry-run', action='store_true', help='say what a run would do, touch nothing')
    args = ap.parse_args()

    def log(s):
        print(s, flush=True)

    coarse = args.coarse or os.path.join(bh.CACHE, 'coarse_1as.npy')
    read_far = None
    if os.path.exists(coarse):
        arr = np.load(coarse, mmap_mode='r')
        want = ((bh.GRID_LAT1 - bh.GRID_LAT0) * NEAR_CPD, (bh.GRID_LON1 - bh.GRID_LON0) * NEAR_CPD)
        if arr.shape != want:
            sys.exit('%s is %s, expected %s' % (coarse, arr.shape, want))
        read_far = lattice_reader(bh.Lattice(arr, (90 - bh.GRID_LAT1) * NEAR_CPD,
                                             (bh.GRID_LON0 + 180) * NEAR_CPD, NEAR_CPD))
        log('far field from the cached 1 arc-second grid')
    elif args.coarse:
        sys.exit('no such file: %s' % coarse)
    if args.near_from_coarse and not read_far:
        sys.exit('--near-from-coarse needs the cached grid; pass --coarse')
    read = read_far if args.near_from_coarse else (lambda *a: bh.read_lattice(*a))
    # read_lattice skips source tiles it cannot find, which is right for a square
    # usgs never published and wrong for a drive that is not mounted
    if not args.dry_run and not os.path.isdir(bh.TILES) and not (args.near_from_coarse and read_far):
        sys.exit('the tile directory (TILES in build_horizons.py) is not there')
    try:
        build(args.out, tuple(args.bbox), read, read_far, force=args.force, dry_run=args.dry_run, log=log)
    except ValueError as e:
        sys.exit(str(e))


if __name__ == '__main__':
    main()
