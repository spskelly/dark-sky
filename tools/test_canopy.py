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


class TestCache(unittest.TestCase):

    SITE = {'name': 'Doubletop', 'key': 'ov:n1', 'ov_id': 'n1', 'view_lat': LAT, 'view_lon': LON, 'deck': None}

    def rec(self, **over):
        r = {'lat': LAT, 'lon': LON, 'radius_m': bc.RADIUS, 'deck_m': None, 'candidates': list(bc.DATASETS)}
        r.update(over)
        return r

    def test_a_matching_record_is_taken(self):
        self.assertTrue(bc.cache_ok(self.rec(), self.SITE))

    def test_moved_pin_deck_radius_or_dataset_list_recomputes(self):
        self.assertFalse(bc.cache_ok(self.rec(lat=LAT + 1e-6), self.SITE))
        self.assertFalse(bc.cache_ok(self.rec(deck_m=18.0), self.SITE))
        self.assertFalse(bc.cache_ok(self.rec(), dict(self.SITE, deck=18.0)))
        self.assertFalse(bc.cache_ok(self.rec(radius_m=150.0), self.SITE))
        self.assertFalse(bc.cache_ok(self.rec(candidates=bc.DATASETS[:-1]), self.SITE))

    def test_cache_files_are_keyed_like_the_horizon_cache(self):
        self.assertTrue(bc.cache_path(self.SITE).endswith(os.path.join('.canopy-cache', 'ov-n1.json')))
        self.assertTrue(bc.cache_path({'name': "Devil's Courthouse", 'ov_id': None}).endswith('devil-s-courthouse.json'))
        self.assertEqual(bc.page_key(self.SITE), 'n1')
        self.assertEqual(bc.page_key({'name': 'Max Patch', 'ov_id': None}), 'Max Patch')

    def test_a_leftover_temp_file_is_never_taken_as_finished(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            saved = bc.CACHE
            bc.CACHE = d
            try:
                with open(os.path.join(d, 'ov-n1.json.tmp'), 'w') as f:
                    f.write('{"half": "written"')
                self.assertIsNone(bc.load_cached(self.SITE))
                with open(os.path.join(d, 'ov-n1.json'), 'w') as f:
                    json.dump(self.rec(t=[0.0] * 360), f)
                self.assertEqual(bc.load_cached(self.SITE)['t'], [0.0] * 360)
            finally:
                bc.CACHE = saved


class TestBlock(unittest.TestCase):

    def test_structures_need_half_a_degree_over_ridge_and_trees(self):
        t = [5.0] * 360
        ridge = [8.0] * 360
        s = [8.4] * 360
        self.assertFalse(bc.needs_s(s, t, ridge))
        s[10] = 8.5
        self.assertTrue(bc.needs_s(s, t, ridge))
        # with no terrain cache only the trees count
        self.assertTrue(bc.needs_s([5.5] * 360, t, None))

    def test_entry_omits_s_and_carries_the_deck(self):
        rec = {'t': [1.0] * 360, 's': [0.0] * 360, 'deck_m': 18.0,
               'deck': {'t': [-2.0] * 360, 's': [3.0] * 360}}
        e = bc.canopy_entry(rec, {'alt': [0.5] * 360, 'deck_alt': [-1.0] * 360})
        self.assertEqual(sorted(e), ['deck', 't'])
        self.assertEqual(len(e['t']), 720)
        self.assertEqual(e['deck']['m'], 18.0)
        self.assertEqual(sorted(e['deck']), ['m', 's', 't'])      # 3 over -1 and -2: kept

    def test_block_is_one_json_object_per_line_keyed_by_name_or_osm_id(self):
        sites = [{'name': 'Max Patch', 'key': 'Max Patch', 'ov_id': None},
                 {'name': 'View Doubletop', 'key': 'ov:n1', 'ov_id': 'n1'},
                 {'name': 'Doughton Park', 'key': 'Doughton Park', 'ov_id': None}]
        results = {'Max Patch': {'t': [1.0] * 360, 's': [0.0] * 360, 'deck_m': None, 'deck': None},
                   'ov:n1': {'t': [2.0] * 360, 's': [9.0] * 360, 'deck_m': None, 'deck': None},
                   'Doughton Park': {'t': None, 'reason': 'no lidar'}}
        js = bc.canopy_js(sites, results, {'Max Patch': {'alt': [0.0] * 360}})
        lines = js.split('\n')
        self.assertEqual(lines[0], bc.START)
        self.assertEqual(lines[1], "const CANOPY_VINTAGE = '2017, leaf-off';")
        self.assertEqual(lines[2], 'const CANOPY = {')
        self.assertTrue(lines[3].startswith('  "Max Patch": {"t":"'))
        self.assertTrue(lines[4].startswith('  "n1": {"t":"'))
        self.assertIn('"s":"', lines[4])
        self.assertNotIn('Doughton', js)
        self.assertEqual(lines[-2:], ['};', bc.END])
        for line in lines[3:5]:
            json.loads(line.split(': ', 1)[1].rstrip(','))     # each entry parses on its own


class TestSites(unittest.TestCase):

    HTML = ('const SPOTS = [\n'
            "  { name: 'Fryingpan Mountain tower', lat: 35.3951, lon: -82.7686, elev: 5340, view: [35.3933, -82.7749], deck: 18.5, kind: 'view' },\n"
            "  { name: 'Max Patch', lat: 35.7963, lon: -82.9620, elev: 4629, kind: 'view' },\n"
            '];\n'
            'const OVERLOOKS = [\n'
            '  {"id":"n1","name":"View Doubletop Mountain (MP 435.3)","lat":35.3907,"lon":-83.0372,"mp":435.3},\n'
            '];\n')

    def test_spots_and_overlooks_with_keys_and_decks(self):
        sites = bc.site_list(self.HTML)
        by = {s['key']: s for s in sites}
        self.assertEqual(sorted(by), ['Fryingpan Mountain tower', 'Max Patch', 'ov:n1'])
        self.assertEqual(by['Fryingpan Mountain tower']['deck'], 18.5)
        self.assertEqual((by['Fryingpan Mountain tower']['view_lat'], by['Fryingpan Mountain tower']['view_lon']), (35.3933, -82.7749))
        self.assertIsNone(by['Max Patch']['deck'])
        self.assertEqual(by['ov:n1']['ov_id'], 'n1')
        self.assertIsNone(by['Max Patch']['ov_id'])

    def test_order_keeps_neighbours_together(self):
        names = [s['name'] for s in bc.site_list(self.HTML)]
        # the two southern sites (35.39 N) come out adjacent, max patch (35.80 N) apart from them
        self.assertEqual(names.index('Max Patch'), 2)


if __name__ == '__main__':
    unittest.main()
