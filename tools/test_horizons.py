"""checks for build_horizons that do not touch S: and do not need a dem.

the geometry tests raycast against surfaces whose skyline can be written down in
closed form, so a failure means the maths is wrong rather than that the output
moved. synthetic rasters only, in memory, stdlib unittest.

  python -m unittest discover -s tools -p "test_*.py"
"""
import math
import unittest

import numpy as np

import build_horizons as bh


class Surface:
    """a height field given as a function of latitude and longitude, standing in
    for a Lattice. an analytic surface keeps the expected profile exact: a real
    raster would quantise the ground to 10 m posts and there would be nothing
    left to compare against."""

    def __init__(self, f):
        self.f = f

    def sample(self, lats, lons):
        return self.f(np.asarray(lats, float), np.asarray(lons, float))


VOID = Surface(lambda la, lo: np.full(la.shape, bh.NODATA))

LAT, LON = 35.5, -83.0
MLAT = 111320.0
MLON = 111320.0 * math.cos(math.radians(LAT))


def ranges_from(lats, lons):
    """metres from the test observer, the same local tangent plane the raycast
    uses, so the round trip through lat/lon is exact."""
    return np.hypot((lats - LAT) * MLAT, (lons - LON) * MLON)


class TestRaycast(unittest.TestCase):

    def test_flat_plane_returns_the_curvature_drop(self):
        """a plane at eye level is not a flat horizon: it falls away as
        r**2 / (2 * R_eff), so the highest thing on it is the nearest sample."""
        ground = Surface(lambda la, lo: np.full(la.shape, 1000.0))
        alt, rng = bh.raycast(LAT, LON, 1000.0, ground, ground)

        r0 = bh.RANGES[0]
        want = -math.degrees(math.atan(r0 / (2.0 * bh.R_EFF)))
        self.assertEqual(alt.shape, (360,))
        np.testing.assert_allclose(alt, want, rtol=1e-9)
        np.testing.assert_array_equal(rng, r0)

    def test_cone_of_known_slope(self):
        """flat out to 20 km, then a cone rising at 1 in 100 all the way round.

        the apparent altitude of the cone flank is
            f(r) = atan(s - s*D/r - r / (2 * R_eff))
        which has an interior maximum: close in the flank has barely started,
        far out the curvature drop is winning. the expected profile is that
        function evaluated over the ray's own sample ranges, computed here
        independently of the raycast's geometry."""
        s, d = 0.01, 20000.0
        cone = Surface(lambda la, lo: 1000.0 + s * np.maximum(0.0, ranges_from(la, lo) - d))
        alt, rng = bh.raycast(LAT, LON, 1000.0, cone, cone)

        r = bh.RANGES
        want = np.degrees(np.arctan(s - s * d / r - r / (2.0 * bh.R_EFF)))
        i = int(np.argmax(want))

        np.testing.assert_allclose(alt, want[i], atol=1e-5)
        np.testing.assert_array_equal(rng, r[i])
        # the flank, not the nearest sample and not the 100 km cutoff
        self.assertTrue(d < r[i] < bh.MAX_RANGE)

    def test_azimuth_zero_is_north_and_ninety_is_east(self):
        """one 25 m tower, 2 km away, has to come out on the side it was put.
        a swapped latitude and longitude, or a sign flip, survives every test
        above this one because those surfaces are rotationally symmetric.

        25 m at 2 km is under a degree wide, so the neighbouring azimuths miss
        it entirely and the answer is exact rather than nearly right."""
        for az, clat, clon in ((0, LAT + 2000.0 / MLAT, LON),
                               (90, LAT, LON + 2000.0 / MLON)):
            surf = Surface(lambda la, lo, a=clat, o=clon: np.where(
                np.hypot((la - a) * MLAT, (lo - o) * MLON) < 25.0, 3000.0, bh.NODATA))
            alt, rng = bh.raycast(LAT, LON, 1000.0, surf, surf)
            self.assertEqual(int(np.argmax(alt)), az)
            self.assertAlmostEqual(rng[az], 2000.0, delta=30.0)


class TestPooling(unittest.TestCase):

    def test_max_pooling_keeps_the_crest_and_mean_pooling_does_not(self):
        """this test exists to stop someone "optimising" pool_max into a mean or
        a strided decimation later. a skyline is an upper envelope: a one cell
        wide ridge crest is exactly the thing that matters and exactly the thing
        averaging destroys. it is not a style preference."""
        a = np.zeros((9, 9), np.float32)
        a[:, 4] = 1000.0            # a north-south crest one cell wide

        pooled = bh.pool_max(a, 3)
        self.assertEqual(pooled.shape, (3, 3))
        np.testing.assert_array_equal(pooled[:, 1], 1000.0)

        mean = a.reshape(3, 3, 3, 3).mean(axis=(1, 3))
        np.testing.assert_allclose(mean[:, 1], 1000.0 / 3.0, rtol=1e-6)
        self.assertLess(mean.max(), pooled.max())

    def test_pooling_does_not_resurrect_void(self):
        """a block that is entirely nodata stays nodata; a block with any real
        cell takes the real value."""
        a = np.full((3, 6), bh.NODATA, np.float32)
        a[1, 4] = 42.0
        np.testing.assert_array_equal(bh.pool_max(a, 3), [[bh.NODATA, 42.0]])


class TestCodec(unittest.TestCase):

    def test_round_trip_within_one_quantisation_step(self):
        step = bh.ALT_RANGE / 4095.0
        alt = np.linspace(bh.ALT_MIN, bh.ALT_MIN + bh.ALT_RANGE, 360)
        s = bh.encode(alt)

        self.assertEqual(len(s), 720)
        self.assertTrue(all(c in bh.B64 for c in s))
        np.testing.assert_allclose(bh.decode(s), alt, atol=step)
        self.assertLessEqual(np.abs(np.array(bh.decode(s)) - alt).max(), step / 2 + 1e-12)

    def test_ends_and_clipping(self):
        self.assertEqual(bh.encode([bh.ALT_MIN]), 'AA')
        self.assertEqual(bh.encode([bh.ALT_MIN + bh.ALT_RANGE]), '//')
        self.assertEqual(bh.encode([-90.0]), 'AA')       # clipped, not wrapped
        self.assertEqual(bh.encode([180.0]), '//')


class TestSpotParsing(unittest.TestCase):

    def test_reads_both_quote_styles(self):
        html = (
            "const SPOTS = [\n"
            "  { name: 'Waterrock Knob', lat: 35.4605, lon: -83.1400, elev: 5820, kind: 'view' },\n"
            "  { name: \"Devil's Courthouse\", lat: 35.3037, lon: -82.8991, elev: 5720, kind: 'view' },\n"
            "];\n")
        spots = bh.parse_spots(html)
        self.assertEqual([s['name'] for s in spots], ['Waterrock Knob', "Devil's Courthouse"])
        self.assertEqual(spots[1]['lon'], -82.8991)
        self.assertEqual(bh.slug("Devil's Courthouse"), 'devil-s-courthouse')
        self.assertEqual(bh.slug('Sam Knob / Flat Laurel Creek'), 'sam-knob-flat-laurel-creek')


class TestLattice(unittest.TestCase):

    def test_sampling_maps_north_to_row_zero_and_west_to_column_zero(self):
        """the lattice is anchored at 90 N / 180 W so that a whole degree always
        lands on a cell boundary, which is what lets the 1 and 1/3 arc-second
        grids agree about where a cell is."""
        cpd = 3600
        row0, col0 = int((90 - 35.6) * cpd), int((-83.1 + 180) * cpd)
        arr = np.arange(20 * 20, dtype=np.float32).reshape(20, 20)
        lat = bh.Lattice(arr, row0, col0, cpd)

        nw = lat.sample(np.array([35.6 - 0.5 / cpd]), np.array([-83.1 + 0.5 / cpd]))
        self.assertEqual(nw[0], arr[0, 0])
        se = lat.sample(np.array([35.6 - 19.5 / cpd]), np.array([-83.1 + 19.5 / cpd]))
        self.assertEqual(se[0], arr[19, 19])
        off = lat.sample(np.array([35.6 + 1.0]), np.array([-83.1]))
        self.assertEqual(off[0], bh.NODATA)


if __name__ == '__main__':
    unittest.main()
