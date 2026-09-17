# Spot viewpoints: proposed `view:` coordinates

For a hike-in spot the parking and the view are two different places. The pin
and the driving directions want the parking; the skyline wants the summit. The
builder now reads an optional second coordinate:

```js
{ name: 'Huckleberry Knob', lat: 35.3350, lon: -83.9880, elev: 5560, ...
  view: [35.3220, -83.9935], ... }
```

With no `view:`, the spot coordinate is used and nothing changes. These are
proposals: nothing below has been applied.

## How each candidate was checked

Three independent sources had to agree before a candidate is proposed here:

1. **OpenStreetMap's named feature** has to carry the spot's own name, from the
   cached Overpass extract `tools/.osm-cache.json`.
2. **OSM's own `ele` tag** on that feature, where it has one.
3. **The 3DEP elevation sampled at that position**, compared against the `elev`
   already hand-entered in `SPOTS`.

The finding that motivated all of this: where a spot's coordinate sits well
below its listed `elev`, the listed figure turns out to describe the named
summit, not the coordinate. Three sources agreeing to within a few metres is
what makes that a conclusion rather than a guess.

A useful property falls out of it. The builder's elevation check compares the
DEM at the **view** coordinate against the listed `elev`, so adding a correct
`view:` makes that spot drop off the elevation report. The check validates the
fix.

## Proposed, three-way agreement

Paste-ready. Distances are from the existing spot coordinate.

```js
Max Patch                    view: [35.7970, -82.9568],   // 493 m,  dem 1411 vs listed 1411, osm ele 1407
Big Bald                     view: [35.9897, -82.4902],   // 1397 m, dem 1681 vs listed 1681, osm ele 1674
Huckleberry Knob             view: [35.3220, -83.9935],   // 1527 m, dem 1694 vs listed 1695, osm ele 1696
Bearwallow Mountain          view: [35.4610, -82.3568],   // 2204 m, dem 1288 vs listed 1290, osm ele 1281
Mount Sterling summit        view: [35.7023, -83.1221],   // 975 m,  dem 1779 vs listed 1781
Devil's Courthouse           view: [35.3028, -82.8955],   // 344 m,  dem 1749 vs listed 1743, osm ele 1744
Fryingpan Mountain tower     view: [35.3934, -82.7743],   // 2126 m, dem 1618 vs listed 1628, osm ele 1621
Craggy Pinnacle              view: [35.7034, -82.3779],   // 253 m,  dem 1774 vs listed 1796, osm ele 1780
```

Craggy Pinnacle is the weakest of the eight: the DEM at OSM's pinnacle node is
22 m below the listed 5,892 ft. The other seven agree to within 10 m. Worth a
look before accepting.

## Needs a human decision

These have a real gap between parking and viewpoint but no candidate that three
sources agree on. Local knowledge beats another query here.

| Spot | What was found | The question |
|---|---|---|
| Grandfather Mountain State Park | MacRae Peak 944 m away (dem 1774), Watauga View 1919 m (dem 1805); listed 5,946 ft is 1812 m, which is Calloway Peak | Which viewpoint does this entry mean? The listed elevation is the mountain's high point, but the spot is tagged for ridge campsites |
| Roan Highlands, Carvers Gap | Nothing matching within 6 km. Carvers Gap is the trailhead; Round Bald and Jane Bald are the destination | Which bald? |
| Elk Knob State Park | South View 1468 m (dem 1685) and North View 1486 m (dem 1688) against listed 1682 m | Both match the elevation well. Two named viewpoints on one summit, so probably either, but it should be your call |
| Panthertown Valley | Tranquility Point 757 m (dem 1222), Salt Rock Overlook 1210 m (dem 1214), listed 1189 m | A valley with several overlooks rather than one summit |
| Whiteside Mountain | Listed 4,930 ft is 1503 m; nearest elevation-matching feature is Shortoff Mountain 4.5 km away, which is a different mountain | Needs the real summit coordinate |

## Coordinates that look wrong, reported not fixed

Flagged for you, unchanged, per your instruction.

**Cherohala Skyway, Hooper Bald.** 3,389 m from OSM's Hooper Bald, and 340 m
below the listed 5,290 ft. No feature within 6 km matches that elevation: the
nearest candidates are Santeetlah Overlook (2,451 m) and Little Huckleberry
Knob (2,565 m). This reads as a genuine coordinate error rather than a
trailhead offset, since a 3.4 km walk is not the short one the tags imply.

**Lake James State Park.** Matched a *different* campground, Paddy's Creek
Drive-In, 3,528 m away. The elevation agrees, so the skyline is probably fine,
but the pin may not be where the entry means.

**Elk Knob State Park.** Listed in both sections deliberately: it sits 61 m
from OSM's picnic area, which reads as a clean match, while being 306 m below
the summit. A close OSM distance does not mean the coordinate is the viewpoint.
This is the case that shows why the elevation check is worth keeping.

## Applying any of these

```sh
# add view: to SPOTS by hand, then
python tools/build_horizons.py
```

No `--force` needed. The cache records the coordinate each profile was computed
from, so a spot that gains or changes a `view:` recomputes by itself and prints
`coordinate moved, recomputing`. Everything else stays cached. A single spot
takes about 0.1 s once the far field grid is built.
