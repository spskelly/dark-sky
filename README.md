# Blue Ridge Skyline

A single-page planner for stargazing and astrophotography nights in the
North Carolina mountains: when the moon is out of the way, whether the sky
will be clear, and where to drive.

**[spskelly.github.io/dark-sky](https://spskelly.github.io/dark-sky/)**

![Blue Ridge Skyline](og.png)

## What it does

- **Four tabs.** *When is it dark?* (calendar and the window list), *where
  do i go?* (the map and the spot list), *what will i see?* (the sky viewer)
  and *field notes* (reading the mountains, how the numbers are made, and the
  credits) are tabs rather than eight screens of scroll. The URL still points
  where it always did: `#when`, `#where`, `#sky`, `#notes`, or any id inside
  a panel such as `#check-before-you-go`, opens the tab that owns it. Cards on
  a wide screen, a sticky strip of short labels on a phone, and the tab you
  were last on is remembered between visits.
- **Home, above the tabs.** Where home is answers none of the questions on
  its own, so it sits in its own strip above them: the town picker, pick on
  map, use my location and exact coordinates, plus a one-line read on
  tonight's sky there and, folded under it, the hour-by-hour row. Picking on
  the map switches to *where do i go?* first, since the map only has a real
  size once that panel has been shown.
- **The sky from anywhere.** *What will i see?* draws the ridge, the moon and
  the Milky Way from a place on a chosen night: drag to turn through a fixed
  110-degree horizon window and slide through the dark hours. The fixed scale
  keeps ridge shapes comparable while the heading changes. The ridge is bare
  earth; the trees and any tower or building within 200 m are drawn as their
  own layers from 2017 lidar and named in the sentence when they are what the
  moon or the core actually sets behind. The place comes from the
  chooser (the thirty-eight spots and every parkway overlook), from a spot card's
  thumbnail, from an overlook popup's button, or from a point picked on the
  map. A picked point has no terrain model yet, so its horizon is drawn flat
  at 0 degrees and the caveat under the canvas says so.
- **Moon phase calendar.** True phase times from the Meeus algorithm
  (*Astronomical Algorithms*, ch. 49), converted to your local time zone, so
  dates match published almanacs to the day. Phases are drawn at 9pm local,
  roughly when you'd be looking up, and the lit limb flips for the southern
  hemisphere.
- **Dark-sky windows.** A 3, 5 or 7 day band centred on each new moon,
  highlighted on the calendar and listed for the next twelve months, with the
  Friday and Saturday nights in each one called out and a note on where the
  Milky Way core sits that month.
- **Hourly sky forecast.** Cloud cover, temperature, wind and dew point for
  tonight, sunset to sunrise, from [Open-Meteo](https://open-meteo.com/)
  (no API key). Each night in the calendar also carries its mean 9pm–3am
  cloud cover.
- **38 dark-sky spots.** Overlooks, balds and campgrounds across western
  North Carolina, from the Cherohala Skyway to Doughton Park, on a topo map.
  Everything reorders around home, ranked by estimated drive time or
  straight-line distance. Each spot links to its Clear Outside forecast,
  light-pollution map and driving directions. The map also carries 116
  Parkway overlooks; opening one loads its own hourly forecast on demand.

  Drive time is estimated rather than routed: each spot carries the minutes
  of slow going once you are off the highway (gravel, the parkway detour,
  the walk in from the lot), and the rest scales with distance from wherever
  home is. That makes it a property of the spot rather than of any one town.

- **Light pollution and the parkway, on the map.** A sky-brightness overlay
  (the familiar green-to-red wash) sits behind the pins, on by default and
  remembered, alongside topo and imagery in the map's own layers control. The
  Blue Ridge Parkway is drawn as a line so the route the notes keep referring
  to is one you can actually see. Both are off the critical path: the overlay
  says so if its tiles stop loading, and the parkway is simply absent if its
  generated block is empty.

## What's remembered

The page comes back as you left it: the tab (above), the home point, the map
view, the spot filter and sort, the overlook layer, the place loaded in the
sky viewer with its scrubber where you left it, and the view it was turned
to. One pair, `recall(key, fallback)`
and `remember(key, value)`, owns the `localStorage` read/write and the
`try/catch` a private window can throw. A remembered value that no longer
means anything (a removed filter name, a map view outside the page's box)
falls back to the default instead of being trusted.

| Key | Holds | Default |
|---|---|---|
| `darksky.home` | `{lat, lon, name}` | Waynesville |
| `darksky.lightpollution` | `'1'` or `'0'` | on |
| `darksky.tab` | the tab id; a hash in the URL outranks it | the calendar tab |
| `darksky.filter` | `all`, `camp` or `drive` | `all` |
| `darksky.sort` | `mins` or `dist` | `mins` |
| `darksky.showAll` | boolean | off (collapsed) |
| `darksky.basemap` | `topo` or `imagery` | `topo` |
| `darksky.mapView` | `{lat, lon, zoom}`; ignored if outside 34-37.5 N, -85.5 to -79.5 E, or zoom outside 6-17 | framed on the visible spots |
| `darksky.overlooks` | `'1'` or `'0'` | off |
| `darksky.active` | a curated spot's name, or `ov:<osm id>`; dropped if it no longer exists. An overlook is only restored if its layer is on, and is cleared again when its popup is closed, so a popup dismissed on one visit does not reopen on the next | none |
| `darksky.pano` | the place loaded in the sky viewer: a curated spot's name, `ov:<osm id>` for an overlook, or `pt:<lat>,<lon>` (four decimals) for a point picked on the map. Loaded again on return without switching tabs, independent of the overlook layer or `darksky.active`; a picked point also gets its map marker back | none |
| `darksky.panoWhen` | `{key: "HH:MM", ...}`, one entry per spot or overlook ever opened; the clock is Eastern, matched to the nearest of that evening's dark-hour slices on return | nearest 9pm |
| `darksky.skyView` | `{az}`, the sky viewer's heading; shared by every spot, overlook and picked point. The vertical range and 110-degree field are fixed so turning cannot make the terrain appear to change shape | south (180 degrees) |
| `darksky.panoAz` | legacy: a heading in degrees, 0-360. Read once by `loadSkyView`, as a fallback for `darksky.skyView`'s own `az` when that key is not set yet, and never written again | (read-once fallback only) |

`darksky.home`, `darksky.lightpollution` and `darksky.tab` predate this table
and kept their existing names and on-disk formats. `darksky.panoWhen` can
reach 154 keys (38 spots plus 116 overlooks), about 3 kB total; it is bounded
but never pruned. The sky viewer's chosen date is deliberately not
remembered: returning next week to last week's sky would be a bug.

## Running it

The published site is one `index.html` with no build step and no bundled
runtime packages. Open it directly, or serve the directory:

```sh
python -m http.server 8000   # then open http://localhost:8000
```

Network access is needed for Leaflet and the fonts from cdnjs, Open-Meteo
forecasts, topo/imagery/light-pollution tiles, and outbound forecast, light-map
and directions links. The phase maths, calendar, spot list, generated horizons,
lidar layers and sky renderer are embedded and work offline. If Leaflet is
blocked, the map degrades to the spot list with a note.

The tabs have a check, since a hidden panel cannot be measured and both the
map and the skyline canvases need a real width the moment their tab opens:

```sh
node tools/check-tabs.mjs                  # browser integration checks; exits non-zero on failure
node tools/check-tabs.mjs --shots          # also writes six PNGs to tools/.shots/
node tools/check-tabs.mjs other-copy.html  # check some other copy of the page
```

It uses the Chrome already on the machine (falling back to Playwright's own
build) and answers or blocks every tile and data host the page reaches for: the
forecast, the basemap tiles, and the light-pollution atlas, which is served a
blank tile locally rather than aborted, because the layer's own error handler
would otherwise remove the layer under the test. Leaflet and the fonts still
load from their CDNs, so the check needs a network even though nothing it
asserts depends on one.

## Privacy and local-only tools

There is no application backend or account. The chosen home coordinate and UI
state stay in the browser's `localStorage`, but network features necessarily
share location at different precision:

- loading a forecast sends the selected latitude and longitude to Open-Meteo;
- map and sky-glow providers receive the tile coordinates for the area shown;
- Clear Outside, light-map and directions destinations receive a coordinate
  only when their link is opened.

`local-tools/` is for private, location-specific and one-off work. The whole
directory is ignored by Git, including generated data and source lidar. Its
tools are not part of the published site; see the local README inside that
directory for their own run instructions. Keep reusable, non-sensitive build
tools under `tools/` instead.

## The moon is always current

The hero, calendar and social card use a local [NASA lunar surface image](assets/README.md)
under the phase mask. The fixed surface rotates with the hemisphere setting.
`moon-preview.html` shows eight phases offline; `npm run build:moon-preview`
refreshes its embedded renderer and image after changes to the site.

Two things show tonight's real phase, and neither is hand-drawn.

- **The tab icon** is generated in the browser on every render, from the same
  `moonPath()` the calendar icons use, and follows the hemisphere toggle. The
  icon in `<head>` is only the no-script fallback.
- **`og.png`**, the link-preview image, is rebuilt daily by
  [a GitHub Action](.github/workflows/deploy-pages.yml). It doesn't recompute
  anything: `tools/build-og.mjs` loads this very page in headless Chromium and
  calls the page's own `lunationFraction()`, `moonSvg()` and `phaseWord()`, so
  the card cannot drift from the calendar it advertises. The workflow stamps a
  fresh cache-busting image URL into its temporary copy of `index.html` and
  deploys a Pages artifact. Daily moon changes therefore create deployments,
  not repository commits.

## The parkway line

`PARKWAY` in `index.html` is a generated, simplified centreline rather than a
hand-typed trace. The populated line ships inside the page; rebuild it only
when the upstream route changes (needs network, which should be close to
never):

```sh
node tools/build-parkway.mjs             # rewrites the block in index.html
node tools/build-parkway.mjs --dry-run   # print the stats, change nothing
```

It asks OpenStreetMap, via Overpass, for the ways in the Blue Ridge Parkway
route relation, clips them to western North Carolina, simplifies each to about
120 metres and writes the result between the `parkway:start` and `parkway:end`
markers. The road travels in the page rather than being fetched at runtime, so
it still draws from `file://` and offline, and cannot break because somebody
else's API moved. With the block empty the map just doesn't draw it.

## The overlook pins

`tools/build-overlooks.mjs` finds every named viewpoint OpenStreetMap knows
about within 400 m of the Blue Ridge Parkway, drops the ones that are already
a curated spot, collapses OSM's habit of mapping one pull-off as two
features, and writes the result into `index.html` as `OVERLOOKS`. Same
source and licence as the parkway line, same generated-block pattern.

```sh
node tools/build-overlooks.mjs             # rewrites OVERLOOKS in index.html
node tools/build-overlooks.mjs --dry-run   # print the filter counts, change nothing
node tools/build-overlooks.mjs --replay    # re-filter the last Overpass response, no network
```

Adding or moving a curated spot near the parkway, or refreshing from OSM,
means re-running this and then `python tools/build_horizons.py` and
`node tools/build-skyglow.mjs --fix`, in that order, so every pin keeps a
horizon and a light-pollution reading: see
[the runbook](docs/horizon_panorama.md#what-invalidates-what).

## Terrain and canopy data

The sky viewer does not fetch terrain at runtime. Its profiles are generated
ahead of time and embedded in `index.html`, so the shipped page remains a
single-file application:

- the authoritative 360-degree terrain silhouette comes from bare-earth USGS
  3DEP. It uses full 1/3-arc-second data inside 5 km and a max-pooled
  1-arc-second far field out to 100 km, with Earth curvature and standard
  refraction accounted for;
- rays begin 50 m from the viewpoint and use a 1.8 m standing eye height unless
  a viewpoint has an explicit calibration;
- nearby trees and structures come from the 2017 NC Phase 5 leaf-off lidar
  within 200 m. That lidar is deliberately labelled as a floor: later growth
  can make the real obstruction higher.

The builders need the pinned Python packages and the local 3DEP tiles at
`S:\dem_tiles`. Canopy builds fetch public USGS EPT lidar unless their cache is
already populated.

```sh
python -m pip install -r tools/requirements.txt
python tools/build_horizons.py --dry-run
python tools/build_horizons.py
python tools/build_canopy.py --dry-run
python tools/build_canopy.py
node tools/sync-panorama.mjs

node --test tools/test-panorama.mjs tools/test-inline-parity.mjs
python -m unittest discover -s tools -p "test_*.py"
```

The [terrain runbook](docs/horizon_panorama.md) has the cache layout, tuning
history and the complete invalidation order. A normal page edit or local run
does not require any of these build steps.

## The sky glow layer

The **light pollution** overlay in the map's layers control draws D. Lorenz's
world atlas of artificial night sky brightness over the topo. That is somebody else's static
tile set on GitHub Pages, and it is the one part of the page that can break on
its own: he republishes under a new folder every few years (`lp2016`, `lp2020`,
`lp2022`) and when the old folder goes, every tile comes back 404.

The page notices. After four misses with nothing loaded it switches the layer
off and says so, rather than leaving a live-looking overlay that does nothing. Every spot still links to its own light map, which is
where the detail was anyway.

To point it at wherever the tiles live now (needs network):

```sh
node tools/find-lp-tiles.mjs           # search, report, change nothing
node tools/find-lp-tiles.mjs --fix     # ... and write the winner into index.html
```

It works from most certain to least. A GitHub Pages site is served straight
out of a public repo, so the first pass *reads* the file layout through the
contents API rather than guessing at it: one real tile filename is enough.
Failing that it reads the site's own pages, printing the small ones whole,
because a 300-byte page is a signpost rather than content; it follows meta
refreshes, frames and links, and turns any `getTileUrl` it finds into a
template. Only then does it try the shapes such tile sets usually take.

A filename says which numbers are in it, not which is z, which is x and which
is y, so the last step is always the same: put them in every way round and let
the network decide. Nothing is believed until it returns real images at three
zooms over two places far apart, which is what rules out x and y being right
the wrong way round. It also reports how deep the set goes, so `maxNativeZoom`
matches. Get that wrong and the layer looks broken at exactly the zoom you'd
use to pick a spot.

If both passes come up empty, open the overlay in a browser, take one working
tile URL out of the network tab, and hand it over with the numbers replaced:

```sh
node tools/find-lp-tiles.mjs --url 'https://.../{z}/{x}/{y}.png' --fix
```

## Reading the glow at a spot

`tools/build-skyglow.mjs` samples the light pollution atlas at every spot and
in a ring of eight bearings at 10, 25 and 50 km around it, so a note can say
which way the sky is worst rather than guessing.

```sh
node tools/build-skyglow.mjs              # sample and report
node tools/build-skyglow.mjs --json sky.json
```

The atlas is coloured PNG tiles, so reading it means reading pixels.
`tools/png.mjs` does that with nothing but Node's own zlib (a PNG is a zlib
stream plus five row filters), so this runs on a bare Node install like every
other tool here, with no `npm install` and no browser download. It is checked
against fixtures covering every colour type, bit depths 1 to 16 and all five
filters, plus a tile whose 65,536 pixels each encode their own coordinates.

Each tile ships its own palette holding only the colours that tile happens to
use, in whatever order they were written, so a palette index means nothing
outside the tile it came from: index 9 is near-black in Nevada and near-white
in Charlotte. Everything keys on the colour itself.

The order of those colours is not a guess about what they look like. A transect
walking from Mount Mitchell into Asheville fixes the middle of the scale, and a
dozen places whose skies are not in question (the Sahara, Great Basin, the
Boundary Waters, Cherry Springs, then Knoxville, Charlotte, Manhattan) fix the
ends. Every run re-checks that reading them in order never steps backwards, and
says so loudly if it does, or if a colour turns up that the scale does not list.
The atlas ships no tile at all over open ocean or the Greenland ice sheet, which
is how we know its blues mean a dark sky rather than missing data.

What a band is worth in mag/arcsec² is the atlas author's business, so the run
also prints his own two legend pages verbatim.

```sh
node tools/build-skyglow.mjs --fix           # write the sky line on each card
node tools/build-skyglow.mjs --replay s.json # replay saved samples, no network
```

`--fix` rewrites the `SKY` block in `index.html`, which the spot cards render
under the hand-written note and visibly apart from it: one is measured, the
other is remembered, and they age differently. Each line carries its band as a
swatch, and the block also holds the scale itself, so the map key is drawn from
the atlas's own sixteen colours as hard stops rather than from an impression of
them: the key it replaced was a seven-stop blend with one green in it, and the
atlas has two. The hand-written notes are never touched, so re-running this
cannot eat somebody's local knowledge. It refuses to write at all if a colour
turned up that the scale cannot place, or if any spot came back without a
reading, because a wrong band on a card is worse than no card.

The band names are chosen to survive being read next to the map. The scale is
built from dark/light pairs of one hue, so they are *deep green* and *bright
green* rather than *dark green* and *green*: the second pair is no use when you
are looking at two greens and working out which one you are standing in.

`--replay` takes the samples back out of a `--json` run instead of fetching, so
the wording, the part most likely to need another pass, can be worked on, and
tested, without re-reading ten tiles off somebody else's server to repunctuate a
sentence. Before 2026-09-17, `--json` did not write the `samples` field this
reads, so `--replay` could not have worked no matter what this said; both do
now.

Without `--fix` it writes nothing into `index.html`. What a colour *means* is the atlas
author's business and not something to invent, so the run also prints a census
of every colour that actually turned up and whatever the site's own source says
about its palette. The mapping from colour to sky brightness goes in once that
has been read.

## Checking the pins

`tools/check-spots.mjs` measures the spot coordinates against two references
that are not somebody's memory:

```sh
node tools/check-spots.mjs           # report, change nothing
node tools/check-spots.mjs --snap    # put roadside pull-offs on the road
node tools/check-spots.mjs --osm     # compare every spot to OpenStreetMap
node tools/check-spots.mjs --osm --fix
```

Anything tagged with a milepost is, by definition, on the parkway, so once the
centreline is in the page an overlook sitting a mile off it is wrong by
construction, so `--snap` moves those, and only those, onto the line. A summit or
a campground up a side road is left alone: its milepost is where you leave the
parkway, not where the spot is.

It also runs a check that needs no external data at all. Two points on one road
cannot be farther apart in a straight line than the difference in their
mileposts, so any pair that is proves one of them wrong. That is what vouches
for a snap: the spots already sitting on the road agree with each other, and
after a snap the moved ones agree with them too.

For everything away from the parkway there is no reference line, so `--osm`
compares each spot to the OpenStreetMap feature of the same name and reports the
distance. `--fix` applies only point features, never the centroid of a park the
size of a county, which is a spot in the woods rather than the parking.

### Keeping a skyline attached to its coordinate

`check-spots.mjs` says where a pin sits. `tools/check_alignment.py` says whether
the drawn skyline still belongs to it, which is the thing that rots silently:
revise a coordinate without rebuilding and the page draws last week's horizon
from this week's pin, looking perfectly plausible.

```sh
python tools/check_alignment.py            # 38 spots in under a second, exit 1 if broken
python tools/check_alignment.py --quiet    # failures only, for a hook or CI
python tools/check_alignment.py --html other.html
```

It needs no DEM and no rasterio, because it reads the cache
`build_horizons.py` leaves behind: every spot has a horizon, every horizon was
raycast from the coordinate the page uses *now*, and the encoded string in the
page is still that raycast. Then it compares the model's ground elevation
against the listed one, reading the two kinds of spot differently: a drive-up
should agree within about 20 m, while a walk-in spot's gap is the climb to its
`view:` coordinate, where a *negative* gap means the viewpoint never left the
trailhead. The four listings that disagree on purpose are named in the script
with their reasons, so the output stays quiet until something new breaks.

### Choosing a pull-off from the model

`tools/check_viewpoint.py` compares two coordinates you already have.
`tools/sweep_road.py` answers the question before that: of the road near a
spot, which point is worth standing on.

```sh
python tools/sweep_road.py --spot "Cove Field"                   # 2 km of parkway
python tools/sweep_road.py --spot "Cove Field" --south --radius 1500
python tools/sweep_road.py 35.4309 -83.0357 --sector 45 135      # score the east instead
```

It walks the `PARKWAY` polyline, takes every vertex within the radius (the line
is simplified to about 120 m, which is roughly a pull-off apart) and measures
each, scoring a sector you choose. Both tools need the DEM tiles and the
far-field grid, so run `build_horizons.py` once first.

Both are bare earth. 3DEP models no vegetation, and the raycast starts 50 m
out. It can include immediate terrain such as a pull-off cut or ridge shoulder,
but never trees or structures. For an overlook whose note says the view has
grown in, the model is the best case.

The npm dependencies are tooling only: the site itself ships nothing from
`node_modules`. To rebuild the card by hand:

```sh
npm ci && npx playwright install chromium && npm run build:og
```

## Check before you go

The spot list is one person's notes, not an official source. Coordinates are
approximate parking or summit points; elevations and drive times are rounded;
and the camping, fire and access notes were true when written and may not be
true tonight. Gates close for ice, forest orders change, permits appear, roads
wash out, campgrounds run seasonally.

Confirm anything you are relying on with whoever manages the land:
[parkway road closures](https://www.nps.gov/blri/planyourvisit/roadclosures.htm),
[Smokies road status](https://www.nps.gov/grsm/planyourvisit/temproadclose.htm),
[National Forests in NC](https://www.fs.usda.gov/r08/nfsnc),
[NC State Parks](https://www.ncparks.gov/). Treat the forecast as a model
rather than a promise. These are remote places at four to six thousand feet,
often on gravel, usually with no signal.

## Notes

- The window is a planning heuristic. The moon also rises and sets, so a
  waxing crescent a few days past new is gone by late evening and a waning
  crescent doesn't rise until the small hours; those edge days are often
  darker than they look.
- Drive times assume the Blue Ridge Parkway is open. The high sections close
  for ice from November into April, so check
  [NPS road status](https://www.nps.gov/blri/planyourvisit/roadclosures.htm)
  before committing to a gate.
- Data, imagery, map and font credits are documented in [ATTRIBUTION.md](ATTRIBUTION.md)
  and the site's **sources & credits** section. This includes the unresolved
  license question for David Lorenz's rendered light-pollution tiles.
