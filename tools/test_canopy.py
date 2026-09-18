"""checks for build_canopy that never touch the network. synthetic points and a
hand-built octree, stdlib unittest.

  python -m unittest discover -s tools -p "test_*.py"

the live check at the bottom fetches two real sites from S3 and is skipped
unless CANOPY_LIVE=1 is set.
"""
import contextlib
import io
import json
import math
import os
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest import mock

import numpy as np

import build_canopy as bc
import build_horizons as bh

# no test reads or writes the real lidar store: a stored ept.json would answer
# a test that stubs the network with a 404, and a test would leave files on H:
bc.STORE = ''
# and none reaches overpass: a suggest test that forgets to stub osm_access
# gets no mirror to ask, so reach reads unknown instead of a real request
bc.OVERPASS = []

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

    def test_vegetation_over_50m_above_ground_becomes_a_structure(self):
        """a column of class-5 returns from 5 m to 70 m: the part below
        TREE_MAX_M stays a tree, the part at or above it is the tower."""
        column = [(20.0, 0.0, h, 5) for h in range(5, 71, 5)]
        x, y, z, c = pts(*ring(2), (20.0, 0.0, 0.0, 2), *column)
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        self.assertGreater(p['s'][90], 60)             # the 70 m top, read as a structure
        self.assertLess(p['t'][90], p['s'][90])         # trees only reach the part under 50 m
        self.assertTrue(bc.needs_s(p['s'], p['t'], None))

    def test_a_35m_tree_with_ground_under_it_stays_entirely_a_tree(self):
        x, y, z, c = pts(*ring(2), (0.0, -20.0, 0.0, 2), (0.0, -20.0, 35.0, 5))
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        self.assertEqual(p['s'][180], bh.ALT_MIN)
        self.assertGreater(p['t'][180], 0)

    def test_tall_vegetation_with_no_ground_in_its_cell_stays_a_tree(self):
        x, y, z, c = pts(*ring(2), (60.0, 0.0, 70.0, 5))
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        self.assertEqual(p['s'][90], bh.ALT_MIN)
        self.assertGreater(p['t'][90], 0)


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
        r = {'lat': LAT, 'lon': LON, 'radius_m': bc.RADIUS, 'deck_m': None, 'candidates': list(bc.DATASETS), 'model': bc.MODEL}
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

    def test_a_record_from_before_the_band_model_recomputes(self):
        r = self.rec()
        del r['model']
        self.assertFalse(bc.cache_ok(r, self.SITE))

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


def _fake_response(data):
    """a context-manager stand-in for urllib.request.urlopen's return value"""
    m = mock.MagicMock()
    m.__enter__.return_value.read.return_value = data
    m.__exit__.return_value = False
    return m


class TestHttpGet(unittest.TestCase):
    """no network: urlopen and time.sleep are stubbed, so these run in
    milliseconds and never touch S3."""

    def test_retries_a_transient_error_then_succeeds(self):
        calls = [urllib.error.URLError('reset'), _fake_response(b'ok')]

        def fake_urlopen(url, timeout=60):
            r = calls.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        with mock.patch.object(bc.urllib.request, 'urlopen', side_effect=fake_urlopen), \
             mock.patch.object(bc.time, 'sleep') as sleep:
            self.assertEqual(bc.http_get('http://example/x'), b'ok')
        sleep.assert_called_once_with(1)      # 2**0, the one retry it needed

    def test_a_404_is_raised_at_once_without_retrying(self):
        calls = []

        def fake_urlopen(url, timeout=60):
            calls.append(url)
            raise urllib.error.HTTPError(url, 404, 'not found', {}, None)
        with mock.patch.object(bc.urllib.request, 'urlopen', side_effect=fake_urlopen), \
             mock.patch.object(bc.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                bc.http_get('http://example/missing')
        self.assertEqual(len(calls), 1)
        sleep.assert_not_called()

    def test_the_final_failed_try_does_not_sleep(self):
        with mock.patch.object(bc.urllib.request, 'urlopen',
                                side_effect=urllib.error.URLError('down')), \
             mock.patch.object(bc.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.URLError):
                bc.http_get('http://example/x', tries=3)
        # three tries, only two gaps between them: 1 s then 2 s, never a third sleep
        self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(2)])

    def test_ept_root_returns_none_on_404(self):
        bc.ept_root.cache_clear()

        def fake_urlopen(url, timeout=60):
            raise urllib.error.HTTPError(url, 404, 'not found', {}, None)
        with mock.patch.object(bc.urllib.request, 'urlopen', side_effect=fake_urlopen), \
             mock.patch.object(bc.time, 'sleep'):
            self.assertIsNone(bc.ept_root('NC_Phase5_NoSuchCounty_2017'))
        bc.ept_root.cache_clear()

    def test_network_counter_counts_bytes_actually_downloaded(self):
        before = bc.net_bytes()
        with mock.patch.object(bc.urllib.request, 'urlopen',
                                side_effect=lambda url, timeout=60: _fake_response(b'0123456789')):
            bc.http_get('http://example/ten-bytes')
        self.assertEqual(bc.net_bytes() - before, 10)


class TestMainKeepsGoing(unittest.TestCase):
    """main() end to end, with the network and index.html both stubbed out."""

    HTML = ('const SPOTS = [\n'
            "  { name: 'Site A (fails)', lat: 35.10, lon: -83.10, elev: 4000, kind: 'view' },\n"
            "  { name: 'Site B (ok)', lat: 35.90, lon: -82.20, elev: 4000, kind: 'view' },\n"
            '];\n'
            'const OVERLOOKS = [\n'
            '];\n')

    @staticmethod
    def _ground_ring(lat, lon):
        """a ring of ground returns around the pin, so profiles_for finds an eye"""
        x0, y0 = bc.mercator(lat, lon)
        k = math.cos(math.radians(lat))
        n = 40
        dx = np.array([2.5 * math.sin(2 * math.pi * i / n) for i in range(n)])
        dy = np.array([2.5 * math.cos(2 * math.pi * i / n) for i in range(n)])
        return (x0 + dx / k, y0 + dy / k, np.full(n, 1000.0), np.full(n, bc.GROUND, dtype=np.int64))

    def fake_fetch_site(self, lat, lon, radius_m=bc.RADIUS):
        if abs(lat - 35.10) < 1e-6:
            raise OSError('connection reset by peer')
        x, y, z, c = self._ground_ring(lat, lon)
        return x, y, z, c, ['NC_Phase5_Fake_2017'], 5, 12345

    def test_a_failed_site_is_skipped_not_cached_and_leaves_html_alone(self):
        saved_cache = bc.CACHE
        with tempfile.TemporaryDirectory() as d:
            bc.CACHE = d
            try:
                with mock.patch.object(bh, 'read_html', return_value=self.HTML), \
                     mock.patch.object(bh, 'write_html') as write_html, \
                     mock.patch.object(bc, 'fetch_site', side_effect=self.fake_fetch_site), \
                     mock.patch.object(sys, 'argv', ['build_canopy.py']):
                    bc.main()
                write_html.assert_not_called()
                names = os.listdir(d)
                self.assertEqual(names, ['site-b-ok.json'])   # site a wrote nothing
            finally:
                bc.CACHE = saved_cache

    def test_a_store_write_failure_surfaces_before_the_next_site_fetches(self):
        """flush_store() runs right after each site's cache write, so a
        failed H: write stops the run there instead of at the end: the fetch
        try/except only catches network errors, so this propagates out of
        main() and the site after the failure is never fetched."""
        HTML = ('const SPOTS = [\n'
                "  { name: 'Site A (ok)', lat: 35.10, lon: -83.10, elev: 4000, kind: 'view' },\n"
                "  { name: 'Site B (ok)', lat: 35.90, lon: -82.20, elev: 4000, kind: 'view' },\n"
                '];\n'
                'const OVERLOOKS = [\n'
                '];\n')
        calls = []

        def fake_fetch_site(lat, lon, radius_m=bc.RADIUS):
            calls.append(lat)
            x, y, z, c = self._ground_ring(lat, lon)
            return x, y, z, c, ['NC_Phase5_Fake_2017'], 5, 12345

        saved_cache = bc.CACHE
        with tempfile.TemporaryDirectory() as d:
            bc.CACHE = d
            try:
                with mock.patch.object(bh, 'read_html', return_value=HTML), \
                     mock.patch.object(bh, 'write_html'), \
                     mock.patch.object(bc, 'fetch_site', side_effect=fake_fetch_site), \
                     mock.patch.object(bc, 'flush_store', side_effect=OSError('disk full')), \
                     mock.patch.object(sys, 'argv', ['build_canopy.py']):
                    with self.assertRaises(OSError):
                        bc.main()
                self.assertEqual(len(calls), 1)   # site b never fetched
            finally:
                bc.CACHE = saved_cache


@unittest.skipUnless(os.environ.get('CANOPY_LIVE'), 'set CANOPY_LIVE=1 to fetch doubletop and pisgah from S3 (about 130 MB)')
class TestLive(unittest.TestCase):
    """the real tool against the two sites the spike measured. the spike
    sampled a 1 m raster and this samples points, so a degree of tolerance is
    deliberate; a miss by more than that is a finding to report, not a
    tolerance to widen."""

    def test_doubletop_within_a_degree_of_the_spike(self):
        x, y, z, c, used, n, nbytes = bc.fetch_site(LAT, LON)
        self.assertEqual(used, ['NC_Phase5_Haywood_2017', 'NC_Phase5_Jackson_2017'])
        p = bc.profiles_for(x, y, z, c, LAT, LON)
        self.assertAlmostEqual(p['ground_m'], 1635.6, delta=1.0)
        with open(os.path.join(bh.CACHE, 'ov-n979739837.json'), encoding='utf-8') as f:
            ridge = json.load(f)['alt']
        both = np.maximum(np.maximum(p['t'], p['s']), ridge)
        self.assertAlmostEqual(float(both.mean()), 12.5, delta=1.0)
        self.assertAlmostEqual(float(both[135:225].mean()), 12.2, delta=1.0)
        self.assertLess(nbytes / 1e6, 200)

    def test_pisgah_summit_shows_its_tower_as_a_structure(self):
        lat, lon = 35.4259, -82.7568
        x, y, z, c, used, n, nbytes = bc.fetch_site(lat, lon)
        p = bc.profiles_for(x, y, z, c, lat, lon)
        self.assertGreater(max(p['s']), 45)       # the spike read 78.7 degrees at 19 m
        self.assertTrue(bc.needs_s(p['s'], p['t'], None))

    def test_north_cove_sees_the_valley_under_the_oaks(self):
        """shawn's photo, 2026-09-18: oak crowns overhead, the valley open
        under them. the window has to be there, well above the ridge. read
        from the full store on H:, with the network shut, so nothing is
        fetched and nothing is written there"""
        site = next(s for s in bc.site_list(bh.read_html()) if s['key'] == 'ov:n1731068878')
        with mock.patch.object(bc, 'STORE', os.environ.get('CANOPY_STORE', 'H:/dark-sky/ept')), \
             mock.patch.object(bc, 'http_get', side_effect=AssertionError('the store should hold every node')):
            x, y, z, c, *_ = bc.fetch_site(site['view_lat'], site['view_lon'])
        p = bc.profiles_for(x, y, z, c, site['view_lat'], site['view_lon'])
        ridge = np.asarray(bc.terrain_for(site)['alt'], float)
        open_deg = np.asarray(p['b']) - np.maximum(np.asarray(p['f']), ridge)
        wide = np.flatnonzero(open_deg >= 10)
        print('\nnorth cove: %d azimuths with a 10 degree window: %s' % (wide.size, runs_of(wide)))
        self.assertGreaterEqual(int(wide.size), 40, 'azimuths with a 10 degree window: %d' % int(wide.size))


def runs_of(az):
    """consecutive azimuths as 'a-b' ranges, for a live test to print"""
    out = []
    for a in az:
        if out and a == out[-1][1] + 1:
            out[-1][1] = a
        else:
            out.append([a, a])
    return ', '.join('%d-%d' % (a, b) for a, b in out)


class TestStore(unittest.TestCase):
    """the raw ept files kept on disk, one writer, only renamed files count"""

    def setUp(self):
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        self.saved = bc.STORE
        bc.STORE = self.dir.name

    def tearDown(self):
        bc.flush_store()
        bc.STORE = self.saved
        self.dir.cleanup()

    def test_first_read_fetches_and_writes_then_reads_from_disk(self):
        calls = []
        fetch = lambda: (calls.append(1), b'laz bytes')[1]
        self.assertEqual(bc.stored('DS/ept-data/0-0-0-0.laz', fetch), b'laz bytes')
        bc.flush_store()
        with open(os.path.join(self.dir.name, 'DS', 'ept-data', '0-0-0-0.laz'), 'rb') as f:
            self.assertEqual(f.read(), b'laz bytes')
        self.assertEqual(bc.stored('DS/ept-data/0-0-0-0.laz', fetch), b'laz bytes')
        self.assertEqual(len(calls), 1)

    def test_a_leftover_temp_file_is_fetched_again(self):
        path = os.path.join(self.dir.name, 'DS', 'ept-data', '1-0-0-0.laz')
        os.makedirs(os.path.dirname(path))
        with open(path + '.tmp', 'wb') as f:
            f.write(b'half')
        self.assertEqual(bc.stored('DS/ept-data/1-0-0-0.laz', lambda: b'whole'), b'whole')
        bc.flush_store()
        with open(path, 'rb') as f:
            self.assertEqual(f.read(), b'whole')

    def test_writes_go_through_one_writer(self):
        self.assertEqual(bc._writer._max_workers, 1)

    def test_an_empty_store_setting_writes_nothing(self):
        bc.STORE = ''
        self.assertEqual(bc.stored('DS/x.laz', lambda: b'x'), b'x')
        bc.flush_store()
        self.assertEqual(os.listdir(self.dir.name), [])

    def test_a_failed_write_surfaces_at_flush(self):
        with open(os.path.join(self.dir.name, 'DS'), 'w') as f:
            f.write('a file where the dataset directory should be')
        bc.stored('DS/ept-data/2-0-0-0.laz', lambda: b'x')
        with self.assertRaises(OSError):
            bc.flush_store()


def lattice(z_of, r=20):
    """ground returns on a 1 m grid, in metres east and north of the pin"""
    return [(float(a), float(b), z_of(a, b), 2) for a in range(-r, r + 1) for b in range(-r, r + 1)]


def arrays(rows):
    a = np.array(rows, float)
    return a[:, 0], a[:, 1], a[:, 2], a[:, 3].astype(np.int64)


# 15 m trees from 5 to 14 m out around a clearing, open ground beyond. the
# clearing is wider than the old finder's CLEAR_R, so that finder took it
RING = lattice(lambda a, b: 0.0, r=30) + [(a + .5, b + .5, 15.0, 5) for a in range(-15, 15) for b in range(-15, 15)
                                         if 5 <= math.hypot(a + .5, b + .5) <= 14]
# ground rising 0.3 m per m, 0.5 m shrubs on every metre, and 15 m trees
# everywhere but uphill past x = 12, where the ground is 3.6 m and more above
# the pin's: the only open ground is further up than the old LEVEL_M allowed
SLOPE = (lattice(lambda a, b: 0.3 * a, r=30)
         + [(a + .5, b + .5, 0.3 * (a + .5) + 0.5, 3) for a in range(-30, 30) for b in range(-30, 30)]
         + [(a + .5, b + .5, 0.3 * (a + .5) + 15.0, 5) for a in range(-30, 12) for b in range(-30, 30)])
# 20 m trees on every metre
FOREST = lattice(lambda a, b: 0.0) + [(a + .5, b + .5, 20.0, 5) for a in range(-20, 20) for b in range(-20, 20)]


class TestStandingSpot(unittest.TestCase):

    def test_closed_in_reads_the_median_tree_altitude_capped_at_the_encoding(self):
        self.assertTrue(bc.closed_in({'t': [60.0] * 360}))
        self.assertTrue(bc.closed_in({'t': [85.0] * 360}))
        self.assertFalse(bc.closed_in({'t': [10.0] * 360}))
        self.assertFalse(bc.closed_in({'t': None}))

    def small(self, search_r, sky_r=5.0):
        """a smaller search and sky box keeps a synthetic site fast"""
        return mock.patch.multiple(bc, SEARCH_R=search_r, SKY_R=sky_r)

    def test_a_grid_cell_covers_every_degree_it_spans(self):
        """a 1 m cell 3 m due north spans -9.5 to +9.5 degrees, touching the
        20 whole degrees from 350 to 9; one point per cell would fill one of
        them and leave the rest reading as open sky"""
        t = bc.skyline(np.array([0.0]), np.array([3.0]), np.array([10.0]), 0.0, 2.0, cell=1.0)
        self.assertEqual(int((t > 0).sum()), 20)
        self.assertTrue(np.all(t[[350, 0, 9]] > 0))
        raw = bc.skyline(np.array([0.0]), np.array([3.0]), np.array([10.0]), 0.0, 2.0)
        self.assertEqual(int((raw > 0).sum()), 1)   # the raw-point raycast is unchanged

    def test_open_pct_counts_azimuths_under_open_deg(self):
        self.assertEqual(bc.open_pct([10.0] * 90 + [40.0] * 270), 25.0)

    def test_an_open_pin_is_its_own_spot(self):
        dx, dy, z, c = arrays(lattice(lambda a, b: 0.0))
        with self.small(20.0):
            cx, cy, dz, med, op = bc.sky_candidates(dx, dy, z, c, 0.0)
        k = bc.pick_spot(cx, cy, med)
        self.assertIsNotNone(k)
        self.assertLess(math.hypot(cx[k], cy[k]), 1.5)

    def test_a_small_clearing_ringed_by_trees_is_not_a_spot(self):
        """jackrabbit: the pin in a clearing 5 m in radius, 15 m trees from 5
        to 14 m out, open ground beyond. the old finder took the clearing
        itself, 0.7 m from the pin; the sky from it is still the ring, so the
        spot is past the trees"""
        with self.small(25.0):
            cx, cy, dz, med, op = bc.sky_candidates(*arrays(RING), 0.0)
        k = bc.pick_spot(cx, cy, med)
        self.assertIsNotNone(k)
        self.assertGreaterEqual(math.hypot(cx[k], cy[k]), 14.0)
        self.assertLessEqual(med[k], bc.CLOSED_DEG)
        pin = int(np.argmin(np.hypot(cx, cy)))
        self.assertGreater(med[pin], bc.CLOSED_DEG)

    def test_a_slope_with_shrubs_still_finds_a_spot(self):
        """devil's courthouse: the only open ground is uphill past the trees,
        3.6 m and more above the pin on a 0.3 m per m slope with shrubs on
        every metre. the old finder's 3 m level window refused it; this one
        takes it, and neither the slope nor the shrubs is in the way"""
        with self.small(25.0):
            cx, cy, dz, med, op = bc.sky_candidates(*arrays(SLOPE), 0.0)
        k = bc.pick_spot(cx, cy, med)
        self.assertIsNotNone(k)
        self.assertGreater(dz[k], 3.0)

    def test_open_ground_below_the_lip_is_refused(self):
        """the pin on a wooded ledge; the open ground 20 m down past x = 3 is
        the foot of the cliff, not a place to stand and look"""
        rows = lattice(lambda a, b: 0.0 if a <= 3 else -20.0)
        rows += [(a + .5, b + .5, 12.0, 5) for a in range(-20, 4) for b in range(-20, 21)]
        with self.small(20.0):
            cx, cy, dz, med, op = bc.sky_candidates(*arrays(rows), 0.0)
        self.assertIsNone(bc.pick_spot(cx, cy, med))

    def test_closed_forest_has_no_spot_but_a_best_candidate(self):
        with self.small(15.0):
            cx, cy, dz, med, op = bc.sky_candidates(*arrays(FOREST), 0.0)
        self.assertIsNone(bc.pick_spot(cx, cy, med))
        self.assertGreater(len(med), 0)
        self.assertGreater(float(np.min(med)), bc.CLOSED_DEG)
        self.assertEqual(len(op), len(med))

    def fetch_of(self, rows):
        """fetch_site's return for synthetic local rows around LAT, LON"""
        dx, dy, z, c = arrays(rows)
        x0, y0 = bc.mercator(LAT, LON)
        k = math.cos(math.radians(LAT))
        return lambda lat, lon: (x0 + dx / k, y0 + dy / k, z, c, [], 0, 0)

    def test_raw_points_confirm_a_spot_the_grid_reads_closed(self):
        """sparse 7 m crowns 6 to 9 m around the pin, one return per cell: the
        grid spreads each return over its whole cell and reads about 40, the
        returns themselves leave most of the sky open"""
        rows = lattice(lambda a, b: 0.0) + [(a + .5, b + .5, 7.0, 5) for a in range(-10, 10) for b in range(-10, 10)
                                           if 6 <= math.hypot(a + .5, b + .5) <= 9]
        dx, dy, z, c = arrays(rows)
        with mock.patch.multiple(bc, SEARCH_R=2.0, SKY_R=15.0):
            cx, cy, dz, med, op = bc.sky_candidates(dx, dy, z, c, 0.0)
            k, raw = bc.confirm_spot(dx, dy, z, c, 0.0, cx, cy, dz, med)
        pin = int(np.argmin(np.hypot(cx, cy)))
        self.assertTrue(bc.CLOSED_DEG < med[pin] <= bc.CLOSED_DEG + bc.CONFIRM_DEG, med[pin])
        self.assertEqual(k, pin)
        self.assertLessEqual(raw[pin], bc.CLOSED_DEG)

    def test_suggest_rows_carry_open_sky_and_the_best_candidate(self):
        site = {'name': 'S', 'key': 'S', 'ov_id': None, 'view_lat': LAT, 'view_lon': LON}
        rec = {'t': [10.0] * 90 + [40.0] * 270}
        no_ridge = mock.patch.object(bc, 'terrain_for', return_value={})
        no_ridge.start()
        self.addCleanup(no_ridge.stop)
        no_osm = mock.patch.object(bc, 'osm_access', return_value=None)   # overpass did not answer
        no_osm.start()
        self.addCleanup(no_osm.stop)
        with self.small(15.0), mock.patch.object(bc, 'fetch_site', side_effect=self.fetch_of(FOREST)):
            row = bc.suggest(site, rec)
        self.assertIsNone(row['spot'])
        self.assertEqual(row['open_before'], 25.0)
        self.assertGreater(row['best_median'], bc.CLOSED_DEG)
        self.assertLessEqual(row['best_m'], 15.0)
        self.assertEqual(row['best_dz_m'], 0.0)
        self.assertEqual(row['best_by'], 'grid')   # every candidate under a crown, so none was raycast raw
        # a dense 7 m stand 6 to 9 m out, solid from the ground up so there is
        # no window under it: the grid lets the candidates through to the raw
        # check, which reads about 40 and confirms none
        stand = lattice(lambda a, b: 0.0) + [(a * .25, b * .25, h, 5) for a in range(-40, 41) for b in range(-40, 41)
                                            for h in np.arange(0.0, 7.01, 1.0) if 6 <= math.hypot(a * .25, b * .25) <= 9]
        with mock.patch.multiple(bc, SEARCH_R=2.0, SKY_R=15.0), \
             mock.patch.object(bc, 'fetch_site', side_effect=self.fetch_of(stand)):
            row = bc.suggest(site, rec)
        self.assertIsNone(row['spot'])
        self.assertEqual(row['best_by'], 'raw')
        self.assertTrue(bc.CLOSED_DEG < row['best_median'] < bc.CLOSED_DEG + bc.CONFIRM_DEG, row['best_median'])
        with self.small(25.0), mock.patch.object(bc, 'fetch_site', side_effect=self.fetch_of(RING)):
            row = bc.suggest(site, rec)
        self.assertGreaterEqual(row['moved_m'], 14.0)
        self.assertEqual(row['dz_m'], 0.0)
        self.assertGreater(row['open_after'], 25.0)
        self.assertNotIn('best_m', row)
        self.assertIsNone(row['on_path'])   # no osm answer: reach unknown
        with self.small(25.0), mock.patch.object(bc, 'fetch_site', side_effect=self.fetch_of(RING)),              mock.patch.object(bc, 'osm_access', return_value=[]):
            row = bc.suggest(site, rec)
        self.assertIs(row['on_path'], False)   # osm answered with nothing near: off path

    def test_from_local_inverts_local_xy(self):
        lat, lon = bc.from_local(12.0, -7.0, LAT, LON)
        x0, y0 = bc.mercator(LAT, LON)
        x, y = bc.mercator(lat, lon)
        dx, dy = bc.local_xy(np.array([x]), np.array([y]), x0, y0, LAT)
        self.assertAlmostEqual(float(dx[0]), 12.0, places=6)
        self.assertAlmostEqual(float(dy[0]), -7.0, places=6)

    def test_the_walk_counts_metres_under_trees(self):
        rows = lattice(lambda a, b: 0.0) + [(5.0 + a * .5, b * .5, 10.0, 5) for a in range(0, 5) for b in range(-2, 3)]
        dx, dy, z, c = arrays(rows)
        self.assertGreater(bc.walk_under_trees(dx, dy, z, c, 0.0, (12.0, 0.0)), 0)
        self.assertEqual(bc.walk_under_trees(dx, dy, z, c, 0.0, (0.0, 12.0)), 0)

    def test_review_table_has_a_row_per_site_and_says_when_there_is_no_spot(self):
        rows = [{'name': 'A', 'key': 'A', 'lat': 35.1, 'lon': -83.1, 'before': 70.0, 'spot': (35.10001, -83.10002),
                 'moved_m': 12.3, 'bearing': 45.0, 'after': 20.0, 'under_trees_m': 4,
                 'open_before': 5.0, 'dz_m': -2.46, 'open_after': 61.4, 'on_path': False},
                {'name': 'B', 'key': 'B', 'lat': 35.2, 'lon': -83.2, 'before': 50.0, 'spot': None,
                 'open_before': 0.0, 'best_m': 23.2, 'best_median': 35.8, 'best_dz_m': -3.1, 'best_by': 'raw'},
                {'name': 'C', 'key': 'C', 'lat': 35.3, 'lon': -83.3, 'before': 40.0, 'spot': None, 'open_before': 0.0},
                {'name': 'D', 'key': 'D', 'lat': 35.4, 'lon': -83.4, 'before': 35.0, 'spot': None,
                 'open_before': 0.0, 'best_m': 4.0, 'best_median': 80.0, 'best_dz_m': 0.0, 'best_by': 'grid'}]
        md = bc.review_md(rows)
        lines = [l for l in md.splitlines() if l[:4] in ('| A ', '| B ', '| C ', '| D ')]
        self.assertEqual(len(lines), 4)
        self.assertIn('| open now |', md)
        self.assertIn('| up/down |', md)
        self.assertIn('| open then |', md)
        self.assertIn('| 5% |', lines[0])
        self.assertIn('| -2.5 m |', lines[0])
        self.assertIn('| 61% |', lines[0])
        self.assertIn('| key |', md)         # header names the column
        self.assertIn('| reach |', md)
        self.assertIn('| off path |', lines[0])
        self.assertIn('| A | A |', lines[0])  # site and key both show for this row
        self.assertIn('35.100010, -83.100020', lines[0])
        self.assertIn('https://www.google.com/maps/@35.100010,-83.100020,40m/data=!3m1!1e3', lines[0])
        self.assertIn('none under 30 within 60 m; best 36 at 23 m, 3 m down', lines[1])
        self.assertIn('none under 30 within 60 m |', lines[2])   # no candidate at all, so no best
        self.assertIn('best 80 at 4 m, 0 m up (grid)', lines[3])   # no raw check ran, so the figure is the grid's
        self.assertNotIn('(grid)', lines[1])

    def test_bearing_wraps_to_000_not_360(self):
        rows = [{'name': 'A', 'key': 'A', 'lat': 35.1, 'lon': -83.1, 'before': 70.0,
                 'spot': (35.10001, -83.10002), 'moved_m': 12.3, 'bearing': 359.8,
                 'after': 20.0, 'under_trees_m': 4, 'open_before': 5.0, 'dz_m': 0.0, 'open_after': 61.4}]
        line = [l for l in bc.review_md(rows).splitlines() if l.startswith('| A ')][0]
        self.assertIn('| 000 |', line)
        self.assertIn('| unknown |', line)   # a row with no on_path, or osm unavailable

    def test_review_table_accepts_a_spot_loaded_back_from_json_as_a_list(self):
        """json has no tuples: a row read back from its cache file carries
        spot as a list, and the table has to format that the same way"""
        rows = [{'name': 'A', 'key': 'A', 'lat': 35.1, 'lon': -83.1, 'before': 70.0,
                 'spot': [35.10001, -83.10002], 'moved_m': 12.3, 'bearing': 45.0,
                 'after': 20.0, 'under_trees_m': 4, 'open_before': 5.0, 'dz_m': 0.0, 'open_after': 61.4}]
        line = [l for l in bc.review_md(rows).splitlines() if l.startswith('| A ')][0]
        self.assertIn('35.100010, -83.100020', line)


class TestAccess(unittest.TestCase):

    def test_a_candidate_beside_a_path_is_reachable_and_one_in_the_woods_is_not(self):
        lat, lon = LAT, LON
        # a path running east-west 20 m north of the pin
        way = {'tags': {'highway': 'footway'}, 'geometry': [
            dict(zip(('lat', 'lon'), bc.from_local(-30.0, 20.0, lat, lon))),
            dict(zip(('lat', 'lon'), bc.from_local(30.0, 20.0, lat, lon)))]}
        ok = bc.near_access(np.array([0.0, 0.0]), np.array([18.0, -20.0]), [way], lat, lon)
        self.assertEqual(list(ok), [True, False])

    def test_inside_a_parking_polygon_is_reachable(self):
        lat, lon = LAT, LON
        ring = [bc.from_local(x, y, lat, lon) for x, y in ((-10, -10), (10, -10), (10, 10), (-10, 10), (-10, -10))]
        lot = {'tags': {'amenity': 'parking'}, 'geometry': [{'lat': a, 'lon': b} for a, b in ring]}
        self.assertTrue(bc.near_access(np.array([0.0]), np.array([0.0]), [lot], lat, lon)[0])

    def test_pick_prefers_the_reachable_spot_over_a_nearer_one_in_the_woods(self):
        cx, cy = np.array([5.0, 12.0]), np.array([0.0, 0.0])
        median = np.array([20.0, 25.0])
        self.assertEqual(bc.pick_spot(cx, cy, median, np.array([False, True])), 1)
        self.assertEqual(bc.pick_spot(cx, cy, median, np.array([False, False])), 0)

    def test_a_highway_that_is_not_a_road_or_path_does_not_count(self):
        lat, lon = LAT, LON
        way = {'tags': {'highway': 'proposed'}, 'geometry': [
            dict(zip(('lat', 'lon'), bc.from_local(-30.0, 0.0, lat, lon))),
            dict(zip(('lat', 'lon'), bc.from_local(30.0, 0.0, lat, lon)))]}
        self.assertFalse(bc.near_access(np.array([0.0]), np.array([0.0]), [way], lat, lon)[0])

    def test_confirm_walks_reachable_candidates_first(self):
        """open ground, so every candidate clears: the nearest is the pin, but
        the one reachable candidate, farther out, is checked first and wins"""
        dx, dy, z, c = arrays(lattice(lambda a, b: 0.0))
        with mock.patch.multiple(bc, SEARCH_R=4.0, SKY_R=5.0):
            cx, cy, dz, med, op = bc.sky_candidates(dx, dy, z, c, 0.0)
            far = int(np.argmax(np.hypot(cx, cy)))
            ok = np.arange(len(cx)) == far
            k, raw = bc.confirm_spot(dx, dy, z, c, 0.0, cx, cy, dz, med, None, ok)
            near, _ = bc.confirm_spot(dx, dy, z, c, 0.0, cx, cy, dz, med)
        self.assertEqual(k, far)
        self.assertNotEqual(near, far)   # without the mask the nearest wins
        self.assertEqual(int(np.isfinite(raw).sum()), 1)   # stopped at the first that cleared

    def test_osm_access_caches_an_answer_and_not_a_failure(self):
        site = {'name': 'Gorges', 'ov_id': None, 'view_lat': LAT, 'view_lon': LON}
        body = json.dumps({'elements': [{'type': 'way', 'tags': {'highway': 'service'}, 'geometry': []}]}).encode()
        with tempfile.TemporaryDirectory() as d, mock.patch.object(bc, 'CACHE', d), \
             mock.patch.object(bc, 'OVERPASS', ['http://one.invalid/', 'http://two.invalid/']):
            with mock.patch.object(bc.urllib.request, 'urlopen', side_effect=urllib.error.URLError('down')) as down, \
                 contextlib.redirect_stdout(io.StringIO()):   # keep the suite output clean
                self.assertIsNone(bc.osm_access(site))
            self.assertEqual(down.call_count, 2)   # both endpoints tried
            self.assertFalse(os.path.exists(os.path.join(d, 'osm', 'gorges.json')))   # so a later run asks again
            with mock.patch.object(bc.urllib.request, 'urlopen', return_value=_fake_response(body)):
                self.assertEqual(len(bc.osm_access(site)), 1)
            with mock.patch.object(bc.urllib.request, 'urlopen', side_effect=AssertionError('cached')):
                self.assertEqual(bc.osm_access(site)[0]['tags'], {'highway': 'service'})


class TestSuggestCheckpoint(unittest.TestCase):
    """--suggest-views is a 20+ minute, 40-site run: each site's row is its
    own file, so a fetch failure partway through loses only that site, and a
    re-run reuses every row already on disk at the same coordinate and
    tunables."""

    HTML = ('const SPOTS = [\n'
            "  { name: 'Site A (fails)', lat: 35.10, lon: -83.10, elev: 4000, kind: 'view' },\n"
            "  { name: 'Site B (ok)', lat: 35.90, lon: -82.20, elev: 4000, kind: 'view' },\n"
            '];\n'
            'const OVERLOOKS = [\n'
            '];\n')

    CLOSED_REC = {'t': [60.0] * 360}

    def fake_suggest(self, s, r):
        if s['name'] == 'Site A (fails)':
            raise OSError('connection reset by peer')
        return {'name': s['name'], 'key': s['key'], 'lat': s['view_lat'], 'lon': s['view_lon'],
                'before': 60.0, 'open_before': 0.0, 'spot': None, 'params': bc.suggest_params()}

    def test_a_failed_site_is_skipped_and_leaves_no_row_file(self):
        with tempfile.TemporaryDirectory() as d:
            saved = bc.CACHE
            bc.CACHE = d
            try:
                with mock.patch.object(bh, 'read_html', return_value=self.HTML), \
                     mock.patch.object(bc, 'load_cached', side_effect=lambda s: dict(self.CLOSED_REC)), \
                     mock.patch.object(bc, 'suggest', side_effect=self.fake_suggest), \
                     mock.patch.object(sys, 'argv', ['build_canopy.py', '--suggest-views']):
                    with contextlib.redirect_stdout(io.StringIO()):   # keep the suite output clean
                        bc.main()
                self.assertEqual(os.listdir(os.path.join(d, 'suggest')), ['site-b-ok.json'])
                with open(os.path.join(d, 'view-review.md'), encoding='utf-8') as f:
                    self.assertIn('Site B (ok)', f.read())
            finally:
                bc.CACHE = saved

    def test_a_spot_whose_reach_is_unknown_is_asked_again(self):
        """overpass not answering is not kept, so the next run recomputes the
        row and asks again; a known reach, or no spot at all, is kept"""
        site = {'view_lat': 35.9, 'view_lon': -82.2}
        row = {'lat': 35.9, 'lon': -82.2, 'params': bc.suggest_params(), 'spot': [35.9, -82.2]}
        self.assertFalse(bc.suggest_ok(dict(row, on_path=None), site))
        self.assertTrue(bc.suggest_ok(dict(row, on_path=False), site))
        self.assertTrue(bc.suggest_ok(dict(row, spot=None), site))

    def test_a_row_already_on_disk_at_the_same_coordinate_and_params_is_reused(self):
        with tempfile.TemporaryDirectory() as d:
            saved = bc.CACHE
            bc.CACHE = d
            try:
                os.makedirs(os.path.join(d, 'suggest'))
                site = {'name': 'Site B (ok)', 'ov_id': None}
                row = {'name': 'Site B (ok)', 'key': 'Site B (ok)', 'lat': 35.90, 'lon': -82.20,
                       'before': 60.0, 'open_before': 0.0, 'spot': None, 'params': bc.suggest_params()}
                with open(os.path.join(d, 'suggest', bh.cache_name(site)), 'w', encoding='utf-8') as f:
                    json.dump(row, f)
                calls = []
                with mock.patch.object(bh, 'read_html', return_value=self.HTML), \
                     mock.patch.object(bc, 'load_cached',
                                        side_effect=lambda s: dict(self.CLOSED_REC) if s['name'] == 'Site B (ok)' else None), \
                     mock.patch.object(bc, 'suggest', side_effect=lambda s, r: calls.append(s['name'])), \
                     mock.patch.object(sys, 'argv', ['build_canopy.py', '--suggest-views']):
                    with contextlib.redirect_stdout(io.StringIO()):   # keep the suite output clean
                        bc.main()
                self.assertEqual(calls, [])   # never recomputed
            finally:
                bc.CACHE = saved

    def test_force_recomputes_a_row_already_on_disk(self):
        with tempfile.TemporaryDirectory() as d:
            saved = bc.CACHE
            bc.CACHE = d
            try:
                os.makedirs(os.path.join(d, 'suggest'))
                site = {'name': 'Site B (ok)', 'ov_id': None}
                row = {'name': 'Site B (ok)', 'key': 'Site B (ok)', 'lat': 35.90, 'lon': -82.20,
                       'before': 60.0, 'open_before': 0.0, 'spot': None, 'params': bc.suggest_params()}
                with open(os.path.join(d, 'suggest', bh.cache_name(site)), 'w', encoding='utf-8') as f:
                    json.dump(row, f)
                calls = []
                with mock.patch.object(bh, 'read_html', return_value=self.HTML), \
                     mock.patch.object(bc, 'load_cached',
                                        side_effect=lambda s: dict(self.CLOSED_REC) if s['name'] == 'Site B (ok)' else None), \
                     mock.patch.object(bc, 'suggest', side_effect=lambda s, r: (calls.append(s['name']), dict(row))[1]), \
                     mock.patch.object(sys, 'argv', ['build_canopy.py', '--suggest-views', '--force']):
                    with contextlib.redirect_stdout(io.StringIO()):
                        bc.main()
                self.assertEqual(calls, ['Site B (ok)'])   # --force recomputed it despite the row on disk
            finally:
                bc.CACHE = saved

    def test_summary_line_reports_net_bytes_pulled(self):
        """the same net figure the main loop prints, so a run over a full
        store can be seen to use 0 MB"""
        with tempfile.TemporaryDirectory() as d:
            saved = bc.CACHE
            bc.CACHE = d
            try:
                with mock.patch.object(bh, 'read_html', return_value=self.HTML), \
                     mock.patch.object(bc, 'load_cached', side_effect=lambda s: dict(self.CLOSED_REC)), \
                     mock.patch.object(bc, 'suggest', side_effect=self.fake_suggest), \
                     mock.patch.object(sys, 'argv', ['build_canopy.py', '--suggest-views']):
                    out = io.StringIO()
                    with contextlib.redirect_stdout(out):
                        bc.main()
                summary = [l for l in out.getvalue().splitlines() if l.startswith('1 closed-in')]
                self.assertEqual(len(summary), 1)
                self.assertIn('net 0 MB', summary[0])   # fake_suggest never calls http_get
            finally:
                bc.CACHE = saved



def crown(x0, y0, z_lo, z_hi, step=0.5):
    """one leaf-off crown filling a 1 m cell from z_lo to z_hi"""
    zs = np.arange(z_lo, z_hi + 1e-9, step)
    return np.full(zs.size, x0), np.full(zs.size, y0), zs


class TestCanopyBands(unittest.TestCase):
    EYE = 1.7

    def bands(self, *parts):
        dx = np.concatenate([p[0] for p in parts]); dy = np.concatenate([p[1] for p in parts]); z = np.concatenate([p[2] for p in parts])
        return bc.canopy_bands(dx, dy, z, self.EYE, bc.MIN_R)

    def test_a_crown_overhead_leaves_the_sky_under_it_open(self):
        """a crown 6 m east from 8 to 18 m: on azimuth 90 the window runs from
        the bottom of the range up to the crown base, about 46 degrees"""
        f, b = self.bands(crown(6.0, 0.0, 8.0, 18.0))
        self.assertAlmostEqual(f[90], bh.ALT_MIN, delta=0.6)
        self.assertAlmostEqual(b[90], math.degrees(math.atan2(8.0 - self.EYE, 6.0)), delta=1.5)
        self.assertTrue(np.isnan(f[270]))          # nothing west, no tree line, no window to speak of

    def test_understory_under_the_crown_does_not_close_the_window(self):
        f, b = self.bands(crown(6.0, 0.0, 8.0, 18.0), crown(6.0, 0.0, 0.2, 1.0, 0.2))
        self.assertAlmostEqual(f[90], math.degrees(math.atan2(1.0 - self.EYE, 6.0)), delta=1.5)
        self.assertGreater(b[90] - f[90], 40)

    def test_a_solid_stem_to_crown_column_has_no_window(self):
        f, b = self.bands(crown(10.0, 0.0, 0.0, 15.0))
        self.assertTrue(np.isnan(f[90]) and np.isnan(b[90]))

    def test_nobody_sees_through_a_forest_past_through_m(self):
        """the same understory-then-crown cell that leaves a window at 6 m
        leaves none at 60 m: past THROUGH_M a cell is solid from its lowest
        return up"""
        f, b = self.bands(crown(60.0, 0.0, 12.0, 22.0), crown(60.0, 0.0, 0.2, 1.0, 0.2))
        # the only open run left is under the forest's lowest return, below the
        # horizon, which canopy_entry's ridge test never ships
        self.assertTrue(np.isnan(b[90]) or b[90] <= 0.0, b[90])

    def test_a_window_narrower_than_window_min_deg_is_not_one(self):
        """a slab 6 m out topping at 20 degrees and a crown 7 m out starting at
        22: two cells, so they never merge, and the 2 degree gap between them
        is under WINDOW_MIN_DEG"""
        lo_top = 6.0 * math.tan(math.radians(20)) + self.EYE
        hi_bot = 7.0 * math.tan(math.radians(22)) + self.EYE
        f, b = self.bands(crown(6.0, 0.0, 0.0, lo_top, lo_top / 40), crown(7.0, 0.0, hi_bot, hi_bot + 8, 0.1))
        self.assertTrue(np.isnan(f[90]), (f[90], b[90]))


class TestSightFloor(unittest.TestCase):

    def test_a_window_above_the_ridge_is_the_floor(self):
        s = bc.sight_floor([70.0] * 360, [-10.0] * 360, [45.0] * 360, [3.0] * 360)
        self.assertEqual(float(s[0]), 3.0)

    def test_without_a_window_the_tree_line_is_the_floor(self):
        s = bc.sight_floor([70.0] * 360, [70.0] * 360, [70.0] * 360, [3.0] * 360)
        self.assertEqual(float(s[0]), 70.0)

    def test_a_window_shorter_than_window_min_deg_over_the_ridge_does_not_count(self):
        s = bc.sight_floor([70.0] * 360, [-10.0] * 360, [5.0] * 360, [3.0] * 360)
        self.assertEqual(float(s[0]), 70.0)

    def test_the_tree_line_is_capped_at_the_top_of_the_encoding(self):
        s = bc.sight_floor([85.0] * 360, [85.0] * 360, [85.0] * 360)
        self.assertEqual(float(s[0]), bh.ALT_MIN + bh.ALT_RANGE)

    def test_closed_in_uses_the_sight_floor(self):
        open_under = {'t': [70.0] * 360, 'f': [-10.0] * 360, 'b': [45.0] * 360}
        self.assertFalse(bc.closed_in(open_under, [3.0] * 360))
        walled = {'t': [70.0] * 360, 'f': [70.0] * 360, 'b': [70.0] * 360}
        self.assertTrue(bc.closed_in(walled, [3.0] * 360))

    def test_the_floor_is_never_above_the_tree_line(self):
        """canopy_bands spreads a cell's slab over every degree the cell
        covers, while skyline on raw points fills only the degrees they fall
        in: a column 3 m east, returns 0 to 3 m and 6 to 9 m, leaves a window
        on azimuths the tree line reads as open. the open azimuth's floor is
        its tree line, not the window's"""
        zs = np.concatenate((np.arange(0.0, 3.01, 0.5), np.arange(6.0, 9.01, 0.5)))
        dx, dy = np.full(zs.size, 3.0), np.zeros(zs.size)
        t = bc.skyline(dx, dy, zs, bh.EYE, bc.MIN_R)
        f, b = bc.canopy_bands(dx, dy, zs, bh.EYE, bc.MIN_R)
        s = bc.sight_floor(t, f, b)
        self.assertTrue(np.all(s <= np.maximum(bh.ALT_MIN, np.minimum(t, bh.ALT_MIN + bh.ALT_RANGE))),
                        (t[80], f[80], b[80], s[80]))

    def test_profiles_for_reads_no_window_as_f_and_b_equal_to_t(self):
        """the sight floor leans on this: a stem-to-crown column east has no
        window (canopy_bands gives nan) and an empty west has no trees, and on
        both the record's f and b are its t"""
        col = [(10.0, 0.0, h, 5) for h in np.arange(0.0, 15.01, 0.5)]
        p = bc.profiles_for(*pts(*ring(2), *col), LAT, LON)
        self.assertGreater(p['t'][90], 50)
        for a in (90, 270):
            self.assertEqual(p['f'][a], p['t'][a])
            self.assertEqual(p['b'][a], p['t'][a])

    # crowns from 8 to 18 m, 6 to 9 m around the pin, open trunk space under
    # them: the tree line is about 70, the sky under the crowns is open
    UNDER = lattice(lambda a, b: 0.0) + [(a * .5, b * .5, h, 5) for a in range(-20, 21) for b in range(-20, 21)
                                        for h in np.arange(8.0, 18.01, 1.0) if 6 <= math.hypot(a * .5, b * .5) <= 9]

    def test_confirm_spot_looks_under_the_crowns(self):
        dx, dy, z, c = arrays(self.UNDER)
        one = np.zeros(1)
        k, raw = bc.confirm_spot(dx, dy, z, c, 0.0, one, one, one, np.array([40.0]), [3.0] * 360)
        self.assertEqual(k, 0)
        self.assertEqual(raw[0], 3.0)    # the window's floor is the ridge

    def test_suggest_reads_before_and_open_before_as_the_sight_floor(self):
        site = {'name': 'S', 'key': 'S', 'ov_id': None, 'view_lat': LAT, 'view_lon': LON}
        rec = {'t': [70.0] * 360, 'f': [-10.0] * 360, 'b': [45.0] * 360}
        fetch = TestStandingSpot.fetch_of(self, FOREST)
        with mock.patch.multiple(bc, SEARCH_R=15.0, SKY_R=5.0), mock.patch.object(bc, 'fetch_site', side_effect=fetch), \
             mock.patch.object(bc, 'terrain_for', return_value={'alt': [3.0] * 360}), \
             mock.patch.object(bc, 'osm_access', return_value=None):
            row = bc.suggest(site, rec)
        self.assertEqual(row['before'], 3.0)
        self.assertEqual(row['open_before'], 100.0)

    def test_suggest_params_carry_the_window_tunables(self):
        self.assertEqual(bc.suggest_params()[-4:], [bc.VGAP_M, bc.THROUGH_M, bc.WINDOW_MIN_DEG, bc.ACCESS_M])


class TestCanopyEntryWindows(unittest.TestCase):

    def rec(self, t, f, b):
        return {'t': [t] * 360, 's': [bh.ALT_MIN] * 360, 'f': [f] * 360, 'b': [b] * 360, 'deck': None}

    def test_a_window_above_the_ridge_ships_f_and_b(self):
        e = bc.canopy_entry(self.rec(60.0, -5.0, 40.0), {'alt': [2.0] * 360})
        self.assertIn('f', e); self.assertIn('b', e)

    def test_a_window_under_the_ridge_ships_nothing_extra(self):
        e = bc.canopy_entry(self.rec(60.0, -5.0, 4.0), {'alt': [3.0] * 360})
        self.assertNotIn('f', e); self.assertNotIn('b', e)

    def test_no_window_anywhere_ships_the_entry_as_before(self):
        e = bc.canopy_entry(self.rec(60.0, 60.0, 60.0), {'alt': [2.0] * 360})
        self.assertEqual(sorted(e), ['t'])


if __name__ == '__main__':
    unittest.main()
