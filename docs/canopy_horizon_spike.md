# Does canopy change a skyline? A spike, 2026-09-17

Measured on 2026-09-17 against the two viewpoints that already have a finished
CHM on disk. Throwaway code, kept findings. Nothing in the page changed.

## What was compared

Three surfaces, same viewpoint, same 360 azimuths:

| | terrain | canopy | ray starts at |
|---|---|---|---|
| **A** what the page ships | 3DEP 1/3 arc-second (~10 m) | none | 150 m |
| **B** | NCEM 2025 QL1, 0.95 m, inside 2 km | none | 20 m |
| **C** | same | 2017 `chm_self`, 0.95 m | 20 m |

Beyond 2 km all three use the existing 3DEP far field, since a 20 m tree at
2 km is 0.57 degrees and at 10 km is 0.11, against a horizon encoding whose own
step is 0.022 degrees. A fourth variant repeated C but blind inside 150 m, to
separate "finer data" from "data where there was none".

Sources: the 2025 NCEM 1 m bare earth COG for Buncombe County (float32 metres)
and a 1 m `chm_self` canopy height model from the 2017 NC Phase 5 lidar
(int16 decimetres), both 0.953 m cells, EPSG:32119 declared as `LOCAL_CS` in the
headers. Eye at 1.7 m on the bare earth, never on its own canopy.

## Result

| | Craggy Pinnacle | Mount Pisgah campground |
|---|---:|---:|
| mean horizon, A | -0.6° | -0.7° |
| mean horizon, B (1 m bare earth) | -0.6° | -0.7° |
| mean horizon, C (plus canopy) | **-0.6°** | **+5.0°** |
| open sky, A → C | 100% → 100% | 100% → **93%** |
| highest obstruction, A → C | 2.9° → 2.9° | 0.5° → **78.1°** |
| south quarter, A → C | -1.1° → -1.1° | -1.1° → **+21.0°** |
| canopy's own contribution | +0.0° mean, +0.4° max | +5.6° mean, +79.3° max |
| of which comes from inside 150 m | none | **all of it** |

Two viewpoints, two opposite answers, and the reason is not "wooded versus
open".

**Craggy Pinnacle: nothing changes.** Canopy around it is real (median 5.4 m,
p99 11 m within 300 m) and irrelevant, because the viewpoint stands above it.
The DSM's maximum inside 300 m is 1796.5 m and the eye is at 1796.7 m: there is
nothing there taller than the person. What little does change, about +0.9
degrees over a narrow band at azimuth 80 to 86, is the 1 m bare earth resolving
a ridge 1.1 km out that the 10 m grid had smoothed, not vegetation.

**Mount Pisgah campground: the page is wrong about the south.** 53 cells
between 40 and 95 m tall sit 16 to 23 m from the viewpoint on bearings 175 to
198, a footprint of 53 m². That is the broadcast tower, and lidar sees it
because lidar sees everything above the ground. The steepest cell is 93.5 m
tall at 19 m, which is 78.7 degrees of altitude. The page currently draws open
sky to the horizon there: its cached far field reports the nearest blocker on
those azimuths at 38 to 100 km.

The blind-inside-150 m variant reproduces the old answer exactly (mean -0.7°,
max 0.5°). So every bit of Pisgah's change is in the ring the current raycast
starts outside of. Beyond 150 m, canopy added nothing measurable at either
spot.

## What this means for a build

- **The clip radius should be metres, not kilometres.** Both spots put the
  whole effect inside 150 m. A 300 to 500 m radius per spot is the shape to
  build, not the 1.5 to 2 km first proposed, which cuts the data volume by
  about twenty times.
- **The 150 m floor is the thing to remove.** It exists because a 10 m grid
  cannot tell a roadcut from a tree line. With 1 m data it can, and that ring
  is where the answer lives.
- **A finer bare earth alone is not the win.** Variant B moved neither spot's
  mean horizon at all. Canopy and structures are the payload.
- **Two spots are not a sample.** Both of these are summits, where canopy is
  downslope by definition. The untested and more common case is a wooded
  pull-off like Cove Field Ridge, whose own entry says the view has grown in,
  and where canopy in the 150 m to 1 km band might well matter. Cove Field is
  in Haywood, which has only a 2.8 by 3.6 km test tile, so that test needs a
  Haywood run before the clip radius is settled on evidence rather than on
  these two.

## Limits of the data, stated before anybody trusts a number

- **The canopy is 2017, the ground is 2025.** Eight growing seasons, and the
  2017 flight was leaf-off Geiger, which is known to under-read
  deciduous crown tops. Canopy heights here are an underestimate of today.
- **`chm_self` is the right product, `chm_dem` is not.** `chm_dem` differences
  2017 canopy against 2025 ground, so anywhere the ground itself moved between
  the epochs, and western North Carolina moved a great deal in September 2024,
  it reports ground change as canopy. At these two spots the two products agree
  within 0.3 m of median, so it changed no conclusion here, but it will
  somewhere with a landslide scar.
- **Coverage is two spots of forty.** Buncombe is the only county with a
  finished CHM. Of the 40 viewpoints, five fall inside its bounding box and
  only these two have data; Bearwallow, Black Mountain Campground and Mount
  Mitchell are in the rectangle but outside the county footprint.
- **Nearest-neighbour sampling at 1 m steps** along each ray, so a thin
  obstruction can be stepped over. Conservative, and it did not matter for a
  53 m² tower, but a single power pole could be missed.
- **PROJ conflict on this machine.** PostgreSQL 17 ships a `proj.db` that
  shadows rasterio's and breaks every CRS lookup until `PROJ_LIB` is cleared
  from the environment. Any GIS script here needs that line.

## A second finding, free of the pipeline question

Structures cut both ways, and the model treats neither.

Pisgah's tower is an obstruction the page should show. But `Fryingpan Mountain
tower`, `Mount Sterling summit` and `Wayah Bald` are spots whose entire point
is that you climb a tower and look over the canopy. There the eye is not 1.7 m
above the ground, it is 20 or 30 m up a steel or stone structure, and the
horizon from the platform is a different horizon from the one the page draws.
Lidar knows the height of those towers. Whether a spot's eye should sit on the
ground or on its platform is a per-spot fact somebody has to decide, the same
way `view:` was.

## The wooded case, measured 2026-09-17 on a Haywood clip

The two summits above could not answer the question that matters, so the EPT
pipeline ran for a 1.2 by 1.5 km box around Cove Field Ridge: 9 depth-6 tiles,
0.38 billion points, 2.4 GB of egress, 130 seconds, with
`--bbox -83.0423 35.4230 -83.0291 35.4363 --max-depth 10 --workers 4`.

**The data validates itself at the pin.** 2025 NCEM DEM 1409.3 m, 2017 lidar
DTM 1409.2 m, 2017 DSM 1409.3 m, canopy 0.1 m. Two independent surveys eight
years apart agree within 0.1 m, and the canopy is zero, so the coordinate is on
open pavement and the two grids are aligned.

### Cove Field Ridge Overlook

Rays from 2 m to 500 m, the clip's usable radius, with the existing 3DEP cache
carrying anything whose blocker is further out. Quarters are mean altitude.

| | mean | open sky | N | E | S | W |
|---|---:|---:|---:|---:|---:|---:|
| what the page ships (3DEP, from 150 m) | 12.3° | 79% | 11.7° | 1.3° | 12.3° | 24.1° |
| 1 m bare earth, from 2 m | 12.7° | 75% | 13.3° | -7.8° | 11.7° | 33.5° |
| **plus 2017 canopy** | **26.5°** | **57%** | 21.1° | 16.8° | 17.1° | 51.1° |

Canopy adds 13.9 degrees to the mean and costs 22 points of open sky. The
interesting part is where it lands. The east is the only quarter the bare-earth
model calls open, 1.3 degrees on 3DEP and -7.8 on the 1 m grid because the
ground falls away, and canopy takes it to 16.8, the largest single rise being
+32.7 degrees at azimuth 087. Due east is the direction the overlook exists to
look at. "The view here has largely grown in" is that number.

The south barely moves: +1.5 degrees at azimuth 190, where the galactic core
sits. Whatever else canopy changes, it does not change what this entry says
about the core, because the road corridor keeps the south open.

### Which distance band does the work

| band | mean | sets the horizon on |
|---|---:|---:|
| 2 to 20 m | -0.1° | 34 of 360 azimuths |
| 20 to 50 m | 21.7° | **196 of 360** |
| 50 to 150 m | 18.8° | 49 of 360 |
| 150 to 500 m | 12.5° | 85 of 360 |

Cumulatively: -0.1 degrees out to 20 m, 22.0 out to 50 m, 25.8 out to 150 m,
26.5 out to 500 m. The 20 to 50 m ring does +22.1 degrees of the 26.5, the next
hundred metres adds 3.8, and everything from 150 to 500 m adds 0.7. A wooded
site agrees with the two summits: a clip of 150 to 200 m captures essentially
all of it, and kilometres are wasted.

### The clearing, and how stable the answer is inside it

The connected run of sub-2 m cells containing the pin is 13,320 m², but it is
not a clearing: it is the parkway corridor, a curved ribbon. Its centroid sits
75 m away and, because the centroid of a curve need not lie on the curve, lands
in the trees and reports an 85 degree horizon. That number is an artifact of
using a centroid on a ribbon, not a measurement of anywhere.

The useful statistic is the most interior open point, the open cell furthest
from any canopy. Here it is 19 m from the nearest trees and 6 m from the pin,
and its horizon is 27.4 degrees against the pin's 26.5. The answer is stable
across the part of the site a person would stand in, and the pin is already as
good as the spot gets, which is worth knowing before anybody builds machinery
to move pins to clearing centres.

### The pull-off south, with canopy

| | Cove Field | road vertex 537 m S | the paved apron |
|---|---:|---:|---:|
| coordinate | 35.4309, -83.0357 | 35.4261, -83.0348 | 35.4254, -83.0359 |
| open inside 10 m | 100% | **54%** | 92% |
| south quarter, bare earth | 11.7° | 4.9° | -2.4° |
| **south quarter, with canopy** | **17.1°** | not measured | **2.3°** |

Two conclusions, and the second replaces what an earlier version of this file
said.

The road vertex the bare-earth sweep picked is half under trees, 54% open
inside 10 m, so the coordinate to name is the paved apron at 92%.

And the southern advantage is not weakened by canopy, it is sharpened. With
trees in the model the apron's south quarter reads 2.3 degrees against Cove
Field's 17.1: a 15 degree advantage where bare earth had shown 7. The apron
pays for it in the north, 53.0 degrees against 21.1, which is the right trade
for anything that sits south. The entry's sentence about the southern view
opening up a few hundred metres along the road is correct, and understated.

### The error in the first version of this section, and the guard against it

The first run of this comparison reported a 48.3 degree mean horizon and 25%
open sky at Cove Field, and concluded that canopy erased the southern
advantage. Both were wrong, from one bug.

`rasterio.read(window=...)` silently clamps a window that extends past the
raster, while `window_transform` describes the window that was *asked for*. A
2,050 m window against a 1.4 km clip therefore returned a smaller array with a
transform for a bigger one, so every sample was offset: the pin's own cell came
back as 25.7 m of canopy instead of 0.1 m, and the rays read tall forest where
the clearing is. The numbers were plausible, self-consistent, and describing
the wrong place.

The spike script now refuses any window that leaves the raster rather than
trusting the read. Anything reading these clips should do the same, because the
failure is silent and the output looks reasonable.

Unaffected by the bug, because they used 60 to 120 m windows well inside the
clip: the pin validation, the canopy-by-ring profile, the contiguity check on
the tall returns, and the three-point openness comparison.

### Where a third dimension comes in, for later

Not now, but worth writing down while the evidence is fresh. A 26 degree mean
horizon with 57% open sky is the point where a cylindrical panorama stops being
the honest picture: what a person wants to know is the shape of the hole
overhead, and the panorama flattens exactly that. The established form is the
hemispherical or fisheye projection that forest canopy work already uses, where
the zenith is the centre and the horizon the rim, so openness is literally the
visible area. It reads as a map of the sky you have rather than a wall of
terrain, and a moon or core track drawn across it answers whether the target
ever clears the trees.

That is a projection change, not a 3D engine, and the data for it already
exists in the 360-value horizon. A real 3D view of terrain and canopy is a
bigger thing and a separate argument.

### Still not measured

- How much eight leaf-off growing seasons understate this year. Every canopy
  number here is a floor.
- Whether any spot needs the 150 to 500 m band. Nothing has yet.
- What the apron's coordinate should be to the metre, and what that pull-off is
  called, which is a question for somebody who has stood there.
