# Horizon panorama runbook

The per-spot skyline and the sky drawn over it. Design and the reasoning behind
it live in a design spec that is kept out of the public repository.
Licensing record: [tools/STARS-LICENSE.md](../tools/STARS-LICENSE.md).

## Commands

```sh
# say what a run would do, compute nothing. takes under a second.
python tools/build_horizons.py --dry-run

# resume, then rewrite the horizons block in index.html
python tools/build_horizons.py

# one spot, by name substring. computes and caches it, and refuses to write
# index.html, because a one-spot HORIZONS block would delete the other 39.
python tools/build_horizons.py --only cowee

# discard the cache and recompute everything
python tools/build_horizons.py --force

# refetch the star catalogue and rebuild tools/stars.js. runs about never.
node tools/build-starcat.mjs

# tests
node --test tools/test-astro.mjs
python -m unittest discover -s tools -p "test_*.py"
```

Refreshing the parkway overlooks is three commands, in this order:

```sh
node tools/build-overlooks.mjs           # needs the network (Overpass); --replay re-filters tools/.overlooks-raw.json instead, no network
python tools/build_horizons.py           # no network: reads the DEM tiles and the cached far field grid. 27.1 s with the grid cached (2026-09-17), 3.4 s on a re-run with nothing moved
node tools/build-skyglow.mjs --fix       # no network once tools/.skyglow-cache/ is warm; a cold cache fetches from the atlas
```

Of the three, only the first touches the network, and not even that one with
`--replay`. Run all three, in this order, whenever OSM is refreshed or a
curated spot is added or moved near the parkway: the 300 m dedupe in
`build-overlooks.mjs` only sees the spot list as it stood when it last ran, so
a spot that moves or is added afterward can leave a duplicate overlook pin
standing beside it.

## Caches

Three, all gitignored, all resumable: an interrupted run picks up rather than
redoing finished work.

- `tools/.horizon-cache/`: one JSON file per spot or overlook, the name slug
  for a curated spot, `ov-<osm id>.json` for an overlook. Two overlooks can
  share a name, and the curated cache is keyed on the name slug, so the id
  keys the overlook side instead. Each file also records the coordinate it was
  raycast from, so a moved point recomputes itself.
- `tools/.overlooks-raw.json`: the raw Overpass response from the last real
  `build-overlooks.mjs` run. `--replay` re-filters from it with no network,
  which is how the filter and dedupe logic gets tested without asking Overpass
  again. Known gap: `--replay` with no raw file yet throws a bare `ENOENT`
  rather than a clear message.
- `tools/.skyglow-cache/`: one file per atlas tile and per legend page,
  fetched once and kept, named from the tile URL's own path, so a new year's
  `LP_TILES` template misses the cache by itself. A tile the atlas answers 404
  for is recorded as an empty `<name>.missing` sentinel and not asked for
  again; only a 404 is recorded this way, never a 500 or a network error. A
  run with everything cached makes no request of any kind. `--refetch` ignores
  all of it and asks the host again for everything.

  Two known limits of `--refetch`, from 2026-09-17: a tile that starts
  404ing keeps whatever PNG is already cached, which then wins over the new
  404; and a tile that stops 404ing leaves its `.missing` sentinel behind,
  unread but harmless.

`python` here means an interpreter with `numpy` and `rasterio` installed, as
listed in `tools/requirements.txt`. Screenshot work is a separate interpreter
again: it needs `playwright`, which the elevation work does not.

## What invalidates what

| If this changes | Re-run | Why |
|---|---|---|
| A spot's `lat, lon` or its `view:` | `build_horizons.py` | Superseded 2026-09-17: each cached profile now records the coordinate it was computed from, so a moved spot recomputes itself and prints `coordinate moved, recomputing`. No `--force` needed |
| A spot's **name** in `SPOTS` | `build_horizons.py --force --only <name>` | The cache is keyed on the name slug, so a rename orphans the old file and silently keeps nothing. The coordinate check cannot help here |
| A spot is added or removed | `build_horizons.py` | Cached spots are skipped, so this only costs the new ones |
| `ALT_MIN`, `ALT_RANGE`, or the azimuth count | `build_horizons.py --force` | The encoding changes, so every profile has to be re-encoded |
| `MAG_LIMIT` in `build-starcat.mjs` | `node tools/build-starcat.mjs` | Changes which stars ship and which figures can close |
| The DEM tiles on `S:` | `build_horizons.py --force` | The far field grid caches the old heights |
| A spot's `lat, lon` changes | `node tools/build-skyglow.mjs --fix` | The `SKY` block is derived from the coordinate, same as the horizon, and nothing was re-running it. Found stale 2026-09-17: `SKY` was last generated 2026-09-12, the spots' coordinates were moved 2026-09-17, and nobody re-ran the skyglow build. Re-running it changed 8 sentences; 7 are explained by the moved pin (Sam Knob, Fryingpan Mountain tower, Hooper Bald, Craggy Pinnacle, Doughton Park, Bearwallow Mountain, Gorges State Park). The eighth, Elk Knob State Park, has the same coordinate before and after the move; why its sentence changed is not established |
| OSM refreshed, or a curated spot added or moved near the parkway | all three, in order: `build-overlooks.mjs`, `build_horizons.py`, `build-skyglow.mjs --fix` | The 300 m dedupe in `build-overlooks.mjs` only sees the spot list as it stood when it last ran; a spot that moves or is added afterward can leave a duplicate overlook pin standing beside it |
| An overlook's OSM id changes | nothing required | Orphans the old `tools/.horizon-cache/ov-<old-id>.json`, harmlessly; the new id gets its own cache file on the next `build_horizons.py` run |

Nothing downstream of `index.html` needs regenerating. `build-og.mjs` and
`build-moon-preview.mjs` do not read any of this.

## Constants, their values and the evidence

| Constant | Value | Evidence |
|---|---|---|
| `R_EFF` | `7/6 * 6371000 m` | Standard refraction allowance. At 100 km it nets the curvature drop from 780 m to about 670 m. The 110 m difference decides which ridge is the skyline, so it is not cosmetic |
| `EYE` | 1.7 m | A person above the DEM surface. Not measured, and not worth measuring: it moves the horizon by under 0.01 degrees at any range past a kilometre |
| `MAX_RANGE` | 100 km | Past this a ridge is haze rather than a skyline |
| `NEAR` | 5 km | Inside this, full 1/3 arc-second resolution; outside, the 1 arc-second max-pooled grid |
| `COARSE_CPD` | 3600 (1 arc-second) | Max-pooled 3x3 from the source. **Max, never mean.** A skyline is an upper envelope; averaging sank a test ridge 5.8 m |
| `ALT_MIN`, `ALT_RANGE` | -10, 90 degrees | 12 bits over 90 degrees is a 0.022 degree step, against a panorama that renders at about 3 px per degree |
| `NODATA` | -999999.0 | 3DEP's own. Masked explicitly before pooling so an all-void block stays void rather than becoming a sea level plain |
| Grid box | 34-37 N, -85 to -80 | Nearly the smallest whole-degree box holding every 100 km ray. Rays from Doughton Park run about 0.3 degrees off the north edge; no n38 tile exists at these longitudes and nothing that far north is on a parkway skyline |
| `MAG_LIMIT` | 4.5 | Plus the 121 fainter stars the constellation figures need to close, admitted for that reason alone and drawn at their true magnitude |
| Thumbnail scale | -3 to +24 degrees | The expanded view's -10..+80 over 60 px is 0.67 px per degree, which reads as a dark smear. Same window for every spot, so thumbnails stay comparable |
| `NEAR_ROAD_M` (`build-overlooks.mjs`) | 400 m | A viewpoint farther than this from the parkway is treated as a trail summit, not a pull-off. Not a count from the dry run: it is baked into the Overpass query itself (`around.bp:400`), so all 164 raw results are inside it by construction |
| `NEAR_SPOT_M` (`build-overlooks.mjs`) | 300 m | Dropped 9 of 135 named, non-generic viewpoints as duplicates of a curated spot's `lat, lon` or `view:` (2026-09-17 dry run), leaving 126. The spec guessed roughly 15; 9 is the measurement. Names such as "Craggy Pinnacle Summit" and "View Devils Courthouse (MP 422.4)" are typical: many curated parkway spots are trailheads OSM does not tag as viewpoints |
| `SAME_M` (`build-overlooks.mjs`) | 150 m | Collapsed 4 node/way pairs mapping the same overlook twice (126 to 122): Bad Fork Valley (9 m apart), Big Ridge (13 m), Caney Fork (13 m), Ballhoot Scar (67 m). The first version compared names exactly and merged none; it now compares a normalised `baseName()` and keeps the spelling that carries the milepost |
| `GENERIC` (`build-overlooks.mjs`) | `{'scenic overlook'}` | Combined with dropping unnamed elements, cuts the 164 Overpass results to 135; the two filters run together in one step, so this does not isolate how many were the generic name alone |

## Stated limits

**Bare earth, no canopy.** Every horizon here is a best case. A wooded pull-off
shows less sky than the drawing does. A 1 m lidar canopy model was considered and
rejected: it covers 14 of the relevant counties, mixes 2017 and 2025 epochs,
and predates Helene's blowdown. The page says this in a footnote rather than
pretending to correct for it.

**UTC is treated as TD.** Delta-T is about 70 s, which is 0.04 arcmin of lunar
motion. The existing chapter 49 phase code makes the same choice, so this
matches it rather than running two time scales in one file.

**Longitude is east-positive.** Meeus is west-positive. `lon: -83.14` is North
Carolina, and `Sky.lmst` adds the longitude. This is the single easiest thing
in the file to get backwards.

**Coordinates on a cell boundary are ambiguous by one cell.** Waterrock Knob's
-83.1400 sits exactly on a 1/3 arc-second boundary: flooring picks the eastern
cell at 1759.9 m, rasterio's inverse transform picks the western at 1764.1 m.
The 4 m gap changes no elevation-report verdict. Written down so nobody spends
an hour on a 14 ft discrepancy.

**The elevation report is a report, not a correction.** A gap between the DEM
and the hand-typed `elev` usually means those two describe different places,
not that the DEM is wrong. The observer stays at the DEM height of the
coordinate the panorama is drawn from, which is where somebody actually stands.

Revised 2026-09-17, after the viewpoints landed. The check measures `elev`
against the **parking** where a spot carries a `view:`, because measuring it
against the summit the panorama is drawn from reports the walk itself as an
error. That change exposed a real inconsistency worth knowing before reading
the report: `elev` means the viewpoint on most entries (Max Patch 4,629 against
a view of 4,629) and the parking on a handful (Waterrock 5,820 against a lot at
5,774 and a summit at 6,287). Neither convention was imposed. The full table is
in [spot_viewpoints.md](spot_viewpoints.md).

**Name collisions are a page-killer, not a feature-killer.** A duplicate
top-level `const` is a SyntaxError that stops the whole script, calendar
included. `index.html` already owns `rad` and `norm360`; the astronomy block
owns `D2R` and `R2D`; the renderer prefixes its own globals `PAN_`. Before
inlining anything new, sweep for collisions across every top-level declaration
in the page and in whatever is being added.

**Unchecked pull-offs.** The 40 curated spots have been stood at or researched.
Nobody has checked the 122 parkway overlooks, and Cove Field Ridge showed what
an unchecked one looks like: the model starts 150 m out, so a grown-in
overlook draws far more open than it really is. Hence the caveat line in every
overlook popup, the smaller marker, and the layer being off by default.

**North Carolina only.** The elevation grid stops at 37 N. Virginia's parkway
overlooks would need more 3DEP tiles fetched and the far field grid rebuilt
to cover them; not attempted here.

## Behaviours worth keeping

Three things that look like bugs and are not. Written down so a future pass
does not "fix" them back.

**Re-render does not reframe the map.** Only a filter change or a home-point
change pans and zooms the map back to fit; nothing else does. Before this,
opening a panorama or ticking the clock reframed the map on every render,
which pulled a zoomed-in map back out from under anyone who had zoomed in on
purpose.

**`#spot-list`'s click and keydown listeners are capture-phase on purpose.**
`.spot`'s own listeners sit nearer the canvas in the DOM, so a bubble-phase
delegated listener would fire after them: a click or Enter/Space on a
skyline thumbnail would also select its card and fly the map to it. Moving
these listeners to bubble phase reintroduces that.

**`chromeW = 32` in the overlook popup sizing is measured, not derived.** It
is this page's own popup-content margin plus Leaflet's default wrapper
padding and rounding, subtracted from the map's width so the requested popup
width matches the outer box that actually has to fit inside the map, not the
inner content box Leaflet's own option clamps against. If the page's CSS
changes enough to make 32 stale, the phone-width assertion in
`tools/check-tabs.mjs` ("the popup sits inside the map on a phone") is what
fails, not a glance at the page.

## Accuracy, measured

Astronomy, against Meeus's own published worked examples, `node --test
tools/test-astro.mjs`, 11 pass:

| Quantity | Delta from the published value |
|---|---|
| Sidereal time (12.a) | 9.1e-8 degrees |
| Sun RA (25.a, same series) | 4.8e-6 degrees |
| Sun RA (25.b, VSOP87 truth) | 2.7e-3 degrees, inside Meeus's stated 0.01 |
| Moon RA (47.a) | 2.2e-3 degrees |
| Moon distance (47.a) | 46 km, 0.013 per cent, from truncating to 25 terms |
| Horizontal parallax (47.a) | 2.7e-4 degrees, which is the number that matters |
| Illuminated fraction (48.a) | 5e-5 |
| Precession (21.b) | 1.2e-6 degrees |

Rendering, `tools/panorama-integration.html` against the real modules:

| Check | Result |
|---|---|
| Horizon codec round trip | 0.01097 degrees against a 0.02198 quantisation step |
| Codec clamp ends | `AA` to -10.00, `//` to 80.00 |
| Lit limb vs the sun's direction | 3 degrees, with a 38 degree parallactic correction applied |
| Milky Way wrap seam | mean edge difference 2.4 of 255, continuous |
| Catalogue | 1,046 stars, 150 figure runs, every index valid |

The limb check is the one that matters and the reason it exists: a flipped sign
in the parallactic rotation reads as roughly 180 degrees, or as twice the
parallactic angle, and is otherwise invisible except as a moon lit from the
wrong side on a night nobody happens to be checking.

## Measured runs

| Date | What | Result |
|---|---|---|
| 2026-09-16 | Star catalogue build, warm cache | 1.1 s, byte-identical output |
| 2026-09-16 | `tools/stars.js` | 29,868 bytes, 12,854 gzipped |
| 2026-09-16 | Far field grid build, 15 tiles off `S:` | about 2 min, 777 MB, 10800 x 18000 float32. Max cell 2036.9 m, which is Mount Mitchell, so the mosaic georeferences correctly |
| 2026-09-16 | 40 spots, grid cached | 0.1 to 0.2 s each, under 10 s total |
| 2026-09-16 | Generated `HORIZONS` block | 29.5 kB for 40 spots |
| 2026-09-17 | 19 coordinate moves plus 24 viewpoints, recompute | 0.1 s per changed spot, everything else served from cache |
| 2026-09-17 | Generated block with `VIEW_ELEV` added (24 lot and view pairs, feet, off the DEM) | 30.4 kB for 40 spots, up from 29.5 |
| 2026-09-17 | `build-overlooks.mjs` filter counts | 164 returned, 135 named and not the generic name, 126 more than 300 m from a curated spot (9 dropped), 122 after collapsing duplicates (4 pairs merged). 72 of the 122 carry a milepost in the name (`grep -c '"mp":' index.html`) |
| 2026-09-17 | Overlook raycast, 122 overlooks, far field grid cached | 27.1 s wall time, 0 skipped for lack of DEM coverage, about 0.2 s per point. A second run printed `cached` for all 162 units (40 spots plus 122 overlooks) in 3.4 s and ended `unchanged` |
| 2026-09-17 | Generated `HORIZONS` block, 40 spots plus 122 overlooks | 119.7 kB, up from 30.4 kB for the 40 spots alone: about 89 kB for the overlooks, against the spec's estimate of about 100 kB |
| 2026-09-17 | Atlas tiles at zoom 6, before and after adding the overlooks | 10 both times: the overlooks ride the same tiles the 40 spots already cover, so they cost nothing extra. 122 of 122 got a reading |
| 2026-09-17 | Generated `OVERLOOK_SKY` block | 27.1 kB, against the spec's estimate of about 35 kB |
| 2026-09-17 | `index.html`, start of this branch to now | 262,462 bytes to 410,877, close to the spec's rough 265 kB starting estimate. About 148 kB added: horizons about 89 kB, skyglow about 27 kB, the overlook list itself about 12 kB, the rest code and tests' worth of CSS and JS |

## Horizon spread, measured 2026-09-17

Taken after the 19 coordinate moves, so it describes the corrected pins and not
the originals. This is the number that says whether the thumbnail window is
still the right one.

| | mean horizon |
|---|---|
| Across all 40 spots | -1.1 to 13.4 degrees |
| Flattest four | Mount Mitchell, Kuwohi, Grandfather, Black Balsam |
| Most enclosed four | Cataloochee Valley, Standing Indian, Cove Field Ridge, Black Mountain Campground |

Highest points flattest, valleys most enclosed, which is the sanity check on the
whole pipeline in one line.

The same check on the 122 overlooks, also 2026-09-17: mean horizon 0.11 to
16.97 degrees, median 4.83. Flattest three: Mount Jefferson View (0.11), Pilot
Mountain Overlook (0.13), Basin Cove Overlook (0.44). Most enclosed three:
Ballhoot Scar Overlook (16.97), Woodfin Cascades Overlook (13.35), Raven Fork
Overlook (13.17). Open viewpoints flat, gorge and road-cut names enclosed:
the same pattern the 40 spots show, holding at more than three times the
count. Elevations off the DEM range 2,102 to 6,053 ft across the 122.

**Known design limit that follows from it.** The thumbnail is scaled -3 to +24
degrees, so it spends most of its height on terrain that a summit does not
have, and the flat end of that range renders as a nearly straight line: correct,
and indistinguishable from an empty box. The strip therefore compares spots well
at the enclosed end and poorly at the open end. A test can only freeze whichever
window is chosen, so this is recorded rather than asserted. The upgrade path is
an adapting scale, or an explicit "open sky" state, rather than a straight line
the reader has to interpret. Revisit the window against the spread above.

**Second limit, same origin.** All 40 spots sit inside about 200 km, so the moon
and the galactic core land within a degree or two of the same screen position on
every one of them. Two spots side by side differ only in their ridgeline. That
is the point of the feature, and it is not obvious from a single screenshot.

## Sampling rule for eyes-on checks

Behavioural assertions pass on a canvas that paints at the right size with the
wrong content, so some looking is not optional. The trap is in how the sample is
picked.

The first eyes-on pass after the coordinate moves used the five spots whose
coordinates had moved furthest. Four of the five came back with near flat, near
identical horizons, which reads as a broken renderer. The renderer was correct:
those five had all moved onto summits, because moving furthest and ending up on
a summit are the same event here. The sample was biased by the dimension it was
sorted on.

**Pick from both ends of the range, never from the extremes of one dimension.**
For this feature that means at least one spot from the flattest group and one
from the most enclosed group above, and it means the check is not finished until
the enclosed end has been looked at, because that is where the drawing carries
information.

`node tools/check-tabs.mjs --shots` renders the where tab at desktop and phone
width and takes a path argument, so it can be pointed at a candidate copy.

## Open items

Recorded here rather than resolved.

- Elk Knob State Park's changed sky sentence (see the `lat, lon` row in "what
  invalidates what"): the coordinate is the same in both commits, so the cause
  is not established.
- Two overlooks kept despite sitting close to a curated spot without sharing
  its name: Browning Knob Overlook (MP 451.2), 309 m from the Waterrock Knob
  lot; Craggy Dome Scenic Overlook (MP 364.5), 365 m from the Craggy Pinnacle
  pin, which is the usual parking for the Pinnacle trail and may be the same
  lot.
- The `bright > 1` canvas assertion in `check-tabs.mjs` has a thin margin and
  depends on the real night sky; `colours >= 30` is the robust signal in that
  same check.
- Under `--refetch`, a tile that starts 404ing keeps its old cached PNG, which
  then wins; a tile that stops 404ing leaves its `.missing` sentinel behind,
  unread but harmless.
- `build-overlooks.mjs --replay` with no `tools/.overlooks-raw.json` yet
  throws a bare `ENOENT`.

## Left open

The per-spot JSON cache carries **range to skyline** per azimuth as well as
altitude. Only altitude is inlined. Distance-graded haze and peak labels
("that ridge is Mount Pisgah, 14 km") therefore cost an inlining step rather
than another 7 GB read.

Planets need only a truncated VSOP87 series; the alt/az plumbing already
accepts them.

A WebGL mesh view would consume the same raycast output.
