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

## Left open

The per-spot JSON cache carries **range to skyline** per azimuth as well as
altitude. Only altitude is inlined. Distance-graded haze and peak labels
("that ridge is Mount Pisgah, 14 km") therefore cost an inlining step rather
than another 7 GB read.

Planets need only a truncated VSOP87 series; the alt/az plumbing already
accepts them.

A WebGL mesh view would consume the same raycast output.
