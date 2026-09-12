# dark sky calendar

A single-page planner for stargazing and astrophotography nights in the
North Carolina mountains: when the moon is out of the way, whether the sky
will be clear, and where to drive.

**[spskelly.github.io/dark-sky](https://spskelly.github.io/dark-sky/)**

![dark sky calendar](og.png)

## What it does

- **Moon phase calendar.** True phase times from the Meeus algorithm
  (*Astronomical Algorithms*, ch. 49), converted to your local time zone, so
  dates match published almanacs to the day. Phases are drawn at 9pm local —
  roughly when you'd be looking up — and the lit limb flips for the southern
  hemisphere.
- **Dark-sky windows.** A 3, 5 or 7 day band centred on each new moon,
  highlighted on the calendar and listed for the next twelve months, with the
  Friday and Saturday nights in each one called out and a note on where the
  Milky Way core sits that month.
- **Hourly sky forecast.** Cloud cover, temperature, wind and dew point for
  tonight, sunset to sunrise, from [Open-Meteo](https://open-meteo.com/)
  (no API key). Each night in the calendar also carries its mean 9pm–3am
  cloud cover.
- **40 dark-sky spots.** Overlooks, balds and campgrounds across western
  North Carolina, from the Cherohala Skyway to Doughton Park, on a topo map.
  Set a home point — a town from the list, a click on the map, or your own
  location — and everything reorders around it, ranked by estimated drive
  time or straight-line distance. Each spot links to its Clear Outside
  forecast, light-pollution map and driving directions.

  Drive time is estimated rather than routed: each spot carries the minutes
  of slow going once you are off the highway (gravel, the parkway detour,
  the walk in from the lot), and the rest scales with distance from wherever
  home is. That makes it a property of the spot rather than of any one town.

## Running it

The site is one `index.html` with no build step and no runtime dependencies.
Open it directly, or serve the directory:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

The map (Leaflet, from cdnjs) and the forecast (Open-Meteo) need network
access; everything else — the phase maths, the calendar, the spot list —
works offline, and the map degrades to the list with a note.

## The moon is always current

Two things show tonight's real phase, and neither is hand-drawn.

- **The tab icon** is generated in the browser on every render, from the same
  `moonPath()` the calendar icons use, and follows the hemisphere toggle. The
  icon in `<head>` is only the no-script fallback.
- **`og.png`**, the link-preview image, is rebuilt daily by
  [a GitHub Action](.github/workflows/og-card.yml). It doesn't recompute
  anything: `tools/build-og.mjs` loads this very page in headless Chromium and
  calls the page's own `lunationFraction()`, `moonSvg()` and `phaseWord()`, so
  the card cannot drift from the calendar it advertises. It commits only when
  the image actually changes.

The npm dependencies exist for that generator alone — the site itself ships
nothing from `node_modules`. To rebuild the card by hand:

```sh
npm ci && npx playwright install chromium && npm run build:og
```

## Check before you go

The spot list is one person's notes, not an official source. Coordinates are
approximate parking or summit points; elevations and drive times are rounded;
and the camping, fire and access notes were true when written and may not be
true tonight. Gates close for ice, forest orders change, permits appear, roads
wash out, campgrounds run seasonally.

Confirm anything you are relying on with whoever manages the land —
[parkway road closures](https://www.nps.gov/blri/planyourvisit/roadclosures.htm),
[Smokies road status](https://www.nps.gov/grsm/planyourvisit/temproadclose.htm),
[National Forests in NC](https://www.fs.usda.gov/r08/nfsnc),
[NC State Parks](https://www.ncparks.gov/) — and treat the forecast as a model
rather than a promise. These are remote places at four to six thousand feet,
often on gravel, usually with no signal.

## Notes

- The window is a planning heuristic. The moon also rises and sets, so a
  waxing crescent a few days past new is gone by late evening and a waning
  crescent doesn't rise until the small hours; those edge days are often
  darker than they look.
- Drive times assume the Blue Ridge Parkway is open. The high sections close
  for ice from November into April — check
  [NPS road status](https://www.nps.gov/blri/planyourvisit/roadclosures.htm)
  before committing to a gate.
- Tiles: [OpenTopoMap](https://opentopomap.org/) (CC-BY-SA) and USGS
  imagery via The National Map.
