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

# trees and structures from the 2017 lidar, 200 m around each site. resumes;
# about 15 GB and about 65 to 80 minutes from cold at 32 workers, seconds
# when everything is cached.
python tools/build_canopy.py --dry-run
python tools/build_canopy.py
python tools/build_canopy.py --only doubletop   # one site, index.html left alone

# refetch the star catalogue and rebuild tools/stars.js. runs about never.
node tools/build-starcat.mjs

# tests
node --test tools/test-astro.mjs
node --test tools/test-panorama.mjs tools/test-inline-parity.mjs
python -m unittest discover -s tools -p "test_*.py"
CANOPY_LIVE=1 python -m unittest discover -s tools -p "test_canopy.py" -k Live   # network, two sites, about 130 MB
```

`build_canopy.py` keeps going past a site whose download fails: it is logged,
no cache file is written for it, and the same command retries it on the next
run. It does not rewrite `index.html` unless every requested site succeeded,
so a partial run never drops an entry. Each progress line carries the run's
own real network total and throughput (`net ... MB at ... MB/s`), which is
the run's own wire traffic, not the site's box size, since neighbouring
sites reuse each other's octree nodes.

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

Four, all gitignored, all resumable: an interrupted run picks up rather than
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

- `tools/.canopy-cache/`: one JSON per spot or overlook, named like the
  horizon cache. Each records the coordinate, radius, deck height and the
  dataset list it was computed from, plus the datasets that had points, the
  node and byte counts, the per-class point counts, the eye height and the
  raw profiles, so a change to any input recomputes that site and a 2025
  re-run is `--force`. About 8 kB a site.
- `tools/.canopy-cache/suggest/`: one review row per closed-in site, reused
  while its coordinate and the nine standing-spot tunables (`CLOSED_DEG`,
  `SEARCH_R`, `LEVEL_M`, `CAND_STEP`, `SKY_R`, `OPEN_DEG`, `CLEAR_H`,
  `CONFIRM_DEG`, `CONFIRM_MAX`) still match. `--suggest-views
  --force`, or deleting the directory, recomputes every row. The table itself
  is `tools/.canopy-cache/view-review.md`. See Standing spots below.

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
| A spot's `lat, lon` or its `view:` | `build_canopy.py` as well as `build_horizons.py` | The canopy cache records the coordinate; a moved site recomputes |
| A spot's `deck:` | `build_horizons.py`, then `build_canopy.py` | Both cache the deck height. `build_horizons.py` recomputes that spot (about 2 s); `build_canopy.py` refetches its box (about 25 s from the network at 32 workers, (pending: measure with `--only doubletop --force` after the store fill run)). Run the terrain first: the block's structures rule compares against the deck terrain line |
| `RADIUS`, `MAX_DEPTH`, `TREE_MAX_M`, the class routing or `COUNTIES` in `build_canopy.py` | `build_canopy.py` | `RADIUS` and `COUNTIES` are recorded per site and recompute by themselves; a routing or depth change, `TREE_MAX_M` included, needs `--force`, since the cache does not record which routing rule computed it. `TREE_MAX_M` shipped 2026-09-18 after the live check found the Pisgah tower routed to vegetation, not partly unclassified as first assumed; that day's full run was `--force` for this reason |
| The 2025 point clouds arrive | change `VINTAGE` and the dataset source in `build_canopy.py`, then `--force` | The vintage is one page constant, so every site is rebuilt together |
| `tools/overlook-views.json` changes | `node tools/build-overlooks.mjs --replay`, then `build_horizons.py`, `build-skyglow.mjs --fix`, `build_canopy.py` | A reviewed spot replaces the OSM point for that overlook, so the coordinate every downstream block raycasts from changes; the three builds are the same chain a moved curated spot needs, run in the same order |
| A spot's `view:` moves | `build_horizons.py`, `build_canopy.py` | `view:` is the coordinate the panorama and canopy are actually drawn from when it is set, invalidating both the same way moving `lat, lon` does. `build-skyglow.mjs` is not listed here: it reads a spot's `lat, lon` only (`SPOT_RE`, line 61), never `view:`. The `tools/overlook-views.json` row above keeps `build-skyglow.mjs --fix`, since overlooks are read by their lat/lon, which the override moves |

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
| Thumbnail scale | -3 to +24 degrees | 27 degrees over a 60 px strip is 0.44 px per degree, which reads as a dark smear otherwise. Fixed and shared across every spot, so thumbnails stay comparable; it no longer has an "open" state to be compared against, since the turnable sky moved into the sky viewer (below, the "what will i see?" tab), which is centred on wherever the reader is looking rather than windowed onto a fixed strip |
| Sky viewer default field of view | 100 degrees, range 40 to 140 | Added 2026-09-17 with the dialog, replacing `PAN_FOV` (120 degrees, a fixed cylindrical window). Stereographic rather than cylindrical, so the field of view is a true angular measure, calibrated in `panViewScale` against a pure-altitude offset rather than an azimuth one so it means the same thing at any altitude, including near the zenith. Not tuned against a reader; a round number in the middle of the range, chosen once and left alone |
| Sky viewer altitude clamp | floor to +90 degrees, floor = min(35, vertical half-angle - 10), where the half-angle is 2 atan((h/w) tan(fov/4)) | Added 2026-09-17, retuned the same day at Shawn's request: the field of view is set across the width, so a 1100x620 canvas looking 7 degrees up showed 21 degrees of ground, which read as "how far below the 0 line we are". The floor keeps the canvas bottom within about 10 degrees under level (19 degrees up on that desktop canvas, fov 100), and the 35 cap keeps a portrait phone, whose half-angle passes 60, from being forced upward; there the default 25 is raised to 35. `skyAltFloor()` in index.html; a remembered altitude below the floor is raised on paint and saved |
| Sky viewer cull | 100 degrees from the view centre | Added 2026-09-17. `panProject` returns `null` past this, which is what lets every draw routine skip a segment instead of drawing it stretched across the canvas; comfortably inside the true singularity at 180 degrees (directly behind the viewer), where the projection's `1 + cos(angle)` denominator reaches zero |
| Sky viewer default view | south, 25 degrees up (az 180, alt 25) | Added 2026-09-17, replacing the open view's old default heading, south at dead centre with no altitude of its own. Azimuth kept at 180 for the same reason it was chosen the first time: a visitor who already knew the old drawing sees the same heading on their first look at the new one. 25 degrees up is new, chosen for a first look with the ridge low in the frame and most of the canvas given to sky |
| `NEAR_ROAD_M` (`build-overlooks.mjs`) | 400 m | A viewpoint farther than this from the parkway is treated as a trail summit, not a pull-off. Not a count from the dry run: it is baked into the Overpass query itself (`around.bp:400`), so all 164 raw results are inside it by construction |
| `NC_NORTH` (`build-overlooks.mjs`) | 36.56 N | Added 2026-09-17, after Pilot Mountain Overlook (36.6419 N, about 28 road miles into Virginia) shipped in the list and was cited here as the second flattest overlook. The grid box above stops at 37 N, so a Virginia overlook's northward rays run off it and its horizon is not a measurement. The parkway crosses the state line at about 36.55 N and runs north-east from there, so nothing on this road in North Carolina lies north of 36.56. The filter is a latitude test rather than a narrower Overpass box because `--replay` re-filters a response that was fetched with the wider box. Dropped 1 of 135 named, non-generic viewpoints |
| `NEAR_SPOT_M` (`build-overlooks.mjs`) | 300 m | Dropped 9 of the 134 named, non-generic viewpoints inside North Carolina as duplicates of a curated spot's `lat, lon` or `view:` (2026-09-17 dry run), leaving 125. The spec guessed roughly 15; 9 is the measurement. Names such as "Craggy Pinnacle Summit" and "View Devils Courthouse (MP 422.4)" are typical: many curated parkway spots are trailheads OSM does not tag as viewpoints |
| `SAME_M` (`build-overlooks.mjs`) | 150 m | Collapsed 6 pairs mapping the same pull-off twice (125 to 119): Bad Fork Valley (9 m apart), Big Ridge (13 m), Caney Fork (13 m), Ballhoot Scar (67 m), Hominy Valley (14 m), Beaver Dam (22 m). Retuned 2026-09-17: the first version compared names exactly and merged none, the second compared a normalised name and merged 4, and this one does not compare names at all. The last two pairs are why: OSM carries them as "View Hominy Valley" against "Hominy Valley (MP 404.2)", and "Beaver Dam Overlook Parking" against "Beaver Dam Gap Overlook (MP 401.7)". Inside 150 m the raycast already starts further out than the gap and the elevation cell is 10 m, so both entries draw the same horizon under two names. The spelling that carries the milepost is still the one kept |
| `GENERIC` (`build-overlooks.mjs`) | `{'scenic overlook'}` | Combined with dropping unnamed elements, cuts the 164 Overpass results to 135; the two filters run together in one step, so this does not isolate how many were the generic name alone |

## Stated limits

**Bare earth ridge, 2017 canopy.** Superseded 2026-09-17: the ridge is still
raycast from 3DEP bare earth from 150 m out, but trees and structures within
200 m now come from the 2017 NC Phase 5 lidar as their own layers (see
Canopy below). What remains true: the canopy is leaf-off and nine growing
seasons old, so every tree line is a floor; the 9 sites without 2017 lidar
(the 8 Doughton Park area sites and The Lump, MP 264, Wilkes) have none and
say "trees not modelled"; the cut bank inside 150 m is
still in neither line.

**Cliff-lip terrain eye, follow-up 2026-09-18.** At cliff-lip sites the
terrain line is raycast from the 3DEP cell, up to 7 m below the lidar ground
at the pin, so near ridges read up to about 2.7 degrees high at 150 m. Using
the lidar ground as the terrain eye where it exists would fix it; not done.

**UTC is treated as TD.** Delta-T is about 70 s, which is 0.04 arcmin of lunar
motion. The existing chapter 49 phase code makes the same choice, so this
matches it rather than running two time scales in one file.

**Retired 2026-09-17: "every clock shown is Eastern; every clock chosen is
the reader's own."** That limit recorded that `panoNight` and `nightWindow`
anchored on the reader's own device clock and calendar day, not North
Carolina's, so a reader far from Eastern got a window of choices shifted
from true Eastern dusk-to-dawn. Fixed, not just documented around: `panoNight`
and `nightWindow` now anchor on the Eastern civil date, found through
`easternParts` (an instant's Eastern year/month/day/hour/minute, read via
`Intl.DateTimeFormat` with an explicit `timeZone`) and `easternInstant` (the
UTC instant for a given Eastern clock time, found by trying Eastern's two
possible whole-hour UTC offsets and checking which one round-trips, rather
than assuming which one applies -- the assumption that used to break on the
two days a year the offset changes). `hhmm`, the remembered per-spot scrubber
time, reads and writes the same Eastern clock now, so it still means the
right slice regardless of the reader's device. Tested in `node --test
tools/test-panorama.mjs` across both 2026 DST changes and, via a child
process (`tools/eastern-tz-child.mjs`), from a `TZ=Asia/Tokyo` process.
`panTime` and `fmtClock`'s own Eastern display predates this and is
unchanged.

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

## Canopy

Trees and structures around each site, from the public USGS EPT mirror of
the state's 2017 lidar (`NC_Phase5_<County>_2017`, EPSG:3857), raycast
straight from the classified points by `tools/build_canopy.py` into two
profiles per site in the same encoding as the ridge. Design record:
`docs/canopy_horizon_spike.md` has the measurements that argued for it.

### Constants, their values and the evidence

| Constant | Value | Evidence |
|---|---|---|
| `RADIUS` | 200 m | Canopy past 150 m added 0.7 degrees at Cove Field, 0.1 at Doubletop, none at the two Buncombe sites (spike, 2026-09-17). Recorded per cache file |
| `MIN_R` | 2 m | Closer than this is the observer and the car. A return at 1 m subtends whatever the pin happens to sit under |
| `DECK_MIN_R` | 6 m | From the deck, the tower's own cab and roof read as a wall without it. Placeholder: the Fryingpan cab is about 4 m across; retune against the lidar tower footprint |
| `MAX_DEPTH` | 10 | About 24 points per square metre on Haywood; the depth every spike used. Deeper costs bytes and adds nothing a degree-wide profile can see |
| Trees | classes 3, 4, 5 | The acquisition's low, medium and high vegetation. Doubletop: 4, 8 and 69 per cent of returns |
| Structures | class 6, plus class 1 at `TALL_M` 2 m or more above the `GROUND_CELL` 5 m ground mean with `CLUSTER_MIN` 3 returns in a `CLUSTER_CELL` 2 m cell | Company in a cell is what separates a tower from a bird. Placeholder, not tuned beyond the two sites, and the assumption behind it turned out wrong: the 2017 classifier did not leave the Pisgah tower partly unclassified, it put the whole thing in the vegetation classes, so this route has not yet caught a real tower. See `TREE_MAX_M` below for what did |
| `TREE_MAX_M` | 50 m | Vegetation returns (classes 3, 4, 5) this far or more above their `GROUND_CELL` ground mean route to structures too, no cluster required, since a 50 m return is never a bird. The 2017 Buncombe classifier put the Mount Pisgah broadcast tower entirely in the vegetation classes: it read 78.2 degrees in the trees layer with structures empty (live check, 2026-09-17). Shawn chose 50 m 2026-09-18; after it, Pisgah reads structures 74 to 78 degrees over trees about 69 on azimuths 175 to 194, and 2,947 of 6.78 million vegetation returns moved. Untested: no other site has been checked for 50 m of vegetation that is really a tree |
| Dropped | classes 7, 18 | Noise |
| Counted, not drawn | everything else (class 13: 2.8 per cent at Doubletop, meaning unknown) | Written into each cache file's `classes` so a future reading of the spec can decide |
| Eye | median class 2 within 3 m of the pin, else 10 m, plus 1.7 m | The median so one return down a drain does not lower the eye. Reported against the 3DEP post when the two differ by over 5 m |
| `S_MIN_DEG` | 0.5 degrees | Structures get a layer only where they stand this far above both ridge and trees somewhere; a shed under the canopy is not a layer |
| Same-time threshold | 5 minutes | The sentence gives one time when the ridge and the canopy crossings agree within this |
| Trees opacity | 0.7 | Shawn, 2026-09-17: the moon and the core stay visible behind the tree band while scrubbing the night |
| Deck heights | see Task 11's entry below once measured | The platform floor above ground at the view coordinate, from the lidar tower top less an allowance for the cab |
| `WORKERS` | 32 | Concurrent node downloads. Latency-bound at 0.2 to 0.3 MB/s per connection from us-west-2, so throughput scales with connection count rather than bytes: 8 workers measured about 1.6 MB/s, 32 about 4.5, 64 about 10 (probe below). 32 is the middle value tried, not a peak |

### Measured runs

`WORKERS` probe, desktop, 2026-09-17 23:34-23:40: downloads are latency-bound
at 0.2 to 0.3 MB/s per connection from us-west-2. 8 workers gave about 1.6
MB/s (44 to 80 s a site), 32 about 4.5, 64 about 10. Sites ran 83 to 111 MB
and 143 to 240 nodes, with only 10 to 25 per cent of a site's nodes reused
from its neighbour. The plan's original estimate (63 MB a dataset, 8 s a
site, 20 to 30 minutes total) was wrong on every count; this probe is the
result that argued for 32 workers over the plan's 8.

The full run (started 2026-09-18 00:28, `--force`, 32 workers) held a steady
4.0 MB/s, about 25 s and 100 to 130 MB a site, which is where "about 15 GB
and about 65 to 80 minutes from cold" in the commands above comes from.

- Full run 2026-09-18 00:28 to 01:21: 150 of 159 sites; the 9 without 2017 lidar are the 8 Doughton Park area sites and The Lump (MP 264, Wilkes). 12.6 GB over the network in 53 min at 4.0 MB/s, 32 workers, no failed fetches. Lidar pin ground against the 3DEP cell: median +0.11 m, sd 1.5 m over 127 sites; five over 5 m (East Fork, Lake James, Wiseman's View, Chestoa View, Jumpinoff Rock), all on cliff or bank lips where neighbouring 3DEP cells differ by 14 to 34 m against 0.9 at Max Patch and 2.4 at Doubletop: a resolution effect, the lidar is the better number. 40 sites read a median tree altitude over 30 degrees; see Standing spots.

### What the page shows

Three rings, back to front: structures (slate, dashed crest, opaque), trees
(dark green, 70 per cent), ridge (unchanged, last). Each ring is the highest
of itself and what is below it. The legend lists only the layers present.
The sentence names the layer at the crossing and gives the ridge time in
brackets when it differs by more than five minutes; with no canopy entry
the sentence is exactly what it was. Tower spots with `deck:` get a
two-button toggle, from the ground and from the deck, that swaps all three
profiles; it resets on every new place and is not remembered.

### Raw lidar store

Every EPT file a site's box touches is kept at
`H:/dark-sky/ept/<dataset>/{ept.json, ept-hierarchy/*.json, ept-data/*.laz}`,
one file per node, at the same relative path the EPT bucket itself uses.
`CANOPY_STORE` overrides the path; set it empty and the store is off, the
same as running on a machine with no `H:` attached. A file already on disk
is read instead of fetched, so a probe, a moved pin, or the 2025 comparison
never downloads the same node twice.

One writer thread, not one per download worker: `H:` is a USB spinning disk,
and TALON measured 8 interleaved writers running it at 26 MB/s against 88
MB/s sequential (2026-09-15; TALON `docs/lidar_chm_pipeline.md`). Every
write lands as `<path>.tmp`, then `os.replace`s onto the real name, so a
`.tmp` left by a killed run is refetched rather than trusted. A write that
fails is only found at `flush_store()`, which raises the first one. `main()`
turns the store off for the run when its drive doesn't exist on this
machine, and `--dry-run` prints where the store is (`raw ept files kept in:
...`, or `nowhere (CANOPY_STORE is empty)`) without writing to it.

Size on disk: (pending: measured size after the store fill run, `du -sh
H:/dark-sky/ept`).

Reversed 2026-09-18: the spec said nothing is written per node; Shawn: "we
can afford 12gb", and every probe after the first run had to download its
box again.

### Standing spots

40 of 150 sites read a median tree altitude over 30 degrees from the pin:
the pin is in or against the canopy. The coordinates were good to about 10
m, which was enough for a terrain raycast from 150 m out and is not enough
for trees 2 m from where somebody would actually stand.

Why spots are chosen by the sky they open (2026-09-18). The first finder
took the nearest ground with no vegetation standing 3 m over it within 3 m.
That is a proxy, and on the 2026-09-18 run it failed both ways. On slopes it
refused every cell, because a 30 cm shrub on ground 3 m uphill reads as 3 m
of vegetation (Devil's Courthouse and Chestoa View: 0 of about 2,300 ground
cells within 30 m passed). In small gaps it took a cell whose skyline was
still set by trees 4 to 10 m away (Jackrabbit, Balsam Gap, Soco Gap, Hominy
Valley and Camp Creek "moved" 1 to 2 m with no change in tree altitude). A
direct raycast from every level 2 m candidate found a real spot at Wayah
Bald (5.7 m, median 43 to 19) and none under 30 degrees within 30 m at
Jackrabbit (best 35.8 at 23 m), Chestoa (best 71.1) or Devil's Courthouse,
which reaches 24 at 28 m and 15 at 30 m west on ground 6 m above the pin.
The design once said the probed sites had "open ground 14 to 19 m away".
That was wrong: the probe counted 4 m cells with no tree over 3 m above the
pin's ground, so canopy tops below the pin downslope read as open, not
places to stand.

How it works. The points in the square `SEARCH_R + SKY_R` either side of the
pin go into 1 m cells: the lowest ground return (the surface you stand on)
and the highest vegetation return (the crown top). Every `CAND_STEP` lattice
point within `SEARCH_R` of the pin, the pin included, whose cell has ground
within `LEVEL_M` of the pin's is a candidate. From an eye `EYE` over that
cell's ground, the tree skyline is raycast over every vegetated cell's top,
with the same `skyline()` and `MIN_R` as the pin's own profile, and each
cell fills every whole degree its 1 m width spans. A candidate whose own
cell has vegetation `CLEAR_H` or more over its ground is under a crown,
which sits inside `MIN_R` and would otherwise be invisible: its sky is the
crown, so it reads the capped 80 degrees and 0 % open.

The grid screens and the raw points decide. Every candidate whose grid
median is at or under `CLOSED_DEG + CONFIRM_DEG`, nearest first and at most
`CONFIRM_MAX` of them, is raycast again through the raw vegetation returns
within `SKY_R` of it, with the plain point `skyline()`. The first whose raw
median is at or under `CLOSED_DEG` is the spot. An under-crown candidate
reads 80 on the grid, so it never reaches the raw check. With no spot, the
row's best is the lowest raw median among those checked, or the lowest grid
median when none was checked, and the table marks that one "(grid)".

`then` and `open then` are an independent re-measure from the spot, not the
raw figure that confirmed it. They come from the same `profiles_for` the
pin uses: the eye on the median ground within 3 m of the spot (not the
1 m cell's lowest return), the whole fetched box rather than `SKY_R` around
the spot, and returns that `structure_mask` routes to built taken out of
the trees. So a confirmed spot's `then` can land a little over 30.

Grid against raw points, measured 2026-09-18 on Wayah Bald (20 sampled
candidates not under a crown, raw raycast over trees within 110 m). One
point per cell leaves the degrees between cell centres empty within about 57
m, so it read 7.0 degrees of median low on average, and a solid synthetic
ring of trees read 122 of 360 degrees open. Filling each cell's full width
at its top reads 10.7 high on average (absolute median 10.4, worst 31.5):
the top is the highest return in a 1 m cell of leaf-off crown, and the rest
of the cell's width is lower or see-through. Picking on the grid alone
therefore erred towards trees, which is why the raw points now decide and
`CONFIRM_DEG` gives the screen 15 degrees of room over that 10.7. At Wayah
1,227 of 2,091 candidates were under a crown.

The raw check, measured 2026-09-18 over the filled store. Wayah Bald: 742
candidates passed the screen, and the second raw check confirmed (0.3 s
each). Jackrabbit: 177 passed. The 40 nearest were checked (6.1 s, 0.15 s
each, reaching 17 m) and none confirmed. Checking all 177 (27 s) confirms
none either: the lowest raw median is 34.0 at 22.6 m, 3 m down (grid 37.7),
against the probe's 35.8 at 23 m. The cap hid no spot there, but it does
make the row's best the lowest among the 40 nearest (39 at 17 m), not the
lowest there is.

Limits of the finder. `CONFIRM_DEG` is margin over the 10.7 degree average
gap between grid and raw points, not over the worst one: the measured worst
was 31.5, so a candidate that is open on the raw points can still read over
45 on the grid and be screened out, never raycast raw. `MIN_R` (2 m) hides
a crown in the neighbouring cell, so nearest-first picks tend to land at a
stand's edge, beside the last trees rather than clear of them. The canopy
is 2017 and leaf-off, so every spot's sky is a floor on what is there now.

```sh
# for every site whose median tree altitude is over CLOSED_DEG, find the
# nearest candidate that opens the sky and write a review table. raycasts
# from the pin's own box, so over a filled store it uses no network: the
# final line's net figure shows it. never touches index.html. 5 to 17 s a
# site over the filled store (2026-09-18: Wayah Bald 17, Jackrabbit 16,
# Devil's Courthouse 9, Chestoa 5, wall clock with the H: read), so about
# 10 minutes for the 40 closed-in sites.
python tools/build_canopy.py --suggest-views
```

Sanity sites, 2026-09-18, the lines the run printed:

```
[11:40:20] [1/1] Wayah Bald ... moved 5 m (+0.0 m), 43 to 27 degrees
[11:40:36] [1/1] Jackrabbit Mountain ... none under 30 within 60 m; best 39 at 17 m, 2 m down
[11:40:46] [1/1] Devil's Courthouse ... moved 30 m (+5.9 m), 72 to 18 degrees
[11:40:51] [1/1] Chestoa View Overlook ... none under 30 within 60 m; best 72 at 29 m, 8 m up (grid)
```

writes `tools/.canopy-cache/view-review.md`, one row per closed-in site,
most closed first: `site`, `key` (the site's key, since decisions are filed
by key: overlooks are `ov:<osm id>`), `now` (median tree altitude at the
pin), `open now` (open sky at the pin), `proposed` (the spot; with none, "none
under CLOSED_DEG within SEARCH_R m" and the best candidate's median, distance
and metres up or down, as in "best 39 at 17 m, 2 m down", with "(grid)"
when no raw check ran), `moved` (metres
from the pin), `bearing`, `up/down` (the spot's ground against the pin's,
signed, metres), `then` (median tree altitude from the spot), `open then`
(open sky from the spot), `walk under trees` (metres of the straight line
from the pin to the spot that pass under a crown), and satellite links for
both `pin` and `spot`. Open sky is the percent of the 360 azimuths whose tree
line is under `OPEN_DEG`, the number the page can show later as "open sky
%". Each row is also cached on its own in `tools/.canopy-cache/suggest/`,
reused while the site's coordinate and the nine tunables below still
match; `--suggest-views --force`, or deleting the directory, recomputes
every row. A run with `--only` rewrites `view-review.md` with only the sites
it matched.

| Constant | Value | Evidence |
|---|---|---|
| `CLOSED_DEG` | 30 degrees | A median tree altitude over this puts the pin in or against the canopy (2026-09-18: 40 of 150 sites), and a candidate at or under it is a spot. Placeholder, from two probed sites |
| `SEARCH_R` | 60 m | How far from the pin a spot may be proposed. 30 m found nothing at three of the four probed sites, and Devil's Courthouse's best sat on the 30 m edge; at 60 m its spot is 30 m out, 5.9 m up (2026-09-18, with the raw check). Placeholder |
| `LEVEL_M` | 10 m | The spot's ground within this of the pin's. 3 m shut out Devil's Courthouse's spot 6 m up; 10 still keeps a cliff lip from being swapped for its foot (a 20 m drop). Placeholder |
| `CAND_STEP` | 2 m | Spacing of the candidate lattice, the spacing the 2026-09-18 probe used. Placeholder |
| `SKY_R` | 100 m | Trees further than this past `SEARCH_R` are not gridded. `SEARCH_R + SKY_R` has to stay inside `RADIUS` (200 m), the box that was fetched. Placeholder |
| `OPEN_DEG` | 20 degrees | An azimuth whose tree line is under this counts as open sky, the cut the 2026-09-18 probe counted. Placeholder |
| `CLEAR_H` | 3 m | Vegetation this far over the ground is in the way: over the walk from the pin, and over a candidate's own cell (it is under a crown). Shrubs under this are not. Placeholder, from two probed sites |
| `CONFIRM_DEG` | 15 degrees | A candidate's grid median may read this far over `CLOSED_DEG` and still be raycast through the raw points. The grid read 10.7 degrees high on average at Wayah Bald (20 candidates, 2026-09-18), so this leaves margin. Placeholder |
| `CONFIRM_MAX` | 40 | Candidates raycast through the raw points at most, nearest first, so a closed site costs a bounded time (Jackrabbit: 40 checks 6.1 s, all 177 27 s, 2026-09-18). Placeholder |

A decision is recorded, never applied by itself. For a curated spot, set
`view:` on its `SPOTS` record to the approved coordinate. For an overlook,
add its osm id to `tools/overlook-views.json` as `"<osm id>": [lat, lon,
note]`. Either way the map dot moves to sit on the viewpoint itself, never
on the OSM point or the old pin, and any off-path walk to it is said as a
line on the card or in the overlook popup, not left for the reader to find
out (Shawn, 2026-09-18). A rejected row changes nothing: the site stays
under trees and the review record says so.

Review outcome (Task 15): (pending: review outcome, Task 15 -- approved,
rejected and corrected counts). Over-30 count: 40 before the review,
(pending: over-30 count after the review).

## Behaviours worth keeping

Things that look like bugs and are not. Written down so a future pass
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
`darksky.skyView` (`{ az, alt, fov }`) is shared across every card, overlook
and picked point that opens the sky viewer, regardless of which
one the reader dragged. Turning to face a landmark on one spot's sky and
opening another spot's next keeps facing the same way, on purpose: it is
"which way am I used to looking," the same kind of preference as the basemap
or the overlook layer, not a fact about a particular place the way the
scrubber's remembered clock time is. Superseded 2026-09-17: this used to be
`darksky.panoAz`, one value (`az0`) written by `bindPanoRotate`; the dialog
looks around in altitude and zoom too, so the same key now carries all
three, and `darksky.panoAz` is read once, as a fallback for `az` alone, and
never written again.

**The sky viewer is a tab, and a restore on load does not switch to it.**
Changed 2026-09-17, from a `<dialog>` opened over the map, at Shawn's request
(the popup and the card thumbnail were both too cramped to turn a sky in).
Everything that loads a place (a card thumbnail, an overlook's button, the
chooser, a picked point) calls `openSkyViewer(o, { show })`. With `show`
(the default) it clicks `#tab-sky` and scrolls the viewer into view; the two
restores on load (`spotState.pano` for a spot, `darksky.pano` in `initMap`
for `ov:` and `pt:` keys) pass `show: false`, so the tab the reader left on
still wins. `paintSkyViewer` returns before drawing while the canvas has no
width, and `showSkyTab` paints on every show of the panel, not just the
first, because the loaded place can change while the panel is hidden. A cold
visit to `#sky` loads the spot the list leads with (`visibleSpots()`, not
the DOM: the cards only render once the map tab has shown).

**A picked point gets a flat horizon, on purpose, until the terrain tiles
exist.** `openSkyViewerForPoint` passes `new Float64Array(360)`, not `null`,
so the summary sentence and the level line still work; the caveat under the
canvas says the ridge is really higher, so rises shown are early and sets
late. Phase 2 (the browser raycast over the tiles, see "Terrain tiles for
picked points") replaces the zeros with a real horizon and drops the caveat.
The key `pt:<lat>,<lon>` carries the point itself, so there is no second
storage key to keep in step.

**The viewer's 0 degree level line is drawn after the ridge, on purpose.** Added
2026-09-17 at Shawn's request. It marks true level over the ground, so the gap
from it up to the crest reads as the degrees of sky the terrain takes, with
altitude labels every 10 degrees up the middle of the view. The compass letters
ride on it: drawn with the grid, before the ridge, they were buried on any
enclosed site (Ballhoot Scar showed none). The ground itself is everything on
the far side of the ridge ring from the zenith, not a wall of fixed depth: a
portrait phone sees about 60 degrees below the horizon and a 30 degree wall
let the sky come back underneath it.

**The viewer paints its canvas last.** The canvas takes whatever height the
text under it leaves. Drawn before that text was set, it was sized for a
taller box and then squashed about 6 per cent on a phone (584 px drawn, 546
shown), which also put drags off target. `check-tabs.mjs` asserts the drawn
and shown sizes agree.

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
| Lit limb vs the sun, sky viewer dialog | 3 degrees, in a view not centred on the moon, so the check exercises the tilt a centred one cannot (see below) |
| Catalogue | 1,046 stars, 150 figure runs, every index valid |

The limb check is the one that matters and the reason it exists: a flipped sign
in the parallactic rotation reads as roughly 180 degrees, or as twice the
parallactic angle, and is otherwise invisible except as a moon lit from the
wrong side on a night nobody happens to be checking. The dialog's own moon
finds "toward the zenith" on screen by projecting a point a degree higher in
altitude, since that direction is only straight up at the view centre itself;
its own limb check, in a view not centred on the moon, is what proves that
holds away from the centre too.

Retired 2026-09-17: the Milky Way wrap seam check, which measured the flat
open view's cylindrical wrap-copy machinery at the join between two edges of
its window. The sky viewer dialog's stereographic projection has no seam to
check -- a point past its 100 degree cull is not drawn at all, never wrapped
or stretched across the canvas -- so the check had nothing left to measure
and was removed with the flat open view it tested.

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
| 2026-09-17 | Sky viewer dialog (`panProject`, stereographic, replacing the flat `PAN_FOV` window): `node --test tools/test-panorama.mjs` | 14 pass: the thumbnail's own affine mapping, `panProject`'s centre-maps-to-centre, left/right symmetry, behind-the-viewer null, the zenith ring, and the true-angular-field calibration |
| 2026-09-17 | Eastern civil date anchoring (`easternParts`, `easternInstant`), same test file | A January and a July evening and both 2026 DST change dates all round-trip to 17:00 Eastern; the four dates are not all the same UTC offset (proof DST moved something); a child process with `TZ=Asia/Tokyo` (`tools/eastern-tz-child.mjs`) computes the same instants and the same Eastern parts |
| 2026-09-17 | Same change, `node --test tools/test-inline-parity.mjs` | 1 pass: the copy of `sky-panorama.js` pasted into `index.html` still matches the source file byte for byte, CRLF normalised |
| 2026-09-17 | Same change, `node tools/check-tabs.mjs` | All checks pass, including the new ones: the dialog opens from a card at the default view, dragging redraws and stores `darksky.skyView`, a reload restores it, garbage falls back, the drag does not select the card, arrow keys and Home turn and reset the view, Escape closes it and returns focus to the thumbnail, the date picker changes the title and the summary sentence, and a Tokyo-timezone browser's "tonight" is the Eastern evening, not its own calendar date |
| 2026-09-17 | Popup slimmed, inline open view deleted: pixel-hash comparison of all 40 card thumbnails against the pre-dialog `index.html` | 0 mismatches: the thumbnail is unchanged, pixel for pixel |

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
window is chosen, so this is recorded rather than asserted. The upgrade path
recorded here used to be "an adapting scale, or an explicit open-sky state";
the sky viewer dialog is that state now, so a flat thumbnail is an invitation
to open it rather than the whole story. The thumbnail's own scale is
unchanged and still worth revisiting against the spread above.

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
- Resolved 2026-09-17: the `bright > 1` canvas assertion in `check-tabs.mjs`
  this used to flag (a thin margin, dependent on the real night sky) is gone
  along with the overlook popup's own moon and stars -- the popup's canvas is
  the closed thumbnail now, which never draws either; the sky viewer dialog
  its "open sky view" button opens is what shows them, and is not checked
  this way.
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
