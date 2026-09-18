"""checks for build_canopy that never touch the network. synthetic points and a
hand-built octree, stdlib unittest.

  python -m unittest discover -s tools -p "test_*.py"

the live check at the bottom fetches two real sites from S3 and is skipped
unless CANOPY_LIVE=1 is set.
"""
import json
import math
import os
import unittest

import numpy as np

import build_canopy as bc
import build_horizons as bh


LAT, LON = 35.3907, -83.0372     # doubletop, the site that started this


class TestBox(unittest.TestCase):

    def test_mercator_matches_the_closed_form(self):
        x, y = bc.mercator(LAT, LON)
        self.assertAlmostEqual(x, 6378137.0 * math.radians(LON), places=6)
        self.assertAlmostEqual(y, 6378137.0 * math.log(math.tan(math.pi / 4 + math.radians(LAT) / 2)), places=6)

    def test_box_half_width_is_radius_over_cos_lat(self):
        """3857 stretches by 1/cos(lat), so a 200 m box is wider than 200 m of
        projected units; sizing it in metres under-sizes every site."""
        x, y = bc.mercator(LAT, LON)
        box = bc.site_box(LAT, LON, 200.0)
        half = 200.0 / math.cos(math.radians(LAT))
        self.assertAlmostEqual(box[2] - x, half, places=8)
        self.assertAlmostEqual(x - box[0], half, places=8)
        self.assertAlmostEqual(box[3] - y, half, places=8)
        self.assertAlmostEqual(y - box[1], half, places=8)


class TestOctree(unittest.TestCase):

    # a 1024 m cube at the origin: depth d nodes are 1024 / 2**d across
    ROOT = [0.0, 0.0, 0.0, 1024.0, 1024.0, 1024.0]

    def test_node_bounds_split_each_axis_by_two_per_depth(self):
        self.assertEqual(bc.node_bounds(self.ROOT, '0-0-0-0'), (0.0, 0.0, 1024.0, 1024.0))
        self.assertEqual(bc.node_bounds(self.ROOT, '1-1-0-0'), (512.0, 0.0, 1024.0, 512.0))
        self.assertEqual(bc.node_bounds(self.ROOT, '2-3-2-1'), (768.0, 512.0, 1024.0, 768.0))

    def test_children_are_the_eight_octants(self):
        kids = bc.children('1-1-0-1')
        self.assertEqual(len(kids), 8)
        self.assertIn('2-2-0-2', kids)
        self.assertIn('2-3-1-3', kids)

    def test_walk_returns_only_nodes_with_points_that_touch_the_box(self):
        """a box in the north-east quarter: the root, the one depth-1 node
        over it, and the depth-2 nodes under that with points. the empty
        depth-2 node and the whole south-west are never returned, and a node
        that only touches the box edge is not an overlap."""
        pages = {'0-0-0-0': {'0-0-0-0': 100, '1-1-1-0': 50, '1-0-0-0': 50,
                             '2-2-2-0': 10, '2-3-2-0': 0, '2-2-3-0': 10, '2-3-3-0': 10}}
        asked = []
        page_of = lambda k: (asked.append(k), pages[k])[1]
        box = (600.0, 600.0, 700.0, 700.0)      # inside 2-2-2-0 (512..768 both axes)
        got = bc.nodes_in_box(self.ROOT, box, page_of, max_depth=2)
        self.assertEqual(sorted(got), ['0-0-0-0', '1-1-1-0', '2-2-2-0'])
        self.assertEqual(asked, ['0-0-0-0'])
        # touching the edge of 2-3-2-0 at x=768 is not inside it
        got = bc.nodes_in_box(self.ROOT, (700.0, 600.0, 768.0, 700.0), page_of, max_depth=2)
        self.assertNotIn('2-3-2-0', got)

    def test_lazy_entries_fetch_their_own_page_and_stop_at_max_depth(self):
        pages = {'0-0-0-0': {'0-0-0-0': 100, '1-1-1-0': -1},
                 '1-1-1-0': {'1-1-1-0': 50, '2-2-2-0': 10, '3-4-4-0': 5}}
        asked = []
        page_of = lambda k: (asked.append(k), pages[k])[1]
        got = bc.nodes_in_box(self.ROOT, (600.0, 600.0, 700.0, 700.0), page_of, max_depth=2)
        self.assertEqual(sorted(got), ['0-0-0-0', '1-1-1-0', '2-2-2-0'])
        self.assertEqual(asked, ['0-0-0-0', '1-1-1-0'])
        # and the same walk one level deeper reaches the depth-3 node
        got = bc.nodes_in_box(self.ROOT, (600.0, 600.0, 700.0, 700.0), page_of, max_depth=3)
        self.assertIn('3-4-4-0', got)


def pts(*rows):
    """rows of (east_m, north_m, up_m, class) around a pin at ground 0, to the
    arrays profiles_for takes: mercator x/y and absolute z."""
    x0, y0 = bc.mercator(LAT, LON)
    k = math.cos(math.radians(LAT))
    a = np.array(rows, float)
    return (x0 + a[:, 0] / k, y0 + a[:, 1] / k, 1000.0 + a[:, 2], a[:, 3].astype(np.int64))


def ring(cls, n=40, r=2.5):
    """ground returns in a ring inside PIN_R, so the eye is defined"""
    return [(r * math.sin(2 * math.pi * i / n), r * math.cos(2 * math.pi * i / n), 0.0, cls) for i in range(n)]


class TestSkyline(unittest.TestCase):

    def test_a_tree_due_south_reads_its_angle_and_nothing_else(self):
        """a 10 m tree 20 m south of a 1.7 m eye: atan((10 - 1.7) / 20) is
        22.5 degrees at azimuth 180, and every other azimuth stays empty."""
        x, y, z, c = pts(*ring(2), (0.0, -20.0, 10.0, 5))
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        self.assertAlmostEqual(p['ground_m'], 1000.0, places=6)
        self.assertAlmostEqual(p['t'][180], math.degrees(math.atan2(10.0 - bh.EYE - 400.0 / (2 * bh.R_EFF), 20.0)), places=3)
        others = [v for i, v in enumerate(p['t']) if i != 180]
        self.assertEqual(max(others), bh.ALT_MIN)
        self.assertEqual(max(p['s']), bh.ALT_MIN)

    def test_azimuths_run_clockwise_from_north(self):
        x, y, z, c = pts(*ring(2), (30.0, 0.0, 10.0, 5), (0.0, 30.0, 12.0, 4), (-30.0, 0.0, 8.0, 3))
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        self.assertGreater(p['t'][90], 5)      # east
        self.assertGreater(p['t'][0], 5)       # north
        self.assertGreater(p['t'][270], 5)     # west
        self.assertEqual(p['t'][180], bh.ALT_MIN)

    def test_points_inside_two_metres_are_the_observer_and_are_dropped(self):
        x, y, z, c = pts(*ring(2), (0.0, -1.5, 3.0, 5), (0.0, -2.05, 3.0, 5))
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        # 2.05 m stays, 1.5 m goes: the outer return alone sets the azimuth.
        # (2.05 rather than 2.0: the round trip through mercator is not exact
        # to the last bit, and a test on the boundary would test that instead.)
        self.assertAlmostEqual(p['t'][180], math.degrees(math.atan2(3.0 - bh.EYE - 2.05 ** 2 / (2 * bh.R_EFF), 2.05)), places=3)

    def test_curvature_term_matches_build_horizons_at_150_m(self):
        """a return at eye height 150 m out reads the same drop the terrain
        raycast gives its first sample, so the two lines meet where they hand
        over instead of stepping."""
        x, y, z, c = pts(*ring(2), (0.0, 150.0, bh.EYE, 5))
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        want = -math.degrees(math.atan(150.0 / (2.0 * bh.R_EFF)))
        self.assertAlmostEqual(p['t'][0], want, places=4)

    def test_eye_falls_back_to_ten_metres_then_gives_up(self):
        x, y, z, c = pts(*ring(2, r=8.0), (0.0, -20.0, 10.0, 5))
        self.assertIsNotNone(bc.profiles_for(x, y, z, c, LAT, LON))
        x, y, z, c = pts(*ring(2, r=12.0), (0.0, -20.0, 10.0, 5))
        self.assertIsNone(bc.profiles_for(x, y, z, c, LAT, LON))

    def test_eye_is_the_median_ground_not_the_lowest(self):
        rows = ring(2) + [(0.5, 0.5, -5.0, 2)]     # one return down a hole
        x, y, z, c = pts(*rows)
        self.assertAlmostEqual(bc.profiles_for(x, y, z, c, LAT, LON)['ground_m'], 1000.0, places=6)


class TestRouting(unittest.TestCase):

    def test_classes_go_to_their_layers(self):
        x, y, z, c = pts(*ring(2), (0.0, 20.0, 10.0, 3), (20.0, 0.0, 10.0, 4), (0.0, -20.0, 10.0, 5),
                         (-20.0, 0.0, 10.0, 6), (14.0, 14.0, 10.0, 7), (-14.0, 14.0, 10.0, 18), (14.0, -14.0, 10.0, 13))
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        for az in (0, 90, 180):
            self.assertGreater(p['t'][az], 20, az)
        self.assertGreater(p['s'][270], 20)
        self.assertEqual(p['s'][180], bh.ALT_MIN)
        for az in (45, 315, 135):                     # noise and the unknown class draw nothing
            self.assertEqual(p['t'][az], bh.ALT_MIN, az)
            self.assertEqual(p['s'][az], bh.ALT_MIN, az)
        self.assertEqual(p['classes'][13], 1)         # but everything is counted
        self.assertEqual(p['classes'][7], 1)

    def test_unclassified_needs_height_and_company_to_be_a_structure(self):
        # ground under the tower so its height above local ground is known
        ground = [(20.0 + dx, dy, 0.0, 2) for dx in (-2.0, 0.0, 2.0) for dy in (-2.0, 0.0, 2.0)]
        tower = [(20.0 + dx, dy, 15.0, 1) for dx in (0.0, 0.3, 0.6) for dy in (0.0, 0.3)]
        bird = [(0.0, -20.0, 15.0, 1)]
        low = [(-20.0 + dx, 0.0, 1.0, 1) for dx in (0.0, 0.3, 0.6)] + [(-20.0, 0.0, 0.0, 2)]
        x, y, z, c = pts(*ring(2), *ground, *tower, *bird, *low)
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        self.assertGreater(p['s'][90], 30)            # six returns 15 m up: built
        self.assertEqual(p['s'][180], bh.ALT_MIN)     # one return alone: not
        self.assertEqual(p['s'][270], bh.ALT_MIN)     # three returns a metre up: not
        self.assertEqual(p['t'][90], bh.ALT_MIN)      # and none of it is a tree

    def test_unclassified_with_no_ground_nearby_is_not_tall(self):
        x, y, z, c = pts(*ring(2), *[(60.0 + d, 0.0, 15.0, 1) for d in (0.0, 0.3, 0.6)])
        self.assertEqual(bc.profiles_for(x, y, z, c, LAT, LON)['s'][90], bh.ALT_MIN)


class TestDeck(unittest.TestCase):

    def test_deck_raises_the_eye_and_excludes_the_tower_itself(self):
        x, y, z, c = pts(*ring(2), (0.0, -4.0, 25.0, 6), (0.0, 40.0, 10.0, 5))
        p = bc.profiles_for(x, y, z, c, LAT, LON, deck_m=20.0)
        self.assertIsNotNone(p['deck'])
        # from the ground the cab 4 m out is a wall; from the deck it is gone
        self.assertGreater(p['s'][180], 60)
        self.assertEqual(p['deck']['s'][180], bh.ALT_MIN)
        # and the tree 40 m north, 10 m up, is below a 21.7 m eye
        self.assertGreater(p['t'][0], 0)
        self.assertLess(p['deck']['t'][0], 0)
        self.assertIsNone(bc.profiles_for(x, y, z, c, LAT, LON)['deck'])


if __name__ == '__main__':
    unittest.main()
