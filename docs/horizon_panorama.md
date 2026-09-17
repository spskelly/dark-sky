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
python tools/build_horizons.py           # no network: reads the DEM tiles and the cached far field grid. 27.1 s with the grid cached (2026-09-17), 2.6 s on a re-run with nothing moved
node tools/build-skyglow.mjs --fix       # no network once tools/.skyglow-cache/ is warm; a cold cache fetches from the atlas
node tools/build-skyglow.mjs --check     # then: does the page's sky block still match? exit 0 yes, exit 1 no
```

`--check` builds the block `--fix` would write and compares it with the one in
the page, line endings normalised, then names the spots and overlooks whose
entries differ. It is the staleness check for both `SKY` and `OVERLOOK_SKY`:
neither block records what it was generated from, so this is the only thing
that notices a spot that moved or an overlook list that was rebuilt underneath
them. It needs `tools/.skyglow-cache/` warm, or `--replay <samples.json>`,
since a check that asks the atlas for ten tiles is a check nobody runs; with
`--replay` it takes about 0.1 s. `--html <path>` points it at a copy of the
page instead of `index.html`. `--check` and `--fix` together is an error.

`node tools/check-tabs.mjs` also asserts, in the page itself, that the six
generated blocks still name the same places: every `OVERLOOKS` id has an
`OVERLOOK_HORIZONS` and an `OVERLOOK_SKY` entry, neither map holds a key the
overlook list does not, the `SKY` keys are exactly the `SPOTS` names, and every
spot has a `HORIZONS` entry. Regenerating one block and forgetting the others
shows up there and nowhere else.

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
  again. With no raw file yet, `--replay` names the file it wanted and the
  command that records one.
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
| The DEM tiles in the tile directory (`TILES` in `build_horizons.py`) | `build_horizons.py --force` | The far field grid caches the old heights |
| A spot's `lat, lon` changes | `node tools/build-skyglow.mjs --fix` | The `SKY` block is derived from the coordinate, same as the horizon, and nothing was re-running it. Found stale 2026-09-17: `SKY` was last generated 2026-09-12, the spots' coordinates were moved 2026-09-17, and nobody re-ran the skyglow build. Re-running it changed 8 sentences; 7 are explained by the moved pin (Sam Knob, Fryingpan Mountain tower, Hooper Bald, Craggy Pinnacle, Doughton Park, Bearwallow Mountain, Gorges State Park). The eighth, Elk Knob State Park, has the same coordinate before and after the move; why its sentence changed is not established |
| OSM refreshed, or a curated spot added or moved near the parkway | all three, in order: `build-overlooks.mjs`, `build_horizons.py`, `build-skyglow.mjs --fix` | The 300 m dedupe in `build-overlooks.mjs` only sees the spot list as it stood when it last ran; a spot that moves or is added afterward can leave a duplicate overlook pin standing beside it |
| `SKY` or `OVERLOOK_SKY` might be stale | `node tools/build-skyglow.mjs --check` | Neither block records what it was generated from, so nothing else notices. Exit 1 names the entries that differ. Run it after any spot move and after every overlook rebuild |
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
| Thumbnail scale | -3 to +24 degrees | 27 degrees over a 60 px strip is 0.44 px per degree, which reads as a dark smear. Fixed and shared across every spot regardless of the open view's own window, so thumbnails stay comparable. Superseded 2026-09-17: this row used to compare against the open view's old full-turn scale, -10..+80 over 60 px, 0.67 px per degree; the open view is now a window that turns (`PAN_FOV`, below) with its own scale, so that comparison no longer says anything about the thumbnail and is dropped |
| `PAN_FOV` | 120 degrees | Added 2026-09-17 with the look-around window. The altitude window below it is 45 degrees (-5..+40); 120 keeps a degree of azimuth close to a degree of altitude across a card's own width, so turning the view reads as turning rather than a slow pan or a blur. Not tuned against a reader; a round number close to the altitude span, chosen once and left alone |
| Open view altitude window | -5 to +40 degrees | Added 2026-09-17, replacing -10..+80. Roughly equal pixel scale to the 120 degree azimuth window, so the view is not badly stretched on one axis. `PAN_TOP`/`PAN_BOT` in `sky-panorama.js` |
| Open view default heading | south, 180 degrees | Added 2026-09-17. Not measured: the old full-turn open view mapped azimuth linearly from 0 at the left edge, which put south at dead centre of the canvas (`panX(180, w) === w / 2`); defaulting the new windowed view's centre to the same 180 means a visitor who already knew the old drawing sees the same centre on their first look at the new one |
| `NEAR_ROAD_M` (`build-overlooks.mjs`) | 400 m | A viewpoint farther than this from the parkway is treated as a trail summit, not a pull-off. Not a count from the dry run: it is baked into the Overpass query itself (`around.bp:400`), so all 164 raw results are inside it by construction |
| `NC_NORTH` (`build-overlooks.mjs`) | 36.56 N | Added 2026-09-17, after Pilot Mountain Overlook (36.6419 N, about 28 road miles into Virginia) shipped in the list and was cited here as the second flattest overlook. The grid box above stops at 37 N, so a Virginia overlook's northward rays run off it and its horizon is not a measurement. The parkway crosses the state line at about 36.55 N and runs north-east from there, so nothing on this road in North Carolina lies north of 36.56. The filter is a latitude test rather than a narrower Overpass box because `--replay` re-filters a response that was fetched with the wider box. Dropped 1 of 135 named, non-generic viewpoints |
| `NEAR_SPOT_M` (`build-overlooks.mjs`) | 300 m | Dropped 9 of the 134 named, non-generic viewpoints inside North Carolina as duplicates of a curated spot's `lat, lon` or `view:` (2026-09-17 dry run), leaving 125. The spec guessed roughly 15; 9 is the measurement. Names such as "Craggy Pinnacle Summit" and "View Devils Courthouse (MP 422.4)" are typical: many curated parkway spots are trailheads OSM does not tag as viewpoints |
| `SAME_M` (`build-overlooks.mjs`) | 150 m | Collapsed 6 pairs mapping the same pull-off twice (125 to 119): Bad Fork Valley (9 m apart), Big Ridge (13 m), Caney Fork (13 m), Ballhoot Scar (67 m), Hominy Valley (14 m), Beaver Dam (22 m). Retuned 2026-09-17: the first version compared names exactly and merged none, the second compared a normalised name and merged 4, and this one does not compare names at all. The last two pairs are why: OSM carries them as "View Hominy Valley" against "Hominy Valley (MP 404.2)", and "Beaver Dam Overlook Parking" against "Beaver Dam Gap Overlook (MP 401.7)". Inside 150 m the raycast already starts further out than the gap and the elevation cell is 10 m, so both entries draw the same horizon under two names. The spelling that carries the milepost is still the one kept |
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

**Every clock shown is Eastern; every clock chosen is the reader's own.**
Added 2026-09-17. `panTime` and `fmtClock` display in `America/New_York`
regardless of the reader's device, since every spot is in North Carolina and
an unlabelled local time on a page about somewhere else is simply wrong.
Deliberately left alone: `hhmm`, `sinceFive`, `nearestSlice`, `panoNight` and
`nightWindow` still read the reader's own device clock and calendar day to
decide *which* instant to look at (tonight's dark hours, the default 9pm
slice, dusk and dawn for the summary sentence). They never display a time
themselves, and every comparison inside them is against a `Date` one of them
produced, so the convention only has to be consistent with itself, not with
Eastern. A reader far from Eastern gets a window of choices shifted from true
Eastern dusk-to-dawn -- re-anchoring `panoNight`'s start to an Eastern civil
day would need DST-aware date arithmetic this page has never had to do, for a
difference nothing here tests or, realistically, many readers of a
western-North-Carolina site will ever see. Recorded rather than fixed.

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
Nobody has checked the 119 parkway overlooks, and Cove Field Ridge showed what
an unchecked one looks like: the model starts 150 m out, so a grown-in
overlook draws far more open than it really is. Hence the caveat line in every
overlook popup, the smaller marker, and the layer being off by default.

**North Carolina only.** The elevation grid stops at 37 N. Virginia's parkway
overlooks would need more 3DEP tiles fetched and the far field grid rebuilt
to cover them; not attempted here. The Overpass box runs to 36.7 N and so
crosses the state line, which let one Virginia overlook through until
`NC_NORTH` was added on 2026-09-17; the filter is in `pick`, not in the query.

## Behaviours worth keeping

Four things that look like bugs and are not. Written down so a future pass
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

**The turned heading is one value for the whole page, not one per spot.**
`darksky.panoAz` is read once into `panoState.az0` and written by
`bindPanoRotate` regardless of which card or overlook the reader dragged.
Turning to face a landmark on one spot's panorama and opening another
spot's panorama next keeps facing the same way, on purpose: it is "which way
am I used to looking," the same kind of preference as the basemap or the
overlook layer, not a fact about a particular place the way the scrubber's
remembered clock time is.

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
| Milky Way wrap seam | mean centre-column difference 2.6 of 255, continuous. Moved 2026-09-17 from the two edge columns to the centre column: the open view is now a 120 degree window rather than a full turn, so its own left and right edges are 120 degrees apart and mean nothing wrapping to compare, while a window centred due north puts the actual wrap seam, azimuth 0, at the middle of the canvas instead |
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
| 2026-09-16 | Far field grid build, 15 DEM tiles | about 2 min, 777 MB, 10800 x 18000 float32. Max cell 2036.9 m, which is Mount Mitchell, so the mosaic georeferences correctly |
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
| 2026-09-17 | The list corrected after review, and everything regenerated from it | The six rows above are the first run of the list. A review found two more pull-offs mapped twice under names that do not match, and one overlook 28 road miles inside Virginia where the elevation grid does not reach. `SAME_M` now collapses on distance alone and `NC_NORTH` drops anything north of 36.56 N, so 122 became 119: Pilot Mountain Overlook dropped for latitude, "View Hominy Valley" and "Beaver Dam Overlook Parking" merged into the entries that carry their mileposts. Regenerated with no network, from the saved Overpass response, the warm horizon cache and saved atlas samples |
| 2026-09-17 | `build-overlooks.mjs` filter counts, corrected list | 164 returned, 135 named and not the generic name, 134 south of 36.56 N (1 dropped), 125 more than 300 m from a curated spot (9 dropped), 119 after collapsing duplicates (6 pairs merged). 72 of the 119 carry a milepost in the name. Generated block 11.4 kB, as the run prints it |
| 2026-09-17 | Overlook raycast, corrected list | Nothing to compute: all 119 were already cached from the first run, so `build_horizons.py` printed `cached` for all 159 units (40 spots plus 119 overlooks) in 2.6 s and rewrote the block without the three dropped ids. The three orphaned `ov-*.json` cache files are left in place, harmlessly |
| 2026-09-17 | Generated blocks, corrected list | `HORIZONS` plus `OVERLOOK_HORIZONS` 117.5 kB as `build_horizons.py` prints it, down from 119.7. `OVERLOOK_SKY` 26.5 kB, down from 27.1, measured from `const OVERLOOK_SKY = {` to its closing brace. 159 of 159 points got an atlas reading, still on the same 10 tiles at zoom 6 |
| 2026-09-17 | `index.html`, corrected list | 409,288 bytes, down 1,589 from 410,877 |
| 2026-09-17 | `build-skyglow.mjs --check`, both ways | Exit 0 against the regenerated page, about 0.1 s with `--replay`. Exit 1 against a copy of the page with one spot renamed (reported as "in the page, but this run does not produce it") and against a copy with one generated sentence reworded (reported as "differs"). Under `--replay` the saved samples are keyed by spot name, so a copy with only a coordinate nudged still exits 0; catching a moved coordinate is what the warm tile cache is for |
| 2026-09-17 | `build-skyglow.mjs --check`, live against the warm tile cache | Exit 0 against the real page. Exit 1 against a copy with Waterrock Knob moved 0.1 degree north, reported as "Waterrock Knob: differs". Both runs printed `10 tile(s) from the cache, 0 asked of the host` and `2 legend page(s) from the cache, 0 asked of the host`, so the check that catches a moved coordinate costs the atlas host nothing |
| 2026-09-17 | Look-around window (`PAN_FOV`, drag and arrow-key turning): `node --test tools/test-panorama.mjs`, the pure azimuth mapping and its wrap cases | 7 pass, including the antipodal-point and turn-copy cases |
| 2026-09-17 | Same change, `node --test tools/test-inline-parity.mjs` | 1 pass: the copy of `sky-panorama.js` pasted into `index.html` still matches the source file byte for byte, CRLF normalised |
| 2026-09-17 | Same change, `node tools/check-tabs.mjs` | All checks pass, including the new ones: default heading south, dragging redraws and stores the heading, a reload restores it, garbage falls back, the drag does not select the card, a closed thumbnail elsewhere is unaffected, both arrow keys turn the view, and a Tokyo-timezone browser still shows Eastern time in the scrubber label and the summary sentence |

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

The same check on the 119 overlooks, recomputed 2026-09-17 after the list was
corrected: mean horizon 0.11 to 16.97 degrees, median 4.83. Flattest three:
Mount Jefferson View (0.11), Basin Cove Overlook (0.44), Haywood Jackson
Overlook (0.71). Most enclosed three: Ballhoot Scar Overlook (MP 467.4)
(16.97), Woodfin Cascades Overlook (MP 446.7) (13.35), Raven Fork Overlook
(MP 467.9) (13.17). Open viewpoints flat, gorge and road-cut names enclosed:
the same pattern the 40 spots show, holding at three times the count.
Elevations off the DEM range 2,102 to 6,053 ft across the 119.

The earlier figure named Pilot Mountain Overlook (0.13) as the second flattest.
It was the Virginia overlook, so it is gone and Haywood Jackson Overlook takes
the third place. Nothing else in the spread moved: the range, the median and
the elevation range are unchanged, which is what dropping three points out of
122 should do.

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

## Terrain tiles for picked points

`tools/build_terrain_tiles.py` cuts the same DEM into static files a browser can
fetch, so a skyline can be raycast in the page for any point picked on the map.
It imports `read_lattice`, `pool_max`, `save_atomic` and the grid bounds from
`build_horizons.py`; nothing about mosaicking or pooling is repeated. The output
goes to an output directory outside this repository (a checkout of the separate
public repository the tiles are served from), never into this one.

### Commands

```sh
# say what a run would do: tile counts, bytes. reads and writes nothing.
python tools/build_terrain_tiles.py --out <output directory> --dry-run

# the real run. one worker, sequential reads off the tile directory.
python tools/build_terrain_tiles.py --out <output directory>

# resume after a stop: the same command. tiles already there print "cached".
python tools/build_terrain_tiles.py --out <output directory>

# rebuild every file
python tools/build_terrain_tiles.py --out <output directory> --force

# a different area, quarter degrees, south west north east
python tools/build_terrain_tiles.py --out <output directory> --bbox 35.25 -83.25 35.50 -83.00
```

`--coarse <path to coarse_1as.npy>` pools `far.i16` from the 1 arc-second grid
`build_horizons.py` already caches instead of reading all 15 source tiles again.
When that cache is in `tools/.horizon-cache/` it is found without the flag.
`--near-from-coarse` cuts the near tiles from the same grid, so the DEM drive is
not read at all; the grid is exactly `read_lattice` at 1 arc-second, and on
2026-09-17 the one tile built both ways was byte-identical. It is only as fresh
as that cache.

Success looks like one line per tile (`tile 17/120 near/n35.25_w083.50.i16
written 1.6 MB 0.0s`, or `cached`), one `read` line per whole degree square,
`far.i16 written`, and a closing line with the totals. `manifest.json` is
written last, so its presence means the run finished. A stopped run leaves at
most one `.tmp` file, which the next run overwrites.

### What is written

| File | What |
|---|---|
| `near/n35.25_w083.50.i16` | 1 arc-second (3600 cells per degree), max-pooled 3x3 from the source, one file per 0.25 degree square, 900 x 900 cells, 1,620,000 bytes |
| `far.i16` | 6 arc-second (600 cells per degree), max-pooled 6x6 from the 1 arc-second lattice, the whole 34 to 37 N, 85 to 80 W grid of `build_horizons.py`, 1800 x 3000 cells, 10,800,000 bytes. Wider than the near tiles on purpose: a ray runs 100 km past the pick |
| `manifest.json` | bounds of both levels, cells per degree, tile size, naming, encoding, nodata, the near tiles present, build date, source, and the raycast constants |

Encoding, everywhere: little-endian int16 metres, rounded to the nearest metre
after pooling, row 0 at the north edge, columns west to east, no header, nodata
-32768. In the browser that is `new Int16Array(buffer)`.

Naming: `n` or `s`, the absolute latitude as `DD.DD`, an underscore, `w` or
`e`, the absolute longitude as `DDD.DD`, all of the tile's south west corner.
Fixed width, so a listing sorts. From a point, by the same floor on the global
1 arc-second lattice that `Lattice.sample` uses, so a point exactly on a tile
edge lands in the tile that really holds its cell (rows count down from the
north, so a point on a parallel belongs to the tile south of it):

```js
const R = Math.floor((90 - lat) * 3600), C = Math.floor((lon + 180) * 3600);
const south = 90 - (Math.floor(R / 900) + 1) / 4, west = Math.floor(C / 900) / 4 - 180;
const part = (v, w) => Math.abs(v).toFixed(2).padStart(w, '0');
const name = (south < 0 ? 's' : 'n') + part(south, 5) + '_' + (west < 0 ? 'w' : 'e') + part(west, 6);
const metres = tile[(R % 900) * 900 + (C % 900)];
```

The far grid is one array: `far[(Rf - 53 * 600) * 3000 + (Cf - 95 * 600)]` with
`Rf = Math.floor((90 - lat) * 600)`, `Cf = Math.floor((lon + 180) * 600)`, 53
and 95 being 90 - 37 and 180 - 85 from the far bounds in the manifest.

A tile that is entirely nodata is not written and not listed in the manifest.
A pick whose tile is not listed gets the flat horizon the viewer already falls
back to.

### Constants

| Constant | Value | Evidence |
|---|---|---|
| `NEAR_CPD` | 3600 (1 arc-second) | the accuracy table below: 3 arc-second everywhere is four times worse |
| `FAR_CPD` | 600 (6 arc-second) | same table: 6 arc-second beyond 10 km costs 0.02 degree of mean error |
| `NEAR_M` | 10000 m | the range at which that table switches grids. Not the 5000 m `NEAR` of `build_horizons.py`, which switches between 1/3 and 1 arc-second |
| `R_EFF`, `EYE`, `MIN_RANGE`, `MAX_RANGE` | copied from `build_horizons.py` into the manifest at build time | the browser raycast has to mirror them; see the constants section above |
| default `--bbox` | 34.75 -84.50 36.75 -80.75 | the mountain region the map shows. 8 x 15 = 120 tiles |

### Accuracy that set the two resolutions

Measured 2026-09-17, offline, 40 curated spots x 360 azimuths, absolute
difference in degrees from the shipped skyline (1/3 arc-second inside 5 km):

| grids the raycast is given | mean | p95 | worst spot mean |
|---|---:|---:|---|
| 1 arc-second everywhere | 0.21 | 0.68 | Wolf Mountain 1.09 |
| 1 arc-second inside 10 km, 3 beyond | 0.22 | 0.69 | same |
| 1 arc-second inside 10 km, 6 beyond | 0.23 | 0.71 | same |
| 3 arc-second everywhere | 0.81 | 2.35 | Cove Field 3.86 |

So the near field needs 1 arc-second and the far field can be 6.

### Measured, and extrapolated

Measured 2026-09-17, one near tile (`--bbox 35.25 -83.25 35.50 -83.00`) from the
source tiles, `far.i16` from the cached grid:

| What | Result |
|---|---|
| Reading the tile's window from its source GeoTIFF | 0.3 s |
| Encoding and writing the tile | under 0.05 s, 1,620,000 bytes |
| `far.i16` pooled from the cached grid | 1.3 s, 10,800,000 bytes |
| Whole command | 2.3 s |
| The tile under `gzip -9` | 959,481 bytes, 59 per cent of raw |
| `far.i16` under gzip level 9 | 6,476,253 bytes |
| Second run of the same command | `cached` for the tile and for `far.i16`, under 1 s, no source read |
| Same tile cut with `--near-from-coarse` | byte-identical, and `far.i16` too |
| Tile against `read_lattice` at 1 arc-second, whole tile | identical after rounding, 810,000 of 810,000 cells |
| `far.i16` read in node with the indexing above | 2037 m at Mount Mitchell (35.7650, -82.2652), and at the three spots below 1917, 1481 and 1474 m, each at or above its near value, as a 6x6 maximum must be |
| Three curated spots inside it | Waterrock Knob 1917 m against 1916.94, Thunder Struck Ridge Overlook 1458 against 1457.76, Cove Field Ridge Overlook 1409 against 1409.34 |

The heights are the maximum of the nine source cells under each 1 arc-second
cell, so a tile reads at or above the bare-earth height at a point, by design.

EXTRAPOLATED from that one tile, not measured. The full default run has not
been made:

| What | Estimate | From |
|---|---|---|
| Runtime, 120 near tiles from source | 1 to 2 minutes | 120 x 0.3 s is 36 s; the far field grid build of 2026-09-16 read 15 whole source tiles in about 2 minutes, and this reads the equivalent of 7.5 |
| Runtime of `far.i16` with no cached grid | about 2 more minutes | it reads all 15 source tiles, the same work as that grid build |
| Output, raw | 205.2 MB: 120 x 1.62 MB plus 10.8 MB | exact if no tile is all nodata, which is expected for this area |
| Output as served, gzipped | about 120 MB in total, about 1 MB per near tile | one mountain tile at 59 per cent; flatter piedmont tiles should compress better |
| Peak memory | about 300 MB, calculated, not measured | one degree square at 1 arc-second is 52 MB of float32; `read_lattice` fills it from source blocks of 1800 x 10800 float32, 78 MB, held twice for a moment. A whole degree square at full resolution (467 MB) is never in memory |

The run is well under the 10 minute line, and it checkpoints per tile anyway.
Replace these rows with measured ones after the first real run.

### What invalidates the tiles

| If this changes | Re-run | Why |
|---|---|---|
| The DEM tiles in the tile directory (`TILES` in `build_horizons.py`) | `build_horizons.py --force` first if the cached grid is used, then `build_terrain_tiles.py --force` | every file holds the old heights, and so does the cached 1 arc-second grid |
| `--bbox` grows | the same command with the new `--bbox` | only the new tiles are built. The manifest is rewritten to list what is inside the new bbox |
| `--bbox` shrinks | the same command, then delete the near files no longer listed | the manifest stops listing them, the files stay on disk until removed |
| Pooling (`NEAR_CPD`, `FAR_CPD`, max to anything else) or the encoding (dtype, byte order, row order, nodata, tile size, naming) | `--force`, and the browser decoder with it | every file changes shape or meaning |
| `R_EFF`, `EYE`, `MIN_RANGE`, `MAX_RANGE` in `build_horizons.py`, or `NEAR_M` | the same command | only `manifest.json` changes. It is rewritten on every run |
| The grid bounds in `build_horizons.py` | `--force` | `far.i16` changes size |

Limit: nothing marks an all-nodata tile as done, so a resumed run reads that
tile's window again. None is expected in the default bbox.

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
- Keyboard handling of an overlook popup, verified 2026-09-17 and left as it
  is. The markers are focusable and Enter opens the popup. Escape does not
  close it while focus is still on the marker, because Leaflet hooks the
  Escape key on the map container rather than on the marker, and the container
  is not what is focused. The popup's own close control is reachable by Tab,
  so the popup can always be dismissed. Moving focus into the popup when it
  opens, and returning it to the marker when it closes, is the fix; it was not
  attempted here because it needs its own pass over focus order and its own
  assertions.

## Left open

The per-spot JSON cache carries **range to skyline** per azimuth as well as
altitude. Only altitude is inlined. Distance-graded haze and peak labels
("that ridge is Mount Pisgah, 14 km") therefore cost an inlining step rather
than another 7 GB read.

Planets need only a truncated VSOP87 series; the alt/az plumbing already
accepts them.

A WebGL mesh view would consume the same raycast output.
