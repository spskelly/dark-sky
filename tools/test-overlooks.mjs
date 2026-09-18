import test from 'node:test';
import assert from 'node:assert/strict';
import { milepost, metres, pick, parseSpots, row } from './build-overlooks.mjs';

const node = (id, name, lat, lon) => ({ type: 'node', id, lat, lon, tags: name ? { tourism: 'viewpoint', name } : { tourism: 'viewpoint' } });
const way = (id, name, lat, lon) => ({ type: 'way', id, center: { lat, lon }, tags: { tourism: 'viewpoint', name } });

test('the milepost is read out of the name and never invented', () => {
  assert.equal(milepost('Licklog Gap Overlook (MP 435.7)'), 435.7);
  assert.equal(milepost('View Funnel Top (MP 409.3)'), 409.3);
  assert.equal(milepost('Mills River Valley Overlook MP404'), 404);
  assert.equal(milepost('Air Bellows Overlook'), null);
});

test('metres is good to a few metres at this latitude', () => {
  // one thousandth of a degree of latitude is 111.2 m
  assert.ok(Math.abs(metres({ lat: 35.4, lon: -83 }, { lat: 35.401, lon: -83 }) - 111.2) < 1);
});

test('unnamed and generically named viewpoints are dropped', () => {
  const out = pick([node(1, null, 35.5, -82.5), node(2, 'Scenic Overlook', 35.6, -82.6), node(3, 'Bad Fork Valley Overlook', 35.7, -82.7)], []);
  assert.deepEqual(out.kept.map(o => o.name), ['Bad Fork Valley Overlook']);
  assert.deepEqual(out.counts, { returned: 3, named: 1, inNorthCarolina: 1, clearOfSpots: 1, distinct: 1 });
});

test('anything within 300 m of a curated spot or its viewpoint is dropped', () => {
  const spots = [{ name: 'Cowee Mountains Overlook', lat: 35.3556, lon: -82.9879, view: null },
                 { name: 'Waterrock Knob', lat: 35.4605, lon: -83.1400, view: [35.4641, -83.1377] }];
  const out = pick([
    node(1, 'Cowee Mountains Overlook', 35.3557, -82.9880),   // on the spot
    node(2, 'Waterrock Knob Summit', 35.4640, -83.1376),      // on the view:
    node(3, 'Fork Ridge Overlook', 35.4490, -83.1300),        // 1.5 km off
  ], spots);
  assert.deepEqual(out.kept.map(o => o.name), ['Fork Ridge Overlook']);
});

test('a node and a way for one overlook collapse, the node winning; same name far apart stays two', () => {
  const out = pick([
    way(10, 'Pounding Mill Overlook', 35.3300, -82.8000),
    node(11, 'Pounding Mill Overlook', 35.3301, -82.8001),    // about 14 m away
    node(12, 'View Waynesville', 35.4500, -83.0000),
    node(13, 'View Waynesville', 35.4700, -83.0000),          // 2.2 km away
  ], []);
  assert.deepEqual(out.kept.map(o => o.id), ['n13', 'n12', 'n11']);   // north to south
});

test('two names for one pull-off collapse whatever they are called, and the milepost spelling is kept', () => {
  const out = pick([
    // the two pairs that shipped twice: a "View " prefix on one, and
    // "Parking" against "Gap Overlook" on the other
    node(981685208, 'View Hominy Valley', 35.4476, -82.7173),
    node(9743653104, 'Hominy Valley (MP 404.2)', 35.4475, -82.7172),         // about 14 m away
    way(98261195, 'Beaver Dam Overlook Parking', 35.4538, -82.6800),
    node(9041327666, 'Beaver Dam Gap Overlook (MP 401.7)', 35.4536, -82.6800), // about 22 m away
    // and the other direction: one name, two real pull-offs 2 km apart
    node(36, 'Fair View Overlook', 35.8000, -83.2000),
    node(37, 'Fair View Overlook', 35.8180, -83.2000),
  ], []);
  const ids = out.kept.map(o => o.id);
  assert.deepEqual(ids.filter(i => i.endsWith('685208') || i.endsWith('653104')), ['n9743653104']);
  assert.deepEqual(ids.filter(i => i.endsWith('261195') || i.endsWith('327666')), ['n9041327666']);
  assert.equal(out.kept.find(o => o.id === 'n9743653104').mp, 404.2);
  assert.equal(out.kept.find(o => o.id === 'n9041327666').mp, 401.7);
  assert.equal(ids.includes('n36') && ids.includes('n37'), true, 'same name 2 km apart stays two');
});

test('anything north of the state line is dropped, and counted', () => {
  const out = pick([
    node(40, 'Pilot Mountain Overlook', 36.6419, -80.5347),   // 28 road miles into virginia
    node(41, 'Air Bellows Overlook', 36.4200, -81.2000),      // the northernmost in north carolina
  ], []);
  assert.deepEqual(out.kept.map(o => o.id), ['n41']);
  assert.equal(out.counts.inNorthCarolina, 1);
});

test('coordinates are cut to four decimals', () => {
  const [o] = pick([node(1, 'X Overlook', 35.123456, -82.987654)], []).kept;
  assert.deepEqual([o.lat, o.lon], [35.1235, -82.9877]);
});

test('a name that tries to close the page script is escaped, and still reads back whole', () => {
  const name = 'Bad Fork </script><script>alert(1)</script> Overlook';
  const line = row({ id: 'n1', name, lat: 35.5, lon: -82.9 });
  assert.equal(line.includes('<'), false, 'no raw < survives into the inline script');
  // the line-wise readers in build_horizons.py, check_alignment.py and
  // build-skyglow.mjs hand the row to a real JSON parser, which reads <
  // back as <, so the name is not altered for them
  assert.equal(JSON.parse(line).name, name);
});

test('spots parse with both quote styles and an optional view', () => {
  const html = "const SPOTS = [\n  { name: 'A', lat: 35.1, lon: -83.1, elev: 1, view: [35.2, -83.2], kind: 'view' },\n" +
    '  { name: "B\'s", lat: 35.3, lon: -83.3, elev: 2, kind: \'view\' },\n];\n';
  assert.deepEqual(parseSpots(html), [{ name: 'A', lat: 35.1, lon: -83.1, view: [35.2, -83.2] }, { name: "B's", lat: 35.3, lon: -83.3, view: null }]);
});

test('a reviewed standing spot replaces the osm point, unrounded, and carries its note', () => {
  const { kept } = pick([node(1, 'X Overlook', 35.123456, -82.987654), node(2, 'Y Overlook', 35.3, -82.5)],
    [], { n1: [35.1236789, -82.9871234, 'the open rock is 15 m north of the pull-off'] });
  const x = kept.find(o => o.id === 'n1'), y = kept.find(o => o.id === 'n2');
  assert.deepEqual([x.lat, x.lon, x.note], [35.1236789, -82.9871234, 'the open rock is 15 m north of the pull-off']);
  assert.equal(y.note, undefined);
  assert.deepEqual([y.lat, y.lon], [35.3, -82.5]);
});

test('a standing spot with no note adds no note key', () => {
  const { kept } = pick([node(1, 'X Overlook', 35.1, -82.9)], [], { n1: [35.10002, -82.90001, ''] });
  assert.equal('note' in kept[0], false);
});
