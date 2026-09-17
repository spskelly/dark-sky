# Spot coordinates and viewpoints: what was applied

Applied 2026-09-17. Supersedes the proposal version of this file. The per-spot
evidence and sources are research notes kept out of the public repository.

For a hike-in spot the parking and the view are two different places. The pin,
the driving directions and the drive-time estimate use `lat, lon`; the skyline
panorama uses `view: [lat, lon]` where one exists. On the map the parking is a
solid pin and the viewpoint a hollow dashed one, joined by a dashed line, so
the walk is visible rather than buried in a note.

**19 coordinates moved. 24 viewpoints added. 16 spots unchanged.**

## The table

`pin moved` is how far the parking coordinate shifted. `walk` is parking to
viewpoint. Elevations are the DEM sampled at each point, in feet.

| spot | pin moved | walk | park ft | view ft | listed |
|---|---:|---:|---:|---:|---:|
| Waterrock Knob | . | 451 m | 5774 | 6287 | 5820 |
| Thunder Struck Ridge Overlook | 246 m | . | 4779 | . | 4780 |
| Cove Field Ridge Overlook | . | . | 4623 | . | 4620 |
| Black Balsam Knob | . | 111 m | 6147 | 6211 | 6214 |
| Sam Knob / Flat Laurel Creek | 1023 m | 1244 m | 5807 | 6072 | 5800 |
| Graveyard Fields | . | . | 5112 | . | 5120 |
| Devil's Courthouse | 171 m | 451 m | 5468 | 5748 | 5720 |
| Cowee Mountains Overlook | . | . | 5949 | . | 5950 |
| Wolf Mountain Overlook | . | . | 5495 | . | 5460 |
| Fryingpan Mountain tower | 2644 m | 605 m | 4934 | 5306 | 5340 |
| Mount Pisgah campground | 1118 m | 2335 m | 4852 | 5707 | 4960 |
| Cataloochee Valley | 1214 m | 2027 m | 2624 | 2771 | 2650 |
| Mount Sterling summit | 1282 m | 2269 m | 3890 | 5835 | 5842 |
| Kuwohi (Clingmans Dome) | 702 m | 707 m | 6310 | 6641 | 6643 |
| Cherohala Skyway, Hooper Bald | 3150 m | 663 m | 5309 | 5428 | 5290 |
| Panthertown Valley | 1635 m | 1545 m | 4058 | 4194 | 3900 |
| Roan Highlands, Carvers Gap | . | 589 m | 5510 | 5824 | 5512 |
| Mayland Earth to Sky Park | 752 m | . | 2876 | . | 2700 |
| PARI | . | . | 2880 | . | 2900 |
| Max Patch | . | 493 m | 4361 | 4629 | 4629 |
| Mount Mitchell State Park | . | . | 6681 | . | 6684 |
| Craggy Pinnacle | 622 m | 361 m | 5651 | 5884 | 5892 |
| Black Mountain Campground | . | . | 2997 | . | 3000 |
| Big Bald | . | 1402 m | 4659 | 5515 | 5516 |
| Wiseman's View | . | . | 3400 | . | 3400 |
| Table Rock picnic area | . | 525 m | 3349 | 3925 | 3400 |
| Beacon Heights | 1621 m | 199 m | 4220 | 4380 | 4220 |
| Grandfather Mountain State Park | 1519 m | 2241 m | 4037 | 5924 | 5946 |
| Elk Knob State Park | . | 1489 m | 4515 | 5538 | 5520 |
| Doughton Park | 2383 m | . | 3694 | . | 3600 |
| Lake James State Park | . | 857 m | 1194 | 1218 | 1200 |
| Bearwallow Mountain | 1250 m | 1024 m | 3653 | 4227 | 4232 |
| DuPont State Recreational Forest | . | . | 2305 | . | 2900 |
| Gorges State Park | 673 m | . | 3249 | . | 3000 |
| Whiteside Mountain | . | 446 m | 4272 | 4903 | 4930 |
| Wayah Bald | . | 123 m | 5273 | 5340 | 5342 |
| Standing Indian Campground | . | . | 3408 | . | 3400 |
| Jackrabbit Mountain | . | . | 1973 | . | 2000 |
| Huckleberry Knob | 2350 m | 920 m | 5301 | 5557 | 5560 |
| Tsali Recreation Area | 1537 m | . | 1739 | . | 1800 |

## The pins that were not on anything

Six were not merely imprecise. The reverse geocode of each old coordinate says
what it actually sat on:

| spot | moved | the old coordinate was |
|---|---:|---|
| Cherohala Skyway, Hooper Bald | 3150 m | out by Stratton Ridge near the Tennessee line, nowhere near the trailhead |
| Doughton Park | 2383 m | the Bluff Ridge Primitive Trail, in the woods, 79.6 % open for an entry tagged "open meadows" |
| Fryingpan Mountain tower | 2644 m | 480 m off the parkway in the woods, 838 ft below its own listed elevation |
| Huckleberry Knob | 2350 m | 1.59 km from the Skyway carriageway, turning a 20 minute walk into a bushwhack |
| Beacon Heights | 1621 m | Blowing Rock Highway (US 221) at Appletree Ridge, a different mountain |
| Grandfather Mountain State Park | 1519 m | Mountain Springs Road, a private road on the west flank, outside the park |

Thunder Struck moved only 246 m but was the worst kind of wrong: 4 m from the
parkway centreline, which is to say in the travel lane.

## What still needs your judgement

**`elev` means two different things across the list, and now that the two
coordinates are separate it is visible.** Compare the `listed` column against
`park ft` and `view ft`:

- Most entries' `elev` is the **viewpoint**: Max Patch 4629 against a view of
  4629, Big Bald 5516 against 5515, Wayah 5342 against 5340, Craggy 5892
  against 5884, Grandfather 5946 against 5924.
- A handful are the **parking**: Waterrock 5820 against a lot at 5774 and a
  summit at 6287, Beacon Heights 4220 against a lot at 4220, Thunder Struck
  4780 against 4779, Hooper Bald 5290 against 5309, Table Rock 3400 against a
  lot at 3349 and a summit at 3925.

Nothing was changed either way, because 40 hand-entered figures are yours to
settle and the page uses `elev` for temperature intuition ("subtract about 15
degrees for the 6,000-foot balds"), which argues for the place you stand at
night. The builder's elevation check compares `elev` against the parking where
a `view:` exists, so whichever convention you pick, it will tell you which
entries do not follow it.

**Four spots disagreed by more than 30 m with no viewpoint to explain it.
Settled with Shawn 2026-09-17:**

- **Gorges**, listed 3000, now 3249, the DEM at the corrected Grassy Ridge
  access. A stale figure.
- **Panthertown**, listed 3900, now 4058, the DEM at the corrected access.
- **DuPont**, left at 2900 against a pin at 2305, and the note now says the
  entry is unsettled: the pin is in the waterfall corridor, 2900 matches the
  granite domes 2.6 km away around Cedar Rock. Still open: which part of the
  forest the entry is for.
- **Mayland**, left at 2700 against 2876 at the observatory, and the note now
  says the listed elevation is uncertain and why: the published GPS and OSM's
  observatory node disagree by 166 m and 53 m of height. Still open, and only
  somebody at the park can close it.

**The card now shows both elevations where there is a walk** (2026-09-17):
`3,890 ft lot · 5,835 ft view` on the 24 spots with a `view:`, the listed
`elev` on the other 16. Both figures come off the DEM, written by
`build_horizons.py` as the generated `VIEW_ELEV` block next to `HORIZONS`, so
they follow a moved coordinate on the next build. The hand-typed `elev` is
untouched and still feeds the forecast's elevation downscaling.

**Two spots are low confidence and flagged in the research:** Kuwohi, where the
original coordinate was the summit rather than the access and moving the pin at
all is arguable, and Lake James, where which park area the entry means is
inferred from its note rather than stated.

## Re-running after an edit

```sh
python tools/build_horizons.py
```

No `--force` needed. Each cached profile records the coordinate it was computed
from, so a spot whose `lat, lon` or `view:` changed recomputes itself and
prints `coordinate moved, recomputing`. Everything else stays cached, and a
single spot takes about 0.1 s.

## Verifying that a skyline still belongs to its coordinate

Added 2026-09-17, after the coordinates above were applied.

The panorama is computed from the coordinate, so comparing the drawing to the
pin proves nothing: move the pin and the drawing moves with it, staying just as
self-consistent. `python tools/check_alignment.py` checks the chain that can
actually break: every spot has a horizon, every horizon was raycast from the
coordinate the page uses now, and the string in the page is still that raycast.
As of this date all 40 pass, and the four listings that disagree with the model
on purpose (DuPont, Gorges, Mayland, Doughton) are named in the script so the
output stays quiet until something new breaks.

There used to be a `tools/.horizon-cache/build.log`, and it cost an hour before
it was deleted on 2026-09-17. It was not written by `build_horizons.py`: it was
a shell redirect from one manual run, so nothing refreshed it, and its
elevation check still listed 20 spots disagreeing by more than 30 m long after
those coordinates were corrected. Being gitignored, it looked like tooling
output while actually being a snapshot of one moment nobody could date. If you
pipe a build into a file again, put the date and the commit in the first line,
or expect to be misled by it later.

## The pull-off 537 m south of Cove Field Ridge

Cove Field Ridge Overlook itself measures correct: the model puts its ground at
1409 m against a listed 4,620 ft (1408 m), and it sits 9 m off the parkway
centreline. Its problem is not placement but aspect. The skyline walls the west
quarter at 24 degrees and the south at 12, with those blockers 150 to 200 m
away, which is the bank the pull-off is cut into rather than a distant ridge.
Only the northeast through southeast is open, and there the nearest terrain is
6 to 29 km out.

`tools/sweep_road.py` measured the 13 parkway vertices within 2 km. One point
stands out, 537 m away on a bearing of 171:

| | Cove Field, as listed | the point south |
|---|---:|---:|
| coordinate | 35.4309, -83.0357 | 35.4261, -83.0348 |
| model ground | 1409 m | 1448 m |
| mean horizon | 12.3° | 7.5° |
| south quarter (135-225°) | 12.3° | 4.9° |
| open sky | 78.9 % | 87.1 % |

USGS imagery at zoom 16 shows a paved apron at that bend, roughly 100 m
southwest of the vertex itself; measured at the apron the south quarter reads
5.0 to 5.5 degrees, so anywhere in that bend buys about 7 degrees of southern
sky over the listed spot. The differences between points inside the bend are
smaller than a 1/3 arc-second grid can resolve, so there is no point choosing
between them by model.

**Not applied, and it should not be a coordinate move.** This is a different
place from the overlook at mp 439.4: moving Cove Field's pin here would leave
its name, its milepost and its note describing somewhere else. It wants either
its own entry, with whatever the pull-off is actually called, or nothing. The
galactic core sits in this southern quarter from here, so an entry that opens
it from 12 degrees to 5 is worth having.
