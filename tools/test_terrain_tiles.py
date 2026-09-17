"""checks for build_terrain_tiles that never touch the dem drive.

the reader is a fake: a height field whose value spells out the lattice row and
column it sits on, so a tile cut one cell off, flipped north for south, or
averaged instead of max pooled gives a wrong number rather than a plausible one.

  python -m unittest discover -s tools -p "test_*.py"
"""
import json
import os
import tempfile
import unittest
from unittest import mock

import numpy as np

import build_horizons as bh
import build_terrain_tiles as tt


def field(rows, cols):
    """height as a function of lattice row and column, inside int16"""
    return ((rows % 100) * 100 + (cols % 100)).astype(np.float32)


class FakeReader:
    """stands in for build_horizons.read_lattice. `void` is an optional
    (south, west, north, east) box that reads as nodata."""

    def __init__(self, void=None):
        self.calls = []
        self.void = void

    def __call__(self, cpd, row0, row1, col0, col1):
        self.calls.append((cpd, row0, row1, col0, col1))
        rows, cols = np.meshgrid(np.arange(row0, row1), np.arange(col0, col1), indexing='ij')
        arr = field(rows, cols)
        if self.void:
            s, w, n, e = self.void
            gone = ((rows >= (90 - n) * cpd) & (rows < (90 - s) * cpd)
                    & (cols >= (w + 180) * cpd) & (cols < (e + 180) * cpd))
            arr[gone] = bh.NODATA
        return bh.Lattice(arr, row0, col0, cpd)


def load(path, shape):
    return np.fromfile(path, dtype='<i2').reshape(shape)


class Naming(unittest.TestCase):
    def test_the_example_in_the_docs(self):
        self.assertEqual(tt.tile_name(35.25, -83.5), 'n35.25_w083.50')

    def test_round_trip(self):
        for south, west in [(35.25, -83.5), (35.0, -84.0), (34.75, -80.75),
                            (-0.25, 0.0), (-12.5, 7.75), (0.0, -0.25), (36.5, 100.25)]:
            name = tt.tile_name(south, west)
            self.assertEqual(tt.tile_corner(name), (south, west), name)
            self.assertEqual(len(name), len('n35.25_w083.50'), name)

    def test_the_tile_that_holds_a_point(self):
        self.assertEqual(tt.tile_name(*tt.tile_of(35.4641, -83.1377)), 'n35.25_w083.25')
        # a point on the south west corner belongs to that tile
        self.assertEqual(tt.tile_of(35.25, -83.25), (35.25, -83.25))
        # floor, not truncation toward zero, on both axes
        self.assertEqual(tt.tile_of(-0.1, -0.1), (-0.25, -0.25))


class Encoding(unittest.TestCase):
    def test_rounds_to_the_nearest_metre(self):
        a = np.array([[1200.4, 1200.6, -3.6, 0.0]], np.float32)
        self.assertEqual(tt.to_i16(a).tolist(), [[1200, 1201, -4, 0]])

    def test_nodata_becomes_minus_32768(self):
        a = np.array([[bh.NODATA, 5.0, bh.NODATA - 1]], np.float32)
        self.assertEqual(tt.to_i16(a).tolist(), [[-32768, 5, -32768]])

    def test_little_endian_int16(self):
        self.assertEqual(tt.to_i16(np.array([[258.0]], np.float32)).tobytes(), b'\x02\x01')


class Bbox(unittest.TestCase):
    def test_quarter_degrees_inside_the_grid_pass(self):
        tt.check_bbox((34.75, -84.5, 36.75, -80.75))

    def test_rejects(self):
        for bad in [(35.1, -83, 36, -82),      # not a quarter degree
                    (36, -83, 35, -82),        # south above north
                    (35, -82, 36, -83),        # west east of east
                    (33.75, -83, 36, -82),     # below the grid
                    (35, -83, 36, -79.75)]:    # east of the grid
            with self.assertRaises(ValueError, msg=str(bad)):
                tt.check_bbox(bad)


class Build(unittest.TestCase):
    BBOX = (35.25, -83.25, 35.5, -82.75)       # two tiles, side by side
    FAR = (35.0, -84.0, 36.0, -83.0)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = self.tmp.name
        self.addCleanup(self.tmp.cleanup)

    def build(self, read=None, **kw):
        read = read or FakeReader()
        tt.build(self.out, self.BBOX, read, far_bounds=self.FAR, log=lambda s: None, **kw)
        return read

    def near(self, name):
        return os.path.join(self.out, 'near', name + '.i16')

    def test_a_tile_lands_on_its_own_cells_with_row_0_north(self):
        self.build()
        got = load(self.near('n35.25_w083.25'), (900, 900))
        row0, col0 = int((90 - 35.5) * 3600), int((-83.25 + 180) * 3600)
        rows, cols = np.meshgrid(np.arange(row0, row0 + 900), np.arange(col0, col0 + 900), indexing='ij')
        np.testing.assert_array_equal(got, field(rows, cols).astype(np.int16))
        # and said out loud: the first row is the north edge, the first column the west
        self.assertEqual(got[0, 0], (row0 % 100) * 100 + col0 % 100)
        self.assertEqual(got[899, 0], ((row0 + 899) % 100) * 100 + col0 % 100)

    def test_far_grid_is_max_pooled_not_averaged(self):
        self.build()
        far = load(os.path.join(self.out, 'far.i16'), (600, 600))
        row0, col0 = (90 - 36) * 3600, (-84 + 180) * 3600
        rows, cols = np.meshgrid(np.arange(row0, row0 + 6), np.arange(col0 + 6, col0 + 12), indexing='ij')
        block = field(rows, cols)
        self.assertEqual(far[0, 1], block.max())
        self.assertNotEqual(far[0, 1], round(float(block.mean())))

    def test_far_grid_lets_a_real_cell_cover_a_void_neighbour_but_keeps_a_void_block(self):
        a = np.full((12, 6), bh.NODATA, np.float32)
        a[0, 0] = 7.0
        self.assertEqual(tt.to_i16(bh.pool_max(a, 6)).tolist(), [[7], [-32768]])

    def test_written_through_a_temp_name_then_renamed(self):
        with mock.patch.object(tt.os, 'replace', wraps=os.replace) as rep:
            self.build()
        moves = {os.path.basename(dst): os.path.basename(src) for src, dst in (c.args for c in rep.call_args_list)}
        for final in ('n35.25_w083.25.i16', 'n35.25_w083.00.i16', 'far.i16', 'manifest.json'):
            self.assertEqual(moves[final], final + '.tmp')
        self.assertEqual(list(moves)[-1], 'manifest.json')
        left = [f for _, _, fs in os.walk(self.out) for f in fs if f.endswith('.tmp')]
        self.assertEqual(left, [])

    def test_an_existing_tile_is_skipped_and_never_read(self):
        os.makedirs(os.path.join(self.out, 'near'))
        for name in ('n35.25_w083.25', 'n35.25_w083.00'):
            with open(self.near(name), 'wb') as f:
                f.write(b'kept')
        with open(os.path.join(self.out, 'far.i16'), 'wb') as f:
            f.write(b'kept')
        read = self.build()
        self.assertEqual(read.calls, [])
        with open(self.near('n35.25_w083.25'), 'rb') as f:
            self.assertEqual(f.read(), b'kept')

    def test_a_resume_reads_only_what_the_missing_tile_needs(self):
        os.makedirs(os.path.join(self.out, 'near'))
        with open(self.near('n35.25_w083.25'), 'wb') as f:
            f.write(b'kept')
        with open(os.path.join(self.out, 'far.i16'), 'wb') as f:
            f.write(b'kept')
        read = self.build()
        self.assertEqual(read.calls, [(3600, int((90 - 35.5) * 3600), int((90 - 35.25) * 3600),
                                       (-83 + 180) * 3600, int((-82.75 + 180) * 3600))])

    def test_force_rebuilds(self):
        os.makedirs(os.path.join(self.out, 'near'))
        with open(self.near('n35.25_w083.25'), 'wb') as f:
            f.write(b'stale')
        self.build(force=True)
        self.assertEqual(os.path.getsize(self.near('n35.25_w083.25')), 900 * 900 * 2)

    def test_a_void_tile_is_not_written_and_the_manifest_lists_only_what_is(self):
        self.build(FakeReader(void=(35.25, -83.0, 35.5, -82.75)))
        self.assertTrue(os.path.exists(self.near('n35.25_w083.25')))
        self.assertFalse(os.path.exists(self.near('n35.25_w083.00')))
        with open(os.path.join(self.out, 'manifest.json'), encoding='utf-8') as f:
            m = json.load(f)
        self.assertEqual(m['near']['tiles'], ['n35.25_w083.25'])
        self.assertEqual(m['nodata'], -32768)
        self.assertEqual(m['near']['cells_per_degree'], 3600)
        self.assertEqual(m['far']['cells_per_degree'], 600)
        self.assertEqual((m['far']['rows'], m['far']['cols']), (600, 600))
        self.assertEqual(m['raycast'], {'R_EFF': bh.R_EFF, 'EYE': bh.EYE, 'MIN_RANGE': bh.MIN_RANGE,
                                        'MAX_RANGE': bh.MAX_RANGE, 'NEAR_M': 10000.0})
        self.assertIn('max-pooled', m['source'])

    def test_dry_run_touches_nothing(self):
        read = self.build(dry_run=True)
        self.assertEqual(read.calls, [])
        self.assertEqual(os.listdir(self.out), [])


class CoarseReader(unittest.TestCase):
    def test_slices_a_lattice_already_in_memory(self):
        rows, cols = np.meshgrid(np.arange(100, 110), np.arange(200, 220), indexing='ij')
        read = tt.lattice_reader(bh.Lattice(field(rows, cols), 100, 200, 3600))
        got = read(3600, 102, 105, 210, 214)
        self.assertEqual((got.row0, got.col0, got.cpd), (102, 210, 3600))
        np.testing.assert_array_equal(got.arr, field(rows, cols)[2:5, 10:14])


if __name__ == '__main__':
    unittest.main()
