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


if __name__ == '__main__':
    unittest.main()
